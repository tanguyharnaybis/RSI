"""
FILTRE DE SOBEL SUR TOUTE LA VIDÉO — visualisation seule, multi-seuils.

Chaque frame est convertie en contours (magnitude de Sobel > seuil, blanc
sur noir) pour CHAQUE seuil testé — une vidéo par seuil, en une seule passe
de décodage. Aucun suivi, aucune soustraction de fond.
"""

import subprocess
import sys
from pathlib import Path

import numpy as np
from scipy import ndimage
import imageio_ffmpeg

import detect_frames as d

# --------------------- Paramètres ---------------------

VIDEO = "WhatsApp Video 2026-10-28 at 16.27.21.mp4"
SEUILS = [100.0, 150.0]  # magnitudes testées (300/250/200 déjà produites)

# -------------------------------------------------------


def magnitude_sobel(gris: np.ndarray) -> np.ndarray:
    f = gris.astype(np.float32)
    gx = ndimage.sobel(f, axis=1, mode="nearest")
    gy = ndimage.sobel(f, axis=0, mode="nearest")
    return np.sqrt(gx * gx + gy * gy)


def main() -> None:
    chemin = Path(sys.argv[1] if len(sys.argv) > 1 else VIDEO)
    if not chemin.exists():
        raise SystemExit(f"Vidéo introuvable : {chemin}")

    exe = d.ffmpeg_exe()

    import io
    from PIL import Image

    r = subprocess.run(
        [exe, "-v", "error", "-i", str(chemin), "-map", "0:v:0",
         "-frames:v", "1", "-f", "image2", "-c:v", "png", "-"],
        capture_output=True,
    )
    image = Image.open(io.BytesIO(r.stdout))
    l, h = image.size
    image.close()
    taille = l * h * 3

    sortie_base = chemin.parent / "sobel_video_seuil_{:.0f}.mp4"
    encodeurs = {}
    for seuil in SEUILS:
        sortie = str(sortie_base).format(seuil)
        encodeur = subprocess.Popen(
            [exe, "-v", "error",
             "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{l}x{h}", "-r", "30",
             "-i", "-",
             "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
             "-crf", "23", "-movflags", "+faststart", "-y", sortie],
            stdin=subprocess.PIPE,
        )
        encodeurs[seuil] = (encodeur, sortie)

    proc = subprocess.Popen(
        [exe, "-v", "error", "-i", str(chemin), "-map", "0:v:0",
         "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        stdout=subprocess.PIPE,
    )
    assert proc.stdout is not None

    n = 0
    compteur = {s: 0 for s in SEUILS}  # px de contours cumulés (1 frame sur 50)
    echantillons = 0
    while True:
        buf = proc.stdout.read(taille)
        if not buf or len(buf) < taille:
            break
        gris = np.frombuffer(buf, np.uint8).reshape(h, l, 3).mean(axis=2)
        magnitude = magnitude_sobel(gris)
        for seuil, (encodeur, _) in encodeurs.items():
            aretes = magnitude > seuil
            rgb = np.zeros((h, l, 3), np.uint8)
            rgb[aretes] = (255, 255, 255)
            try:
                encodeur.stdin.write(rgb.tobytes())
            except (OSError, ValueError):
                encodeur.stdin.close()
                encodeur.wait()
                raise SystemExit("Échec d'encodage : fermez le lecteur des anciennes vidéos.")
        if n % 50 == 0:
            for s in SEUILS:
                compteur[s] += int((magnitude > s).sum())
            echantillons += 1
        n += 1
    proc.wait()
    for seuil, (encodeur, _) in encodeurs.items():
        encodeur.stdin.close()
        if encodeur.wait() != 0:
            raise SystemExit("Échec de l'encodage.")
    print(f"{n} frames | seuils testés : {SEUILS}")
    if echantillons:
        for s in SEUILS:
            print(f"  seuil {s:.0f} : {compteur[s] // echantillons} px de contours par frame (moyenne, 1 frame sur 50)")
    for seuil, (_, sortie) in encodeurs.items():
        print(f"  vidéo : {sortie}")


if __name__ == "__main__":
    main()
