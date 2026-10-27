"""
Labo de détection — ÉTAPE 1 (méthode révisée) : frames importantes,
sans classification atterrissage/décollage.

MÉTHODE : suivi du bas du corps par soustraction de fond
-------------------------------------------------------
L'exploration (explore_energie.py / verifie_orientation.py) a montré que
la bande basse de l'image est le SOL STATIQUE : pendant les vols les pieds
la quittent, l'énergie de mouvement n'y dit rien. On suit donc directement
la trajectoire verticale des pieds :

1. Décodage fidèle : pipe ffmpeg rawvideo gris, largeur 384,
   -fps_mode passthrough (chaque frame décodée sort exactement une fois).
2. Fond : médiane temporelle sur ~64 frames échantillonnées (caméra fixe).
3. Pour chaque frame : masque de mouvement = |frame - fond| > SEUIL_DIFF ;
   position des pieds = ligne médiane du BAS du masque (quantile 2 %),
   robuste aux pixels de bruit isolés.
4. Lissage par médiane glissante.
5. Ligne de sol = quantile POURCENT_SOL des positions pieds (appuis).
   Epsilon adaptatif : 2 x le bruit médian pendant les vols, avec plancher.
6. FRAMES IMPORTANTES = croisements du seuil (sol - epsilon), notés avec la
   DIRECTION du croisement (descente / montée) comme simple diagnostic —
   aucune étiquette atterrissage/décollage à cette étape.

TEMPS RÉEL : la vidéo se lit à FPS_LECTURE (30) mais correspond à un
ralenti : capture à FPS_ENREGISTREMENT (120). t réel = frame / 120.

SORTIES : evenements.json, trajectoire.png, vignettes/.
"""

import io
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
import imageio_ffmpeg

# ============================ Paramètres ============================

VIDEO_DEFAUT = "WhatsApp Video 2026-10-27 at 14.29.28.mp4"

FPS_LECTURE = 0.0            # 0 = détecté depuis le conteneur (30 attendu)
FPS_ENREGISTREMENT = 120.0   # fps de capture réels (ralenti x4 à 30 fps)
FRAME_DEBUT = 0              # 0 = début de la vidéo
FRAME_FIN = 0                # 0 = fin de la vidéo ; sinon ignore tout
                             # au-delà (ex. le sujet allant éteindre l'enregistrement)
LARGEUR = 384                # largeur de décodage (px)
SEUIL_DIFF = 25              # écart au fond (niveaux de gris) = pixel du sujet
QUANTILE_PIED = 0.02         # bas du masque retenu (2 % les plus bas, médiane)
FENETRE_LISSAGE = 5          # médiane glissante sur la trajectoire
POURCENT_SOL = 0.85          # quantile des positions pieds = ligne de sol
SEGMENT_MIN_FRAMES = 4       # durée minimale d'un régime (frames de lecture)
VIGNETTE_DEMI = 2            # frames de part et d'autre pour les vignettes
NB_ECHANTILLONS_FOND = 64    # frames échantillonnées pour la médiane du fond

# ====================================================================


def ffmpeg_exe() -> str:
    return imageio_ffmpeg.get_ffmpeg_exe()


def demarrer_decodage(exe: str, chemin: Path, largeur: int):
    """Pipe rawvideo gris, passthrough, + dimensions décodées (1 frame PNG)."""
    vf = f"scale={largeur}:-2,format=gray"
    r = subprocess.run(
        [exe, "-v", "error", "-i", str(chemin), "-map", "0:v:0",
         "-vf", vf, "-frames:v", "1", "-f", "image2", "-c:v", "png", "-"],
        capture_output=True,
    )
    image = Image.open(io.BytesIO(r.stdout))
    l, h = image.size
    proc = subprocess.Popen(
        [exe, "-v", "error", "-i", str(chemin), "-map", "0:v:0",
         "-vf", vf, "-fps_mode", "passthrough",
         "-f", "rawvideo", "-pix_fmt", "gray", "-"],
        stdout=subprocess.PIPE,
    )
    return proc, l, h


