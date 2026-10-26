/**
 * Moteur de pose MediaPipe (pose_landmarker_full) pour la détection des
 * événements de pogo jump.
 *
 * Deux étapes :
 *  1. Extraction des frames par ffmpeg.wasm PAR MORCEAUX (mémoire bornée) :
 *     seek temporel exact (timestamps de l'index) + `-fps_mode passthrough`
 *     + `-frames:v N` → chaque frame décodée sort exactement une fois, dans
 *     l'ordre de l'index. Sortie JPEG basse résolution (suffisante pour la
 *     pose, ~25 Ko/frame), lue puis supprimée au fil de l'eau.
 *  2. Détection MediaPipe Pose sur chaque frame : landmarks du pied
 *     (cheville 27/28, talon 29/30, pointe 31/32). La trajectoire de la
 *     pointe (moyenne pondérée par la visibilité) alimente pogoEvents.
 *
 * Le modèle (~9,4 Mo) et le runtime WASM sont servis localement
 * (public/mediapipe/) : aucun appel réseau externe après le déploiement.
 */

import type { PoseLandmarker } from '@mediapipe/tasks-vision';
import { getFFmpegEngine, isFFmpegEngineReady } from '../video/ffmpegIndex';

/** Landmarks du pied exploités (chevilles, talons, pointes) */
const FOOT_LANDMARKS = [27, 28, 29, 30, 31, 32] as const;
const FOOT_INDEX_LEFT = 31;
const FOOT_INDEX_RIGHT = 32;

/** Nombre de frames extraites par morceau (borné la mémoire MEMFS) */
const CHUNK_SIZE = 250;
/** Largeur cible des frames envoyées à la pose (hauteur auto, pair) */
const EXTRACT_WIDTH = 384;

/** Un landmark du pied (coordonnées normalisées 0-1 + visibilité) */
export interface FootPoint {
  x: number;
  y: number;
  v: number;
}

/** Données de pose frame par frame */
export interface PoseFrameData {
  /** Trajectoire y de la pointe (repère image : y augmente vers le bas) */
  footY: Float64Array;
  /** Visibilité des pointes (min des deux pieds) par frame */
  visibility: Float64Array;
  /** 6 landmarks du pied par frame (overlay de validation) */
  points: FootPoint[][];
}

export interface PoseProgress {
  stage: 'model' | 'frames';
  ratio: number;
}

export type PoseProgressCallback = (progress: PoseProgress) => void;

/** Résolution d'un chemin sous la base de l'app (GitHub Pages compris) */
function assetUrl(path: string): string {
  return new URL(path, document.baseURI).href;
}

/** Télécharge le modèle avec progression (fetch streaming) */
async function fetchModel(onProgress: (ratio: number) => void): Promise<Uint8Array> {
  const response = await fetch(assetUrl('mediapipe/pose_landmarker_full.task'));
  if (!response.ok) {
    throw new Error(`Modèle de pose introuvable (HTTP ${response.status}).`);
  }
  const total = Number(response.headers.get('content-length')) || 0;
  if (!response.body || !total) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    onProgress(1);
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress(Math.min(1, received / total));
  }
  const buffer = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.length;
  }
  return buffer;
}

let cachedModelBuffer: Uint8Array | null = null;

/** Crée le PoseLandmarker (GPU si disponible, sinon CPU) */
async function createPoseLandmarker(
  onModelProgress: (ratio: number) => void
): Promise<PoseLandmarker> {
  const vision = await import('@mediapipe/tasks-vision');
  const fileset = await vision.FilesetResolver.forVisionTasks(
    assetUrl('mediapipe/wasm/')
  );

  if (!cachedModelBuffer) {
    cachedModelBuffer = await fetchModel(onModelProgress);
  }

  const makeOptions = (delegate: 'CPU' | 'GPU') => ({
    baseOptions: { modelAssetBuffer: cachedModelBuffer!, delegate },
    runningMode: 'IMAGE' as const,
    numPoses: 1,
    minPoseDetectionConfidence: 0.4,
    minPosePresenceConfidence: 0.4,
    minTrackingConfidence: 0.4,
  });

  try {
    return await vision.PoseLandmarker.createFromOptions(fileset, makeOptions('GPU'));
  } catch {
    // GPU indisponible (WebGL restreint, iOS en économie d'énergie…) → CPU
    return await vision.PoseLandmarker.createFromOptions(fileset, makeOptions('CPU'));
  }
}

/** Plus petit intervalle positif entre frames (s vidéo) */
function minPositiveInterval(ptsTimes: Float64Array): number {
  let min = Infinity;
  for (let i = 1; i < ptsTimes.length; i++) {
    const d = ptsTimes[i] - ptsTimes[i - 1];
    if (d > 0 && d < min) min = d;
  }
  return Number.isFinite(min) ? min : 1 / 240;
}

/**
 * Extrait et analyse les frames d'un morceau [start, end] (inclus).
 * Remplit data aux index start..end. Échoue bruyamment si le nombre de
 * frames extraites ne correspond pas au nombre attendu (validation).
 */
