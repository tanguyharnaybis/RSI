"""
Exploration du signal vidéo : où se concentre le mouvement ?
Calcule, pour 10 bandes horizontales, l'énergie de mouvement moyenne,
et affiche la chronologie de l'énergie par bande basse.
"""

import io
import subprocess
import sys
from pathlib import Path

import numpy as np
import imageio_ffmpeg

VIDEO = Path(sys.argv[1] if len(sys.argv) > 1 else "WhatsApp Video 2026-10-27 at 14.29.28.mp4")
LARGEUR = 384


def main() -> None:
    exe = imageio_ffmpeg.get_ffmpeg_exe()
    # 1 frame pour les dimensions
    r = subprocess.run(
        [exe, "-v", "error", "-i", str(VIDEO), "-map", "0:v:0",
         "-vf", f"scale={LARGEUR}:-2,format=gray",
         "-frames:v", "1", "-f", "image2", "-c:v", "png", "-"],
        capture_output=True,
    )
    image = Image.open(io.BytesIO(r.stdout)) if False else None
    from PIL import Image
    image = Image.open(io.BytesIO(r.stdout))
    l, h = image.size
    print(f"dimensions décodées : {l}x{h}")

    proc = subprocess.Popen(
        [exe, "-v", "error", "-i", str(VIDEO), "-map", "0:v:0",
         "-vf", f"scale={LARGEUR}:-2,format=gray",
         "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "gray", "-"],
        stdout=subprocess.PIPE,
    )
    assert proc.stdout is not None
    taille = l * h

    nb_bandes = 10
    bande_h = h // nb_bandes
    energies_bandes = [[] for _ in range(nb_bandes)]
    precedentes = [None] * nb_bandes
    n = 0
    while True:
        buf = proc.stdout.read(taille)
        if not buf or len(buf) < taille:
            break
        frame = np.frombuffer(buf, np.uint8).reshape(h, l).astype(np.int16)
        for b in range(nb_bandes):
            bande = frame[b * bande_h:(b + 1) * bande_h, :]
            if precedentes[b] is not None:
                e = float(np.abs(bande - precedentes[b]).mean())
                energies_bandes[b].append(e)
            else:
                energies_bandes[b].append(0.0)
            precedentes[b] = bande
        n += 1
    proc.wait()
    print(f"{n} frames")

    print("\nÉnergie moyenne par bande horizontale (0 = HAUT de l'image, 9 = BAS) :")
    for b in range(nb_bandes):
        arr = np.array(energies_bandes[b])
        print(
            f"  bande {b} (y {b * bande_h:>4}-{(b + 1) * bande_h:>4}) : "
            f"moyenne {arr.mean():6.2f} | médiane {np.median(arr):6.2f} | "
            f"max {arr.max():6.2f} | p95 {np.percentile(arr, 95):6.2f}"
        )

    # Chronologie : énergie de chaque bande, échantillonnée toutes les 30 frames
    print("\nChronologie (colonnes = bandes 0..9, lignes = frame tous les 30) :")
    arrs = [np.array(e) for e in energies_bandes]
    for i in range(0, n, 30):
        ligne = " ".join(f"{arr[i]:4.0f}" for arr in arrs)
        print(f"  f{i + 1:>5}: {ligne}")


if __name__ == "__main__":
    main()