def lire_frame(proc, taille: int) -> np.ndarray | None:
    assert proc.stdout is not None
    buf = proc.stdout.read(taille)
    if not buf or len(buf) < taille:
        return None
    return np.frombuffer(buf, np.uint8)


def probe_video(exe: str, chemin: Path) -> dict:
    r = subprocess.run(
        [exe, "-hide_banner", "-i", str(chemin)],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    fps_match = re.search(r"([\d.]+) fps", r.stderr)
    return {"fps_lecture": float(fps_match.group(1)) if fps_match else 0.0}


def mediane_glissante(x: np.ndarray, fenetre: int) -> np.ndarray:
    if fenetre <= 1:
        return x.copy()
    demi = fenetre // 2
    sortie = np.empty_like(x)
    for i in range(len(x)):
        sortie[i] = np.median(x[max(0, i - demi): i + demi + 1])
    return sortie


def construire_fond(exe: str, chemin: Path, largeur: int) -> tuple[np.ndarray, int, int, int]:
    """Passe 1 : compte les frames et construit le fond (médiane échantillonnée)."""
    proc, l, h = demarrer_decodage(exe, chemin, largeur)
    taille = l * h
    total = 0
    while lire_frame(proc, taille) is not None:
        total += 1
    proc.wait()
    if total == 0:
        raise RuntimeError("Aucune frame décodée.")

    pas = max(1, total // NB_ECHANTILLONS_FOND)
    proc, l, h = demarrer_decodage(exe, chemin, largeur)
    echantillons = []
    n = 0
    while True:
        frame = lire_frame(proc, taille)
        if frame is None:
            break
        if n % pas == 0:
            echantillons.append(frame.reshape(h, l))
        n += 1
    proc.wait()
    fond = np.median(np.stack(echantillons), axis=0)
    return fond.astype(np.int16), l, h, total


def trajectoire_pieds(
    exe: str, chemin: Path, largeur: int, fond: np.ndarray, l: int, h: int
) -> tuple[np.ndarray, np.ndarray]:
    """Passe 2 : position verticale des pieds à chaque frame.
    Retourne (pieds_y, fiabilite) — fiabilite = fraction de pixels du masque
    dans le bas (qualité du suivi)."""
    proc, _, _ = demarrer_decodage(exe, chemin, largeur)
    taille = l * h
    pieds = np.zeros(0, dtype=np.float64)
    liste: list[float] = []
    fiabilite: list[float] = []
    n = 0
    while True:
        frame = lire_frame(proc, taille)
        if frame is None:
            break
        f = frame.reshape(h, l).astype(np.int16)
        masque = np.abs(f - fond) > SEUIL_DIFF
        if masque.sum() < 50:
            # sujet perdu → maintenir la dernière position
            liste.append(liste[-1] if liste else float(h))
            fiabilite.append(0.0)
        else:
            lignes = np.nonzero(masque.any(axis=1))[0]
            # bas du masque : les QUANTILE_PIED % lignes les plus basses
            nb_bas = max(1, int(len(lignes) * QUANTILE_PIED))
            bas = lignes[-nb_bas:]
            liste.append(float(np.median(bas)))
            fiabilite.append(1.0)
        n += 1
    proc.wait()
    return np.array(liste), np.array(fiabilite)


def main() -> None:
    chemin = Path(sys.argv[1] if len(sys.argv) > 1 else VIDEO_DEFAUT)
    if not chemin.exists():
        raise SystemExit(f"Vidéo introuvable : {chemin}")

    exe = ffmpeg_exe()
    infos = probe_video(exe, chemin)
    fps_lecture = FPS_LECTURE if FPS_LECTURE > 0 else infos["fps_lecture"]
    facteur = FPS_ENREGISTREMENT / fps_lecture
    print(f"Vidéo : {chemin.name} | lecture {fps_lecture} fps | réel {FPS_ENREGISTREMENT:.0f} fps (x{facteur:.2f})")

    print("Passe 1 : comptage + fond (médiane échantillonnée)…")
    fond, l, h, total = construire_fond(exe, chemin, LARGEUR)
    print(f"{total} frames, décodage {l}x{h}")

    print("Passe 2 : trajectoire des pieds (soustraction de fond)…")
    pieds_y, fiabilite = trajectoire_pieds(exe, chemin, LARGEUR, fond, l, h)
    perdus = int((fiabilite == 0).sum())
    if perdus > 0:
        print(f"ATTENTION : {perdus} frame(s) sans sujet détecté (position maintenue)")

    lissee = mediane_glissante(pieds_y, FENETRE_LISSAGE)

    # Fenêtre d'analyse (ignore ex. le sujet allant éteindre l'enregistrement)
    debut = min(FRAME_DEBUT, total - 2) if FRAME_DEBUT > 0 else 0
    fin = FRAME_FIN if 0 < FRAME_FIN < total else total
    if fin - debut < 8:
        raise SystemExit("Fenêtre d'analyse trop courte (réglez FRAME_DEBUT/FRAME_FIN).")
    fenetre = lissee[debut:fin]
    if debut > 0 or fin < total:
        print(f"Fenêtre d'analyse : frames {debut + 1} à {fin} (hors fenêtre ignoré)")

    # Ligne de sol : quantile des positions pieds (appuis = y les plus grands)
    sol = float(np.percentile(fenetre, POURCENT_SOL * 100))

    # Epsilon adaptatif : bruit médian des variations PENDANT les vols
    # (frames nettement au-dessus du sol), x2, avec plancher relatif à
    # l'amplitude du mouvement.
    amplitude = float(fenetre.max() - fenetre.min())
    deltas = np.abs(np.diff(fenetre))
    en_vol = fenetre[1:] < sol - 0.1 * amplitude
    bruit = float(np.median(deltas[en_vol])) if en_vol.sum() >= 8 else 1.0
    epsilon = max(2 * bruit, 0.02 * amplitude, 1.0)
    seuil = sol - epsilon

    print(f"Ligne de sol : {sol:.0f} px | epsilon : {epsilon:.1f} px | seuil : {seuil:.0f} px")

    # Frames importantes : croisements du seuil (sans classification)
    seuils = fenetre >= seuil
    evenements = []
    precedent = seuils[0]
    for i in range(1, len(seuils)):
        if seuils[i] != precedent:
            evenements.append(
                {
                    "frame": debut + i,
                    "direction": "descente (vers le sol)" if seuils[i] else "montée (quitte le sol)",
                }
            )
            precedent = seuils[i]

    # Fusion des régimes trop courts (micro-croisements)
    if evenements:
        fusionnes = [evenements[0]]
        for ev in evenements[1:]:
            if ev["frame"] - fusionnes[-1]["frame"] < SEGMENT_MIN_FRAMES:
                # trop proche du précédent : on garde le dernier croisement
                fusionnes[-1] = ev
            else:
                fusionnes.append(ev)
        evenements = fusionnes

    temps_reel = np.arange(total) / FPS_ENREGISTREMENT
    print(f"\n{len(evenements)} frame(s) importante(s) :")
    for ev in evenements:
        print(
            f"  frame {ev['frame'] + 1:>6} | {temps_reel[ev['frame']]:8.3f} s réel | {ev['direction']}"
        )

    # ---------------- Sorties ----------------
    rapport = {
        "fichier": chemin.name,
        "fps_lecture": fps_lecture,
        "fps_enregistrement": FPS_ENREGISTREMENT,
        "facteur_ralenti": round(facteur, 4),
        "nb_frames": total,
        "methode": "soustraction de fond, bas du masque (quantile 2 %)",
        "parametres": {
            "seuil_diff": SEUIL_DIFF,
            "quantile_pied": QUANTILE_PIED,
            "fenetre_lissage": FENETRE_LISSAGE,
            "pourcent_sol": POURCENT_SOL,
            "segment_min_frames": SEGMENT_MIN_FRAMES,
            "frame_debut": debut,
            "frame_fin": fin,
        },
        "sol_px": round(sol, 1),
        "epsilon_px": round(epsilon, 2),
        "seuil_px": round(seuil, 1),
        "amplitude_px": round(amplitude, 1),
        "frames_sujet_perdu": perdus,
        "evenements": [
            {
                "frame": ev["frame"],
                "temps_reel_s": round(float(temps_reel[ev["frame"]]), 4),
                "direction_croisement": ev["direction"],
                "pieds_y_px": round(float(lissee[ev["frame"]]), 1),
            }
            for ev in evenements
        ],
    }
    sortie_json = chemin.parent / "evenements.json"
    sortie_json.write_text(json.dumps(rapport, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\nRapport : {sortie_json}")

    # Graphique
    fig, ax = plt.subplots(figsize=(14, 5), dpi=120)
    idx = np.arange(total)
    ax.plot(idx, pieds_y, color="#9aa1b5", alpha=0.35, linewidth=0.8, label="position brute")
    ax.plot(idx, lissee, color="#4d9fff", linewidth=1.5, label="position lissée")
    ax.axhline(sol, color="#e6a23c", linestyle="-", linewidth=1.2, label="ligne de sol")
    ax.axhline(seuil, color="#e94560", linestyle="--", linewidth=1.2, label="seuil (sol - epsilon)")
    for ev in evenements:
        ax.axvline(ev["frame"], color="#2ecc71", linewidth=1.2, alpha=0.9)
        ax.annotate(
            str(ev["frame"] + 1),
            (ev["frame"], lissee[ev["frame"]]),
            textcoords="offset points", xytext=(0, 12),
            ha="center", fontsize=7, color="#2ecc71",
        )
    ax.invert_yaxis()  # repère image : y vers le bas
    if debut > 0:
        ax.axvspan(0, debut, color="#333333", alpha=0.35)
    if fin < total:
        ax.axvspan(fin, total, color="#333333", alpha=0.35)
    ax.set_xlabel("frame")
    ax.set_ylabel("position verticale des pieds (px)")
    ax.set_title(
        f"{chemin.name} — {total} frames, lecture {fps_lecture} fps, "
        f"enregistrement {FPS_ENREGISTREMENT:.0f} fps (ralenti x{facteur:.2f})"
    )
    ax.legend(loc="upper right", fontsize=8)
    fig.tight_layout()
    fig.savefig(chemin.parent / "trajectoire.png")
    print("Graphique : trajectoire.png")

    # Vignettes
    dossier_v = chemin.parent / "vignettes"
    dossier_v.mkdir(exist_ok=True)
    for ancien in dossier_v.glob("*.jpg"):
        ancien.unlink()
    voulues = set()
    for ev in evenements:
        for k in range(-VIGNETTE_DEMI, VIGNETTE_DEMI + 1):
            if ev["frame"] + k >= 0:
                voulues.add(ev["frame"] + k)
    proc, _, _ = demarrer_decodage(exe, chemin, LARGEUR)
    taille = l * h
    tampon = {}
    n = 0
    while True:
        frame = lire_frame(proc, taille)
        if frame is None:
            break
        if n in voulues:
            tampon[n] = frame.reshape(h, l).copy()
        n += 1
    proc.wait()

    for ev in evenements:
        f = ev["frame"]
        morceaux = []
        for k in range(-VIGNETTE_DEMI, VIGNETTE_DEMI + 1):
            morceaux.append((f + k, tampon.get(f + k, np.zeros((h, l), np.uint8))))
        largeur_bande = l * len(morceaux) + 2 * (len(morceaux) - 1)
        bande_img = Image.new("L", (largeur_bande, h), 32).convert("RGB")
        dessin = ImageDraw.Draw(bande_img)
        x = 0
        for num, arr in morceaux:
            bande_img.paste(Image.fromarray(arr), (x, 0))
            couleur = (255, 80, 80) if num == f else (150, 150, 150)
            dessin.text((x + 4, h - 14), f"#{num + 1}", fill=couleur)
            x += l + 2
        bande_img.save(dossier_v / f"frame_{f + 1:06d}.jpg", quality=85)
    print(f"Vignettes : vignettes/ ({len(evenements)} bandes de {2 * VIGNETTE_DEMI + 1} frames)")


if __name__ == "__main__":
    main()
