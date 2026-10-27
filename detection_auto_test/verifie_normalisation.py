"""
Test : méthode legacy (soustraction de fond + quantile) avec NORMALISATION
RGB des canaux, pour supprimer l'impact de la luminosité — donc de l'ombre.

Principe : chromaticité r' = R/(R+G+B), g' = G/(R+G+B), b' = B/(R+G+B).
Ces valeurs sont INVARIANTES à la luminosité : une ombre abaisse R, G et B
dans les mêmes proportions, la chromaticité du sol ne change pas. Le masque
de mouvement est calculé sur l'écart de chromaticité, pas de luminance.

Pipeline (identique au legacy, seule la représentation couleur change) :
1. Décodage couleur, largeur 384 (h = 682, même repère que la pose).
2. Chromaticité par pixel (pixels trop sombres exclus : division instable).
3. Fond = médiane temporelle des chromaticités échantillonnées.
4. Masque = écart max de chromaticité > SEUIL_CHROMA.
5. Pied = bas du masque (quantile 2 %, comme le legacy).
6. Comparaison chiffrée avec la trajectoire POSE (référence).
7. Vidéo verification_normalisation.mp4 : corps surligné (rouge),
   ligne verte = méthode normalisée, ligne bleue = pose (référence).
"""

import re
import subprocess
import sys
from pathlib import Path

import numpy as np
import imageio_ffmpeg

import detect_frames as d
import pose_pieds as pp

# --------------------- Paramètres ---------------------

VIDEO = "WhatsApp Video 2026-10-27 at 14.29.28.mp4"
SEUIL_CHROMA = 0.05      # écart max de chromaticité (0-1) = pixel du sujet
SEUIL_SOMME_MIN = 15.0   # R+G+B en dessous : pixel exclu (division instable)
QUANTILE_PIED = 0.02     # bas du masque retenu (comme le legacy)
NB_ECHANTILLONS_FOND = 64
TAILLE_MIN_MASQUE = 50
RAYON = 3                # épaisseur des lignes dessinées

# -------------------------------------------------------


