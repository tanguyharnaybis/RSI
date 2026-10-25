# Extraction de frames — méthode fiable (ffmpeg/ffprobe)

Outil : `scripts/extract-frames.mjs` (Node.js). Test automatisé des critères
d'acceptation : `npm run frames:test`.

## Pourquoi les vidéos slow-mo iPhone posent problème

- Un slow-mo iPhone **n'est pas une vidéo ralentie** : c'est un flux à 120 ou
  240 fps, ralenti uniquement à la lecture/édition (métadonnées
  `com.apple.quicktime.slo-mo` — ignorées ici, elles ne servent pas au
  décodage). Ne jamais déduire la cadence depuis la durée apparente.
- Les fichiers iPhone sont majoritairement **VFR** (fréquence variable) : la
  cadence varie au fil du fichier, une même clip peut mélanger des segments
  240 fps et 30 fps.
- La cause classique des bugs : **forcer une cadence constante** (`-r`,
  `vsync cfr`, `fps=30`, `frames = durée × fps`) sur un flux VFR → frames
  dupliquées ou supprimées. Interdit ici, et aucun calcul de ce type n'existe
  dans le code.

## Méthode

### 1. Analyse — comptage réel, zéro estimation

```
ffprobe -v error -count_frames -select_streams v:0 \
  -show_entries stream=nb_read_frames,r_frame_rate,avg_frame_rate,codec_name,pix_fmt,width,height \
  -of json VIDEO
```

- `nb_read_frames` : comptage réel par décodage — **référence absolue**, fiable en VFR.
- `r_frame_rate` / `avg_frame_rate` : **indicatifs** en VFR — affichés dans le
  rapport mais jamais utilisés pour calculer un nombre de frames ou une durée.

### 2. Extraction — fidèle, sans duplication ni suppression

```
ffmpeg -xerror -i VIDEO -map 0:v:0 -vf showinfo \
  -fps_mode passthrough -frame_pts 1 frames/frame_%06d.png
```

- `-fps_mode passthrough` (`-vsync passthrough` sur ffmpeg < 6) : chaque frame
  décodée sort **exactement une fois**, avec ses timestamps d'origine.
- `-frame_pts 1` : les fichiers sont nommés d'après le pts (timestamp) de la
  frame — les noms ne sont donc pas une re-numérotation séquentielle, et les
  trous dans la numérotation sont normaux en VFR. L'ordre croissant des pts
  correspond à l'ordre de décodage.
- `-vf showinfo` : chaque frame logge son `pts` et son `pts_time` (index de
  corrélation frame ↔ temps exact).
- Format **PNG** (sans perte), jamais JPEG.
- Sur ffmpeg ≥ 6 l'option s'écrit `-frame_pts` (tiret bas) : le brief initial
  indiquait `-frame-pts`, le nom réel dans le muxer image2 est `-frame_pts`.

### 3. Validation obligatoire — échouer bruyamment plutôt que livrer faux

1. `count(PNG extraits) == nb_read_frames` — sinon erreur explicite avec les
   deux nombres (décodage ayant dupliqué/perdu des frames).
2. `-xerror` + analyse du stderr (`Invalid data`, `corrupt`, `error while
   decoding`…) : toute erreur de décodage est un **échec**, pas un avertissement.
3. L'index `showinfo` doit couvrir chaque frame exactement une fois, avec des
   pts uniques.
4. Échantillon de PNG ouverts et vérifiés (en-tête IHDR) : dimensions
   cohérentes avec `width`/`height` du flux.

### 4. Déterminisme

`--verify-determinism` : deux exécutions complètes sur le même fichier ;
tous les PNG doivent être **md5-identiques** (décodage déterministe).

### 5. Couleur (fidelité)

Les sources sont YUV 4:2:0 ; la conversion YUV→RGB des PNG est déterministe,
mais la perte liée au sous-échantillonnage de la chroma est **inhérente au
fichier source** (rien ne peut la restaurer). Pour une fidélité bit à bit :
`--raw-yuv` sort en plus `frames.yuv` (yuv420p brut), validé par
`taille == nb_frames × width × height × 1,5`.

## Usage

```bash
# Installation (binaires ffmpeg/ffprobe statiques, aucune installation système)
npm install

# Extraction complète avec toutes les garanties
npm run frames:extract -- ma_video_slowmo.mov --out out --verify-determinism --raw-yuv --json rapport.json

# Test automatisé des critères d'acceptation (CFR 240, VFR mixte 240+30, 30 fps)
npm run frames:test
```

Résultat sur les vidéos de référence (exécution réelle) :

| Vidéo | Frames réelles (ffprobe) | PNG extraits | Déterminisme | YUV brut |
|---|---|---|---|---|
| CFR 240 fps (2 s) | 480 | 480 | 480/480 md5 identiques | OK |
| **VFR mixte 240→30 fps (2 s)** | **270** | **270** | **270/270 md5 identiques** | OK |
| Normale 30 fps (2 s) | 60 | 60 | 60/60 md5 identiques | OK |

Le cas VFR mixte est la validation décisive : une cadence forcée (240 × 2 s)
aurait produit 480 PNG avec duplication — la méthode extrait exactement les
270 frames réelles.

## Transposition PWA (feuille de route)

La PWA RSI Calc ne peut pas embarquer ffmpeg/ffprobe natifs ni extraire des
gigaoctets de PNG sur mobile. Les mêmes principes s'y appliquent néanmoins :

- **Comptage réel** : le parseur binaire (`src/video/metadataParser.ts`) lit
  le nombre de samples réel du conteneur (stts ou fragments moof, iPhone
  compris) — aucune estimation `durée × fps` pour le comptage.
- **Aucune cadence forcée** à la navigation (seek au centre de frame + saut
  visuel des frames identiques).
- **Étape suivante validée** : intégrer ffmpeg.wasm (~30 Mo, en cache PWA
  après premier chargement) pour appliquer cette méthode à l'identique dans
  le navigateur — comptage réel par décodage et index des timestamps.
