/**
 * Application principale RSI Calc
 * Branche l'interface (index.html) sur les modules métier :
 * vidéo, marquage, calcul, stockage, statistiques.
 */

import Chart from 'chart.js/auto';
import type { Session, Trial, VideoMetadata, VideoFrame, MarkerPoints } from './types';
import { calculateRSI, calculateRSIFromTimestamps, formatRSIResult } from './calculation';
import { FrameByFramePlayer } from './video/player';
import { extractVideoMetadata, validateVideoFile, formatDuration } from './video/loader';
import { analyzeVideoFrames, disposeFFmpegEngine, getFFmpegEngine, isFFmpegEngineReady } from './video/ffmpegIndex';
import type { FrameIndex } from './types';
import { createMarkerManager, MARKER_TYPES } from './annotation';
import type { MarkerType } from './annotation';
import { createLocalStorageService } from './storage';
import type { LocalStorageService } from './storage';
import { createSession, createTrialFromMarkers, createTrialFromTimestamps } from './storage/session';
import { calculateSessionStats, getProgressChartData } from './stats';
import { clamp } from './utils/helpers';

// ============================================
// Services et état
// ============================================

const storage: LocalStorageService = createLocalStorageService();
const markerManager = createMarkerManager();

let videoPlayer: FrameByFramePlayer | null = null;
let currentVideo: VideoMetadata | null = null;
let currentFile: File | null = null;
let frameIndex: FrameIndex | null = null;
let currentSession: Session | null = null;
let sessions: Session[] = [];
let gravity = 9.81;
let progressChart: Chart | null = null;
let isSeeking = false;

// ============================================
// Raccourcis DOM
// ============================================

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Élément manquant : #${id}`);
  return el as T;
}

const el = {
  get loadingFallback() { return $('loading-fallback'); },
  get loadingError() { return $('loading-error'); },
  get dropZone() { return $('drop-zone'); },
  get fileInput() { return $<HTMLInputElement>('file-input'); },
  get videoSection() { return $('video-section'); },
  get videoWrapper() { return $('video-wrapper'); },
  get videoElement() { return $<HTMLVideoElement>('video-element'); },
  get btnPrevFrame() { return $<HTMLButtonElement>('btn-prev-frame'); },
  get btnPlayPause() { return $<HTMLButtonElement>('btn-play-pause'); },
  get btnNextFrame() { return $<HTMLButtonElement>('btn-next-frame'); },
  get btnZoom() { return $<HTMLButtonElement>('btn-zoom'); },
  get playbackRate() { return $<HTMLSelectElement>('playback-rate'); },
  get frameCounter() { return $('frame-counter'); },
  get videoInfo() { return $('video-info'); },
  get timeline() { return $('timeline'); },
  get timelineFill() { return $('timeline-fill'); },
  get timelineThumb() { return $('timeline-thumb'); },
  get fpsInput() { return $<HTMLInputElement>('fps-input'); },
  get gravityInput() { return $<HTMLInputElement>('gravity-input'); },
  get btnMarkLanding() { return $<HTMLButtonElement>('btn-mark-landing'); },
  get btnMarkTakeoff() { return $<HTMLButtonElement>('btn-mark-takeoff'); },
  get btnMarkFinalLanding() { return $<HTMLButtonElement>('btn-mark-final-landing'); },
  get btnResetMarkers() { return $<HTMLButtonElement>('btn-reset-markers'); },
  get btnCalculate() { return $<HTMLButtonElement>('btn-calculate'); },
  get resultsContent() { return $('results-content'); },
  get sessionStats() { return $('session-stats'); },
  get sessionNameInput() { return $<HTMLInputElement>('session-name-input'); },
  get dropHeightInput() { return $<HTMLInputElement>('drop-height-input'); },
  get btnNewSession() { return $<HTMLButtonElement>('btn-new-session'); },
  get btnSaveTrial() { return $<HTMLButtonElement>('btn-save-trial'); },
  get btnExportCsv() { return $<HTMLButtonElement>('btn-export-csv'); },
  get btnExportJson() { return $<HTMLButtonElement>('btn-export-json'); },
  get historyList() { return $('history-list'); },
  get chartCanvas() { return $<HTMLCanvasElement>('progress-chart'); },
  get btnTheme() { return $<HTMLButtonElement>('btn-theme'); },
  get alertContainer() { return $('alert-container'); },
  get btnFfmpegAnalyze() { return $<HTMLButtonElement>('btn-ffmpeg-analyze'); },
  get ffmpegStatus() { return $('ffmpeg-status'); },
  get ffmpegProgress() { return $('ffmpeg-progress'); },
  get ffmpegProgressFill() { return $('ffmpeg-progress-fill'); },
  get btnFfmpegPreload() { return $<HTMLButtonElement>('btn-ffmpeg-preload'); },
  get ffmpegPreloadStatus() { return $('ffmpeg-preload-status'); },
};

