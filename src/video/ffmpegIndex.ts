/**
 * Analyse ffmpeg.wasm — index exact des frames d'une vidéo.
 *
 * Décode le flux vidéo avec le filtre showinfo en mode passthrough :
 * chaque frame décodée est loggée avec son timestamp réel (pts_time).
 * L'index obtenu est la base du calcul VFR-exact : le temps entre deux
 * frames marquées est une différence de timestamps, pas une division
 * par un fps supposé constant.
 *
 * Le core (~32 Mo) est servi par la PWA (public/ffmpeg/) et mis en
 * cache par le service worker : le premier usage télécharge une fois,
 * ensuite tout fonctionne hors ligne.
 */

import { FFmpeg } from '@ffmpeg/ffmpeg';
import type { FrameIndex } from '../types';

/** Taille maximale de fichier analysée (limite mémoire du navigateur) */
const MAX_VIDEO_BYTES = 250 * 1024 * 1024;

// Instance unique (chargée paresseusement)
let ffmpegInstance: FFmpeg | null = null;
let loadingPromise: Promise<FFmpeg> | null = null;

// Handlers courants (l'API 0.12 n'autorise pas plusieurs .on() cumulés
// par analyse : on redirige via des variables)
let currentLogHandler: ((message: string) => void) | null = null;
let currentProgressHandler: ((progress: number) => void) | null = null;

function coreBaseURL(): string {
  return new URL('ffmpeg/', document.baseURI).href;
}

