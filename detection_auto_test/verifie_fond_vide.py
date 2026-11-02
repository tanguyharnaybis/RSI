"""
Nouvelle méthode : FOND VIDE de référence.

La vidéo commence par le décor SEUL (athlète absent). On utilise ces frames
comme image de référence (fond propre, jamais contaminé par l'athlète ni
par son ombre), puis :
1. détection AUTOMATIQUE de la phase vide (frames identiques au début) ;
2. fond = médiane des frames vides ;
3. masque = |frame - fond| > SEUIL_DIFF (l'athlète + son ombre) ;
4. pieds = bas du masque (quantile 2 %, comme le legacy) ;
5. vidéo résultat : corps surligné en rouge translucide, position des
   pieds en vert (ligne + carré) — verification_fond_vide.mp4 ;
6. statistiques : ligne de sol (quantile des positions d'appui),
   croisements, et surtout l'amplitude en VOL : si la position monte
   nettement au-dessus de la ligne de sol pendant les vols, le suivi
   suit enfin le vrai pied.
"""

import re
import subprocess
import sys
from pathlib import Path

import numpy as np
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import imageio_ffmpeg

import detect_frames as d
import pose_pieds as pp

# --------------------- Paramètres ---------------------

VIDEO = "WhatsApp Video 2026-10-28 at 16.27.21.mp4"
SEUIL_DIFF = 60.0        # écart au fond vide = pixel du sujet.
                         # MESURÉ sur cette vidéo : l'ombre portée ne s'écarte
                         # du fond que de 26-30 niveaux, la chaussure de 67-105.
                         # À 60, le masque contient l'athlète SANS son ombre ;
                         # à 25 (ancien réglage) l'ombre polluait le bas du
                         # masque et la ligne restait collée au sol.
SEUIL_VIDE = 3.0         # écart moyen au-dessus = athlète entré dans le champ
MAX_FRAMES_VIDES = 1500  # borne de recherche de la phase vide (~6 s à 234 fps)
QUANTILE_PIED = 0.02     # bas du masque retenu
TAILLE_MIN_MASQUE = 50
POURCENT_SOL = 90.0      # quantile des positions d'appui = ligne de sol
RAYON = 3

# -------------------------------------------------------


