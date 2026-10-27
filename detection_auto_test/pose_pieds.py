"""
Détection du pied par pose estimation — MediaPipe Pose (tasks API, modèle
local déjà utilisé par la PWA : public/mediapipe/pose_landmarker_full.task).

Remplace UNIQUEMENT l'étape « masque + quantile » de detect_frames.py.
Tout l'aval du pipeline (série temporelle, ligne de sol, epsilon, croisements,
graphique, JSON) est inchangé.

CONTRAT DE SORTIE (identique à l'ancienne méthode, pour compatibilité
descendante) :
    pieds_y   : np.ndarray float (N,) — position verticale du pied en
                PIXELS du décodage largeur=LARGEUR (y vers le bas, repère image)
    fiabilite : np.ndarray (N,) — 1.0 = suivi fiable, 0.0 = interpolé
Points clés extraits (par pied) : cheville 27/28, talon 29/30, pointe 31/32,
avec leur score de confiance (visibility).

- Point suivi configurable : POINT (pointe|talon|cheville) × PIED
  (moyenne|gauche|droite).
- Frames avec confiance < SEUIL_CONFIANCE : ignorées puis interpolées
  linéairement entre les frames fiables voisines.
- Cache .npz local (la pose est lente ; les comparaisons relancent souvent).
"""

import os

# Réduire le bruit de logs de MediaPipe/absl (avant l'import)
os.environ.setdefault("GLOG_minloglevel", "3")

import subprocess
from pathlib import Path

import numpy as np
import imageio_ffmpeg

import mediapipe as mp
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision

# Modèle local (celui de la PWA) — résolu depuis ce fichier, quel que soit le CWD
MODELE = Path(__file__).resolve().parent.parent / "public" / "mediapipe" / "pose_landmarker_full.task"

# Landmarks MediaPipe Pose (indices)
CHEVILLE = {"gauche": 27, "droite": 28}
TALON = {"gauche": 29, "droite": 30}
POINTE = {"gauche": 31, "droite": 32}
POINTS = {"pointe": POINTE, "talon": TALON, "cheville": CHEVILLE}
# Les 6 keypoints du pied (chevilles, talons, pointes), pour le rendu de contrôle
KEYPOINTS_PIED = [27, 28, 29, 30, 31, 32]

# --------------------------- Configuration ---------------------------

POINT = "pointe"       # point suivi : pointe | talon | cheville
PIED = "moyenne"       # pied suivi : moyenne (pondérée par la confiance) | gauche | droite
SEUIL_CONFIANCE = 0.5  # en dessous : frame ignorée puis interpolée

# ----------------------------------------------------------------------


def ffmpeg_exe() -> str:
    return imageio_ffmpeg.get_ffmpeg_exe()


