"""
CONTOURS DE L'IMAGE DE FOND (idée utilisateur, étape 1 : le fond seul).

Prend le décor vide du début de la vidéo et produit une image de TOUS ses
contours, la plus précise possible :

1. Image de fond = MÉDIANE des 30 premières frames vides (à la résolution
   ORIGINALE) — la médiane supprime le bruit capteur/ compression frame par
   frame, les contours en sont d'autant plus propres. Une variante à partir
   d'une seule frame est aussi produite pour comparaison.
2. Détection de contours Canny (scikit-image) : lissage gaussien (sigma),
   gradient, suppression des non-maxima (contours de 1 px de large),
   double seuil avec hystérésis (contours continus, pas de fragments).
3. Sorties :
   - contours_fond.png            : contours (blanc sur noir), meilleur réglage
   - contours_fond_overlay.png    : fond + contours en rouge (vérifier la précision)
   - contours_fond_comparaison.png: grille des réglages testés
   - contours_fond_sobel.png      : magnitude de gradient (force continue)
   - fond_reference.png           : l'image de fond utilisée
"""

import subprocess
import sys
from pathlib import Path

import numpy as np
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from PIL import Image
from scipy import ndimage
from skimage import feature
import imageio_ffmpeg

import detect_frames as d

# --------------------- Paramètres ---------------------

VIDEO = "WhatsApp Video 2026-10-28 at 16.27.21.mp4"
NB_FRAMES_FOND = 30      # frames vides pour la médiane du fond
SEUIL_VIDE = 3.0

# Réglages Canny testés : (sigma, seuil_bas, seuil_haut)
REGLAGES = [
    (1.0, 20, 60),
    (1.0, 40, 120),
    (1.5, 25, 75),
    (1.5, 50, 150),
    (2.0, 30, 90),
    (2.0, 60, 180),
]
REGLAGE_RETENU = 3       # index du réglage retenu pour la sortie principale

# -------------------------------------------------------


def decoder_couleur_originale(exe: str, chemin: Path, max_frames: int | None = None):
    """Pipe rawvideo RGB24 à la résolution originale (autoration appliquée)."""
    import io

    args = [exe, "-v", "error", "-i", str(chemin), "-map", "0:v:0"]
    if max_frames:
        args += ["-frames:v", str(max_frames)]
    args += ["-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
    r = subprocess.run(
        [exe, "-v", "error", "-i", str(chemin), "-map", "0:v:0",
         "-frames:v", "1", "-f", "image2", "-c:v", "png", "-"],
        capture_output=True,
    )
    image = Image.open(io.BytesIO(r.stdout))
    l, h = image.size
    image.close()
    proc = subprocess.Popen(args, stdout=subprocess.PIPE)
    return proc, l, h


def main() -> None:
    chemin = Path(sys.argv[1] if len(sys.argv) > 1 else VIDEO)
    if not chemin.exists():
        raise SystemExit(f"Vidéo introuvable : {chemin}")

    exe = d.ffmpeg_exe()

    # ---------------- Fond : médiane des premières frames vides ----------------
    proc, l, h = decoder_couleur_originale(exe, chemin, max_frames=400)
    assert proc.stdout is not None
    taille = l * h * 3
    frames = []
    premiere = None
    n = 0
    while n < NB_FRAMES_FOND:
        buf = proc.stdout.read(taille)
        if not buf or len(buf) < taille:
            break
        gris = np.frombuffer(buf, np.uint8).reshape(h, l, 3).mean(axis=2)
        if premiere is None:
            premiere = gris.astype(np.int16)
        elif float(np.abs(gris.astype(np.int16) - premiere).mean()) > SEUIL_VIDE:
            break
        frames.append(gris)
        n += 1
    try:
        proc.kill()
    except OSError:
        pass
    proc.wait()
    if len(frames) < 3:
        raise SystemExit("Phase vide non détectée au début de la vidéo.")

    fond_median = np.median(np.stack(frames), axis=0).astype(np.uint8)
    fond_unique = frames[0]
    print(
        f"Fond : médiane de {len(frames)} frames vides | résolution originale {l}x{h}"
    )

    Image.fromarray(fond_median).save("fond_reference.png")
    Image.fromarray(fond_unique.astype(np.uint8)).save("fond_une_frame.png")

    # ---------------- Canny : grille de réglages ----------------
    resultats_median = []
    for sigma, bas, haut in REGLAGES:
        contours = feature.canny(fond_median.astype(float) / 255.0, sigma=sigma, low_threshold=bas / 255.0, high_threshold=haut / 255.0)
        resultats_median.append(contours)
        print(f"  réglage sigma={sigma}, seuils {bas}/{haut} : {int(contours.sum())} px de contours")

    # Variante depuis UNE seule frame (pour mesurer l'apport de la médiane)
    sigma, bas, haut = REGLAGES[REGLAGE_RETENU]
    contours_unique = feature.canny(fond_unique.astype(float) / 255.0, sigma=sigma, low_threshold=bas / 255.0, high_threshold=haut / 255.0)
    print(
        f"Comparaison (réglage retenu) : médiane {int(resultats_median[REGLAGE_RETENU].sum())} px "
        f"vs une seule frame {int(contours_unique.sum())} px de contours "
        "(la médiane élimine le bruit — moins de faux contours)"
    )

    # ---------------- Sorties ----------------
    # 1. Contours du réglage retenu (blanc sur noir)
    retenu = resultats_median[REGLAGE_RETENU]
    img_contours = np.zeros((h, l, 3), np.uint8)
    img_contours[retenu] = (255, 255, 255)
    Image.fromarray(img_contours).save("contours_fond.png")
    print("Contours (réglage retenu) : contours_fond.png")

    # 2. Overlay : fond + contours rouges (vérification de la précision)
    overlay = np.stack([fond_median] * 3, axis=-1).astype(np.int16)
    rouge = np.zeros_like(overlay)
    rouge[:, :, 0] = 255
    overlay[retenu] = rouge[retenu]
    Image.fromarray(overlay.astype(np.uint8)).save("contours_fond_overlay.png")
    print("Vérification visuelle : contours_fond_overlay.png")

    # 3. Grille de comparaison des réglages
    fig, axes = plt.subplots(2, 3, figsize=(15, 11), dpi=110)
    for i, (axe, (sigma, bas, haut)) in enumerate(zip(axes.flat, REGLAGES)):
        axe.imshow(resultats_median[i], cmap="gray")
        axe.set_title(f"sigma={sigma}, seuils {bas}/{haut} — {int(resultats_median[i].sum())} px", fontsize=10)
        axe.axis("off")
    fig.suptitle("Contours Canny de l'image de fond (médiane) — réglages comparés", fontsize=12)
    fig.tight_layout()
    fig.savefig("contours_fond_comparaison.png")
    print("Comparaison des réglages : contours_fond_comparaison.png")

    # 4. Magnitude de Sobel (force continue des arêtes)
    f = fond_median.astype(np.float32)
    gx = ndimage.sobel(f, axis=1, mode="nearest")
    gy = ndimage.sobel(f, axis=0, mode="nearest")
    magnitude = np.sqrt(gx * gx + gy * gy)
    fig2, ax2 = plt.subplots(figsize=(7, 12), dpi=110)
    ax2.imshow(magnitude, cmap="inferno")
    ax2.set_title("Magnitude du gradient (Sobel) du fond")
    ax2.axis("off")
    fig2.tight_layout()
    fig2.savefig("contours_fond_sobel.png")
    print("Magnitude de gradient : contours_fond_sobel.png")


if __name__ == "__main__":
    main()
