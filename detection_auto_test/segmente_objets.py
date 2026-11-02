"""
SEGMENTATION EN OBJETS de la silhouette (suite de l'idée utilisateur).

Pipeline :
1. Premier filtre : fond vide (médiane des premières frames, décor seul),
   masque = |frame - fond| > SEUIL_DIFF.   [comme verifie_fond_vide.py]
2. Deuxième filtre : ÉROSION binaire (coupe les ponts fins, ex. le lien
   corps-ombre) puis ÉTIQUETAGE des composantes connexes (scipy) — la
   silhouette rouge est séparée en plusieurs MORCEAUX = objets.
3. SUIVI temporel : chaque objet reçoit un ID STABLE (rapprochement par
   proximité du centroïde entre frames), une couleur et un numéro fixes.
4. Vidéo verification_objets.mp4 : chaque objet teinté de sa couleur,
   numéro affiché à son bas + marqueur de bas (ligne courte).
5. Sauvegarde objets_suivi.json : par frame et par objet, la position du
   BAS (le pied candidat), le centroïde et la taille — pour que
   l'utilisateur désigne ensuite l'objet « pied » et qu'on suive son
   évolution.
"""

import json
import re
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage
import imageio_ffmpeg

import detect_frames as d
import pose_pieds as pp

# --------------------- Paramètres ---------------------

VIDEO = "WhatsApp Video 2026-10-28 at 16.27.21.mp4"
SEUIL_DIFF = 25.0        # premier filtre : écart au fond vide
EROSION_ITER = 1         # érosions binaires avant étiquetage (coupe les ponts)
MIN_TAILLE_OBJET = 150   # composante plus petite ignorée (bruit)
MIN_HAUTEUR_OBJET = 180  # hauteur verticale minimale (px) pour être un OBJET :
                         # l'athlète fait 250-450 px de haut, l'ombre couchée
                         # au sol moins de ~140 px — filtre l'ombre et les
                         # fragments plats, ne garde que des objets stables.
MATCH_DIST = 100.0       # rayon de rapprochement centroïde frame précédente
EXPIRATION = 5           # frames d'absence avant de tuer un objet
SEUIL_VIDE = 3.0
MAX_FRAMES_VIDES = 1500
RAYON = 3

PALETTE = [
    (255, 60, 60),     # rouge (ID 0)
    (60, 160, 255),    # bleu
    (255, 220, 40),    # jaune
    (255, 60, 230),    # magenta
    (60, 255, 120),    # vert
    (255, 140, 40),    # orange
    (200, 130, 255),   # violet clair
    (40, 255, 230),    # cyan
    (255, 120, 120),   # rose
    (170, 200, 60),    # vert olive
]

# -------------------------------------------------------


