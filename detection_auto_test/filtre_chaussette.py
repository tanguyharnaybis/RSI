"""
FILTRE « CHAUSSETTE » : ne garder que les pixels EXACTEMENT de la couleur
de la chaussette, tout le reste en blanc (idée utilisateur).

1. La couleur de référence est échantillonnée : médiane RGB du masque du
   pied (SAM 2, frame de contact) — affichée en clair pour vérification.
2. Sur chaque frame : pixel gardé si |R-cr| <= T, |G-cg| <= T, |B-cb| <= T
   (tolérance resserrée, « exactement la même couleur ») ; sinon BLANC.
3. Sortie : chaussette_video.mp4 — les pixels de la couleur de la
   chaussette gardent leur couleur, tout le reste est blanc.
"""

import json
import re
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
FRAME_ECHANTILLON = 3983    # frame de contact pour l'échantillon
X_PIED = 166
DECALAGE_Y_PIED = 10
TOLERANCE = 10              # ± par canal — « exactement la même couleur »

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
    print(f"Vidéo : {chemin.name}")

    # ---------------- Échantillon de la couleur de la chaussette ----------------
    donnees_ref = json.load(open("iso_sobel_video.json", encoding="utf-8"))
    y_bas = donnees_ref["reference"][FRAME_ECHANTILLON]

    proc, l, h = demarrer_decodage_originale(exe, chemin, max_frames=FRAME_ECHANTILLON + 2)
    assert proc.stdout is not None
    taille = l * h * 3
    frame_ech = None
    n = 0
    while n <= FRAME_ECHANTILLON:
        buf = proc.stdout.read(taille)
        if not buf or len(buf) < taille:
            break
        if n == FRAME_ECHANTILLON:
            frame_ech = np.frombuffer(buf, np.uint8).reshape(h, l, 3).copy()
        n += 1
    try:
        proc.kill()
    except OSError:
        pass
    proc.wait()
    if frame_ech is None:
        raise SystemExit("Frame d'échantillon non trouvée.")

    print("SAM 2 : masque du pied pour échantillonner la chaussette…")
    from sam2.build_sam import build_sam2
    from sam2.sam2_image_predictor import SAM2ImagePredictor

    modele = build_sam2(CONFIG, CHECKPOINT, device="cpu")
    predicteur = SAM2ImagePredictor(modele)
    predicteur.set_image(frame_ech)
    masques, scores, _ = predicteur.predict(
        point_coords=np.array([[X_PIED, y_bas - DECALAGE_Y_PIED]], dtype=np.float32),
        point_labels=np.array([1]),
        multimask_output=False,
    )
    masque_pied = masques[0] > 0.5
    pixels = frame_ech[masque_pied]
    couleur = np.median(pixels, axis=0)
    cr, cg, cb = [int(c) for c in couleur]
    print(f"Couleur de référence mesurée : RGB ({cr}, {cg}, {cb})")
    print(f"  (tolérance ±{TOLERANCE} par canal — dites-moi la vraie couleur si besoin)")

    # ---------------- Passe unique : filtre ----------------
    sortie = chemin.parent / "chaussette_video.mp4"
    encodeur = subprocess.Popen(
        [exe, "-v", "error",
         "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{l}x{h}", "-r", "30",
         "-i", "-",
         "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
         "-crf", "23", "-movflags", "+faststart", "-y", str(sortie)],
        stdin=subprocess.PIPE,
    )
    assert encodeur.stdin is not None

    n = 0
    gardes_moyens = 0
    echantillons = 0
    proc, l, h = demarrer_decodage_originale(exe, chemin)
    while True:
        buf = proc.stdout.read(taille)
        if not buf or len(buf) < taille:
            break
        rgb = np.frombuffer(buf, np.uint8).reshape(h, l, 3)

        garde = (
            (np.abs(rgb[:, :, 0].astype(np.int16) - cr) <= TOLERANCE)
            & (np.abs(rgb[:, :, 1].astype(np.int16) - cg) <= TOLERANCE)
            & (np.abs(rgb[:, :, 2].astype(np.int16) - cb) <= TOLERANCE)
        )
        resultat = np.full_like(rgb, 255)      # tout blanc
        resultat[garde] = rgb[garde]           # pixels chaussette gardés

        try:
            encodeur.stdin.write(resultat.tobytes())
        except (OSError, ValueError):
            encodeur.stdin.close()
            encodeur.wait()
            raise SystemExit("Échec d'encodage : fermez le lecteur des anciennes vidéos.")

        if n % 50 == 0:
            gardes_moyens += int(garde.sum())
            echantillons += 1
        n += 1
    proc.wait()
    encodeur.stdin.close()
    if encodeur.wait() != 0:
        raise SystemExit("Échec de l'encodage.")
    print(f"\n{n} frames")
    if echantillons:
        print(f"Pixels gardés : {gardes_moyens // echantillons} par frame en moyenne (1 frame sur 50)")
    print(f"Vidéo résultat : {sortie}")


if __name__ == "__main__":
    main()
