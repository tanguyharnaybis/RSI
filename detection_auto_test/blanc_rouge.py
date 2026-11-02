"""
VIDÉO BLANC → ROUGE : ressemblance au fond, SANS la composante de
luminosité (anti-ombre), idée utilisateur.

Pour chaque pixel de chaque frame :
  - la couleur est convertie en CHROMATICITÉ r' = R/(R+G+B), g' = G/(R+G+B)
    (b' = 1 - r' - g') : invariante à la luminosité. Une ombre abaisse
    R, G et B dans les mêmes proportions → la chromaticité du sol ne
    change pas → il reste BLANC ;
  - l'écart de chromaticité au fond (médiane des frames vides) est
    normalisé : 0 (identique) → BLANC, >= SEUIL_ROUGE → ROUGE PUR,
    dégradé continu entre les deux ;
  - les pixels trop sombres (division instable) sont considérés comme
    DIFFÉRENTS (rouge) : le fond de la scène est clair, un pixel très
    sombre est du sujet (chaussure, vêtements).

Sortie : blanc_rouge.mp4 (résolution originale, lecture 30 fps).
"""

import re
import subprocess
import sys
from pathlib import Path

import numpy as np
import imageio_ffmpeg

import detect_frames as d

# --------------------- Paramètres ---------------------

VIDEO = "WhatsApp Video 2026-10-28 at 16.27.21.mp4"
NB_FRAMES_FOND = 30
SEUIL_VIDE = 3.0
SEUIL_SOMME_MIN = 15.0   # R+G+B en dessous : pixel trop sombre → différent
SEUIL_ROUGE = 0.08       # écart de chromaticité → rouge pur (0.08 ≈ 8 %)

# -------------------------------------------------------


def probe(exe: str, chemin: Path) -> float:
    r = subprocess.run(
        [exe, "-hide_banner", "-i", str(chemin)],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    m = re.search(r"([\d.]+) fps", r.stderr)
    return float(m.group(1)) if m else 30.0


def demarrer_decodage_originale(exe: str, chemin: Path, max_frames: int | None = None):
    import io
    from PIL import Image

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


def chromaticite(rgb: np.ndarray):
    f = rgb.astype(np.float32)
    somme = f[:, :, 0] + f[:, :, 1] + f[:, :, 2]
    stable = somme > SEUIL_SOMME_MIN
    sure = np.maximum(somme, 1.0)
    return f[:, :, 0] / sure, f[:, :, 1] / sure, stable


def main() -> None:
    chemin = Path(sys.argv[1] if len(sys.argv) > 1 else VIDEO)
    if not chemin.exists():
        raise SystemExit(f"Vidéo introuvable : {chemin}")

    exe = d.ffmpeg_exe()
    fps = probe(exe, chemin)
    print(f"Vidéo : {chemin.name} | {fps:.2f} fps")

    # ---------------- Fond en chromaticité ----------------
    proc, l, h = demarrer_decodage_originale(exe, chemin, max_frames=400)
    assert proc.stdout is not None
    taille = l * h * 3
    ech_r, ech_g = [], []
    premiere = None
    n = 0
    while n < NB_FRAMES_FOND:
        buf = proc.stdout.read(taille)
        if not buf or len(buf) < taille:
            break
        rgb = np.frombuffer(buf, np.uint8).reshape(h, l, 3)
        gris = rgb.mean(axis=2).astype(np.int16)
        if premiere is None:
            premiere = gris
        elif float(np.abs(gris - premiere).mean()) > SEUIL_VIDE:
            break
        r, g, stable = chromaticite(rgb)
        ech_r.append(np.where(stable, r, np.nan))
        ech_g.append(np.where(stable, g, np.nan))
        n += 1
    try:
        proc.kill()
    except OSError:
        pass
    proc.wait()
    if len(ech_r) < 3:
        raise SystemExit("Phase vide non détectée.")

    fond_r = np.nanmedian(np.stack(ech_r), axis=0)
    fond_g = np.nanmedian(np.stack(ech_g), axis=0)
    fond_b = np.clip(1.0 - fond_r - fond_g, 0.0, 1.0)
    print(f"Fond : chromaticité médiane de {len(ech_r)} frames vides | {l}x{h}")

    # ---------------- Encodage ----------------
    sortie = chemin.parent / "blanc_rouge.mp4"
    encodeur = subprocess.Popen(
        [exe, "-v", "error",
         "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{l}x{h}", "-r", "30",
         "-i", "-",
         "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
         "-crf", "23", "-movflags", "+faststart", "-y", str(sortie)],
        stdin=subprocess.PIPE,
    )
    assert encodeur.stdin is not None

    # ---------------- Passe unique : dégradé blanc → rouge ----------------
    n = 0
    rouge_moyen = 0.0
    echantillons = 0
    proc, l, h = demarrer_decodage_originale(exe, chemin)
    while True:
        buf = proc.stdout.read(taille)
        if not buf or len(buf) < taille:
            break
        rgb = np.frombuffer(buf, np.uint8).reshape(h, l, 3)
        r, g, stable = chromaticite(rgb)
        b = np.clip(1.0 - r - g, 0.0, 1.0)

        with np.errstate(invalid="ignore"):
            diff = np.maximum(
                np.maximum(np.abs(r - fond_r), np.abs(g - fond_g)),
                np.abs(b - fond_b),
            )
        # pixels instables (trop sombres) : considérés différents
        diff = np.where(stable & np.isfinite(fond_r), diff, SEUIL_ROUGE)
        diff = np.nan_to_num(diff, nan=SEUIL_ROUGE)

        # normalisation : 0 = blanc, SEUIL_ROUGE = rouge pur
        intensite = np.clip(diff / SEUIL_ROUGE, 0.0, 1.0)
        sortie_rgb = np.empty((h, l, 3), np.uint8)
        sortie_rgb[:, :, 0] = 255
        non_blanc = (255 * (1.0 - intensite)).astype(np.uint8)
        sortie_rgb[:, :, 1] = non_blanc
        sortie_rgb[:, :, 2] = non_blanc

        try:
            encodeur.stdin.write(sortie_rgb.tobytes())
        except (OSError, ValueError):
            encodeur.stdin.close()
            encodeur.wait()
            raise SystemExit("Échec d'encodage : fermez le lecteur des anciennes vidéos.")

        if n % 50 == 0:
            rouge_moyen += float((intensite > 0.5).mean())
            echantillons += 1
        n += 1
    proc.wait()
    encodeur.stdin.close()
    if encodeur.wait() != 0:
        raise SystemExit("Échec de l'encodage.")
    print(f"\n{n} frames")
    if echantillons:
        print(
            f"Pixels franchement différents (dégradé > 50 %) : "
            f"{rouge_moyen / echantillons * 100:.1f} % de l'image en moyenne"
        )
    print(f"Vidéo résultat : {sortie}")
    print("Rappel : blanc = même chromaticité que le fond (insensible aux ombres) ;")
    print(f"  rouge pur = écart de chromaticité >= {SEUIL_ROUGE:.2f} ; pixels très sombres = rouges")


if __name__ == "__main__":
    main()
