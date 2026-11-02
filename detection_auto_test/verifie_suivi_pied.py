"""
SUIVI LOCAL DU PIED (idée utilisateur) : plutôt que détecter toute la
silhouette, on ne suit QUE le pied.

Principe :
1. INITIALISATION : à FRAME_INIT (athlète debout, avant les sauts), la
   position du pied est déterminée par le masque fort du fond vide
   (bas de la silhouette). On extrait un MOTIF (patch 48x48 autour du
   pied) et la COULEUR unie de la chaussette (médiane RGB du cœur du
   patch).
2. À CHAQUE FRAME SUIVANTE : analyse LIMITÉE à une fenêtre autour de la
   position précédente. Le motif est recherché par corrélation normalisée
   (NCC via FFT — insensible aux changements de luminosité) dans un rayon
   borné. Le motif s'adapte lentement (10 % par frame fiable) pour
   tolérer la rotation du pied (pointes tendues au décollage, etc.).
3. FORME DU PIED : autour de la position trouvée, les pixels proches de
   la couleur de la chaussette sont extraits — la forme précise du pied,
   affichée en vert dans la vidéo.
4. Sorties : verification_suivi_pied.mp4 (fenêtre de recherche encadrée,
   forme du pied, marqueur de position), suivi_pied.json, analyse
   (croisements, vols) et trajectoire_suivi.png.
"""

import json
import re
import subprocess
import sys
from pathlib import Path

import numpy as np
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from PIL import Image, ImageDraw
from scipy import ndimage
from scipy.signal import fftconvolve
import imageio_ffmpeg

import detect_frames as d
import pose_pieds as pp

# --------------------- Paramètres ---------------------

VIDEO = "WhatsApp Video 2026-10-28 at 16.27.21.mp4"
FRAME_INIT = 3800        # frame d'initialisation (athlète debout, avant les sauts)
SEUIL_INIT = 60.0        # masque fort pour l'initialisation (ombre exclue)
DEMI_MOTIF = 24          # demi-taille du motif (patch 48x48)
DEMI_FENETRE_X = 80      # fenêtre de recherche (ROI) autour de la position
DEMI_FENETRE_Y = 100
RECHERCHE_X = 60         # déplacement max du pied entre 2 frames
RECHERCHE_Y = 80
SEUIL_SCORE = 0.30       # NCC minimal pour un suivi fiable
TAUX_ADAPTATION = 0.10   # adaptation lente du motif (par frame fiable)
SEUIL_FORME = 50.0       # distance RGB max = pixel de la chaussette
RAYON = 3
POURCENT_SOL = 90.0
SEUIL_VIDE = 3.0
MAX_FRAMES_VIDES = 1500

COULEUR_SUIVI = (60, 255, 60)   # vert : suivi + forme du pied
COULEUR_CADRE = (255, 230, 40) # jaune : fenêtre de recherche

# -------------------------------------------------------


