/**
 * Module de chargement vidéo
 * Gère l'importation et l'analyse des fichiers vidéo
 */

import type { VideoMetadata } from '../types';

// FPS minimum pour être considéré comme slow-motion
const MIN_SLOW_MOTION_FPS = 200;

// FPS par défaut si la détection échoue (slow-mo smartphone standard)
const DEFAULT_SLOW_MO_FPS = 240;

/**
 * Extrait les métadonnées d'un fichier vidéo
 * @param file - Fichier vidéo à analyser
 * @returns Promise avec les métadonnées vidéo
 */
export async function extractVideoMetadata(file: File): Promise<VideoMetadata> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    const objectUrl = URL.createObjectURL(file);

    video.preload = 'metadata';
    video.muted = true;

    video.onloadedmetadata = () => {
      try {
        const duration = video.duration;
        const width = video.videoWidth;
        const height = video.videoHeight;

        // Les navigateurs n'exposent pas le FPS réel via l'API standard.
        // On propose 240 fps par défaut (slow-mo smartphone standard),
        // modifiable manuellement par l'utilisateur dans les paramètres.
        const fps = DEFAULT_SLOW_MO_FPS;

        const frameCount = Math.max(1, Math.round(duration * fps));
        const isSlowMotion = fps >= MIN_SLOW_MOTION_FPS;

        const metadata: VideoMetadata = {
          duration,
          fps,
          frameCount,
          width,
          height,
          isSlowMotion,
          detectedFps: fps,
        };

        URL.revokeObjectURL(objectUrl);
        resolve(metadata);
      } catch (error) {
        URL.revokeObjectURL(objectUrl);
        reject(error);
      }
    };

    video.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('Impossible de charger les métadonnées vidéo'));
    };

    video.src = objectUrl;
  });
}

/**
 * Recalcule le nombre de frames à partir de la durée et du FPS
 * @param duration - Durée en secondes
 * @param fps - FPS de la vidéo
 * @returns Nombre de frames
 */
export function computeFrameCount(duration: number, fps: number): number {
  if (!Number.isFinite(duration) || !Number.isFinite(fps) || duration <= 0 || fps <= 0) {
    return 1;
  }
  return Math.max(1, Math.round(duration * fps));
}

// Typage de requestVideoFrameCallback (inclus dans les lib DOM récents)

/**
 * Détecte le FPS de lecture réel du conteneur vidéo (ex. ~30 fps pour une
 * vidéo slow-mo iPhone de 240 fps d'enregistrement, ralentie à l'export).
 * Nécessite une brève lecture muette ; retourne null si l'API est absente.
 * @param video - Élément vidéo (muet, déjà chargé)
 * @param sampleCount - Nombre de frames présentées à échantillonner
 * @returns FPS de lecture détecté, ou null
 */
export function detectPlaybackFps(
  video: HTMLVideoElement,
  sampleCount = 12,
  timeoutMs = 3000
): Promise<number | null> {
  return new Promise((resolve) => {
    if (typeof video.requestVideoFrameCallback !== 'function') {
      resolve(null);
      return;
    }

    const mediaTimes: number[] = [];
    let settled = false;
    let timeoutId = 0;

    const finish = (result: number | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      video.pause();
      resolve(result);
    };

    const compute = (): number | null => {
      if (mediaTimes.length < 2) return null;
      const first = mediaTimes[0];
      const last = mediaTimes[mediaTimes.length - 1];
      const span = last - first;
      if (span <= 0) return null;
      // frames présentées par seconde de temps média
      const fps = (mediaTimes.length - 1) / span;
      if (!Number.isFinite(fps) || fps <= 0) return null;
      // Arrondir aux cadences standard les plus proches (24, 25, 30, 50, 60)
      const standards = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60, 120, 240];
      const nearest = standards.reduce((a, b) => (Math.abs(b - fps) < Math.abs(a - fps) ? b : a));
      return Math.abs(nearest - fps) / fps < 0.1 ? nearest : Math.round(fps * 100) / 100;
    };

    const onFrame = (_now: number, metadata: VideoFrameCallbackMetadata) => {
      mediaTimes.push(metadata.mediaTime);
      if (mediaTimes.length >= sampleCount) {
        finish(compute());
        return;
      }
      video.requestVideoFrameCallback(onFrame);
    };

    timeoutId = window.setTimeout(() => finish(compute()), timeoutMs);

    video.requestVideoFrameCallback(onFrame);
    video.play().catch(() => finish(null));
  });
}

/**
 * Valide le format vidéo
 * @param file - Fichier à valider
 * @returns Vrai si le fichier est une vidéo supportée
 */
export function validateVideoFile(file: File): boolean {
  const validTypes = [
    'video/mp4',
    'video/webm',
    'video/ogg',
    'video/quicktime',
    'video/x-m4v',
    'video/3gpp',
  ];
  const maxSize = 500 * 1024 * 1024; // 500 Mo

  // Certains navigateurs renvoient un type vide : on accepte si l'extension est connue
  const extensionOk = /\.(mp4|webm|ogv|mov|m4v|3gp)$/i.test(file.name);

  return (validTypes.includes(file.type) || (file.type === '' && extensionOk)) && file.size <= maxSize;
}

/**
 * Formate une durée en secondes en format lisible
 * @param seconds - Durée en secondes
 * @returns Durée formatée
 */
export function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  if (seconds < 3600) {
    return `${minutes}m ${secs}s`;
  }
  const hours = Math.floor(seconds / 3600);
  return `${hours}h ${minutes}m ${secs}s`;
}