// ============================================
// Initialisation
// ============================================

export async function initApp(): Promise<void> {
  applySavedTheme();
  bindEvents();
  markerManager.addEventListener('marker:change', () => updateMarkerChips());
  await refreshSessions();
  updateHistory();
  updateChart();
  updateMarkerChips();
  el.loadingFallback.classList.add('hidden');
}

// ============================================
// Alertes (toasts)
// ============================================

function showAlert(message: string, type: 'success' | 'error' | 'info' = 'info'): void {
  const alert = document.createElement('div');
  alert.className = `alert alert-${type}`;
  alert.textContent = message;
  el.alertContainer.appendChild(alert);
  setTimeout(() => {
    alert.style.opacity = '0';
    alert.style.transition = 'opacity 0.3s ease';
    setTimeout(() => alert.remove(), 300);
  }, 4000);
}

// ============================================
// Thème
// ============================================

function applySavedTheme(): void {
  const saved = localStorage.getItem('rsi-calc-theme');
  document.body.classList.toggle('light-theme', saved === 'light');
}

function toggleTheme(): void {
  const isLight = document.body.classList.toggle('light-theme');
  localStorage.setItem('rsi-calc-theme', isLight ? 'light' : 'dark');
}

// ============================================
// Événements
// ============================================

function bindEvents(): void {
  // Import vidéo
  el.dropZone.addEventListener('click', () => el.fileInput.click());
  el.dropZone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') el.fileInput.click();
  });
  el.fileInput.addEventListener('change', () => {
    const file = el.fileInput.files?.[0];
    if (file) void handleVideoUpload(file);
    el.fileInput.value = '';
  });

  // Glisser-déposer
  const dz = el.dropZone;
  dz.addEventListener('dragover', (e) => {
    e.preventDefault();
    dz.classList.add('drag-over');
  });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag-over'));
  dz.addEventListener('drop', (e) => {
    e.preventDefault();
    dz.classList.remove('drag-over');
    const file = e.dataTransfer?.files?.[0];
    if (file) void handleVideoUpload(file);
  });

  // Contrôles vidéo (navigation sur frames uniques)
  el.btnPrevFrame.addEventListener('click', () => void goToPreviousUniqueFrame());
  el.btnNextFrame.addEventListener('click', () => void goToNextUniqueFrame());
  el.btnPlayPause.addEventListener('click', togglePlayPause);
  el.btnZoom.addEventListener('click', () => {
    el.videoWrapper.classList.toggle('zoomed');
    el.btnZoom.classList.toggle('btn-primary');
  });
  el.playbackRate.addEventListener('change', () => {
    videoPlayer?.setPlaybackRate(parseFloat(el.playbackRate.value));
  });

  // Paramètres
  el.fpsInput.addEventListener('change', () => applyFps(parseFloat(el.fpsInput.value)));
  el.gravityInput.addEventListener('change', () => {
    const g = parseFloat(el.gravityInput.value);
    gravity = clamp(Number.isFinite(g) && g > 0 ? g : 9.81, 1, 20);
    el.gravityInput.value = String(gravity);
  });

  // Marquage
  el.btnMarkLanding.addEventListener('click', () => markFrame(MARKER_TYPES.LANDING));
  el.btnMarkTakeoff.addEventListener('click', () => markFrame(MARKER_TYPES.TAKEOFF));
  el.btnMarkFinalLanding.addEventListener('click', () => markFrame(MARKER_TYPES.FINAL_LANDING));
  el.btnResetMarkers.addEventListener('click', resetMarkers);
  el.btnCalculate.addEventListener('click', calculateRSIFromMarkers);

  // Session
  el.btnNewSession.addEventListener('click', createNewSession);
  el.btnSaveTrial.addEventListener('click', saveCurrentTrial);
  el.btnExportCsv.addEventListener('click', exportCsv);
  el.btnExportJson.addEventListener('click', exportJson);

  // Timeline (clic + glisser)
  const timeline = el.timeline;
  const seekFromEvent = (e: MouseEvent | TouchEvent) => {
    if (!videoPlayer || !currentVideo) return;
    const rect = timeline.getBoundingClientRect();
    const clientX = 'touches' in e ? e.touches[0]?.clientX ?? rect.left : e.clientX;
    const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
    videoPlayer.goToFrame(Math.round(ratio * (currentVideo.frameCount - 1)));
  };
  timeline.addEventListener('mousedown', (e) => {
    isSeeking = true;
    seekFromEvent(e);
  });
  timeline.addEventListener('mousemove', (e) => {
    if (isSeeking) seekFromEvent(e);
  });
  window.addEventListener('mouseup', () => { isSeeking = false; });
  timeline.addEventListener('touchstart', seekFromEvent, { passive: true });
  timeline.addEventListener('touchmove', seekFromEvent, { passive: true });

  // Raccourcis clavier
  window.addEventListener('keydown', (e) => {
    // Ignorer si l'utilisateur tape dans un champ
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA') return;
    if (e.key === 'ArrowLeft') void goToPreviousUniqueFrame();
    if (e.key === 'ArrowRight') void goToNextUniqueFrame();
    if (e.key === ' ') {
      e.preventDefault();
      togglePlayPause();
    }
  });

  // Thème
  el.btnTheme.addEventListener('click', toggleTheme);

  // Analyse exacte (ffmpeg)
  el.btnFfmpegAnalyze.addEventListener('click', () => void runFfmpegAnalysis());

  // Préchargement du moteur (possible avant l'import d'une vidéo)
  el.btnFfmpegPreload.addEventListener('click', () => void runFfmpegPreload());
}