def probe(exe: str, chemin: Path) -> dict:
    r = subprocess.run(
        [exe, "-hide_banner", "-i", str(chemin)],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    m = re.search(r"([\d.]+) fps", r.stderr)
    dur = re.search(r"Duration: (\d+):(\d+):([\d.]+)", r.stderr)
    infos = {"fps": float(m.group(1)) if m else 0.0}
    if dur:
        h, mn, s = dur.groups()
        infos["duree"] = int(h) * 3600 + int(mn) * 60 + float(s)
    return infos


def main() -> None:
    chemin = Path(sys.argv[1] if len(sys.argv) > 1 else VIDEO)
    if not chemin.exists():
        raise SystemExit(f"Vidéo introuvable : {chemin}")

    exe = d.ffmpeg_exe()
    infos = probe(exe, chemin)
    fps = infos["fps"]
    print(f"Vidéo : {chemin.name} | {fps:.2f} fps | durée {infos.get('duree', 0):.1f} s")

    # ---------------- Phase 1 : détection de la phase vide + fond ----------------
    proc, l, h = pp.demarrer_decodage_couleur(exe, chemin, d.LARGEUR)
    assert proc.stdout is not None
    taille = l * h * 3
    vides = []
    premiere = None
    n = 0
    while n < MAX_FRAMES_VIDES:
        buf = proc.stdout.read(taille)
        if not buf or len(buf) < taille:
            break
        gris = np.frombuffer(buf, np.uint8).reshape(h, l, 3).mean(axis=2)
        if premiere is None:
            premiere = gris.astype(np.int16)
            vides.append(gris.astype(np.int16))
            n += 1
            continue
        ecart = float(np.abs(gris.astype(np.int16) - premiere).mean())
        if ecart > SEUIL_VIDE:
            break  # l'athlète (ou un changement) entre dans le champ
        vides.append(gris.astype(np.int16))
        n += 1
    # Terminer ce décodage partiel sans erreur de pipe
    try:
        proc.kill()
    except OSError:
        pass
    proc.wait()

    if len(vides) < 3:
        raise SystemExit(
            "Phase vide non détectée au début de la vidéo (moins de 3 frames "
            "sans athlète) — vérifiez que le décor est bien filmé seul au début."
        )
    # Fond = médiane des 300 premières frames vides au plus (suffisant et rapide)
    fond = np.median(np.stack(vides[:300]), axis=0).astype(np.int16)
    frames_vides = len(vides)
    entree = frames_vides if frames_vides < MAX_FRAMES_VIDES else None
    print(
        f"Phase vide : {frames_vides} premières frames "
        f"({frames_vides / fps:.2f} s) — fond = médiane des {min(300, frames_vides)} premières"
        + ("" if entree is not None else " (borne de recherche atteinte : entrée réelle inconnue)")
    )
    # Terminer le décodage sans erreur de pipe
    try:
        proc.kill()
    except OSError:
        pass
    proc.wait()

    # ---------------- Phase 2 : masque + trajectoire + rendu ----------------
    largeur_out = (l * 3 // 2) + (l * 3 // 2) % 2
    hauteur_out = (h * 3 // 2) + (h * 3 // 2) % 2
    sortie = chemin.parent / "verification_fond_vide.mp4"
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

    positions: list[float] = []
    fiables: list[float] = []
    perdus = 0
    n = 0
    proc, l, h = pp.demarrer_decodage_couleur(exe, chemin, d.LARGEUR)
    while True:
        buf = proc.stdout.read(taille)
        if not buf or len(buf) < taille:
            break
        rgb = np.frombuffer(buf, np.uint8).reshape(h, l, 3).astype(np.int16)
        gris = rgb.mean(axis=2)
        masque = np.abs(gris - fond) > SEUIL_DIFF

        if int(masque.sum()) >= TAILLE_MIN_MASQUE:
            lignes = np.nonzero(masque.any(axis=1))[0]
            nb_bas = max(1, int(len(lignes) * QUANTILE_PIED))
            bas = lignes[-nb_bas:]
            pieds_y = int(np.median(bas))
            colonnes = np.nonzero(masque[bas[len(bas) // 2]] | masque[bas[-1]])[0]
            centre_x = int(colonnes.mean()) if len(colonnes) > 0 else l // 2
            positions.append(float(pieds_y))
            fiables.append(1.0)
        else:
            perdus += 1
            positions.append(positions[-1] if positions else float(h))
            fiables.append(0.0)
            pieds_y = None
            centre_x = l // 2

        # Rendu : corps rouge translucide + pieds verts (ligne + carré)
        rouge = np.zeros_like(rgb)
        rouge[:, :, 0] = 255
        rgb[masque] = (0.45 * rouge[masque] + 0.55 * rgb[masque]).astype(np.int16)
        rgb = rgb.astype(np.uint8)

        if pieds_y is not None and 0 <= pieds_y < h:
            couleur = (60, 255, 60)
            rgb[max(0, pieds_y - RAYON): pieds_y + RAYON + 1, l // 4:, :] = couleur
            rgb[
                max(0, pieds_y - 6): pieds_y + 7,
                max(0, centre_x - 8): centre_x + 9,
            ] = couleur

        try:
            encodeur.stdin.write(rgb.tobytes())
        except (OSError, ValueError):
            encodeur.stdin.close()
            encodeur.wait()
            raise SystemExit("Échec d'encodage : fermez le lecteur des anciennes vidéos.")
        n += 1
    proc.wait()
    encodeur.stdin.close()
    if encodeur.wait() != 0:
        raise SystemExit("Échec de l'encodage.")
    print(f"\n{n} frames analysées | {perdus} frame(s) sans sujet détecté")
    print(f"Vidéo résultat : {sortie}")

    # ---------------- Analyse ----------------
    pieds = np.array(positions)
    fiab = np.array(fiables)
    lissee = d.mediane_glissante(pieds, d.FENETRE_LISSAGE)

    # L'athlète ENTRE dans la vidéo : l'analyse commence à sa première frame
    # fiable (la phase vide ne doit polluer ni la ligne de sol ni les bascules).
    fiables_idx = np.nonzero(fiab > 0)[0]
    if len(fiables_idx) == 0:
        raise SystemExit("Aucune frame avec sujet détecté.")
    debut = int(fiables_idx[0])
    if entree is not None and entree < debut:
        debut = entree
    fin = len(lissee)
    fenetre = lissee[debut:fin]
    fiab_fenetre = fiab[debut:fin]
    print(f"\nAnalyse : frames {debut + 1} à {fin} (entrée de l'athlète à {debut / fps:.2f} s)")

    # Ligne de sol : quantile des positions d'appui, sur les frames fiables
    # de la fenêtre uniquement.
    positions_fiables = fenetre[fiab_fenetre > 0]
    sol = float(np.percentile(positions_fiables, POURCENT_SOL))
    amplitude = float(positions_fiables.max() - positions_fiables.min())
    deltas = np.abs(np.diff(fenetre))
    en_vol = fenetre[1:] < sol - 0.1 * amplitude
    bruit = float(np.median(deltas[en_vol])) if en_vol.sum() >= 8 else 1.0
    epsilon = max(2 * bruit, 0.02 * amplitude, 1.0)
    seuil = sol - epsilon

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
    if evenements:
        fusionnes = [evenements[0]]
        for ev in evenements[1:]:
            if ev["frame"] - fusionnes[-1]["frame"] < d.SEGMENT_MIN_FRAMES:
                fusionnes[-1] = ev
            else:
                fusionnes.append(ev)
        evenements = fusionnes

    print(f"\nLigne de sol (quantile {POURCENT_SOL:.0f} %) : {sol:.1f} px | seuil : {seuil:.1f} px")
    print(f"Amplitude de la trajectoire : {amplitude:.0f} px "
          f"(min {positions_fiables.min():.0f}, max {positions_fiables.max():.0f})")
    print(
        "VERDICT VOL : " +
        ("le suivi MONTE avec le pied pendant les vols (écart sol-sommet : "
         f"{sol - positions_fiables.min():.0f} px) — méthode valide en vol"
         if sol - positions_fiables.min() > 0.25 * amplitude
         else "ATTENTION : la position reste proche du sol pendant les vols "
              f"(sommet à {sol - positions_fiables.min():.0f} px du sol) — le suivi colle "
              "encore au sol (ombre ?)")
    )
    print(f"\n{len(evenements)} bascule(s) détectée(s) :")
    for ev in evenements:
        print(f"  frame {ev['frame'] + 1:>6} | {ev['frame'] / fps:7.3f} s | {ev['direction']}")

    # Graphique
    fig, ax = plt.subplots(figsize=(14, 5), dpi=120)
    idx = np.arange(len(lissee))
    ax.plot(idx, pieds, color="#9aa1b5", alpha=0.35, linewidth=0.8, label="position brute")
    ax.plot(idx, lissee, color="#4d9fff", linewidth=1.5, label="position lissée")
    ax.axhline(sol, color="#e6a23c", linewidth=1.2, label="ligne de sol")
    ax.axhline(seuil, color="#e94560", linestyle="--", linewidth=1.2, label="seuil")
    for ev in evenements:
        ax.axvline(ev["frame"], color="#2ecc71", linewidth=1.1, alpha=0.85)
    ax.axvspan(0, len(vides), color="#2ecc71", alpha=0.12)
    ax.invert_yaxis()
    ax.set_xlabel("frame")
    ax.set_ylabel("position verticale des pieds (px)")
    ax.set_title(f"{chemin.name} — fond vide de référence ({len(vides)} frames vides)")
    ax.legend(loc="upper right", fontsize=8)
    fig.tight_layout()
    fig.savefig(chemin.parent / "trajectoire_fond_vide.png")
    print("Graphique : trajectoire_fond_vide.png")


if __name__ == "__main__":
    main()
