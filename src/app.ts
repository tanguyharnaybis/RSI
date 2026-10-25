/**
 * Application principale RSI Calc
 * Branche l'interface (index.html) sur les modules métier :
 * vidéo, marquage, calcul, stockage, statistiques.
 */

import Chart from 'chart.js/auto';
import type { Session, Trial, VideoMetadata, VideoFrame, MarkerPoints } from './types';
import { calculateRSI, formatRSIResult } from './calculation';
import { FrameByFramePlayer } from './video/player';
import { extractVideoMetadata, validateVideoFile, computeFrameCount, formatDuration, detectPlaybackFps } from './video/loader';
import { parseMp4FileMetadata } from './video/metadataParser';
import { createMarkerManager, MARKER_TYPES } from './annotation';
import type { MarkerType } from './annotation';
import { createLocalStorageService } from './storage';
import type { LocalStorageService } from './storage';
import { createSession, createTrialFromMarkers } from './storage/session';
import { calculateSessionStats, getProgressChartData } from './stats';
import { clamp } from './utils/helpers';

// ============================================
// Services et état
// ============================================

const storage: LocalStorageService = createLocalStorageService();
const markerManager = createMarkerManager();

let videoPlayer: FrameByFramePlayer | null = null;
let currentVideo: VideoMetadata | null = null;
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

  // Contrôles vidéo
  el.btnPrevFrame.addEventListener('click', () => videoPlayer?.previousFrame());
  el.btnNextFrame.addEventListener('click', () => videoPlayer?.nextFrame());
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
    if (e.key === 'ArrowLeft') videoPlayer?.previousFrame();
    if (e.key === 'ArrowRight') videoPlayer?.nextFrame();
    if (e.key === ' ') {
      e.preventDefault();
      togglePlayPause();
    }
  });

  // Thème
  el.btnTheme.addEventListener('click', toggleTheme);
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

  const fps = clamp(parseFloat(el.fpsInput.value) || metadata.fps, 1, 1000);
  currentVideo = {
    ...metadata,
    duration,
    width: el.videoElement.videoWidth,
    height: el.videoElement.videoHeight,
    fps,
  };

  // Déterminer le FPS de lecture du conteneur, qui sert à la navigation
  // frame-par-frame, et le nombre exact de frames.
  // Priorité 1 : parsing binaire du fichier (table stts du MP4/MOV) — exact.
  // Priorité 2 : mesure à la lecture (requestVideoFrameCallback) — approximative.
  // Priorité 3 : le FPS d'enregistrement saisi — fallback.
  const parsed = await parseMp4FileMetadata(file);
  let playbackFps: number;
  let frameCount: number;
  let detectionSource: string;

  if (parsed && parsed.frameCount > 1 && parsed.playbackFps > 0) {
    playbackFps = parsed.playbackFps;
    frameCount = parsed.frameCount;
    detectionSource = 'métadonnées du fichier';
  } else {
    const detected = await detectPlaybackFps(el.videoElement);
    el.videoElement.pause();
    el.videoElement.currentTime = 0;
    if (detected && detected > 0) {
      playbackFps = detected;
      detectionSource = 'mesure à la lecture';
    } else {
      playbackFps = currentVideo.fps;
      detectionSource = 'approximation — réglez le FPS de lecture si la navigation semble incorrecte';
    }
    frameCount = computeFrameCount(duration, playbackFps);
  }

  currentVideo.playbackFps = playbackFps;
  currentVideo.frameCount = frameCount;

  initVideoPlayer(currentVideo);
  resetMarkers();

  el.videoSection.style.display = 'block';
  el.fpsInput.value = String(currentVideo.fps);
  updateVideoInfo();
  updateFrameUI(0);

  const slowdown = currentVideo.fps / playbackFps;
  const realDuration = frameCount / currentVideo.fps;
  const ratioNote = slowdown > 1.05
    ? ` Ralenti ×${slowdown.toFixed(1)} — temps réel du saut ≈ ${realDuration.toFixed(1)} s.`
    : '';
  showAlert(
    `Vidéo chargée : ${frameCount} frames, lecture ${Math.round(playbackFps)} fps (${detectionSource}).${ratioNote}`,
    'success'
  );
}

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
  // Le compteur de frames reste basé sur le FPS de lecture (navigation)
  const playback = currentVideo.playbackFps ?? currentVideo.fps;
  currentVideo.frameCount = computeFrameCount(currentVideo.duration, playback);
  markerManager.initialize(currentVideo.frameCount);
  if (videoPlayer) {
    videoPlayer.setMetadata({ fps: valid, frameCount: currentVideo.frameCount });
  }
  updateVideoInfo();
  updateFrameUI(videoPlayer?.getCurrentFrame() ?? 0);
  showAlert(`FPS d'enregistrement mis à jour : ${valid}`, 'info');
}

function updateVideoInfo(): void {
  if (!currentVideo) return;
  const playback = currentVideo.playbackFps ?? currentVideo.fps;
  const slowdown = currentVideo.fps / playback;
  const realDuration = currentVideo.frameCount / currentVideo.fps;
  el.videoInfo.textContent =
    `${currentVideo.width}×${currentVideo.height} · ${formatDuration(currentVideo.duration)} · ` +
    `${currentVideo.frameCount} frames · lecture ${Math.round(playback)} fps` +
    (slowdown > 1.05
      ? ` · ralenti ×${slowdown.toFixed(1)} · enregistrement ${currentVideo.fps} fps · temps réel ≈ ${realDuration.toFixed(1)} s`
      : ` · ${currentVideo.fps} fps`);
}

function updateFrameUI(frame: number): void {
  if (!currentVideo) return;
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
// Calcul RSI
// ============================================

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
    const result = calculateRSI(
      landing.frameNumber,
      takeoff.frameNumber,
      finalLanding.frameNumber,
      currentVideo.fps,
      gravity
    );
    const formatted = formatRSIResult(result);
    displayResults(formatted);
    showAlert('RSI calculé.', 'success');
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

  const trial: Trial = createTrialFromMarkers(
    currentSession.id,
    markerManager.getAllMarkers(),
    currentVideo,
    gravity
  );

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
