"""
Validation comparative : méthode legacy (masque + quantile) vs pose
(MediaPipe Pose), sur la même vidéo.

Produit :
1. trajectoire_comparee.png — les deux courbes superposées, croisements de
   chaque méthode, zones de divergence (|pose - legacy| > seuil) surlignées
   en rouge : c'est là que l'ombre faussait le legacy.
2. verification_pose.mp4 — vidéo annotée avec les keypoints du pied
   (chevilles 27/28, talons 29/30, pointes 31/32 — couleur selon confiance),
   la position pose (ligne verte) et la position legacy (ligne orange).
3. Console — croisements des deux méthodes côte à côte (écart en frames),
   fenêtres de divergence, et synthèse vol/contact.
"""

import io
import re
import subprocess
import sys
from pathlib import Path

import numpy as np
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from PIL import Image, ImageDraw
import imageio_ffmpeg

import detect_frames as d
import pose_pieds as pp

# --------------------- Paramètres ---------------------

VIDEO = "WhatsApp Video 2026-10-27 at 14.29.28.mp4"
DIVERGENCE_PX = 15.0    # |pose - legacy| au-delà : divergence marquée
RAYON_KEYPOINT = 7      # rayon des cercles keypoints (vidéo originale)

COULEUR_POSE = (60, 255, 60)       # vert
COULEUR_LEGACY = (255, 150, 60)    # orange
COULEUR_FIABLE = (60, 255, 60)     # keypoint fiable
COULEUR_FAIBLE = (255, 170, 40)    # keypoint peu fiable

# -------------------------------------------------------