def probe_fps(exe: str, chemin: Path) -> float:
    r = subprocess.run(
        [exe, "-hide_banner", "-i", str(chemin)],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    m = re.search(r"([\d.]+) fps", r.stderr)
    return float(m.group(1)) if m else 30.0


def chromaticite(rgb: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """(r', g') normalisés par la somme des canaux + masque de stabilité.
    rgb : (h, l, 3) uint8 → r', g' : float32 (0-1)."""
    f = rgb.astype(np.float32)
    somme = f[:, :, 0] + f[:, :, 1] + f[:, :, 2]
    stable = somme > SEUIL_SOMME_MIN
    sure = np.maximum(somme, 1.0)  # évite la division par zéro
    return f[:, :, 0] / sure, f[:, :, 1] / sure, stable, somme


def main() -> None:
    chemin = Path(sys.argv[1] if len(sys.argv) > 1 else VIDEO)
    if not chemin.exists():
        raise SystemExit(f"Vidéo introuvable : {chemin}")

    exe = d.ffmpeg_exe()
    fps = probe_fps(exe, chemin)

    # Référence : trajectoire pose (cache)
    pieds_pose, fiab_pose, _kpts, h_pose = pp.trajectoire_pieds_pose(exe, chemin, d.LARGEUR)
    lissee_pose = d.mediane_glissante(pieds_pose, d.FENETRE_LISSAGE)
    analyse_pose = d.analyser_trajectoire(lissee_pose, fiab_pose, len(pieds_pose))
    sol_pose = analyse_pose["sol"]
    eps_pose = analyse_pose["epsilon"]

    # ---------------- Passe 1 : comptage + fond en chromaticité ----------------
    proc, l, h = pp.demarrer_decodage_couleur(exe, chemin, d.LARGEUR)
    assert proc.stdout is not None
    taille = l * h * 3
    total = 0
    while proc.stdout.read(taille):
        total += 1
    proc.wait()
    pas = max(1, total // NB_ECHANTILLONS_FOND)

    proc, l, h = pp.demarrer_decodage_couleur(exe, chemin, d.LARGEUR)
    echant_r = []
    echant_g = []
    n = 0
    while True:
        buf = proc.stdout.read(taille)
        if not buf or len(buf) < taille:
            break
        if n % pas == 0:
            rgb = np.frombuffer(buf, np.uint8).reshape(h, l, 3)
            r, g, stable, _s = chromaticite(rgb)
            echant_r.append(np.where(stable, r, np.nan))
            echant_g.append(np.where(stable, g, np.nan))
        n += 1
    proc.wait()

    # Médiane en ignorant les pixels instables (nan)
    fond_r = np.nanmedian(np.stack(echant_r), axis=0)
    fond_g = np.nanmedian(np.stack(echant_g), axis=0)
    fond_b = np.clip(1.0 - fond_r - fond_g, 0.0, 1.0)
    print(f"{total} frames {l}x{h} | fond en chromaticité sur {len(echant_r)} échantillons")

    # ---------------- Passe 2 : masque normalisé + rendu ----------------
    largeur_out = (l * 3 // 2) + (l * 3 // 2) % 2   # 576
    hauteur_out = (h * 3 // 2) + (h * 3 // 2) % 2  # 1024 (paire, exigée par x264)
    sortie = chemin.parent / "verification_normalisation.mp4"
    encodeur = subprocess.Popen(
        [exe, "-v", "error",
         "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{l}x{h}", "-r", str(fps),
         "-i", "-",
         "-vf", f"scale={largeur_out}:{hauteur_out}",
         "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
         "-crf", "23", "-movflags", "+faststart", "-y", str(sortie)],
        stdin=subprocess.PIPE,
    )
    assert encodeur.stdin is not None

    positions: list[float] = []
    fiables: list[float] = []
    images: list[np.ndarray] = []

    proc, l, h = pp.demarrer_decodage_couleur(exe, chemin, d.LARGEUR)
    n = 0
    while True:
        buf = proc.stdout.read(taille)
        if not buf or len(buf) < taille:
            break
        rgb = np.frombuffer(buf, np.uint8).reshape(h, l, 3).copy()
        r, g, stable, _s = chromaticite(rgb)
        b = np.clip(1.0 - r - g, 0.0, 1.0)

        with np.errstate(invalid="ignore"):
            diff = np.maximum(
                np.maximum(np.abs(r - fond_r), np.abs(g - fond_g)),
                np.abs(b - fond_b),
            )
        utilisable = stable & np.isfinite(fond_r) & np.isfinite(fond_g)
        masque = np.where(utilisable, diff, 0.0) > SEUIL_CHROMA

        if int(masque.sum()) >= TAILLE_MIN_MASQUE:
            lignes = np.nonzero(masque.any(axis=1))[0]
            nb_bas = max(1, int(len(lignes) * QUANTILE_PIED))
            bas = lignes[-nb_bas:]
            positions.append(float(np.median(bas)))
            fiables.append(1.0)
        else:
            positions.append(positions[-1] if positions else float(h))
            fiables.append(0.0)

        # Rendu : corps surligné rouge translucide
        rgb = rgb.astype(np.int16)
        rouge = np.zeros_like(rgb)
        rouge[:, :, 0] = 255
        rgb[masque] = (0.45 * rouge[masque] + 0.55 * rgb[masque]).astype(np.int16)
        rgb = rgb.astype(np.uint8)

        # Lignes : vert = méthode normalisée, bleu = pose (référence)
        yp = int(positions[-1])
        if 0 <= yp < h:
            rgb[max(0, yp - RAYON): yp + RAYON + 1, :, :] = (60, 255, 60)
        if n < len(lissee_pose):
            yq = int(lissee_pose[n])
            if 0 <= yq < h:
                rgb[max(0, yq - RAYON): yq + RAYON + 1, :, :] = (80, 160, 255)

        try:
            encodeur.stdin.write(rgb.tobytes())
        except (OSError, ValueError):
            encodeur.stdin.close()
            encodeur.wait()
            raise SystemExit(
                "Échec d'encodage : fermez le lecteur qui lit les anciennes vidéos."
            )
        n += 1

    proc.wait()
    encodeur.stdin.close()
    if encodeur.wait() != 0:
        raise SystemExit("Échec de l'encodage.")
    print(f"Vidéo : {sortie} (vert = normalisé, bleu = pose)")

    # ---------------- Analyse et comparaison ----------------
    pieds_norm = np.array(positions)
    fiab_norm = np.array(fiables)
    lissee_norm = d.mediane_glissante(pieds_norm, d.FENETRE_LISSAGE)
    analyse_norm = d.analyser_trajectoire(lissee_norm, fiab_norm, total)

    total_c = min(total, len(lissee_pose))
    ecart = np.abs(lissee_norm[:total_c] - lissee_pose[:total_c])
    en_vol = lissee_pose[:total_c] < sol_pose - 0.5 * eps_pose
    print(f"\nMéthode normalisée : {len(analyse_norm['evenements'])} bascules "
          f"(pose : {len(analyse_pose['evenements'])})")
    print(f"Écart moyen avec la pose pendant les VOLS    : {ecart[en_vol].mean():6.1f} px")
    print(f"Écart moyen avec la pose pendant les CONTACTS : {ecart[~en_vol].mean():6.1f} px")
    print(f"Écart max : {ecart.max():.1f} px | frames non fiables : {int((fiab_norm == 0).sum())}")

    # Quelques fenêtres de vol pour comparaison directe
    print("\nPosition pendant des phases de vol (référence pose) :")
    fenetres = [(395, 460), (490, 550), (575, 628), (660, 712), (745, 798), (830, 882)]
    for debut_f, fin_f in fenetres:
        pose_moy = lissee_pose[debut_f:fin_f].mean()
        norm_moy = lissee_norm[debut_f:fin_f].mean()
        print(
            f"  frames {debut_f + 1}-{fin_f}: pose {pose_moy:6.1f} px | "
            f"normalisé {norm_moy:6.1f} px | écart {abs(pose_moy - norm_moy):5.1f} px"
        )


if __name__ == "__main__":
    main()