// ============================================
// Préchargement du moteur ffmpeg
// ============================================

let ffmpegPreloading = false;

async function runFfmpegPreload(): Promise<void> {
  if (ffmpegPreloading || isFFmpegEngineReady()) return;
  ffmpegPreloading = true;
  const button = el.btnFfmpegPreload;
  button.disabled = true;
  button.textContent = 'Préchargement en cours…';
  const status = el.ffmpegPreloadStatus;
  status.style.display = 'block';
  status.textContent = 'Chargement du moteur ffmpeg (≈32 Mo, une seule fois)…';

  try {
    await getFFmpegEngine((ratio) => {
      status.textContent =
        `Chargement du moteur ffmpeg… ${Math.round(ratio * 100)} % (une seule fois)`;
    });
    status.textContent =
      'Moteur chargé ✓ — l\'indexation des frames sera plus rapide après l\'import d\'une vidéo.';
    button.textContent = 'Moteur chargé ✓';
  } catch (error) {
    console.error('[RSI Calc] Préchargement ffmpeg :', error);
    status.textContent = `Échec : ${error instanceof Error ? error.message : String(error)}`;
    button.disabled = false;
    button.textContent = 'Réessayer le préchargement';
  } finally {
    ffmpegPreloading = false;
  }
}

// ============================================
// Vidéo
// ============================================

async function handleVideoUpload(file: File): Promise<void> {
  if (!validateVideoFile(file)) {
    showAlert(
      `Format non supporté (${file.type || 'type inconnu'}, ${(file.size / 1024 / 1024).toFixed(1)} Mo). ` +
      'Utilisez MP4, WebM ou MOV (max 500 Mo).',
      'error'
    );
    return;
  }

  let metadata;
  try {
    metadata = await extractVideoMetadata(file);
  } catch {
    showAlert('Impossible de lire les métadonnées de cette vidéo.', 'error');
    return;
  }

  const url = URL.createObjectURL(file);
  el.videoElement.preload = 'metadata';
  el.videoElement.src = url;
  el.videoElement.loop = true;

  // Attendre les métadonnées, avec timeout : certains formats (ex. HEVC/H.265
  // filmés sur iPhone) ne sont pas décodables par tous les navigateurs.
  const loaded = await new Promise<boolean>((resolve) => {
    const timeout = window.setTimeout(() => resolve(false), 15000);
    el.videoElement.onloadedmetadata = () => {
      window.clearTimeout(timeout);
      resolve(true);
    };
    el.videoElement.onerror = () => {
      window.clearTimeout(timeout);
      resolve(false);
    };
  });

  const duration = el.videoElement.duration;
  if (!loaded || !Number.isFinite(duration)) {
    el.videoElement.removeAttribute('src');
    URL.revokeObjectURL(url);
    showAlert(
      'Cette vidéo ne peut pas être lue par votre navigateur. ' +
      'Cause fréquente : format HEVC/H.265 (vidéos iPhone récentes) non supporté, ou fichier corrompu. ' +
      'Essayez une autre vidéo ou un autre navigateur.',
      'error'
    );
    return;
  }

  currentFile = file;
  frameIndex = null;

  const fps = clamp(parseFloat(el.fpsInput.value) || metadata.fps, 1, 1000);
  currentVideo = {
    ...metadata,
    duration,
    width: el.videoElement.videoWidth,
    height: el.videoElement.videoHeight,
    fps,
  };

  // Afficher la vidéo, puis l'analyse par le moteur ffmpeg se lance
  // AUTOMATIQUEMENT : c'est la seule méthode (comptage réel et timestamps
  // exacts de chaque frame — fiable en VFR, fichiers iPhone compris).
  el.videoSection.style.display = 'block';
  el.fpsInput.value = String(currentVideo.fps);
  setNavigationEnabled(false);
  el.btnFfmpegAnalyze.style.display = 'none';
  el.videoInfo.textContent = 'Analyse des frames par le moteur ffmpeg…';

  void runFfmpegAnalysis();
}

/**
 * Active/désactive la navigation frame par frame (l'index ffmpeg des
 * timestamps est indispensable — pas de méthode de substitution).
 */
