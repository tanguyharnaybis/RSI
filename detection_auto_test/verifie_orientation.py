"""
Vérifie l'orientation et la position du sujet :
1. construit un fond (médiane temporelle sur frames échantillonnées) ;
2. compare des frames au fond et localise les pixels en mouvement ;
3. sauvegarde des PNG pour contrôle visuel.
"""

import io
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image
import imageio_ffmpeg

VIDEO = Path(sys.argv[1] if len(sys.argv) > 1 else "WhatsApp Video 2026-10-27 at 14.29.28.mp4")
LARGEUR = 384
NB_ECHANTILLONS = 40


def decoder(exe: str, video: Path, rotation: str = ""):
    """Retourne (Popen, l, h) — pipe rawvideo gris avec filtre optionnel."""
    vf = f"scale={LARGEUR}:-2,format=gray{(',' + rotation) if rotation else ''}"
    r = subprocess.run(
        [exe, "-v", "error", "-i", str(video), "-map", "0:v:0",
         "-vf", vf, "-frames:v", "1", "-f", "image2", "-c:v", "png", "-"],
        capture_output=True,
    )
    image = Image.open(io.BytesIO(r.stdout))
    l, h = image.size
    proc = subprocess.Popen(
        [exe, "-v", "error", "-i", str(video), "-map", "0:v:0",
         "-vf", vf, "-fps_mode", "passthrough",
         "-f", "rawvideo", "-pix_fmt", "gray", "-"],
        stdout=subprocess.PIPE,
    )
    return proc, l, h


def main() -> None:
    exe = imageio_ffmpeg.get_ffmpeg_exe()
    proc, l, h = decoder(exe, VIDEO)
    assert proc.stdout is not None
    taille = l * h

    # Passe 1 : nb frames + échantillons pour le fond
    echantillons = []
    n = 0
    # pas d'échantillonnage : on découvre le total après coup ; on garde
    # 1 frame sur k avec k adapté a posteriori → deux passes simples :
    # d'abord compter (rapide en lisant tout, on garde aussi des frames)
    toutes_index = []
    frames_gardees = {}
    while True:
        buf = proc.stdout.read(taille)
        if not buf or len(buf) < taille:
            break
        if n % 30 == 0:
            frames_gardees[n] = np.frombuffer(buf, np.uint8).reshape(h, l).copy()
        n += 1
    proc.wait()
    print(f"{n} frames, {len(frames_gardees)} échantillons gardés")

    echantillons = list(frames_gardees.values())
    fond = np.median(np.stack(echantillons), axis=0).astype(np.int16)

    # Passe 2 : mouvement par bande pour quelques frames actives
    index_test = [i for i in [331, 451, 541, 901, 1321] if i < n]
    proc, l, h = decoder(exe, VIDEO)
    assert proc.stdout is not None
    nb_bandes = 10
    bande_h = h // nb_bandes
    k = 0
    resultats = {}
    while True:
        buf = proc.stdout.read(taille)
        if not buf or len(buf) < taille:
            break
        if k in index_test:
            frame = np.frombuffer(buf, np.uint8).reshape(h, l).astype(np.int16)
            diff = np.abs(frame - fond)
            masque = diff > 25
            if masque.any():
                ys, xs = np.nonzero(masque)
                bbox = (int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max()))
            else:
                bbox = None
            profils = [float(masque[b * bande_h:(b + 1) * bande_h, :].mean()) for b in range(nb_bandes)]
            resultats[k] = (bbox, profils)
        k += 1
    proc.wait()

    for idx in index_test:
        if idx in resultats:
            bbox, profils = resultats[idx]
            print(f"\nframe {idx + 1} : bbox mouvement (x0,y0,x1,y1) = {bbox}")
            print("  % de pixels en mouvement par bande (0=haut … 9=bas) :")
            print("   " + " ".join(f"{p * 100:4.1f}" for p in profils))

    # Sauvegardes pour contrôle visuel
    Image.fromarray(fond.astype(np.uint8)).save("fond.png")
    for idx in index_test[:2]:
        if idx in frames_gardees:
            Image.fromarray(frames_gardees[idx]).save(f"frame_{idx + 1:06d}.png")
    print("\nPNG sauvés : fond.png + frames échantillonnées (contrôle visuel)")


if __name__ == "__main__":
    main()