def demarrer_decodage_couleur(exe: str, chemin: Path, largeur: int):
    """Pipe rawvideo RGB24, largeur `largeur` (même échelle que le décodage
    gris de detect_frames.py → même hauteur). 1 frame PNG pour les dimensions."""
    import io
    from PIL import Image

    r = subprocess.run(
        [exe, "-v", "error", "-i", str(chemin), "-map", "0:v:0",
         "-vf", f"scale={largeur}:-2", "-frames:v", "1",
         "-f", "image2", "-c:v", "png", "-"],
        capture_output=True,
    )
    image = Image.open(io.BytesIO(r.stdout))
    l, h = image.size
    image.close()
    proc = subprocess.Popen(
        [exe, "-v", "error", "-i", str(chemin), "-map", "0:v:0",
         "-vf", f"scale={largeur}:-2",
         "-fps_mode", "passthrough",
         "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        stdout=subprocess.PIPE,
    )
    return proc, l, h


def chemin_cache(chemin_video: Path, largeur: int, point: str, pied: str, seuil: float) -> Path:
    nom = f"cache_pose_{chemin_video.stem}_{largeur}_{point}_{pied}_{int(seuil * 100)}.npz"
    return chemin_video.parent / nom


def _position_pied(landmarks, point: str, pied: str) -> tuple[float, float]:
    """Retourne (y_normalisé, confiance) du point/pied demandés.
    'moyenne' : moyenne des deux pieds pondérée par la confiance."""
    table = POINTS[point]
    if pied == "moyenne":
        gauche = landmarks[table["gauche"]]
        droite = landmarks[table["droite"]]
        vg, vd = gauche.visibility, droite.visibility
        if vg + vd < 0.1:
            return float("nan"), 0.0
        y = (gauche.y * vg + droite.y * vd) / (vg + vd)
        return y, min(vg, vd)
    seul = landmarks[table[pied]]
    return seul.y, seul.visibility


def trajectoire_pieds_pose(
    exe: str,
    chemin: Path,
    largeur: int,
    point: str = POINT,
    pied: str = PIED,
    seuil: float = SEUIL_CONFIANCE,
    progress=None,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, int]:
    """
    Trajectoire du pied par MediaPipe Pose.
    Retourne (pieds_y, fiabilite, keypoints, h) :
      pieds_y   — (N,) positions en PIXELS du décodage largeur `largeur`
      fiabilite — (N,) 1.0 fiable / 0.0 interpolé
      keypoints — (N, 6, 3) chevilles/talons/pointes (x, y normalisés + confiance)
      h         — hauteur du décodage
    """
    cache = chemin_cache(chemin, largeur, point, pied, seuil)
    if cache.exists():
        donnees = np.load(cache, allow_pickle=True)
        if (
            str(donnees["largeur"]) == str(largeur)
            and str(donnees["point"]) == str(point)
            and str(donnees["pied"]) == str(pied)
        ):
            print(f"Pose : cache réutilisé ({cache.name})")
            return (
                donnees["pieds_y"].astype(np.float64),
                donnees["fiabilite"].astype(np.float64),
                donnees["keypoints"],
                int(donnees["h"]),
            )

    if not MODELE.exists():
        raise FileNotFoundError(f"Modèle introuvable : {MODELE}")

    proc, l, h = demarrer_decodage_couleur(exe, chemin, largeur)
    assert proc.stdout is not None
    taille = l * h * 3

    base = mp_python.BaseOptions(model_asset_path=str(MODELE))
    options = vision.PoseLandmarkerOptions(
        base_options=base,
        running_mode=vision.RunningMode.VIDEO,
        num_poses=1,
    )
    landmarker = vision.PoseLandmarker.create_from_options(options)

    ys: list[float] = []
    fiabilites: list[float] = []
    keypoints: list[list[list[float]]] = []
    n = 0
    try:
        while True:
            assert proc.stdout is not None
            buf = proc.stdout.read(taille)
            if not buf or len(buf) < taille:
                break
            rgb = np.frombuffer(buf, np.uint8).reshape(h, l, 3)
            image_mp = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
            result = landmarker.detect_for_video(image_mp, n)

            poses = result.pose_landmarks
            if poses and len(poses[0]) >= 33:
                lms = poses[0]
                y_norm, confiance = _position_pied(lms, point, pied)
                cadres = [
                    [lms[i].x, lms[i].y, lms[i].visibility] for i in KEYPOINTS_PIED
                ]
            else:
                y_norm, confiance = float("nan"), 0.0
                cadres = [[float("nan")] * 3] * 6

            if not np.isfinite(y_norm) or confiance < seuil:
                ys.append(float("nan"))
                fiabilites.append(0.0)
            else:
                ys.append(float(y_norm * h))
                fiabilites.append(1.0)
            keypoints.append(cadres)
            n += 1
            if progress and n % 50 == 0:
                progress(n)
    finally:
        landmarker.close()
        proc.wait()

    if n == 0:
        raise RuntimeError("Aucune frame décodée pour la pose.")

    pieds_y = np.array(ys, dtype=np.float64)
    fiabilite = np.array(fiabilites, dtype=np.float64)

    # Frames peu fiables → interpolation linéaire entre frames fiables
    fiables = np.nonzero(fiabilite > 0)[0]
    if len(fiables) >= 2:
        mauvaises = np.nonzero(fiabilite == 0)[0]
        if len(mauvaises) > 0:
            pieds_y[mauvaises] = np.interp(mauvaises, fiables, pieds_y[fiables])
    elif len(fiables) == 1:
        pieds_y[:] = pieds_y[fiables[0]]

    np.savez(
        cache,
        pieds_y=pieds_y,
        fiabilite=fiabilite,
        keypoints=np.array(keypoints, dtype=np.float64),
        h=h,
        largeur=largeur,
        point=point,
        pied=pied,
    )
    return pieds_y, fiabilite, np.array(keypoints, dtype=np.float64), h


if __name__ == "__main__":
    # Test rapide sur la vidéo par défaut (avec progression)
    import sys
    import time

    chemin = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("WhatsApp Video 2026-10-27 at 14.29.28.mp4")
    debut = time.time()

    def progression(n: int) -> None:
        ecoule = time.time() - debut
        print(f"  {n} frames posées ({ecoule:.0f} s)", flush=True)

    y, fiab, kpts, h = trajectoire_pieds_pose(
        ffmpeg_exe(), chemin, 384, progress=progression
    )
    fiables = int((fiab > 0).sum())
    print(f"\n{len(y)} frames, hauteur décodage {h}, {fiables} frames fiables")
    print(f"position médiane : {np.median(y):.1f} px | min {np.nanmin(y):.1f} | max {np.nanmax(y):.1f}")