function setNavigationEnabled(enabled: boolean): void {
  el.btnPrevFrame.disabled = !enabled;
  el.btnNextFrame.disabled = !enabled;
  if (!enabled) {
    el.frameCounter.textContent = 'Frame — / —';
  }
}

/**
 * Crée le lecteur frame-par-frame après l'indexation ffmpeg réussie.
 */
function initVideoPlayer(metadata: VideoMetadata): void {
  if (videoPlayer) {
    videoPlayer.destroy();
    videoPlayer = null;
  }

  videoPlayer = new FrameByFramePlayer(el.videoElement, metadata);

  videoPlayer.addEventListener('video:frame:changed', (frame: number) => {
    updateFrameUI(frame);
  });
  videoPlayer.addEventListener('video:play', () => {
    el.btnPlayPause.textContent = '⏸';
  });
  videoPlayer.addEventListener('video:pause', () => {
    el.btnPlayPause.textContent = '▶';
  });

  videoPlayer.goToFrame(0);
  markerManager.initialize(metadata.frameCount);
}

function togglePlayPause(): void {
  if (!videoPlayer) {
    showAlert('Importez d\'abord une vidéo.', 'info');
    return;
  }
  if (el.videoElement.paused) {
    void el.videoElement.play();
  } else {
    el.videoElement.pause();
  }
}

function applyFps(fps: number): void {
  const valid = clamp(Number.isFinite(fps) && fps > 0 ? fps : 240, 1, 1000);
  el.fpsInput.value = String(valid);
  if (!currentVideo) return;

  currentVideo.fps = valid;
  // Le compteur de frames vient de l'index ffmpeg (jamais d'un calcul) ;
  // le FPS d'enregistrement ne sert qu'à la conversion en temps réels
  // (facteur d'étirement) et à l'affichage.
  if (videoPlayer) {
    videoPlayer.setMetadata({ fps: valid });
  }
  updateVideoInfo();
  showAlert(`FPS d'enregistrement mis à jour : ${valid}`, 'info');
}

function updateVideoInfo(): void {
  if (!currentVideo) return;
  if (!frameIndex || !currentVideo.playbackFps) {
    el.videoInfo.textContent = 'Analyse des frames en cours…';
    return;
  }
  const k = temporalFactor();
  // Durée réelle de la scène = durée vidéo / facteur total
  const realDuration = (currentVideo.frameCount * frameIndex.medianInterval) / k;
  el.videoInfo.textContent =
    `${currentVideo.width}×${currentVideo.height} · ${formatDuration(currentVideo.duration)} · ` +
    `${currentVideo.frameCount} frames (timestamps exacts) · lecture ${Math.round(currentVideo.playbackFps)} fps` +
    (k > 1 ? ` · facteur ×${k}` : ` · ${currentVideo.fps} fps`) +
    ` · temps réel ≈ ${realDuration.toFixed(1)} s`;
}

function updateFrameUI(frame: number): void {
  if (!currentVideo) return;
  if (!currentVideo.playbackFps || currentVideo.frameCount < 1) {
    el.frameCounter.textContent = 'Frame — / —';
    return;
  }
  el.frameCounter.textContent = `Frame ${frame + 1} / ${currentVideo.frameCount}`;
  const ratio = currentVideo.frameCount > 1 ? frame / (currentVideo.frameCount - 1) : 0;
  const pct = `${(ratio * 100).toFixed(2)}%`;
  el.timelineFill.style.width = pct;
  el.timelineThumb.style.left = pct;
}

// ============================================
// Marquage
// ============================================

function markFrame(type: MarkerType): void {
  if (!videoPlayer || !currentVideo) {
    showAlert('Importez d\'abord une vidéo.', 'error');
    return;
  }
  const frameNumber = videoPlayer.getCurrentFrame();
  const frame: VideoFrame = {
    frameNumber,
    timestamp: videoPlayer.getTimeAtFrame(frameNumber),
  };
  markerManager.setMarker(type, frame);
  showAlert(`${markerLabel(type)} marqué au frame ${frameNumber + 1}.`, 'success');
}

function markerLabel(type: MarkerType): string {
  switch (type) {
    case MARKER_TYPES.LANDING: return 'Atterrissage';
    case MARKER_TYPES.TAKEOFF: return 'Décollage';
    case MARKER_TYPES.FINAL_LANDING: return 'Atterrissage final';
    default: return type;
  }
}

function resetMarkers(): void {
  markerManager.clearAllMarkers();
}

