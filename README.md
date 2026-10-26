# RSI Calc - Calculateur Reactive Strength Index

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-blue.svg)](https://www.typescriptlang.org/)
[![Vite](https://img.shields.io/badge/Vite-5.0-purple.svg)](https://vitejs.dev/)
[![Vitest](https://img.shields.io/badge/Vitest-1.2-green.svg)](https://vitest.dev/)

**RSI Calc** est une **PWA mobile-first** pour calculer le **Reactive Strength Index (RSI)** à partir de vidéos de **drop jump** filmées en slow-motion (240 fps).

## 🚀 Fonctionnalités

### 📹 Analyse Vidéo
- Import de vidéos depuis l'appareil (MP4, WebM, QuickTime)
- Détection automatique du FPS (avec possibilité de correction manuelle)
- Lecteur vidéo **frame-par-frame** avec navigation précise
- Timeline scrubbable avec visualisation de la position
- Zoom sur la zone des pieds pour un marquage précis

### 🎯 Marquage et Calcul
- Marquage des 3 frames clés : atterrissage, décollage, atterrissage final
- Calcul automatique du RSI avec les formules :
  - **Temps de contact** = (frame_decollage - frame_atterrissage) / fps
  - **Temps de vol** = (frame_final - frame_decollage) / fps
  - **Hauteur de saut** = g × t_vol² / 8
  - **RSI** = hauteur / temps_de_contact
  - **RSI modifié** = hauteur / temps_total
- Affichage des résultats en temps réel

### 🤖 Détection automatique par pose IA (MediaPipe)
- Pipeline **MediaPipe Pose** (`@mediapipe/tasks-vision`, modèle
  `pose_landmarker_full.task` servi localement — aucun appel réseau externe) :
  - landmarks du pied extraits frame par frame : chevilles (27/28), talons
    (29/30), pointes (31/32) — en pogo jump, la pointe est le premier et le
    dernier point de contact ;
  - ligne de sol estimée par moyenne glissante des positions minimales stables
    de la pointe pendant les appuis ;
  - détection des croisements du seuil de sol avec epsilon adaptatif au bruit
    mesuré, trajectoire lissée (moyenne mobile) ;
  - **sous-frame** : régression linéaire sur 3-4 frames autour de chaque
    événement → instant du croisement interpolé à la milliseconde ;
  - reconstruction **cyclique** des pogo jumps : une seule timeline d'événements
    alternés contact/vol, l'atterrissage final d'un saut est le premier contact
    du suivant (aucun doublon) ; vol initial et contact final incomplet ignorés ;
    cycles incohérents rejetés (contact < 80 ms ou > 400 ms, vol < 100 ms ou
    > 600 ms, chevauchements).
- **Validation manuelle obligatoire (hybride)** : l'IA propose, vous validez —
  liste des sauts proposés, ajustement frame par frame (◀/▶) pour chaque
  événement, métriques recalculées en direct, overlay des landmarks du pied sur
  la vidéo (vert si visibilité ≥ 0.6, orange sinon), boutons « Valider ce saut »,
  « Tout valider », « Rejeter ce saut ». Les corrections sont enregistrées avec
  la session.
- Extraction des frames par le moteur ffmpeg par morceaux (mémoire bornée) avec
  `-fps_mode passthrough` : chaque frame décodée sort exactement une fois, et
  validation stricte du nombre de frames extraites.


### 📊 Gestion des Sessions
- Création de sessions avec nom et hauteur de drop
- Sauvegarde locale de plusieurs essais par session
- Statistiques : moyenne, écart-type du RSI par session
- Historique complet avec graphique de progression
- Export CSV et JSON des données

### 🎨 Interface Mobile-First
- Design **thème sombre** par défaut (avec basculement vers thème clair)
- **Gros boutons tactiles** pour une utilisation facile sur mobile
- **Responsive** : adaptée aux smartphones et tablettes
- **Accessible** : labels, contrastes, navigation clavier

### 📱 PWA (Progressive Web App)
- **Installable** sur iOS et Android
- **Fonctionne hors ligne** (vidéos et données sauvegardées localement)
- **Notifications push** (futur)

### 📚 Guide Intégré
- Checklist du protocole de mesure
- Conseils pour obtenir des résultats précis
- Recommandations sur la configuration du smartphone

## 📦 Structure du Projet

```
rsi-calc/
├── index.html                    # Page principale
├── manifest.json                # Manifest PWA
├── package.json                 # Dépendances et scripts
├── vite.config.ts              # Configuration Vite
├── tsconfig.json               # Configuration TypeScript
├── sw.ts                        # Service Worker
├── public/
│   ├── favicon.svg             # Icône
│   └── sw.js                   # Service Worker compilé
├── src/
│   ├── main.ts                 # Point d'entrée
│   ├── app.ts                  # Logique applicative
│   ├── types.ts                # Types TypeScript
│   ├── calculation/
│   │   ├── formulas.ts         # Formules de calcul RSI
│   │   └── index.ts
│   ├── video/
│   │   ├── loader.ts           # Chargement vidéo
│   │   ├── player.ts           # Lecteur frame-par-frame
│   │   └── index.ts
│   ├── annotation/
│   │   ├── marker.ts           # Gestion des marqueurs
│   │   └── index.ts
│   ├── storage/
│   │   ├── localStorage.ts     # Stockage local
│   │   ├── session.ts          # Gestion des sessions
│   │   └── index.ts
│   ├── stats/
│   │   ├── statistics.ts       # Calcul des statistiques
│   │   └── index.ts
│   ├── ui/
│   │   ├── components.ts       # Composants UI réutilisables
│   │   ├── theme.ts            # Gestion du thème
│   │   └── index.ts
│   └── utils/
│       ├── helpers.ts          # Fonctions utilitaires
│       └── index.ts
└── tests/
    ├── setup.ts               # Configuration des tests
    ├── formulas.test.ts       # Tests des formules RSI
    └── storage.test.ts        # Tests du stockage
```

## 🛠 Prérequis

- Node.js 18+ 
- npm ou yarn ou pnpm
- TypeScript 5.0+

## 🚀 Installation et Développement

### 1. Cloner le dépôt
```bash
git clone https://github.com/votre-utilisateur/rsi-calc.git
cd rsi-calc
```

### 2. Installer les dépendances
```bash
npm install
```

### 3. Lancer en développement
```bash
npm run dev
```

L'application sera disponible à [http://localhost:3000](http://localhost:3000)

### 4. Build pour production
```bash
npm run build
```

Les fichiers seront générés dans le dossier `dist/`

### 5. Lancer les tests
```bash
npm test
```

Pour les tests avec couverture de code :
```bash
npm run test:coverage
```

## 📤 Déploiement

### Déploiement sur GitHub Pages

1. Créer un dépôt GitHub
2. Pousser le code
3. Exécuter `npm run build`
4. Configurer GitHub Pages pour servir depuis le dossier `dist/`

### Déploiement sur Netlify/Vercel

1. Créer un nouveau projet
2. Lier au dépôt GitHub
3. Définir la commande de build : `npm run build`
4. Définir le dossier de build : `dist/`

### Déploiement sur un serveur statique

Copier simplement le contenu du dossier `dist/` sur votre serveur.

## 📱 Installation comme PWA

1. Ouvrir l'application dans Chrome sur Android ou Safari sur iOS
2. Cliquer sur "Installer" ou "Ajouter à l'écran d'accueil"
3. L'application sera disponible hors ligne

## 🎯 Protocole de Mesure

Pour obtenir des résultats précis :

### ✅ Configuration
- [ ] **240 fps minimum** (slow-motion smartphone)
- [ ] Téléphone en **strict profil** à hauteur du sol
- [ ] Distance de filmage : 1-2 mètres
- [ ] Bon éclairage

### ✅ Exécution du Test
- [ ] **3-5 essais** par hauteur de drop
- [ ] **Mains sur les hanches** pendant le saut
- [ ] **Pointes tendues** à l'atterrissage et au décollage
- [ ] **Atterrir sur la même position** que le décollage
- [ ] **Hauteur de drop constante** pour chaque session

### ✅ Marquage des Frames
1. **Atterrissage** : Premier contact des orteils avec le sol
2. **Décollage** : Dernier contact des orteils avec le sol
3. **Atterrissage Final** : Premier contact après le saut

## 🔬 Formules Utilisées

### Temps de Contact (tc)
```
tc = (frame_decollage - frame_atterrissage) / fps
```

### Temps de Vol (tv)
```
tv = (frame_final - frame_decollage) / fps
```

### Hauteur de Saut (h)
```
h = g × tv² / 8
```
*où g = 9.81 m/s² (configurable)*

### Reactive Strength Index (RSI)
```
RSI = h / tc  (en m/s)
```

### RSI Modifié
```
RSI_modifié = h / (tc + tv)  (en m/s)
```

## 📊 Valeurs de Référence

| Niveau | RSI (m/s) |
|--------|-----------|
| Débutant | < 0.5 |
| Intermédiaire | 0.5 - 1.0 |
| Avancé | 1.0 - 1.5 |
| Élite | > 1.5 |

## 🎨 Personnalisation

### Thème
- **Sombre** (par défaut) : Parfait pour l'utilisation en faible lumière
- **Clair** : Pour une meilleure visibilité en plein jour
- Basculer avec le bouton 🌓 dans l'en-tête

### Gravité
- Valeur par défaut : 9.81 m/s²
- Configurable dans les paramètres vidéo

### FPS
- Détection automatique depuis la vidéo
- Correction manuelle possible si nécessaire

## 🔧 Technologies Utilisées

- **TypeScript** : Langage principal
- **Vite** : Bundler ultra-rapide
- **Vitest** : Framework de tests
- **Chart.js** : Graphiques de progression
- **HTML5 Video API** : Lecture et analyse vidéo
- **Canvas API** : Affichage des frames
- **localStorage** : Stockage des données
- **Service Worker** : Fonctionnalités PWA

## 🤝 Contribution

1. Forker le projet
2. Créer une branche (`git checkout -b feature/nouvelle-fonctionnalité`)
3. Commiter les changements (`git commit -m 'Ajout nouvelle fonctionnalité'`)
4. Pousser vers la branche (`git push origin feature/nouvelle-fonctionnalité`)
5. Ouvrir une Pull Request

## 📜 Licence

Ce projet est sous licence **MIT** - voir le fichier [LICENSE](LICENSE) pour plus de détails.

## 🙏 Remerciements

- Inspiration : Méthodes de calcul RSI utilisées en kinésiologie
- Conception : Mobile-first avec focus sur l'accessibilité
- Tests : Validation des formules avec des valeurs de référence

---

**Créé avec ❤️ pour la communauté du sport et de la performance**

*RSI Calc - 2024*
