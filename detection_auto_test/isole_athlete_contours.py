"""
ISOLEMENT DE L'ATHLÈTE PAR SOUSTRACTION DE CONTOURS SOBEL (idée utilisateur).

NB : l'image téléchargée (739x1600) n'a pas les dimensions de la vidéo
(464x832) ni le même ratio d'aspect — impossible à aligner avec le fond.
On extrait donc directement des frames de la vidéo (alignement parfait).

Protocole demandé, appliqué à des frames avec l'athlète :
1. contours de la frame : magnitude de Sobel > SEUIL_SOBEL ;
2. contours du fond : même filtre sur l'image de fond (médiane des frames
   vides), DILATÉS de quelques px (tolérance d'alignement) ;
3. contours de l'athlète = contours de la frame HORS contours du fond
   (les arêtes « nouvelles ») ;
4. variante Canny (hystérésis → contours continus, plus résistante au
   bruit) pour comparaison sur les mêmes frames.

Sorties (par frame) : magnitude Sobel, contours isolés (blanc/noir),
overlay rouge (vérification), et version nettoyée des petits fragments.
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
import imageio_ffmpeg

import detect_frames as d

# --------------------- Paramètres ---------------------

VIDEO = "WhatsApp Video 2026-10-28 at 16.27.21.mp4"
FRAMES_CIBLES = [900, 3981, 4391]   # debout / contact / vol
NB_FRAMES_FOND = 30
SEUIL_VIDE = 3.0
SEUIL_SOBEL = 300.0      # magnitude de gradient minimale (bruit capteur élevé)
DILATATION_FOND = 2      # dilatation des contours du fond (tolérance)
MIN_FRAGMENT = 25        # fragments de contours plus petits supprimés (version nettoyée)
CANNY_SIGMA = 1.5
CANNY_BAS = 50.0
CANNY_HAUT = 150.0

# -------------------------------------------------------


def magnitude_sobel(gris: np.ndarray) -> np.ndarray:
    f = gris.astype(np.float32)
    gx = ndimage.sobel(f, axis=1, mode="nearest")
    gy = ndimage.sobel(f, axis=0, mode="nearest")
    return np.sqrt(gx * gx + gy * gy)


def principal() -> None:
    chemin = Path(sys.argv[1] if len(sys.argv) > 1 else VIDEO)
    if not chemin.exists():
        raise SystemExit(f"Vidéo introuvable : {chemin}")
    exe = d.ffmpeg_exe()

    # ---------------- Fond (médiane des frames vides) ----------------
    import io

    r = subprocess.run(
        [exe, "-v", "error", "-i", str(chemin), "-map", "0:v:0",
         "-frames:v", "1", "-f", "image2", "-c:v", "png", "-"],
        capture_output=True,
    )
    image = Image.open(io.BytesIO(r.stdout))
    l, h = image.size
    image.close()
    taille = l * h * 3

    proc = subprocess.Popen(
        [exe, "-v", "error", "-i", str(chemin), "-map", "0:v:0",
         "-frames:v", "400", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        stdout=subprocess.PIPE,
    )
    assert proc.stdout is not None
    frames_fond = []
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
        frames_fond.append(gris.astype(np.uint8))
        n += 1
    try:
        proc.kill()
    except OSError:
        pass
    proc.wait()
    if len(frames_fond) < 3:
        raise SystemExit("Phase vide non détectée.")
    fond = np.median(np.stack(frames_fond), axis=0).astype(np.uint8)
    print(f"Fond : médiane de {len(frames_fond)} frames | {l}x{h}")

    # ---------------- Contours du fond (Sobel + Canny) ----------------
    from skimage import feature

    mag_fond = magnitude_sobel(fond)
    contours_fond_sobel = mag_fond > SEUIL_SOBEL
    contours_fond_sobel_dil = ndimage.binary_dilation(contours_fond_sobel, iterations=DILATATION_FOND)
    contours_fond_canny = feature.canny(
        fond.astype(float) / 255.0, sigma=CANNY_SIGMA,
        low_threshold=CANNY_BAS / 255.0, high_threshold=CANNY_HAUT / 255.0,
    )
    contours_fond_canny_dil = ndimage.binary_dilation(contours_fond_canny, iterations=DILATATION_FOND)
    print(
        f"Contours du fond : Sobel {int(contours_fond_sobel.sum())} px | "
        f"Canny {int(contours_fond_canny.sum())} px"
    )

    # ---------------- Extraction des frames cibles ----------------
    cibles = set(FRAMES_CIBLES)
    gardees: dict[int, np.ndarray] = {}
    proc = subprocess.Popen(
        [exe, "-v", "error", "-i", str(chemin), "-map", "0:v:0",
         "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        stdout=subprocess.PIPE,
    )
    assert proc.stdout is not None
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

    structure = ndimage.generate_binary_structure(2, 2)

    for numero, rgb in sorted(gardees.items()):
        gris = rgb.mean(axis=2).astype(np.uint8)
        print(f"\n----- frame {numero + 1} -----")

        # ---- Sobel : contours de la frame, moins ceux du fond ----
        mag = magnitude_sobel(gris)
        contours_frame = mag > SEUIL_SOBEL
        nouvelles = contours_frame & ~contours_fond_sobel_dil
        print(
            f"Sobel : {int(contours_frame.sum())} px de contours dans la frame, "
            f"{int(nouvelles.sum())} px HORS fond (= athlète + bruit)"
        )

        # nettoyage : fragments trop petits = bruit
        etiquettes, nb = ndimage.label(nouvelles, structure=structure)
        nettoyees = np.zeros_like(nouvelles)
        if nb > 0:
            tailles = ndimage.sum_labels(np.ones_like(etiquettes), etiquettes, np.arange(1, nb + 1))
            gardees_idx = np.nonzero(tailles >= MIN_FRAGMENT)[0] + 1
            nettoyees = np.isin(etiquettes, gardees_idx)
        print(
            f"Nettoyage (fragments >= {MIN_FRAGMENT} px) : {int(nettoyees.sum())} px conservés"
        )

        # ---- Variante Canny ----
        canny_frame = feature.canny(
            gris.astype(float) / 255.0, sigma=CANNY_SIGMA,
            low_threshold=CANNY_BAS / 255.0, high_threshold=CANNY_HAUT / 255.0,
        )
        nouvelles_canny = canny_frame & ~contours_fond_canny_dil
        etiquettes_c, nb_c = ndimage.label(nouvelles_canny, structure=structure)
        canny_nettoyees = np.zeros_like(nouvelles_canny)
        if nb_c > 0:
            tailles_c = ndimage.sum_labels(np.ones_like(etiquettes_c), etiquettes_c, np.arange(1, nb_c + 1))
            canny_nettoyees = np.isin(etiquettes_c, np.nonzero(tailles_c >= MIN_FRAGMENT)[0] + 1)
        print(
            f"Canny : {int(canny_frame.sum())} px dans la frame, "
            f"{int(nouvelles_canny.sum())} px hors fond, "
            f"{int(canny_nettoyees.sum())} px après nettoyage"
        )

        # ---- Sorties ----
        suffixe = f"frame_{numero + 1:04d}"

        # magnitude Sobel (carte de chaleur)
        fig, ax = plt.subplots(figsize=(5.5, 9), dpi=110)
        ax.imshow(mag, cmap="inferno")
        ax.set_title(f"Frame {numero + 1} — magnitude Sobel")
        ax.axis("off")
        fig.tight_layout()
        fig.savefig(f"sobel_athlete_{suffixe}.png")
        plt.close(fig)

        # contours isolés : blanc sur noir (Sobel nettoyé + Canny nettoyé)
        for nom, masque in [
            (f"iso_sobel_{suffixe}.png", nettoyees),
            (f"iso_canny_{suffixe}.png", canny_nettoyees),
        ]:
            img = np.zeros((h, l, 3), np.uint8)
            img[masque] = (255, 255, 255)
            Image.fromarray(img).save(nom)

        # overlay rouge (vérification de la précision)
        overlay = rgb.astype(np.int16).copy()
        rouge = np.zeros_like(overlay)
        rouge[:, :, 0] = 255
        overlay[nettoyees] = rouge[nettoyees]
        Image.fromarray(overlay.astype(np.uint8)).save(f"overlay_iso_sobel_{suffixe}.png")

        overlay_c = rgb.astype(np.int16).copy()
        overlay_c[canny_nettoyees] = rouge[canny_nettoyees]
        Image.fromarray(overlay_c.astype(np.uint8)).save(f"overlay_iso_canny_{suffixe}.png")

    print("\nSorties par frame : sobel_athlete_*, iso_sobel_*, iso_canny_*,")
    print("  overlay_iso_sobel_*, overlay_iso_canny_* (contours rouges sur l'image)")


if __name__ == "__main__":
    principal()