function updateMarkerChips(): void {
  const markers = markerManager.getAllMarkers();
  const chips: Array<{ key: keyof MarkerPoints; id: string }> = [
    { key: 'landing', id: 'chip-landing' },
    { key: 'takeoff', id: 'chip-takeoff' },
    { key: 'finalLanding', id: 'chip-finalLanding' },
  ];
  for (const { key, id } of chips) {
    const chip = document.getElementById(id);
    if (!chip) continue;
    const m = markers[key];
    chip.textContent = `${markerLabel(key as MarkerType)} : ${m ? `frame ${m.frameNumber + 1}` : '—'}`;
    chip.classList.toggle('set', m !== null);
    chip.classList.toggle(key, m !== null);
  }

  // Activer le bouton calcul si les marqueurs sont valides
  el.btnCalculate.disabled = !markerManager.areMarkersValid();

  // Marqueurs sur la timeline
  el.timeline.querySelectorAll('.tl-marker').forEach((n) => n.remove());
  if (!currentVideo || currentVideo.frameCount < 2) return;
  const colors: Record<string, string> = {
    landing: 'landing',
    takeoff: 'takeoff',
    finalLanding: 'finalLanding',
  };
  (['landing', 'takeoff', 'finalLanding'] as const).forEach((key) => {
    const m = markers[key];
    if (!m) return;
    const tick = document.createElement('div');
    tick.className = `tl-marker ${colors[key]}`;
    tick.style.left = `${((m.frameNumber / (currentVideo!.frameCount - 1)) * 100).toFixed(2)}%`;
    el.timeline.appendChild(tick);
  });
}

// ============================================
// Navigation frame-par-frame (saute les frames dupliquées)
// ============================================

/** Facteur de duplication confirmé (1 = aucune duplication) */
function getDuplicationFactor(): number {
  return videoPlayer?.getConfirmedDuplicationFactor() ?? 1;
}

/** Navigation en cours (évite les clics simultanés) */
let navigating = false;
let duplicationToastShown = false;

async function goToNextUniqueFrame(): Promise<void> {
  if (!videoPlayer || navigating) return;
  navigating = true;
  el.btnNextFrame.disabled = true;
  try {
    await videoPlayer.nextUniqueFrame();
    notifyDuplicationDetected();
  } finally {
    navigating = false;
    el.btnNextFrame.disabled = false;
  }
}

async function goToPreviousUniqueFrame(): Promise<void> {
  if (!videoPlayer || navigating) return;
  navigating = true;
  el.btnPrevFrame.disabled = true;
  try {
    await videoPlayer.previousUniqueFrame();
    notifyDuplicationDetected();
  } finally {
    navigating = false;
    el.btnPrevFrame.disabled = false;
  }
}

/** Prévient l'utilisateur qu'un facteur de duplication a été détecté */
function notifyDuplicationDetected(): void {
  const factor = getDuplicationFactor();
  updateVideoInfo();
  if (factor > 1 && !duplicationToastShown) {
    duplicationToastShown = true;
    showAlert(
      `Frames dupliquées détectées (×${factor}) : chaque clic avance d'une vraie frame. ` +
      'Les calculs sont ajustés automatiquement.',
      'info'
    );
  }
}

// ============================================
// Analyse exacte des frames (ffmpeg.wasm)
// ============================================

let ffmpegAnalyzing = false;

function ffmpegSetStatus(text: string | null): void {
  if (text) {
    el.ffmpegStatus.textContent = text;
    el.ffmpegStatus.style.display = 'block';
  } else {
    el.ffmpegStatus.style.display = 'none';
  }
}

function ffmpegSetProgress(ratio: number | null): void {
  if (ratio === null) {
    el.ffmpegProgress.style.display = 'none';
    el.ffmpegProgressFill.style.width = '0%';
  } else {
    el.ffmpegProgress.style.display = 'block';
    el.ffmpegProgressFill.style.width = `${Math.round(ratio * 100)}%`;
  }
}

/**
 * Facteur temporel k : rapport entre l'intervalle vidéo médian des frames
 * et la période de capture réelle (1/fps d'enregistrement). k = 1 quand la
 * vidéo est à la cadence de capture (fichiers iPhone originaux) ; k > 1
 * pour un export étiré (durée ×k). Temps réel = temps vidéo / k.
 */
function temporalFactor(): number {
  if (!frameIndex || !currentVideo) return 1;
  // Facteur total = étirement de la timeline (intervalle vidéo médian ×
  // fps de capture) × duplication confirmée (frames identiques consécutives).
  // Couvre les trois structures d'export : cadence de capture (×1),
  // export étiré (×k), export avec frames dupliquées (×k).
  const stretch = Math.max(1, Math.round(frameIndex.medianInterval * currentVideo.fps));
  return stretch * getDuplicationFactor();
}

/** Temps réel d'une frame depuis l'index ffmpeg (VFR-exact) */
function realTimeOfFrame(frameNumber: number): number | null {
  if (!frameIndex || frameNumber < 0 || frameNumber >= frameIndex.ptsTimes.length) {
    return null;
  }
  return frameIndex.ptsTimes[frameNumber] / temporalFactor();
}

