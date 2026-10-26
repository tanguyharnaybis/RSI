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
 * Diagnostic indépendant : exécute le core UMD dans un worker classique
 * minimal que nous contrôlons. Isole la cause racine d'un échec : réseau,
 * syntaxe non supportée, ou exécution crashée.
 */
function probeCoreExecution(coreJsUrl: string): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const source =
      `try { importScripts(${JSON.stringify(coreJsUrl)}); ` +
      `postMessage({ ok: typeof self.createFFmpegCore === 'function' }); } ` +
      `catch (e) { postMessage({ ok: false, error: String(e && (e.stack || e.message) || e) }); }`;

    let worker: Worker;
    try {
      worker = new Worker(
        URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
      );
    } catch (error) {
      resolve({ ok: false, error: `création du worker impossible : ${String(error)}` });
      return;
    }

    let settled = false;
    const finish = (result: { ok: boolean; error?: string }) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      worker.terminate();
      resolve(result);
    };
    const timeoutId = window.setTimeout(
      () => finish({ ok: false, error: 'expiration après 30 s' }),
      30000
    );

    worker.onmessage = (event: MessageEvent) => finish(event.data);
    worker.onerror = (event: ErrorEvent) =>
      finish({ ok: false, error: `${event.message} (${event.filename}:${event.lineno})` });
  });
}

/** Le moteur est-il déjà chargé (préchargement possible avant import) */
export function isFFmpegEngineReady(): boolean {
  return ffmpegInstance !== null;
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
    const umdJsUrl = new URL('ffmpeg-core.js', base).href;
    const esmJsUrl = new URL('esm/ffmpeg-core.js', base).href;
    const wasmUrl = new URL('ffmpeg-core.wasm', base).href;

    // Vérification d'accessibilité + copie légère du core UMD (112 Ko)
    // pour le repli blob. Le WASM (32 Mo) reste téléchargé par le worker.
    const umdJs = await downloadWithProgress(umdJsUrl, onDownloadProgress);

    const attachListeners = (instance: FFmpeg) => {
      instance.on('log', ({ message }) => {
        currentLogHandler?.(message);
      });
      instance.on('progress', ({ progress }) => {
        currentProgressHandler?.(progress);
      });
    };

    const makeLoad = (coreURL: string) => async (): Promise<FFmpeg> => {
      const instance = new FFmpeg();
      attachListeners(instance);
      await instance.load({ coreURL, wasmURL: wasmUrl });
      return instance;
    };

    // Le worker du package est TOUJOURS un module worker (type: "module")
    // où importScripts n'existe pas : le package bascule sur un import
    // dynamique, conçu pour le core ESM — chemin natif, le plus fiable
    // (notamment Safari iOS). Puis essais UMD (classic) en repli.
    const attempts: Array<{ label: string; run: () => Promise<FFmpeg> }> = [
      { label: 'core ESM', run: makeLoad(esmJsUrl) },
      { label: 'core UMD (URL directe)', run: makeLoad(umdJsUrl) },
      {
        label: 'core UMD (blob)',
        run: async () => {
          const blobURL = URL.createObjectURL(
            new Blob([umdJs as unknown as BlobPart], { type: 'text/javascript' })
          );
          try {
            return await makeLoad(blobURL)();
          } finally {
            URL.revokeObjectURL(blobURL);
          }
        },
      },
    ];

    const errors: string[] = [];
    for (const attempt of attempts) {
      try {
        ffmpegInstance = await attempt.run();
        return ffmpegInstance;
      } catch (error) {
        errors.push(
          `${attempt.label} : ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    // Diagnostic indépendant : le core s'exécute-t-il dans un worker
    // classique que nous contrôlons ? Ce test isole la cause racine.
    const probe = await probeCoreExecution(umdJsUrl);

    const diagnosis = probe.ok
      ? 'le core s\'exécute correctement dans un worker classique de diagnostic'
      : `le core ne s'exécute pas non plus dans le worker de diagnostic : ${probe.error}`;
    throw new Error(
      `Chargement du moteur ffmpeg impossible. Tentatives : [${errors.join(' ; ')}]. Diagnostic : ${diagnosis}`
    );
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
  // Blocs du filtre metadata : (pts_time, lavfi.scene) par frame
  const sceneBlocks: { ptsTime: number; scene: number }[] = [];
  let lastMetadataPtsTime = 0;
  let decodeError: string | null = null;

  currentLogHandler = (message) => {
    const parsed = parseShowinfoLine(message);
    if (parsed) {
      entries.push(parsed);
      return;
    }
    // Filtre metadata=print : bloc frame/pts/pts_time puis clés lavfi.*
    if (message.includes('Parsed_metadata')) {
      const blockMatch = /frame:\s*\d+\s+pts:\s*-?\d+\s+pts_time:\s*(-?[\d.eE+-]+)/.exec(message);
      if (blockMatch) {
        lastMetadataPtsTime = parseFloat(blockMatch[1]);
        return;
      }
      const sceneMatch = /lavfi\.scene=([\d.eE+-]+)/.exec(message);
      if (sceneMatch && Number.isFinite(lastMetadataPtsTime)) {
        sceneBlocks.push({ ptsTime: lastMetadataPtsTime, scene: parseFloat(sceneMatch[1]) });
      }
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
  // Le score de mouvement (lavfi.scene du filtre select) alimente la
  // détection automatique des sauts ; en cas d'échec du filtre étendu,
  // repli sur l'analyse simple (index sans scores).
  const FILTER_WITH_SCENE =
    'showinfo,select=gte(scene\\,0),metadata=print';
  const FILTER_BASIC = 'showinfo';

  const runAnalysis = async (filter: string): Promise<number> => {
    // Réinitialiser les collecteurs à chaque tentative
    entries.length = 0;
    sceneBlocks.length = 0;
    decodeError = null;
    return ffmpeg.exec([
      '-hide_banner',
      '-nostdin',
      '-i', inputName,
      '-map', '0:v:0',
      '-vf', filter,
      '-fps_mode', 'passthrough', // jamais de cadence forcée
      '-f', 'null',
      '-',
    ]);
  };

  try {
    exitCode = await runAnalysis(FILTER_WITH_SCENE);
    if (exitCode !== 0) {
      // Repli : filtre étendu non supporté par ce build
      exitCode = await runAnalysis(FILTER_BASIC);
    }
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

  const medianInterval = median(intervals) || 0;

  // Aligner les scores de mouvement sur l'index des frames :
  // chaque bloc metadata porte son pts_time → index de la frame couvrante
  // (recherche par pointeur croissant, robuste aux formats d'affichage).
  let sceneScores: Float64Array | undefined;
  if (sceneBlocks.length > 0 && ptsTimes.length > 0) {
    const scores = new Float64Array(ptsTimes.length);
    let cursor = 0;
    let matched = 0;
    const tolerance = Math.max(medianInterval, 1 / 1000);
    for (const block of sceneBlocks) {
      while (cursor + 1 < ptsTimes.length && ptsTimes[cursor + 1] <= block.ptsTime) {
        cursor++;
      }
      const distance =
        cursor < ptsTimes.length ? Math.abs(ptsTimes[cursor] - block.ptsTime) : Infinity;
      if (distance <= tolerance) {
        scores[cursor] = block.scene;
        matched++;
      }
    }
    // Garde-fou : au moins 90 % des frames couvertes, sinon détection
    // indisponible (résultat faussement incomplet → pas de résultat du tout)
    if (matched >= ptsTimes.length * 0.9) {
      sceneScores = scores;
    }
  }

  return {
    frameCount: entries.length,
    ptsTimes,
    medianInterval,
    sceneScores,
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
