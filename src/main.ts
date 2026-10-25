/**
 * Point d'entrée principal de RSI Calc
 */

import { initApp } from './app';
import pkg from '../package.json';

// Afficher la version (vérifiable en bas de page et dans la console)
const version = `v${pkg.version}`;
{
  const badge = document.getElementById('app-version');
  if (badge) badge.textContent = version;
  console.info(`[RSI Calc] ${version}`);
}

// Injecter le manifest dynamiquement : le fichier est servi à la racine
// (public/manifest.json), indépendamment de la base de déploiement.
// (Vite déplacerait sinon le manifest dans assets/, ce qui casserait
// le start_url "./" de la PWA installée.)
{
  const link = document.createElement('link');
  link.rel = 'manifest';
  link.href = new URL('manifest.json', document.baseURI).href;
  document.head.appendChild(link);
}

async function bootstrap(): Promise<void> {
  try {
    await initApp();
  } catch (error) {
    console.error('[RSI Calc] Erreur d\'initialisation :', error);

    // Afficher l'erreur sur l'écran de chargement pour un diagnostic facile
    const loadingError = document.getElementById('loading-error');
    const fallback = document.getElementById('loading-fallback');
    if (loadingError) {
      loadingError.textContent =
        `Erreur d'initialisation : ${error instanceof Error ? error.message : String(error)}`;
    }
    if (fallback) fallback.classList.remove('hidden');
  }
}

// Les scripts module sont différés : le DOM est déjà prêt à l'exécution
void bootstrap();

// En dev : désinscrire tout ancien Service Worker pour éviter qu'il
// serve une vieille version de la page depuis son cache
if (import.meta.env.DEV && 'serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then((regs) => {
    for (const reg of regs) void reg.unregister();
  });
}

// Enregistrer le Service Worker uniquement en production (build).
// Chemin relatif : fonctionne à la racine et sous un sous-chemin (GitHub Pages).
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((err) => {
      console.warn('[RSI Calc] Service Worker non enregistré :', err);
    });
  });
}