async function runFfmpegAnalysis(): Promise<void> {
  if (!currentVideo || !currentFile || ffmpegAnalyzing) return;
  ffmpegAnalyzing = true;
  el.btnFfmpegAnalyze.disabled = true;
  el.btnFfmpegAnalyze.style.display = 'none';
  ffmpegSetProgress(0);

  try {
    if (frameIndex) {
      // Relance : réinitialiser l'état précédent
      frameIndex = null;
      videoPlayer?.setTimestampIndex(null);
    }

    ffmpegSetStatus(
      isFFmpegEngineReady()
        ? 'Décodage de la vidéo et indexation des timestamps…'
        : 'Chargement du moteur ffmpeg (≈32 Mo, une seule fois)…'
    );
    ffmpegSetProgress(null);
    const index = await analyzeVideoFrames(currentFile, {
      onDecodeProgress: (ratio) => {
        ffmpegSetStatus('Décodage de la vidéo et indexation des timestamps…');
        ffmpegSetProgress(ratio);
      },
    });

    frameIndex = index;
    // FPS de lecture équivalent, dérivé de l'index (affichage uniquement)
    currentVideo.playbackFps =
      index.medianInterval > 0 ? Math.round(1 / index.medianInterval) : currentVideo.fps;
    currentVideo.frameCount = index.frameCount;

    // Créer (ou recréer) le lecteur avec l'index des timestamps exacts
    initVideoPlayer(currentVideo);
    videoPlayer!.setTimestampIndex(index);
    resetMarkers();
    markerManager.initialize(index.frameCount);
    setNavigationEnabled(true);

    ffmpegSetStatus(null);
    ffmpegSetProgress(null);
    updateVideoInfo();
    updateFrameUI(0);

    const k = temporalFactor();
    const realDuration = (index.frameCount * index.medianInterval) / k;
    showAlert(
      `Vidéo analysée : ${index.frameCount} frames réelles (timestamps exacts)` +
      (k > 1 ? `, facteur ×${k}` : '') +
      ` — temps réel ≈ ${realDuration.toFixed(1)} s.`,
      'success'
    );
  } catch (error) {
    console.error('[RSI Calc] Analyse ffmpeg :', error);
    ffmpegSetStatus(`Échec : ${error instanceof Error ? error.message : String(error)}`);
    ffmpegSetProgress(null);
    setNavigationEnabled(false);
    el.btnFfmpegAnalyze.textContent = 'Réessayer l\'analyse des frames';
    el.btnFfmpegAnalyze.style.display = 'block';
    // Libérer le moteur en cas d'erreur mémoire pour permettre un nouvel essai
    if (/memory|allocation|abort/i.test(String(error))) {
      disposeFFmpegEngine();
      ffmpegSetStatus(`Échec (mémoire insuffisante) : ${error instanceof Error ? error.message : error}. Réessayez.`);
    }
  } finally {
    ffmpegAnalyzing = false;
    el.btnFfmpegAnalyze.disabled = false;
  }
}

function calculateRSIFromMarkers(): void {
  if (!currentVideo || !markerManager.areMarkersValid()) {
    showAlert('Marquez les 3 frames dans l\'ordre : atterrissage, décollage, atterrissage final.', 'error');
    return;
  }

  const markers = markerManager.getAllMarkers();
  const landing = markers.landing!;
  const takeoff = markers.takeoff!;
  const finalLanding = markers.finalLanding!;

  try {
    // Priorité à la méthode VFR-exact : temps réels issus de l'index
    // ffmpeg (différence de timestamps — correcte même si la cadence
    // varie au fil de la vidéo).
    const t1 = realTimeOfFrame(landing.frameNumber);
    const t2 = realTimeOfFrame(takeoff.frameNumber);
    const t3 = realTimeOfFrame(finalLanding.frameNumber);

    let result;
    let method: string;
    if (t1 !== null && t2 !== null && t3 !== null) {
      result = calculateRSIFromTimestamps(t1, t2, t3, gravity);
      method = 'timestamps exacts (ffmpeg, VFR)';
    } else {
      // Sans index : cadence supposée constante (fps × duplication)
      const effectiveFps = currentVideo.fps * getDuplicationFactor();
      result = calculateRSI(
        landing.frameNumber,
        takeoff.frameNumber,
        finalLanding.frameNumber,
        effectiveFps,
        gravity
      );
      method = 'cadence constante supposée';
    }
    const formatted = formatRSIResult(result);
    displayResults(formatted);
    showAlert(`RSI calculé (${method}).`, 'success');
  } catch (error) {
    console.error(error);
    showAlert(`Erreur de calcul : ${error instanceof Error ? error.message : String(error)}`, 'error');
  }
}

