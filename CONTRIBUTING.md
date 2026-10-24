# Contribuer à RSI Calc

Merci de votre intérêt pour contribuer à **RSI Calc** ! ❤️

## 📚 Comment contribuer

### 1. Signaler un bug

Si vous trouvez un bug, veuillez :

- Vérifier que le bug n'a pas déjà été signalé
- Créer une issue avec :
  - Une description claire et détaillée
  - Les étapes pour reproduire le bug
  - La version de l'application
  - Le navigateur et le système d'exploitation
  - Des screenshots ou vidéos si applicable

### 2. Proposer une fonctionnalité

Si vous avez une idée de nouvelle fonctionnalité :

- Vérifier que l'idée n'a pas déjà été proposée
- Créer une issue avec :
  - Une description détaillée de la fonctionnalité
  - Le cas d'utilisation (pourquoi cette fonctionnalité serait utile)
  - Des exemples si possible

### 3. Contribuer au code

#### Configuration du projet

1. Forker le dépôt
2. Cloner votre fork localement
3. Installer les dépendances :
   ```bash
   npm install
   ```
4. Créer une branche :
   ```bash
   git checkout -b feature/nom-de-la-fonctionnalite
   ```

#### Développement

- Suivre les conventions de code existantes
- Écrire des commits clairs et atomiques
- Ajouter des tests pour les nouvelles fonctionnalités
- Mettre à jour la documentation si nécessaire

#### Pull Request

1. Pousser vos changements vers votre fork
2. Ouvrir une Pull Request vers la branche `main`
3. Remplir le template de Pull Request
4. Attendre les revues et les corrections nécessaires

## 🎯 Bonnes pratiques

### Code

- **TypeScript** : Utiliser TypeScript pour tout le nouveau code
- **Noms** : Utiliser des noms descriptifs (éviter `x`, `data`, etc.)
- **Commentaires** : Commenter le code complexe ou non-obvie
- **Fonctions** : Garder les fonctions courtes et ciblées
- **Gestion d'erreurs** : Toujours gérer les erreurs de manière élégante

### Tests

- Tous les tests doivent passer avant de soumettre une PR
- Ajouter des tests pour les nouvelles fonctionnalités
- Maintenir une couverture de test élevée
- Les tests doivent être rapides et isolés

### UI/UX

- **Mobile-first** : Toujours tester sur mobile
- **Accessibilité** : Respecter les normes WCAG
- **Responsive** : Vérifier sur différentes tailles d'écran
- **Performances** : Éviter les calculs inutiles

### Commits

Utiliser des messages de commit clairs :

- `feat: ajouter nouvelle fonctionnalité`
- `fix: corriger bug dans le calcul RSI`
- `docs: mettre à jour la documentation`
- `refactor: nettoyer le module de stockage`
- `test: ajouter des tests pour les formules`
- `chore: mettre à jour les dépendances`

## 📁 Structure du projet

```
rsi-calc/
├── src/                       # Code source
│   ├── app.ts               # Logique applicative principale
│   ├── main.ts              # Point d'entrée
│   ├── types.ts             # Types TypeScript
│   ├── calculation/         # Calculs RSI
│   │   └── formulas.ts      # Formules de calcul
│   ├── video/               # Gestion vidéo
│   │   ├── loader.ts        # Chargement vidéo
│   │   └── player.ts        # Lecteur frame-par-frame
│   ├── annotation/          # Marquage des frames
│   │   └── marker.ts        # Gestion des marqueurs
│   ├── storage/             # Stockage des données
│   │   ├── localStorage.ts  # Service de stockage local
│   │   └── session.ts       # Gestion des sessions
│   ├── stats/               # Statistiques
│   │   └── statistics.ts    # Calcul des statistiques
│   ├── ui/                  # Interface utilisateur
│   │   ├── components.ts    # Composants UI
│   │   └── theme.ts         # Thème et styles
│   └── utils/               # Utilitaires
│       └── helpers.ts       # Fonctions utilitaires
├── tests/                   # Tests unitaires
│   ├── formulas.test.ts    # Tests des formules
│   └── storage.test.ts     # Tests du stockage
├── public/                  # Assets statiques
│   └── favicon.svg          # Icône
└── index.html              # Page principale
```

## 🔧 Outils de développement

### Tests

```bash
# Exécuter tous les tests
npm test

# Exécuter avec couverture
npm run test:coverage

# Mode watch (pour le développement)
npm run test:watch
```

### Build

```bash
# Build pour production
npm run build

# Build du Service Worker
npm run build:sw
```

### Type Checking

```bash
# Vérifier les erreurs TypeScript
npm run type-check
```

## 🤝 Code de conduite

Nous nous engageons à offrir une communauté ouverte et accogliante. Les contributeurs sont attendus pour :

- Respecter les autres
- Être constructifs
- Accepter les feedbacks
- Suivre les bonnes pratiques

## 📄 Licence

En contribuant, vous acceptez que vos contributions soient sous licence **MIT** avec le reste du projet.
