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