def probe(exe: str, chemin: Path) -> float:
    r = subprocess.run(
        [exe, "-hide_banner", "-i", str(chemin)],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    m = re.search(r"([\d.]+) fps", r.stderr)
    return float(m.group(1)) if m else 30.0


def main() -> None:
    chemin = Path(sys.argv[1] if len(sys.argv) > 1 else VIDEO)
    if not chemin.exists():
        raise SystemExit(f"Vidéo introuvable : {chemin}")

    exe = d.ffmpeg_exe()
    fps = probe(exe, chemin)
    print(f"Vidéo : {chemin.name} | {fps:.2f} fps")

    # ---------------- Phase 1 : fond vide ----------------
    proc, l, h = pp.demarrer_decodage_couleur(exe, chemin, d.LARGEUR)
    assert proc.stdout is not None
    taille = l * h * 3
    grises = []
    premiere = None
    n = 0
    while n < MAX_FRAMES_VIDES:
        buf = proc.stdout.read(taille)
        if not buf or len(buf) < taille:
            break
        gris = np.frombuffer(buf, np.uint8).reshape(h, l, 3).mean(axis=2).astype(np.int16)
        if premiere is None:
            premiere = gris
        elif float(np.abs(gris - premiere).mean()) > SEUIL_VIDE:
            break
        if n < 300:
            grises.append(gris)
        n += 1
    try:
        proc.kill()
    except OSError:
        pass
    proc.wait()
    frames_vides = n
    if len(grises) < 3:
        raise SystemExit("Phase vide non détectée.")
    fond = np.median(np.stack(grises), axis=0).astype(np.int16)
    print(f"Phase vide : {frames_vides} frames — fond prêt")

    # ---------------- Phase 2 : segmentation + suivi + rendu ----------------
    largeur_out = (l * 3 // 2) + (l * 3 // 2) % 2
    hauteur_out = (h * 3 // 2) + (h * 3 // 2) % 2
    sortie = chemin.parent / "verification_objets_v2.mp4"
    encodeur = subprocess.Popen(
        [exe, "-v", "error",
         "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{l}x{h}", "-r", "30",
         "-i", "-",
         "-vf", f"scale={largeur_out}:{hauteur_out}",
         "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
         "-crf", "23", "-movflags", "+faststart", "-y", str(sortie)],
        stdin=subprocess.PIPE,
    )
    assert encodeur.stdin is not None

    suivis: dict[int, dict] = {}       # id -> état courant
    archives: dict[int, dict] = {}     # id -> statistiques de vie
    prochain_id = 0
    enregistrement: list = []          # données par frame
    structure = ndimage.generate_binary_structure(2, 2)  # connexité 8

    n = 0
    proc, l, h = pp.demarrer_decodage_couleur(exe, chemin, d.LARGEUR)
    while True:
        buf = proc.stdout.read(taille)
        if not buf or len(buf) < taille:
            break
        rgb = np.frombuffer(buf, np.uint8).reshape(h, l, 3)
        gris = rgb.mean(axis=2).astype(np.int16)

        # Deuxième filtre : érosion + étiquetage
        masque = np.abs(gris - fond) > SEUIL_DIFF
        if EROSION_ITER > 0:
            masque = ndimage.binary_erosion(masque, structure, iterations=EROSION_ITER)
        etiquettes, nb = ndimage.label(masque, structure=structure)

        # Composantes retenues : assez grandes ET assez HAUTES (l'ombre,
        # couchée au sol, est plate : exclue par MIN_HAUTEUR_OBJET)
        composantes = []
        if nb > 0:
            slices = ndimage.find_objects(etiquettes)
            for idx in range(1, nb + 1):
                sl = slices[idx - 1]
                if sl is None:
                    continue
                zone = etiquettes[sl] == idx
                taille_obj = int(zone.sum())
                if taille_obj < MIN_TAILLE_OBJET:
                    continue
                ys = np.nonzero(zone.any(axis=1))[0] + sl[0].start
                xs = np.nonzero(zone.any(axis=0))[0] + sl[1].start
                if ys.max() - ys.min() < MIN_HAUTEUR_OBJET:
                    continue
                composantes.append(
                    {
                        "cx": float(xs.mean()),
                        "cy": float(ys.mean()),
                        "bas": int(ys.max()),
                        "x0": int(xs.min()), "x1": int(xs.max()),
                        "taille": taille_obj,
                        "zone": (sl, zone),
                    }
                )
        composantes.sort(key=lambda c: -c["taille"])

        # Zones écartées (ombre, fragments) : fond gris neutre pour le rendu
        retenu = np.zeros_like(masque)
        for comp in composantes:
            sl, zone = comp["zone"]
            retenu[sl][zone] = True
        ecarte = masque & ~retenu

        # Suivi : rapprochement par centroïde
        identifiants = [None] * len(composantes)
        restants = dict(suivis)
        for i, comp in enumerate(composantes):
            meilleur_id, meilleur_d = None, MATCH_DIST
            for oid, etat in restants.items():
                dist = ((comp["cx"] - etat["cx"]) ** 2 + (comp["cy"] - etat["cy"]) ** 2) ** 0.5
                if dist < meilleur_d:
                    meilleur_id, meilleur_d = oid, dist
            if meilleur_id is not None:
                identifiants[i] = meilleur_id
                restants.pop(meilleur_id)
        for i in range(len(composantes)):
            if identifiants[i] is None:
                identifiants[i] = prochain_id
                prochain_id += 1

        # Mise à jour des suivis
        vus = set()
        for comp, oid in zip(composantes, identifiants):
            vus.add(oid)
            if oid not in archives:
                archives[oid] = {
                    "premiere": n, "derniere": n, "frames": 0,
                    "taille_max": 0, "bas_min": h, "bas_max": 0,
                    "bas_somme": 0.0,
                }
            a = archives[oid]
            a["derniere"] = n
            a["frames"] += 1
            a["taille_max"] = max(a["taille_max"], comp["taille"])
            a["bas_min"] = min(a["bas_min"], comp["bas"])
            a["bas_max"] = max(a["bas_max"], comp["bas"])
            a["bas_somme"] += comp["bas"]
            suivis[oid] = {"cx": comp["cx"], "cy": comp["cy"], "manque": 0}
        for oid in list(suivis):
            if oid not in vus:
                suivis[oid]["manque"] += 1
                if suivis[oid]["manque"] > EXPIRATION:
                    del suivis[oid]

        enregistrement.append(
            {
                "frame": n,
                "objets": [
                    [oid, round(comp["cx"], 1), round(comp["cy"], 1), comp["bas"], comp["taille"]]
                    for comp, oid in zip(composantes, identifiants)
                ],
            }
        )

        # ---------------- Rendu ----------------
        rgb16 = rgb.astype(np.int16)
        # zones écartées : gris neutre discret
        gris_fonce = np.zeros((h, l, 3), np.int16)
        gris_fonce[:, :] = (90, 90, 100)
        rgb16[ecarte] = (0.30 * gris_fonce[ecarte] + 0.70 * rgb16[ecarte]).astype(np.int16)
        for comp, oid in zip(composantes, identifiants):
            couleur = PALETTE[oid % len(PALETTE)]
            sl, zone = comp["zone"]
            teinte = np.zeros((zone.shape[0], zone.shape[1], 3), np.int16)
            teinte[:, :] = couleur
            sous = rgb16[sl]
            sous[zone] = (0.45 * teinte[zone] + 0.55 * sous[zone]).astype(np.int16)
            rgb16[sl] = sous
        rgb8 = rgb16.astype(np.uint8)

        # Marqueurs de bas (numpy) puis numéros (PIL, une conversion)
        for comp, oid in zip(composantes, identifiants):
            couleur = PALETTE[oid % len(PALETTE)]
            bas = comp["bas"]
            cx = int(comp["cx"])
            rgb8[
                max(0, bas - RAYON): min(h, bas + RAYON + 1),
                max(0, cx - 30): min(l, cx + 31),
                :,
            ] = couleur
        image = Image.fromarray(rgb8)
        dessin = ImageDraw.Draw(image)
        for comp, oid in zip(composantes, identifiants):
            couleur = PALETTE[oid % len(PALETTE)]
            dessin.text(
                (int(comp["cx"]) - 4, max(0, comp["bas"] - 18)),
                str(oid), fill=couleur,
            )
        rgb8 = np.array(image)

        try:
            encodeur.stdin.write(rgb8.tobytes())
        except (OSError, ValueError):
            encodeur.stdin.close()
            encodeur.wait()
            raise SystemExit("Échec d'encodage : fermez le lecteur des anciennes vidéos.")
        n += 1

    proc.wait()
    encodeur.stdin.close()
    if encodeur.wait() != 0:
        raise SystemExit("Échec de l'encodage.")
    print(f"\n{n} frames | {prochain_id} objets suivis au total")

    # ---------------- Sauvegarde et synthèse ----------------
    with open(chemin.parent / "objets_suivi_v2.json", "w", encoding="utf-8") as f:
        json.dump(enregistrement, f, ensure_ascii=False)
    print("Données : objets_suivi.json (frame → objets [id, cx, cy, bas, taille])")

    longs = [
        (oid, a) for oid, a in archives.items() if a["frames"] >= 60
    ]
    longs.sort(key=lambda pa: -pa[1]["frames"])
    print("\nObjets persistants (> 60 frames) :")
    print(f"{'ID':>4} {'frames':>7} {'taille max':>11} {'bas min':>8} {'bas max':>8} {'bas moyen':>10}")
    for oid, a in longs:
        print(
            f"{oid:>4} {a['frames']:>7} {a['taille_max']:>11} "
            f"{a['bas_min']:>8} {a['bas_max']:>8} {a['bas_somme'] / a['frames']:>10.1f}"
        )
    print(
        "\nRegardez verification_objets.mp4 : chaque objet garde SA couleur et "
        "SON numéro. Le pied cherché est l'objet dont le marqueur de bas descend "
        "au sol aux contacts et remonte pendant les vols."
    )
    print(f"Vidéo résultat : {sortie}")


if __name__ == "__main__":
    main()