function displayResults(formatted: {
  contactTimeMs: number;
  flightTimeMs: number;
  heightCm: number;
  rsi: number;
  modifiedRsi: number;
}): void {
  const items = [
    { label: 'Temps de contact', value: formatted.contactTimeMs, unit: 'ms' },
    { label: 'Temps de vol', value: formatted.flightTimeMs, unit: 'ms' },
    { label: 'Hauteur', value: formatted.heightCm, unit: 'cm' },
    { label: 'RSI', value: formatted.rsi, unit: 'm/s', highlight: true },
    { label: 'RSI modifié', value: formatted.modifiedRsi, unit: 'm/s' },
  ];

  el.resultsContent.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'results-grid';
  for (const item of items) {
    const box = document.createElement('div');
    box.className = 'result-item';
    const label = document.createElement('span');
    label.className = 'result-label';
    label.textContent = item.label;
    const value = document.createElement('span');
    value.className = item.highlight ? 'result-value highlight' : 'result-value';
    value.textContent = String(item.value);
    const unit = document.createElement('span');
    unit.className = 'result-unit';
    unit.textContent = item.unit;
    box.append(label, value, unit);
    grid.appendChild(box);
  }
  el.resultsContent.appendChild(grid);
  updateSessionStatsDisplay();
}

// ============================================
// Sessions et essais
// ============================================

async function refreshSessions(): Promise<void> {
  sessions = await storage.getAllSessions();
  sessions.sort((a, b) => b.createdAt - a.createdAt);
}

async function createNewSession(): Promise<void> {
  const name = el.sessionNameInput.value.trim() || `Session ${new Date().toLocaleDateString('fr-FR')}`;
  const dropHeight = clamp(parseFloat(el.dropHeightInput.value) || 30, 5, 100);
  el.dropHeightInput.value = String(dropHeight);

  const session = createSession(name, dropHeight);
  await storage.saveSession(session);
  currentSession = session;
  sessions = [session, ...sessions.filter((s) => s.id !== session.id)];

  el.sessionNameInput.value = name;
  updateHistory();
  updateChart();
  updateSessionStatsDisplay();
  showAlert(`Session « ${name} » créée.`, 'success');
}

async function saveCurrentTrial(): Promise<void> {
  if (!currentSession) {
    showAlert('Créez d\'abord une session (bouton « Nouvelle session »).', 'error');
    return;
  }
  if (!currentVideo || !markerManager.areMarkersValid()) {
    showAlert('Importez une vidéo et marquez les 3 frames.', 'error');
    return;
  }

  // Priorité à la méthode VFR-exact (timestamps réels de l'index ffmpeg) ;
  // sinon cadence constante supposée (fps d'enregistrement × duplication).
  const markers = markerManager.getAllMarkers();
  const t1 = realTimeOfFrame(markers.landing!.frameNumber);
  const t2 = realTimeOfFrame(markers.takeoff!.frameNumber);
  const t3 = realTimeOfFrame(markers.finalLanding!.frameNumber);

  let trial: Trial;
  if (t1 !== null && t2 !== null && t3 !== null) {
    trial = createTrialFromTimestamps(
      currentSession.id,
      {
        landing: markers.landing!.frameNumber,
        takeoff: markers.takeoff!.frameNumber,
        finalLanding: markers.finalLanding!.frameNumber,
      },
      { landing: t1, takeoff: t2, finalLanding: t3 },
      currentVideo,
      gravity
    );
  } else {
    const effectiveMetadata = { ...currentVideo, fps: currentVideo.fps * getDuplicationFactor() };
    trial = createTrialFromMarkers(
      currentSession.id,
      markers,
      effectiveMetadata,
      gravity
    );
  }

  try {
    await storage.addTrial(currentSession.id, trial);
    currentSession.trials.push(trial);
    currentSession.updatedAt = Date.now();
    await storage.saveSession(currentSession);

    // Rafraîchir la session depuis le stockage pour rester cohérent
    const stored = await storage.getSession(currentSession.id);
    if (stored) currentSession = stored;

    resetMarkers();
    updateHistory();
    updateChart();
    updateSessionStatsDisplay();
    showAlert('Essai sauvegardé.', 'success');
  } catch (error) {
    console.error(error);
    showAlert('Erreur lors de la sauvegarde de l\'essai.', 'error');
  }
}

function updateSessionStatsDisplay(): void {
  if (!currentSession || currentSession.trials.length === 0) {
    el.sessionStats.style.display = 'none';
    return;
  }
  const stats = calculateSessionStats(currentSession);
  el.sessionStats.style.display = 'flex';
  el.sessionStats.innerHTML =
    `<span><strong>${stats.trialCount}</strong> essai(s)</span>` +
    `<span>RSI moyen : <strong>${stats.meanRsi} m/s</strong></span>` +
    `<span>Écart-type : <strong>${stats.stdDevRsi}</strong></span>` +
    `<span>Hauteur moyenne : <strong>${stats.meanHeight} cm</strong></span>` +
    `<span>Contact moyen : <strong>${stats.meanContactTime} ms</strong></span>`;
}

// ============================================
// Historique
// ============================================

