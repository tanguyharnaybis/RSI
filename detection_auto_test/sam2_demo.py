"""
DÉMO SAM 2 (Segment Anything Model 2) sur des frames clés de la vidéo.

SAM 2, c'est quoi ?
- Un modèle de Meta qui SEGMENTE un objet précis à partir d'un « prompt »
  (un clic, une boîte) : il rend un masque pixel-par-pixel de l'objet.
- Sa version vidéo propage le masque à travers toutes les frames (suivi
  par apparence, avec mémoire : insensible aux ombres et aux fonds
  texturés — nos problèmes du labo).

Cette démo (CPU, sans GPU) applique le mode IMAGE à 3 frames clés :
  - frame 3801 : athlète debout
  - frame 3982 : contact au sol
  - frame 4392 : vol
Pour chaque frame : un clic sur le PIED → masque du pied, un clic sur le
TORSE → masque du corps entier. Sortie : images annotées + scores.
"""

import json
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image
import imageio_ffmpeg

import detect_frames as d

# --------------------- Paramètres ---------------------

VIDEO = "WhatsApp Video 2026-10-28 at 16.27.21.mp4"
CHECKPOINT = "sam2.1_hiera_tiny.pt"
CONFIG = "configs/sam2.1/sam2.1_hiera_t.yaml"
FRAMES_CIBLES = [3801, 3982, 4392]  # debout / contact / vol
X_PIED = 166             # abscisse approximative du pied (athlète quasi sur place)
DECALAGE_Y_PIED = 10     # le clic vise un peu AU-DESSUS du bas mesuré

# -------------------------------------------------------


def demarrer_decodage_originale(exe: str, chemin: Path):
    import io

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


def main() -> None:
    chemin = Path(sys.argv[1] if len(sys.argv) > 1 else VIDEO)
    if not chemin.exists():
        raise SystemExit(f"Vidéo introuvable : {chemin}")

    # Positions du bas du pied mesurées précédemment (référence fond vide)
    donnees = json.load(open("iso_sobel_video.json", encoding="utf-8"))
    reference = donnees["reference"]

    exe = d.ffmpeg_exe()
    proc, l, h = demarrer_decodage_originale(exe, chemin)
    assert proc.stdout is not None
    taille = l * h * 3
    cibles = set(FRAMES_CIBLES)
    gardees = {}
    n = 0
    maxi = max(FRAMES_CIBLES)
    while n <= maxi:
        buf = proc.stdout.read(taille)
        if not buf or len(buf) < taille:
            break
        if n in cibles:
            gardees[n] = np.frombuffer(buf, np.uint8).reshape(h, l, 3).copy()
        n += 1
    try:
        proc.kill()
    except OSError:
        pass
    proc.wait()
    print(f"{len(gardees)} frames extraites ({l}x{h})")

    # ---- SAM 2 ----
    import torch
    from sam2.build_sam import build_sam2
    from sam2.sam2_image_predictor import SAM2ImagePredictor

    print("Chargement du modèle SAM 2.1 hiera tiny (CPU)…")
    modele = build_sam2(CONFIG, CHECKPOINT, device="cpu")
    predicteur = SAM2ImagePredictor(modele)

    for numero, rgb in sorted(gardees.items()):
        y_bas = reference[numero]  # bas du pied mesuré (résolution originale)
        print(f"\n----- frame {numero + 1} (bas du pied mesuré : y={y_bas:.0f}) -----")

        predicteur.set_image(rgb)

        # 1) clic sur le pied
        point_pied = np.array([[X_PIED, y_bas - DECALAGE_Y_PIED]], dtype=np.float32)
        masques, scores, _ = predicteur.predict(
            point_coords=point_pied, point_labels=np.array([1]), multimask_output=False
        )
        masque_pied = masques[0] > 0.5
        print(f"  masque PIED : {int(masque_pied.sum())} px | score {scores[0]:.2f}")

        # 2) clic sur le torse (corps entier)
        point_torse = np.array([[X_PIED, max(50, y_bas - 260)]], dtype=np.float32)
        masques_c, scores_c, _ = predicteur.predict(
            point_coords=point_torse, point_labels=np.array([1]), multimask_output=False
        )
        masque_corps = masques_c[0] > 0.5
        print(f"  masque CORPS : {int(masque_corps.sum())} px | score {scores_c[0]:.2f}")

        # ---- sorties annotées ----
        suffixe = f"frame_{numero + 1:04d}"

        # corps en bleu translucide
        sortie = rgb.astype(np.int16).copy()
        bleu = np.zeros_like(sortie)
        bleu[:, :, 2] = 255
        sortie[masque_corps] = (0.45 * bleu[masque_corps] + 0.55 * sortie[masque_corps]).astype(np.int16)
        # pied en vert translucide
        vert = np.zeros_like(sortie)
        vert[:, :, 1] = 255
        sortie[masque_pied] = (0.55 * vert[masque_pied] + 0.45 * sortie[masque_pied]).astype(np.int16)
        # points de prompt
        for (x, y), couleur in [
            ((X_PIED, y_bas - DECALAGE_Y_PIED), (255, 60, 60)),
            ((X_PIED, max(50, y_bas - 260)), (255, 255, 60)),
        ]:
            x, y = int(x), int(y)
            sortie[max(0, y - 3): y + 4, x, :] = couleur
            sortie[y, max(0, x - 3): x + 4, :] = couleur
        Image.fromarray(sortie.astype(np.uint8)).save(f"sam2_demo_{suffixe}.png")

        # bas du masque pied (pour comparaison avec la référence)
        lignes = np.nonzero(masque_pied.any(axis=1))[0]
        if len(lignes):
            bas_sam = float(lignes.max())
            print(
                f"  bas du masque pied : y={bas_sam:.0f} "
                f"(référence mesurée : {y_bas:.0f}, écart {abs(bas_sam - y_bas):.0f} px)"
            )
        print(f"  image : sam2_demo_{suffixe}.png")

    print("\nRappel : bleu = corps (clic torse) ; vert = pied (clic pied) ;")
    print("  rouge = clic pied ; jaune = clic torse")


if __name__ == "__main__":
    main()