async function processChunk(
  ffmpeg: Awaited<ReturnType<typeof getFFmpegEngine>>,
  landmarker: PoseLandmarker,
  inputName: string,
  seekMarginSec: number,
  start: number,
  end: number,
  ptsTimes: Float64Array,
  data: PoseFrameData,
  onChunkFrame: (processed: number, total: number) => void
): Promise<void> {
  const count = end - start + 1;
  // Seek LÉGÈREMENT avant la frame `start` : la première frame décodée dont
  // le pts >= ss est exactement la frame `start` (marge < min intervalle).
  const seek = Math.max(0, ptsTimes[start] - seekMarginSec);
  const seekStr = seek.toFixed(4);

  const exitCode = await ffmpeg.exec([
    '-hide_banner',
    '-nostdin',
    '-ss', seekStr,
    '-i', inputName,
    '-map', '0:v:0',
    '-vf', `scale=min(${EXTRACT_WIDTH}\\,iw):-2`,
    '-fps_mode', 'passthrough', // chaque frame décodée sort exactement une fois
    '-frames:v', String(count),
    '-q:v', '7',
    'frame_%06d.jpg',
  ]);
  if (exitCode !== 0) {
    throw new Error(`Extraction des frames ${start + 1}–${end + 1} échouée (code ${exitCode}).`);
  }

  let read = 0;
  let lastFootY = start > 0 ? data.footY[start - 1] : 1;
  for (let k = 0; k < count; k++) {
    const fileName = `frame_${String(k + 1).padStart(6, '0')}.jpg`;
    let bytes: Uint8Array;
    try {
      bytes = (await ffmpeg.readFile(fileName)) as Uint8Array;
    } catch {
      // Frame manquante : échec explicite avec les deux nombres
      throw new Error(
        `Frames extraites (${read}) ≠ frames attendues (${count}) ` +
        `(bloc ${start + 1}–${end + 1}). Décodage incohérent — réessayez.`
      );
    }

    const bitmap = await createImageBitmap(
      new Blob([bytes as unknown as BlobPart], { type: 'image/jpeg' })
    );
    let result;
    try {
      result = landmarker.detect(bitmap);
    } finally {
      bitmap.close();
    }
    await ffmpeg.deleteFile(fileName).catch(() => {});

    const frameIndex = start + k;
    const landmarks = result.landmarks?.[0];
    if (landmarks && landmarks.length > FOOT_INDEX_RIGHT) {
      const left = landmarks[FOOT_INDEX_LEFT];
      const right = landmarks[FOOT_INDEX_RIGHT];
      const vl = left.visibility ?? 0;
      const vr = right.visibility ?? 0;
      // Pointe = moyenne pondérée par la visibilité des deux pieds
      if (vl + vr > 0.05) {
        lastFootY = (left.y * vl + right.y * vr) / (vl + vr);
      }
      data.footY[frameIndex] = lastFootY;
      data.visibility[frameIndex] = Math.min(vl, vr);
      data.points[frameIndex] = FOOT_LANDMARKS.map((i) => ({
        x: landmarks[i].x,
        y: landmarks[i].y,
        v: landmarks[i].visibility ?? 0,
      }));
    } else {
      // Pose non détectée : visibilité nulle, trajectoire maintenue
      data.footY[frameIndex] = lastFootY;
      data.visibility[frameIndex] = 0;
      data.points[frameIndex] = [];
    }

    read++;
    onChunkFrame(read, count);
  }

  if (read !== count) {
    throw new Error(
      `Frames extraites (${read}) ≠ frames attendues (${count}) ` +
      `(bloc ${start + 1}–${end + 1}).`
    );
  }
}

/**
 * Analyse complète : extraction + pose sur toutes les frames de la vidéo.
 * @param file Fichier vidéo importé
 * @param ptsTimes Timestamps vidéo exacts de chaque frame (index ffmpeg)
 */
export async function runPoseDetection(
  file: File,
  ptsTimes: Float64Array,
  onProgress: PoseProgressCallback
): Promise<PoseFrameData> {
  const frameCount = ptsTimes.length;
  if (frameCount < 4) {
    throw new Error('Vidéo trop courte pour la détection de pose.');
  }

  const data: PoseFrameData = {
    footY: new Float64Array(frameCount),
    visibility: new Float64Array(frameCount),
    points: new Array(frameCount),
  };

  let landmarker: PoseLandmarker | null = null;
  const inputName =
    'pose_input' + (file.name.includes('.') ? '.' + file.name.split('.').pop() : '.mp4').toLowerCase();

  try {
    onProgress({ stage: 'model', ratio: 0 });
    landmarker = await createPoseLandmarker((ratio) =>
      onProgress({ stage: 'model', ratio })
    );
    onProgress({ stage: 'model', ratio: 1 });

    const ffmpeg = await getFFmpegEngine();
    const bytes = new Uint8Array(await file.arrayBuffer());
    await ffmpeg.writeFile(inputName, bytes);

    const seekMarginSec = Math.min(0.5, minPositiveInterval(ptsTimes) * 0.4);
    const totalChunks = Math.ceil(frameCount / CHUNK_SIZE);
    let chunkIndex = 0;

    for (let start = 0; start < frameCount; start += CHUNK_SIZE) {
      const end = Math.min(start + CHUNK_SIZE, frameCount) - 1;
      const chunkBase = chunkIndex / totalChunks;
      await processChunk(
        ffmpeg,
        landmarker,
        inputName,
        seekMarginSec,
        start,
        end,
        ptsTimes,
        data,
        (processed) => {
          onProgress({
            stage: 'frames',
            ratio: chunkBase + (processed / (end - start + 1)) / totalChunks,
          });
        }
      );
      chunkIndex++;
    }
    onProgress({ stage: 'frames', ratio: 1 });

    return data;
  } finally {
    // Nettoyage sans re-télécharger le moteur s'il n'est pas déjà chargé
    if (isFFmpegEngineReady()) {
      const ffmpeg = await getFFmpegEngine().catch(() => null);
      if (ffmpeg) {
        await ffmpeg.deleteFile(inputName).catch(() => {});
      }
    }
    landmarker?.close();
  }
}