function updateHistory(): void {
  const list = el.historyList;
  list.innerHTML = '';

  if (sessions.length === 0) {
    list.innerHTML = '<p class="empty-state">Aucune session enregistrée.</p>';
    return;
  }

  for (const session of sessions) {
    const stats = calculateSessionStats(session);
    const item = document.createElement('div');
    item.className = 'session-item';

    const info = document.createElement('div');
    const name = document.createElement('div');
    name.className = 's-name';
    name.textContent = session.name + (currentSession?.id === session.id ? ' (active)' : '');
    const meta = document.createElement('div');
    meta.className = 's-meta';
    meta.textContent =
      `${session.date} · drop ${session.dropHeightCm} cm · ${session.trials.length} essai(s)` +
      (stats.trialCount > 0 ? ` · RSI moyen ${stats.meanRsi} m/s` : '');
    info.append(name, meta);

    const actions = document.createElement('div');
    actions.className = 's-actions';

    const selectBtn = document.createElement('button');
    selectBtn.className = 'btn btn-sm';
    selectBtn.textContent = 'Sélectionner';
    selectBtn.addEventListener('click', () => {
      currentSession = session;
      el.sessionNameInput.value = session.name;
      el.dropHeightInput.value = String(session.dropHeightCm);
      updateHistory();
      updateSessionStatsDisplay();
      showAlert(`Session « ${session.name} » sélectionnée.`, 'info');
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn btn-sm btn-danger';
    deleteBtn.textContent = 'Supprimer';
    deleteBtn.addEventListener('click', () => void deleteSession(session));

    actions.append(selectBtn, deleteBtn);
    item.append(info, actions);
    list.appendChild(item);
  }
}

async function deleteSession(session: Session): Promise<void> {
  if (!window.confirm(`Supprimer la session « ${session.name} » ? Cette action est irréversible.`)) {
    return;
  }
  try {
    await storage.deleteSession(session.id);
    sessions = sessions.filter((s) => s.id !== session.id);
    if (currentSession?.id === session.id) currentSession = null;
    updateHistory();
    updateChart();
    updateSessionStatsDisplay();
    showAlert('Session supprimée.', 'info');
  } catch (error) {
    console.error(error);
    showAlert('Erreur lors de la suppression.', 'error');
  }
}

// ============================================
// Export
// ============================================

function downloadFile(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function exportCsv(): Promise<void> {
  if (currentSession) {
    const csv = await storage.exportSessionToCSV(currentSession.id);
    downloadFile(`\uFEFF${csv}`, `rsi-session-${currentSession.name.replace(/\s+/g, '_')}.csv`, 'text/csv;charset=utf-8');
    showAlert('Session exportée en CSV.', 'success');
  } else {
    const csv = await storage.exportToCSV();
    downloadFile(`\uFEFF${csv}`, 'rsi-calc-export.csv', 'text/csv;charset=utf-8');
    showAlert('Toutes les sessions exportées en CSV.', 'success');
  }
}

async function exportJson(): Promise<void> {
  if (currentSession) {
    const json = await storage.exportSessionToJSON(currentSession.id);
    downloadFile(json, `rsi-session-${currentSession.name.replace(/\s+/g, '_')}.json`, 'application/json');
    showAlert('Session exportée en JSON.', 'success');
  } else {
    const json = await storage.exportToJSON();
    downloadFile(json, 'rsi-calc-export.json', 'application/json');
    showAlert('Toutes les données exportées en JSON.', 'success');
  }
}

// ============================================
// Graphique de progression
// ============================================

function updateChart(): void {
  const chartData = getProgressChartData(sessions);

  if (progressChart) {
    progressChart.destroy();
    progressChart = null;
  }

  if (chartData.labels.length === 0) {
    return;
  }

  const textColor = getComputedStyle(document.body).color;

  progressChart = new Chart(el.chartCanvas, {
    type: 'line',
    data: {
      labels: chartData.labels,
      datasets: [
        {
          label: 'RSI moyen (m/s)',
          data: chartData.datasets.rsi,
          borderColor: '#e94560',
          backgroundColor: 'rgba(233, 69, 96, 0.15)',
          fill: true,
          tension: 0.35,
          spanGaps: true,
        },
        {
          label: 'RSI modifié moyen (m/s)',
          data: chartData.datasets.modifiedRsi,
          borderColor: '#4d9fff',
          backgroundColor: 'rgba(77, 159, 255, 0.12)',
          fill: true,
          tension: 0.35,
          spanGaps: true,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: textColor } },
      },
      scales: {
        x: {
          ticks: { color: textColor, maxRotation: 45 },
          grid: { color: 'rgba(128,128,128,0.15)' },
        },
        y: {
          beginAtZero: true,
          ticks: { color: textColor },
          grid: { color: 'rgba(128,128,128,0.15)' },
        },
      },
    },
  });
}
