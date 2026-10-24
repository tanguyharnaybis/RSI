import { defineConfig } from 'vite';

// Base pour le déploiement :
// - '/' pour un hébergement à la racine (Netlify, Vercel, serveur perso)
// - '/NomDuRepo/' pour GitHub Pages (repo > utilisateur.github.io)
//   → build avec : BASE_PATH=/NomDuRepo/ npm run build
const base = process.env.BASE_PATH || '/';

export default defineConfig({
  base,
  root: '.',
  publicDir: 'public',
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  server: {
    port: 3000,
    open: true,
  },
  preview: {
    port: 3000,
    open: true,
  },
});