def probe(exe: str, chemin: Path) -> float:
    r = subprocess.run(
        [exe, "-hide_banner", "-i", str(chemin)],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    m = re.search(r"([\d.]+) fps", r.stderr)
    return float(m.group(1)) if m else 30.0


def carte_ncc(roi: np.ndarray, motif: np.ndarray) -> np.ndarray:
    """Carte de corrélation normalisée (NCC) du motif dans la ROI."""
    th, tw = motif.shape
    n = th * tw
    ones = np.ones((th, tw), dtype=np.float32)
    motif_inv = motif[::-1, ::-1].astype(np.float32)
    roi32 = roi.astype(np.float32)
    cross = fftconvolve(roi32, motif_inv, mode="valid")
    sommes = fftconvolve(roi32, ones, mode="valid")
    carres = fftconvolve(roi32 * roi32, ones, mode="valid")
    mean_w = sommes / n
    std_w = np.sqrt(np.maximum(carres / n - mean_w * mean_w, 1e-6))
    mean_t = float(motif.mean())
    std_t = max(float(motif.std()), 1e-6)
    num = cross - n * mean_w * mean_t
    return num / (n * std_w * std_t)


def main() -> None:
    chemin = Path(sys.argv[1] if len(sys.argv) > 1 else VIDEO)
    if not chemin.exists():
        raise SystemExit(f"Vidéo introuvable : {chemin}")

    exe = d.ffmpeg_exe()
    fps = probe(exe, chemin)
    print(f"Vidéo : {chemin.name} | {fps:.2f} fps")

    # ---------------- Fond vide ----------------
    proc, l, h = pp.demarrer_decodage_couleur(exe, chemin, d.LARGEUR)
    assert proc.stdout is not None
    taille = l * h * 3
    grises = []
    premiere = None
    n = 0
    while n < MAX_FRAMES_VIDES:
        buf = proc.stdout.read(taille)
        if not buf or len(buf) < taille:
            break
        gris = np.frombuffer(buf, np.uint8).reshape(h, l, 3).mean(axis=2).astype(np.int16)
        if premiere is None:
            premiere = gris
        elif float(np.abs(gris - premiere).mean()) > SEUIL_VIDE:
            break
        if n < 300:
            grises.append(gris)
        n += 1
    try:
        proc.kill()
    except OSError:
        pass
    proc.wait()
    if len(grises) < 3:
        raise SystemExit("Phase vide non détectée.")
    fond = np.median(np.stack(grises), axis=0).astype(np.int16)
    print(f"Phase vide : {n} frames — fond prêt")

    # ---------------- Encodage ----------------
    largeur_out = (l * 3 // 2) + (l * 3 // 2) % 2
    hauteur_out = (h * 3 // 2) + (h * 3 // 2) % 2
    sortie = chemin.parent / "verification_suivi_pied.mp4"
    encodeur = subprocess.Popen(
        [exe, "-v", "error",
         "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{l}x{h}", "-r", "30",
         "-i", "-",
         "-vf", f"scale={largeur_out}:{hauteur_out}",
         "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
         "-crf", "23", "-movflags", "+faststart", "-y", str(sortie)],
        stdin=subprocess.PIPE,
    )
    assert encodeur.stdin is not None

    # ---------------- Passe unique : init + suivi + rendu ----------------
    suivi: list[dict] = []          # {frame, x, y, score, fiable}
    motif: np.ndarray | None = None  # patch gris suivi
    couleur_chaussette: np.ndarray | None = None
    pos_x = pos_y = 0.0
    th = tw = 2 * DEMI_MOTIF

    n = 0
    proc, l, h = pp.demarrer_decodage_couleur(exe, chemin, d.LARGEUR)
    while True:
        buf = proc.stdout.read(taille)
        if not buf or len(buf) < taille:
            break
        rgb = np.frombuffer(buf, np.uint8).reshape(h, l, 3)
        gris = rgb.mean(axis=2).astype(np.int16)

        if n == FRAME_INIT:
            # ---- Initialisation : bas de la silhouette forte ----
            masque = np.abs(gris - fond) > SEUIL_INIT
            if int(masque.sum()) < 500:
                raise SystemExit(
                    f"Athlète non détecté à FRAME_INIT={FRAME_INIT} — "
                    "ajustez FRAME_INIT sur une phase debout."
                )
            lignes = np.nonzero(masque.any(axis=1))[0]
            nb_bas = max(1, int(len(lignes) * 0.02))
            bas = lignes[-nb_bas:]
            pos_y = float(np.median(bas))
            cols = np.nonzero(masque[bas[len(bas) // 2]] | masque[bas[-1]])[0]
            pos_x = float(cols.mean()) if len(cols) > 0 else l / 2

            cy = int(pos_y) - DEMI_MOTIF // 2
            cx = int(pos_x)
            y0 = max(0, cy - DEMI_MOTIF)
            x0 = max(0, cx - DEMI_MOTIF)
            y1, x1 = y0 + th, x0 + tw
            if y1 > h or x1 > l:
                raise SystemExit("Pied trop proche du bord pour l'initialisation.")
            motif = gris[y0:y1, x0:x1].astype(np.float32)
            coeur = rgb[max(0, cy - 6): cy + 6, max(0, cx - 6): cx + 6]
            couleur_chaussette = np.median(coeur.reshape(-1, 3), axis=0)
            print(
                f"Initialisation frame {FRAME_INIT + 1} : pied à "
                f"({pos_x:.0f}, {pos_y:.0f}) | couleur chaussette "
                f"RGB {couleur_chaussette.astype(int).tolist()}"
            )
            suivi.append({"frame": n, "x": pos_x, "y": pos_y, "score": 1.0, "fiable": 1})

        elif motif is not None and n > FRAME_INIT:
            # ---- Suivi : fenêtre bornée autour de la position précédente ----
            roi_y0 = max(0, int(pos_y) - DEMI_MOTIF // 2 - DEMI_FENETRE_Y)
            roi_x0 = max(0, int(pos_x) - DEMI_MOTIF // 2 - DEMI_FENETRE_X)
            roi_y1 = min(h, roi_y0 + 2 * DEMI_FENETRE_Y + th)
            roi_x1 = min(l, roi_x0 + 2 * DEMI_FENETRE_X + tw)
            roi = gris[roi_y0:roi_y1, roi_x0:roi_x1].astype(np.float32)

            ncc = carte_ncc(roi, motif)
            # bornes de recherche autour de la position précédente
            oi = int(pos_y) - DEMI_MOTIF // 2 - roi_y0
            oj = int(pos_x) - DEMI_MOTIF // 2 - roi_x0
            i0 = max(0, oi - RECHERCHE_Y)
            i1 = min(ncc.shape[0], oi + RECHERCHE_Y + 1)
            j0 = max(0, oj - RECHERCHE_X)
            j1 = min(ncc.shape[1], oj + RECHERCHE_X + 1)
            morceau = ncc[i0:i1, j0:j1]
            idx = int(np.argmax(morceau))
            mi, mj = np.unravel_index(idx, morceau.shape)
            score = float(morceau[mi, mj])

            if score >= SEUIL_SCORE:
                nouveau_x = float(roi_x0 + mj + tw // 2)
                nouveau_y = float(roi_y0 + mi + th // 2)  # centre du motif
                fiable = 1
                # adaptation lente du motif
                py = int(nouveau_y) - DEMI_MOTIF // 2
                px = int(nouveau_x) - DEMI_MOTIF // 2
                patch = gris[py: py + th, px: px + tw].astype(np.float32)
                if patch.shape == motif.shape:
                    motif = (1 - TAUX_ADAPTATION) * motif + TAUX_ADAPTATION * patch
                pos_x, pos_y = nouveau_x, nouveau_y + DEMI_MOTIF // 2  # bas du pied
            else:
                fiable = 0  # position maintenue
            suivi.append(
                {"frame": n, "x": pos_x, "y": pos_y, "score": score, "fiable": fiable}
            )

        # ---- Rendu ----
        rgb16 = rgb.astype(np.int16)
        if motif is not None and suivi:
            dernier = suivi[-1]
            px, py = int(dernier["x"]), int(dernier["y"])
            # fenêtre de recherche
            image = Image.fromarray(rgb16.astype(np.uint8))
            dessin = ImageDraw.Draw(image)
            fy0 = max(0, int(dernier["y"]) - DEMI_MOTIF // 2 - DEMI_FENETRE_Y)
            fx0 = max(0, px - DEMI_MOTIF // 2 - DEMI_FENETRE_X)
            dessin.rectangle(
                [fx0, fy0, min(l - 1, fx0 + 2 * DEMI_FENETRE_X + tw), min(h - 1, fy0 + 2 * DEMI_FENETRE_Y + th)],
                outline=COULEUR_CADRE, width=1,
            )
            rgb8 = np.array(image)
            # forme du pied : pixels proches de la couleur chaussette
            zy0, zx0 = max(0, py - 30), max(0, px - 40)
            zone = rgb16[zy0: min(h, py + 30), zx0: min(l, px + 40)]
            if zone.size and couleur_chaussette is not None:
                dist = np.sqrt(
                    ((zone.astype(np.float32) - couleur_chaussette.astype(np.float32)) ** 2).sum(axis=2)
                )
                forme = dist < SEUIL_FORME
                verte = np.zeros_like(zone, dtype=np.int16)
                verte[:, :] = COULEUR_SUIVI
                zone[forme] = (0.55 * verte[forme] + 0.45 * zone[forme]).astype(np.int16)
                rgb16[zy0: zy0 + zone.shape[0], zx0: zx0 + zone.shape[1]] = zone
            rgb8 = rgb16.astype(np.uint8)
            # marqueur : ligne + carré
            if 0 <= py < h:
                rgb8[max(0, py - RAYON): py + RAYON + 1, max(0, px - 30): px + 31, :] = COULEUR_SUIVI
                rgb8[max(0, py - 6): py + 7, max(0, px - 8): px + 9, :] = COULEUR_SUIVI
        else:
            rgb8 = rgb16.astype(np.uint8)

        try:
            encodeur.stdin.write(rgb8.tobytes())
        except (OSError, ValueError):
            encodeur.stdin.close()
            encodeur.wait()
            raise SystemExit("Échec d'encodage : fermez le lecteur des anciennes vidéos.")
        n += 1
    proc.wait()
    encodeur.stdin.close()
    if encodeur.wait() != 0:
        raise SystemExit("Échec de l'encodage.")
    print(f"\n{n} frames | suivi de {len(suivi)} frames (depuis {FRAME_INIT + 1})")
    fiables_nb = sum(1 for s in suivi if s["fiable"])
    scores = np.array([s["score"] for s in suivi])
    print(
        f"Suivi fiable : {fiables_nb}/{len(suivi)} frames | "
        f"score NCC médian {np.median(scores):.2f} | min {scores.min():.2f}"
    )
    print(f"Vidéo résultat : {sortie}")
    print("Rappel : jaune = fenêtre de recherche ; vert = forme du pied + marqueur")

    # ---------------- Sauvegarde + analyse ----------------
    with open(chemin.parent / "suivi_pied.json", "w", encoding="utf-8") as f:
        json.dump(suivi, f, ensure_ascii=False)
    print("Données : suivi_pied.json")

    if not suivi:
        return
    pieds = np.array([s["y"] for s in suivi])
    fiab = np.array([s["fiable"] for s in suivi], dtype=float)
    lissee = d.mediane_glissante(pieds, d.FENETRE_LISSAGE)

    positions_fiables = lissee[fiab > 0]
    sol = float(np.percentile(positions_fiables, POURCENT_SOL))
    amplitude = float(positions_fiables.max() - positions_fiables.min())
    deltas = np.abs(np.diff(lissee))
    en_vol = lissee[1:] < sol - 0.1 * amplitude
    bruit = float(np.median(deltas[en_vol])) if en_vol.sum() >= 8 else 1.0
    epsilon = max(2 * bruit, 0.02 * amplitude, 1.0)
    seuil = sol - epsilon

    seuils = lissee >= seuil
    evenements: list[dict] = []
    precedent = seuils[0]
    for i in range(1, len(seuils)):
        if seuils[i] != precedent:
            evenements.append(
                {
                    "frame": suivi[0]["frame"] + i,
                    "direction": "descente (vers le sol)" if seuils[i] else "montée (quitte le sol)",
                }
            )
            precedent = seuils[i]
    if evenements:
        fusionnes = [evenements[0]]
        for ev in evenements[1:]:
            if ev["frame"] - fusionnes[-1]["frame"] < d.SEGMENT_MIN_FRAMES:
                fusionnes[-1] = ev
            else:
                fusionnes.append(ev)
        evenements = fusionnes

    vols_profondeur = []
    for i in range(len(evenements) - 1):
        a, b_ev = evenements[i], evenements[i + 1]
        if a["direction"].startswith("mont") and b_ev["direction"].startswith("desc"):
            ia = a["frame"] - suivi[0]["frame"]
            ib = b_ev["frame"] - suivi[0]["frame"]
            sommet = lissee[ia:ib].min()
            vols_profondeur.append((a["frame"], sommet))

    print(f"\nLigne de sol : {sol:.1f} px | seuil : {seuil:.1f} px")
    print(f"Amplitude : {amplitude:.0f} px (min {positions_fiables.min():.0f}, max {positions_fiables.max():.0f})")
    if vols_profondeur:
        profondeurs = [sol - s for _, s in vols_profondeur]
        print(
            f"{len(vols_profondeur)} vols complets — élévation moyenne : "
            f"{np.mean(profondeurs):.0f} px (min {np.min(profondeurs):.0f}, max {np.max(profondeurs):.0f})"
        )
    print(f"\n{len(evenements)} bascule(s) :")
    for ev in evenements:
        print(f"  frame {ev['frame'] + 1:>6} | {ev['frame'] / fps:7.3f} s | {ev['direction']}")

    # Graphique
    frames = [s["frame"] for s in suivi]
    fig, ax = plt.subplots(figsize=(14, 5), dpi=120)
    ax.plot(frames, pieds, color="#9aa1b5", alpha=0.4, linewidth=0.8, label="position brute")
    ax.plot(frames, lissee, color="#4d9fff", linewidth=1.5, label="position lissée")
    ax.axhline(sol, color="#e6a23c", linewidth=1.2, label="ligne de sol")
    ax.axhline(seuil, color="#e94560", linestyle="--", linewidth=1.2, label="seuil")
    ax.plot(frames, scores, color="#2ecc71", alpha=0.5, linewidth=0.8, label="score NCC")
    for ev in evenements:
        ax.axvline(ev["frame"], color="#2ecc71", linewidth=1.0, alpha=0.7)
    ax.invert_yaxis()
    ax.set_xlabel("frame")
    ax.set_ylabel("position du pied (px) / score NCC")
    ax.set_title(f"{chemin.name} — suivi local du pied depuis la frame {FRAME_INIT + 1}")
    ax.legend(loc="upper right", fontsize=8)
    fig.tight_layout()
    fig.savefig(chemin.parent / "trajectoire_suivi.png")
    print("Graphique : trajectoire_suivi.png")


if __name__ == "__main__":
    main()