/** Télécharge une ressource avec progression */
async function downloadWithProgress(
  url: string,
  onProgress?: (ratio: number) => void
): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Téléchargement impossible : ${url} (HTTP ${response.status})`);
  }
  if (!response.body) {
    throw new Error('Réponse réseau illisible (stream absent).');
  }
  const total = Number(response.headers.get('content-length')) || 0;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (onProgress && total > 0) {
      onProgress(received / total);
    }
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Charge le moteur ffmpeg.wasm (une seule fois par session).
 * @param onDownloadProgress - Progression du téléchargement du core (0-1)
 */
export async function getFFmpegEngine(
  onDownloadProgress?: (ratio: number) => void
): Promise<FFmpeg> {
  if (ffmpegInstance) return ffmpegInstance;
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    const base = coreBaseURL();
    const coreJsUrl = new URL('ffmpeg-core.js', base).href;
    const coreWasmUrl = new URL('ffmpeg-core.wasm', base).href;

    // Pré-télécharger avec progression : garantit la présence en cache
    // (HTTP + service worker) avant le chargement par le worker.
    const [coreJs, coreWasm] = await Promise.all([
      downloadWithProgress(coreJsUrl),
      downloadWithProgress(coreWasmUrl, onDownloadProgress),
    ]);

    const ffmpeg = new FFmpeg();
    // Listeners uniques attachés à la création de l'instance
    ffmpeg.on('log', ({ message }) => {
      currentLogHandler?.(message);
    });
    ffmpeg.on('progress', ({ progress }) => {
      currentProgressHandler?.(progress);
    });

    try {
      // URL HTTP directes (same-origin) : le mode de chargement le plus
      // fiable — notamment sur iPhone / PWA installée, où WebKit restreint
      // l'accès aux URLs blob: depuis un Worker (erreur
      // « failed to import ffmpeg-core.js »).
      await ffmpeg.load({ coreURL: coreJsUrl, wasmURL: coreWasmUrl });
    } catch (directError) {
      // Repli : blob URLs (contextes qui restreignent l'import http direct)
      const coreBlobURL = URL.createObjectURL(
        new Blob([coreJs as unknown as BlobPart], { type: "text/javascript" })
      );
      const wasmBlobURL = URL.createObjectURL(
        new Blob([coreWasm as unknown as BlobPart], { type: "application/wasm" })
      );
      try {
        await ffmpeg.load({ coreURL: coreBlobURL, wasmURL: wasmBlobURL });
      } catch (blobError) {
        console.error('[RSI Calc] Chargement ffmpeg (URL directe) :', directError);
        console.error('[RSI Calc] Chargement ffmpeg (blob) :', blobError);
        throw new Error(
          'Impossible de charger le moteur ffmpeg sur ce navigateur. ' +
          'Sur iPhone, utilisez Safari (l\'analyse nécessite aussi assez de mémoire libre).'
        );
      } finally {
        URL.revokeObjectURL(coreBlobURL);
        URL.revokeObjectURL(wasmBlobURL);
      }
    }

    ffmpegInstance = ffmpeg;
    return ffmpeg;
  })();

  try {
    return await loadingPromise;
  } catch (error) {
    loadingPromise = null; // permettre un nouvel essai
    throw error;
  }
}

/**
 * Extrait (frameNumber, pts, ptsTime) d'une ligne de log showinfo.
 * Fonction pure — testée unitairement.
 */
export function parseShowinfoLine(
  message: string
): { frameNumber: number; pts: number; ptsTime: number } | null {
  if (!message.includes('Parsed_showinfo')) return null;
  const match = /n:\s*(\d+)\s+pts:\s*(-?\d+)\s+pts_time:\s*(-?[\d.eE+-]+)/.exec(
    message
  );
  if (!match) return null;
  return {
    frameNumber: parseInt(match[1], 10),
    pts: parseInt(match[2], 10),
    ptsTime: parseFloat(match[3]),
  };
}

/** Médiane d'un tableau de nombres */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

export interface AnalyzeOptions {
  onDownloadProgress?: (ratio: number) => void;
  onDecodeProgress?: (ratio: number) => void;
}

/**
 * Analyse une vidéo : décode le flux et indexe le timestamp exact de
 * chaque frame (méthode showinfo + passthrough — aucun comptage estimé).
 * @param file - Fichier vidéo
 * @returns Index des frames avec timestamps vidéo exacts
 */
export async function analyzeVideoFrames(
  file: File,
  options: AnalyzeOptions = {}
): Promise<FrameIndex> {
  if (file.size > MAX_VIDEO_BYTES) {
    throw new Error(
      'Vidéo trop volumineuse pour l\'analyse sur navigateur (max 250 Mo). ' +
      'Utilisez une version courte de la vidéo.'
    );
  }

  const ffmpeg = await getFFmpegEngine(options.onDownloadProgress);

  const extension = file.name.includes('.')
    ? '.' + file.name.split('.').pop()
    : '.mp4';
  const inputName = 'input' + extension.toLowerCase();

  const data = new Uint8Array(await file.arrayBuffer());
  await ffmpeg.writeFile(inputName, data);

  const entries: { frameNumber: number; pts: number; ptsTime: number }[] = [];
  let decodeError: string | null = null;

  currentLogHandler = (message) => {
    const parsed = parseShowinfoLine(message);
    if (parsed) {
      entries.push(parsed);
      return;
    }
    if (
      /Invalid data found|error while decoding|non-existing PPS|Decode returned error/i.test(
        message
      )
    ) {
      decodeError = message;
    }
  };
  currentProgressHandler = (progress) => {
    options.onDecodeProgress?.(Math.max(0, Math.min(1, progress)));
  };

  let exitCode = -1;
  try {
    exitCode = await ffmpeg.exec([
      '-hide_banner',
      '-nostdin',
      '-i', inputName,
      '-map', '0:v:0',
      '-vf', 'showinfo',
      '-fps_mode', 'passthrough', // jamais de cadence forcée
      '-f', 'null',
      '-',
    ]);
  } finally {
    currentLogHandler = null;
    currentProgressHandler = null;
    await ffmpeg.deleteFile(inputName).catch(() => {});
  }

  if (decodeError) {
    throw new Error(`Erreur de décodage : ${decodeError}`);
  }
  if (exitCode !== 0) {
    throw new Error(`L'analyse ffmpeg a échoué (code ${exitCode}).`);
  }
  if (entries.length === 0) {
    throw new Error('Aucune frame n\'a pu être indexée (flux vidéo illisible ?).');
  }

  // Ordre de décodage = ordre des messages showinfo
  entries.sort((a, b) => a.frameNumber - b.frameNumber);

  const ptsTimes = new Float64Array(entries.length);
  for (let i = 0; i < entries.length; i++) {
    ptsTimes[i] = entries[i].ptsTime;
  }

  const intervals: number[] = [];
  for (let i = 1; i < ptsTimes.length; i++) {
    const delta = ptsTimes[i] - ptsTimes[i - 1];
    if (delta > 0) intervals.push(delta);
  }

  return {
    frameCount: entries.length,
    ptsTimes,
    medianInterval: median(intervals) || 0,
  };
}

/**
 * Libère le moteur (en cas d'erreur ou de manque de mémoire).
 */
export function disposeFFmpegEngine(): void {
  try {
    ffmpegInstance?.terminate();
  } catch {
    // ignore
  }
  ffmpegInstance = null;
  loadingPromise = null;
}