def probe_fps(exe: str, chemin: Path) -> float:
    r = subprocess.run(
        [exe, "-hide_banner", "-i", str(chemin)],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    m = re.search(r"([\d.]+) fps", r.stderr)
    return float(m.group(1)) if m else 30.0


def decoder_couleur_originale(exe: str, chemin: Path):
    """Pipe rawvideo RGB24 à la résolution originale (autoration appliquée)."""
    r = subprocess.run(
        [exe, "-v", "error", "-i", str(chemin), "-map", "0:v:0",
         "-frames:v", "1", "-f", "image2", "-c:v", "png", "-"],
        capture_output=True,
    )
    image = Image.open(io.BytesIO(r.stdout))
    l, h = image.size
    image.close()
    proc = subprocess.Popen(
        [exe, "-v", "error", "-i", str(chemin), "-map", "0:v:0",
         "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        stdout=subprocess.PIPE,
    )
    return proc, l, h


def croisements_avec_sol(
    lissee: np.ndarray, sol: float, epsilon: float, debut: int, fin: int, segment_min: int
) -> list[dict]:
    """Croisements d'un seuil donné (logique identique à detect_frames)."""
    fenetre = lissee[debut:fin]
    seuil = sol - epsilon
    seuils = fenetre >= seuil
    evenements: list[dict] = []
    precedent = seuils[0]
    for i in range(1, len(seuils)):
        if seuils[i] != precedent:
            evenements.append(
                {
                    "frame": debut + i,
                    "direction": "descente (vers le sol)" if seuils[i] else "montée (quitte le sol)",
                }
            )
            precedent = seuils[i]
    if evenements:
        fusionnes = [evenements[0]]
        for ev in evenements[1:]:
            if ev["frame"] - fusionnes[-1]["frame"] < segment_min:
                fusionnes[-1] = ev
            else:
                fusionnes.append(ev)
        evenements = fusionnes
    return evenements


def main() -> None:
    chemin = Path(sys.argv[1] if len(sys.argv) > 1 else VIDEO)
    if not chemin.exists():
        raise SystemExit(f"Vidéo introuvable : {chemin}")

    exe = d.ffmpeg_exe()

    # ---------------- Trajectoires des deux méthodes ----------------
    print("Méthode legacy (masque + quantile)…")
    fond, l_d, h_d, total_legacy = d.construire_fond(exe, chemin, d.LARGEUR)
    pieds_legacy, fiab_legacy = d.trajectoire_pieds(exe, chemin, d.LARGEUR, fond, l_d, h_d)
    lissee_legacy = d.mediane_glissante(pieds_legacy, d.FENETRE_LISSAGE)
    analyse_legacy = d.analyser_trajectoire(lissee_legacy, fiab_legacy, total_legacy)

    print("Méthode pose (MediaPipe)…")
    pieds_pose, fiab_pose, keypoints, h_pose = pp.trajectoire_pieds_pose(exe, chemin, d.LARGEUR)
    total_pose = len(pieds_pose)
    lissee_pose = d.mediane_glissante(pieds_pose, d.FENETRE_LISSAGE)
    analyse_pose = d.analyser_trajectoire(lissee_pose, fiab_pose, total_pose)

    total = min(total_legacy, total_pose)
    if total_legacy != total_pose:
        print(f"ATTENTION : nombre de frames différent ({total_legacy} legacy vs {total_pose} pose)")

    print(f"\nLegacy : {len(analyse_legacy['evenements'])} bascules | sol {analyse_legacy['sol']:.0f} px")
    print(f"Pose   : {len(analyse_pose['evenements'])} bascules | sol {analyse_pose['sol']:.0f} px")

    # Legacy HISTORIQUE : croisements avec l'ancienne ligne de sol (quantile
    # 85 %) — celle qui donnait autrefois des bascules « plausibles ». Permet
    # la comparaison au niveau des FRAMES même quand le legacy plat ne
    # détecte plus rien avec la ligne de sol par frames de référence.
    sol_hist = float(np.percentile(lissee_legacy[:total], 85))
    ev_legacy_hist = croisements_avec_sol(
        lissee_legacy, sol_hist, analyse_legacy["epsilon"],
        analyse_legacy["debut"], analyse_legacy["fin"], d.SEGMENT_MIN_FRAMES
    )
    print(
        f"Legacy (ligne de sol historique, quantile 85 % = {sol_hist:.0f} px) : "
        f"{len(ev_legacy_hist)} bascules"
    )

    # ---------------- Divergences ----------------
    # (là où l'ombre faussait le legacy : pose et legacy s'écartent pendant les vols)
    divergence = np.abs(lissee_pose[:total] - lissee_legacy[:total]) > DIVERGENCE_PX
    fenetres_divergence = []
    debut_f = None
    for i in range(total):
        if divergence[i] and debut_f is None:
            debut_f = i
        elif not divergence[i] and debut_f is not None:
            fenetres_divergence.append((debut_f, i - 1))
            debut_f = None
    if debut_f is not None:
        fenetres_divergence.append((debut_f, total - 1))

    ecart = np.abs(lissee_pose[:total] - lissee_legacy[:total])
    print(f"\nDivergence (|pose - legacy| > {DIVERGENCE_PX:.0f} px) : {len(fenetres_divergence)} fenêtre(s)")
    for debut_f, fin_f in fenetres_divergence:
        print(
            f"  frames {debut_f + 1}-{fin_f + 1} "
            f"({(fin_f - debut_f + 1)} frames, écart max {ecart[debut_f:fin_f + 1].max():.0f} px)"
        )

    # Croisements côte à côte : pour chaque bascule pose, la plus proche legacy
    ev_legacy = [e["frame"] for e in ev_legacy_hist]
    ev_pose = [e["frame"] for e in analyse_pose["evenements"]]
    print("\nBascules pose (référence) vs la plus proche legacy (ligne de sol historique) :")
    print(f"{'frame pose':>12} {'direction':>22} {'legacy la + proche':>20} {'écart':>8}")
    for ev in analyse_pose["evenements"]:
        if ev_legacy:
            plus_proche = min(ev_legacy, key=lambda f: abs(f - ev["frame"]))
            ecart_f = plus_proche - ev["frame"]
            marque = "  <- absent du legacy" if abs(ecart_f) > 6 else ""
            print(f"{ev['frame'] + 1:>12} {ev['direction']:>22} {plus_proche + 1:>20} {ecart_f:>+8d}{marque}")
        else:
            print(f"{ev['frame'] + 1:>12} {ev['direction']:>22} {'—':>20}")

    # Synthèse vol/contact : écart moyen pendant les phases de vol de la pose
    en_vol = lissee_pose[:total] < analyse_pose["sol"] - 0.5 * analyse_pose["epsilon"]
    en_contact = ~en_vol
    print(f"\nÉcart moyen pose-legacy pendant les vols (pose) : {ecart[en_vol].mean():.0f} px")
    print(f"Écart moyen pose-legacy pendant les contacts (pose) : {ecart[en_contact].mean():.0f} px")

    # ---------------- Graphique superposé ----------------
    fig, ax = plt.subplots(figsize=(14, 6), dpi=120)
    idx = np.arange(total)
    ax.plot(idx, lissee_legacy[:total], color="#ff9a3c", linewidth=1.4,
            label="legacy : masque + quantile (faussé par l'ombre en vol)")
    ax.plot(idx, lissee_pose[:total], color="#4d9fff", linewidth=1.4,
            label="pose : MediaPipe (pointe moyenne des 2 pieds)")
    # zones de divergence
    for debut_f, fin_f in fenetres_divergence:
        ax.axvspan(debut_f, fin_f, color="#e94560", alpha=0.15)
    # lignes de seuil de chaque méthode
    ax.axhline(analyse_pose["sol"], color="#4d9fff", linestyle=":", linewidth=1, alpha=0.7)
    ax.axhline(analyse_legacy["sol"], color="#ff9a3c", linestyle=":", linewidth=1, alpha=0.7)
    # bascules
    for ev in ev_legacy_hist:
        ax.axvline(ev["frame"], color="#ff9a3c", linewidth=1.0, alpha=0.75)
    for ev in analyse_pose["evenements"]:
        ax.axvline(ev["frame"], color="#2ecc71", linewidth=1.0, alpha=0.8)
    ax.invert_yaxis()  # repère image : y vers le bas
    ax.set_xlabel("frame")
    ax.set_ylabel("position verticale du pied (px)")
    ax.set_title(
        f"{chemin.name} — legacy vs pose | zones rouges = divergence "
        f"(> {DIVERGENCE_PX:.0f} px, l'ombre faussait le legacy en vol)"
    )
    ax.legend(loc="upper right", fontsize=8)
    fig.tight_layout()
    fig.savefig(chemin.parent / "trajectoire_comparee.png")
    print("\nGraphique : trajectoire_comparee.png")

    # ---------------- Vidéo annotée avec keypoints ----------------
    print("Rendu de la vidéo annotée (keypoints + deux lignes)…")
    proc, l_o, h_o = decoder_couleur_originale(exe, chemin)
    assert proc.stdout is not None
    taille = l_o * h_o * 3
    echelle = h_o / h_pose  # positions (px du décodage 384) → vidéo originale

    sortie = chemin.parent / "verification_pose.mp4"
    encodeur = subprocess.Popen(
        [exe, "-v", "error",
         "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{l_o}x{h_o}",
         "-r", str(probe_fps(exe, chemin)),
         "-i", "-",
         "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
         "-crf", "23", "-movflags", "+faststart", "-y", str(sortie)],
        stdin=subprocess.PIPE,
    )
    assert encodeur.stdin is not None

    n = 0
    while True:
        buf = proc.stdout.read(taille)
        if not buf or len(buf) < taille:
            break
        rgb = np.frombuffer(buf, np.uint8).reshape(h_o, l_o, 3).astype(np.uint8)

        if n < total:
            # keypoints du pied (normalisés → pixels originaux)
            for (kx, ky, conf) in keypoints[n]:
                if np.isfinite(kx) and np.isfinite(ky):
                    x = int(kx * l_o)
                    y = int(ky * h_o)
                    couleur = COULEUR_FIABLE if conf >= pp.SEUIL_CONFIANCE else COULEUR_FAIBLE
                    y0, y1 = max(0, y - RAYON_KEYPOINT), min(h_o, y + RAYON_KEYPOINT + 1)
                    x0, x1 = max(0, x - RAYON_KEYPOINT), min(l_o, x + RAYON_KEYPOINT + 1)
                    rgb[y0:y1, x0:x1] = couleur
            # position pose (vert) et legacy (orange)
            yp = int(lissee_pose[n] * echelle)
            if 0 <= yp < h_o:
                rgb[max(0, yp - 1): yp + 2, l_o // 4:] = COULEUR_POSE
            yl = int(lissee_legacy[n] * echelle)
            if 0 <= yl < h_o:
                rgb[max(0, yl - 1): yl + 2, : l_o // 4] = COULEUR_LEGACY

        encodeur.stdin.write(rgb.tobytes())
        n += 1
    proc.wait()
    encodeur.stdin.close()
    if encodeur.wait() != 0:
        raise SystemExit("Échec de l'encodage de verification_pose.mp4")

    print(f"Vidéo : {sortie}")
    print("Rappel : points = keypoints du pied (vert fiable / orange faible) ;")
    print("  ligne verte (3/4 droits) = position pose ; ligne orange (1/4 gauche) = position legacy")


if __name__ == "__main__":
    main()
