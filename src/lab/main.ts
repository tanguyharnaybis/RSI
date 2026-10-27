/**
 * Labo de détection (page de développement, non déployée).
 *
 * Réutilise le moteur de la PWA (index ffmpeg, pose MediaPipe, pipeline
 * pogoEvents) sur une vidéo test locale, avec :
 *  - des paramètres de détection réglables en direct (lissage, ligne de
 *    sol, epsilon, seuils, bornes, critère d'arrêt, frame de départ) ;
 *  - la visualisation complète : trajectoire de la pointe, ligne de sol,
 *    seuil, événements, phases contact/vol ;
 *  - un export JSON de diagnostic (paramètres + événements + sauts +
 *    trajectoire) pour itérer sur l'algorithme hors de la PWA.
 */

import { analyzeVideoFrames } from '../video/ffmpegIndex';
import type { FrameIndex } from '../types';
import { validateVideoFile } from '../video/loader';
import { FrameByFramePlayer } from '../video/player';
import { determineTimeFactor, estimateDuplication } from '../calculation/timeSource';
import type { TimeFactor } from '../calculation/timeSource';
import { runPoseDetection } from '../pose/poseEngine';
import type { PoseFrameData } from '../pose/poseEngine';
import {
  smooth,
  estimateGroundLine,
  adaptiveEpsilon,
  detectFootEvents,
  reconstructJumps,
} from '../pose/pogoEvents';
import type { FootEvent, PogoJump, RejectedJump } from '../pose/pogoEvents';
import { calculateRSIFromTimestamps, formatRSIResult } from '../calculation';
import { clamp } from '../utils/helpers';

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Élément manquant : #${id}`);
  return el as T;
};

const el = {
  dropzone: $<HTMLDivElement>('dropzone'),
  fileInput: $<HTMLInputElement>('file-input'),
  statusIndex: $('status-index'),
  progressIndex: $('progress-index'),
  pipelineCard: $('pipeline-card'),
  videoCard: $('video-card'),
  chartCard: $('chart-card'),
  resultsCard: $('results-card'),
  video: $<HTMLVideoElement>('video'),
  overlay: $<HTMLCanvasElement>('lab-overlay'),
  chart: $<HTMLCanvasElement>('lab-chart'),
  chartCursor: $<HTMLCanvasElement>('lab-chart-cursor'),
  jumpsSummary: $('jumps-summary'),
  jumpsTable: $<HTMLTableElement>('jumps-table'),
  eventsTable: $<HTMLTableElement>('events-table'),
  rejectedList: $('rejected-list'),
  statusPose: $('status-pose'),
  progressPose: $('progress-pose'),
  frameInfo: $('frame-info'),
  pFps: $<HTMLInputElement>('p-fps'),
  pSmooth: $<HTMLInputElement>('p-smooth'),
  pGround: $<HTMLInputElement>('p-ground'),
  pEps: $<HTMLInputElement>('p-eps'),
  pVel: $<HTMLInputElement>('p-vel'),
  pSettling: $<HTMLSelectElement>('p-settling'),
  pCmin: $<HTMLInputElement>('p-cmin'),
  pCmax: $<HTMLInputElement>('p-cmax'),
  pFmin: $<HTMLInputElement>('p-fmin'),
  pFmax: $<HTMLInputElement>('p-fmax'),
  pStart: $<HTMLInputElement>('p-start'),
  btnRun: $<HTMLButtonElement>('btn-run'),
  btnSetStart: $<HTMLButtonElement>('btn-set-start'),
  btnClearStart: $<HTMLButtonElement>('btn-clear-start'),
  btnRepose: $<HTMLButtonElement>('btn-repose'),
  btnExport: $<HTMLButtonElement>('btn-export'),
  btnPrev: $<HTMLButtonElement>('btn-prev'),
  btnPrev10: $<HTMLButtonElement>('btn-prev10'),
  btnPlay: $<HTMLButtonElement>('btn-play'),
  btnNext10: $<HTMLButtonElement>('btn-next10'),
  btnNext: $<HTMLButtonElement>('btn-next'),
};

// ---------------------------------------------------------------------------
// État
// ---------------------------------------------------------------------------

let currentFile: File | null = null;
let frameIndex: FrameIndex | null = null;
let poseData: PoseFrameData | null = null;
let player: FrameByFramePlayer | null = null;
let timeFactorValue: TimeFactor = { factor: 1, source: 'manual-fps', label: '' };
let pipeline: {
  smoothY: Float64Array;
  ground: Float64Array;
  epsilon: number;
  events: FootEvent[];
  jumps: PogoJump[];
  rejected: RejectedJump[];
} | null = null;

function setStatus(node: HTMLElement, text: string): void {
  node.textContent = text;
}

function setProgress(bar: HTMLElement, ratio: number | null): void {
  if (ratio === null) {
    bar.style.display = 'none';
  } else {
    bar.style.display = 'block';
    (bar.firstElementChild as HTMLElement).style.width = `${Math.round(ratio * 100)}%`;
  }
}

// ---------------------------------------------------------------------------
// Paramètres
// ---------------------------------------------------------------------------

interface LabParams {
  manualFps: number;
  smoothWindow: number;
  groundWindowSec: number;
  epsilonFactor: number;
  velocityThreshold: number;
  requireSettling: boolean;
  minContactMs: number;
  maxContactMs: number;
  minFlightMs: number;
  maxFlightMs: number;
  startFrame: number | null;
}

function readParams(): LabParams {
  const startRaw = parseInt(el.pStart.value, 10);
  return {
    manualFps: clamp(parseFloat(el.pFps.value) || 240, 1, 1000),
    smoothWindow: Math.max(1, Math.round(parseFloat(el.pSmooth.value) || 5)),
    groundWindowSec: clamp(parseFloat(el.pGround.value) || 2, 0.5, 10),
    epsilonFactor: clamp(parseFloat(el.pEps.value) || 1, 0.1, 10),
    velocityThreshold: Math.max(0, parseFloat(el.pVel.value) || 0),
    requireSettling: el.pSettling.value === '1',
    minContactMs: Math.max(0, parseFloat(el.pCmin.value) || 0),
    maxContactMs: Math.max(0, parseFloat(el.pCmax.value) || 0),
    minFlightMs: Math.max(0, parseFloat(el.pFmin.value) || 0),
    maxFlightMs: Math.max(0, parseFloat(el.pFmax.value) || 0),
    startFrame: Number.isFinite(startRaw) && startRaw > 0 ? startRaw - 1 : null,
  };
}

/** Temps réels de chaque frame (mêmes règles que la PWA) */
function computeFrameTimes(ptsTimes: Float64Array, params: LabParams): Float64Array {
  const containerFps =
    frameIndex && frameIndex.medianInterval > 0 ? 1 / frameIndex.medianInterval : 0;
  const duplication =
    frameIndex?.sceneScores ? estimateDuplication(frameIndex.sceneScores) : 1;
  timeFactorValue = determineTimeFactor(containerFps, duplication, params.manualFps);
  const out = new Float64Array(ptsTimes.length);
  for (let i = 0; i < out.length; i++) {
    out[i] = ptsTimes[i] / timeFactorValue.factor;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Import + analyse
// ---------------------------------------------------------------------------

async function handleFile(file: File): Promise<void> {
  if (!validateVideoFile(file)) {
    setStatus(el.statusIndex, 'Format non supporté (MP4/WebM/MOV, max 500 Mo).');
    return;
  }
  currentFile = file;
  frameIndex = null;
  poseData = null;
  pipeline = null;
  el.pipelineCard.style.display = 'none';
  el.videoCard.style.display = 'none';
  el.chartCard.style.display = 'none';
  el.resultsCard.style.display = 'none';

  // Précharger la vidéo pour le lecteur
  el.video.src = URL.createObjectURL(file);
  await new Promise<void>((resolve) => {
    el.video.onloadedmetadata = () => resolve();
    el.video.onerror = () => resolve();
  });

  setStatus(el.statusIndex, 'Indexation des frames par ffmpeg…');
  setProgress(el.progressIndex, 0);
  try {
    frameIndex = await analyzeVideoFrames(file, {
      onDecodeProgress: (ratio) => setProgress(el.progressIndex, ratio),
    });
    setProgress(el.progressIndex, null);
    setStatus(
      el.statusIndex,
      `${frameIndex.frameCount} frames indexées · intervalle médian ` +
      `${(frameIndex.medianInterval * 1000).toFixed(2)} ms. Pose en cours…`
    );
    el.pipelineCard.style.display = 'block';
    el.videoCard.style.display = 'block';
    initPlayer();
    await runPose(true);
  } catch (error) {
    setProgress(el.progressIndex, null);
    setStatus(
      el.statusIndex,
      `Échec : ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function initPlayer(): void {
  if (!frameIndex) return;
  player?.destroy();
  player = new FrameByFramePlayer(el.video, {
    duration: el.video.duration,
    fps: 240,
    frameCount: frameIndex.frameCount,
    width: el.video.videoWidth,
    height: el.video.videoHeight,
    isSlowMotion: true,
  });
  player.setTimestampIndex(frameIndex);
  player.addEventListener('video:frame:changed', (frame: number) => {
    updateFrameInfo(frame);
    drawOverlay(frame);
    drawCursor(frame);
  });
  player.goToFrame(0);
}

async function runPose(force: boolean): Promise<void> {
  if (!currentFile || !frameIndex) return;
  if (poseData && !force) {
    runPipeline();
    return;
  }
  setStatus(el.statusPose, 'Extraction des frames + pose IA…');
  setProgress(el.progressPose, 0);
  try {
    poseData = await runPoseDetection(currentFile, frameIndex.ptsTimes, (progress) => {
      if (progress.stage === 'model') {
        setStatus(el.statusPose, `Chargement du modèle de pose… ${Math.round(progress.ratio * 100)} %`);
        setProgress(el.progressPose, progress.ratio * 0.2);
      } else {
        setStatus(el.statusPose, 'Extraction des frames + détection de la pose…');
        setProgress(el.progressPose, 0.2 + progress.ratio * 0.8);
      }
    });
    setProgress(el.progressPose, null);
    const lowVis = countLowVisibility(poseData);
    setStatus(
      el.statusPose,
      `Pose extraite sur ${poseData.footY.length} frames` +
      (lowVis > 0 ? ` (${lowVis} à faible visibilité)` : '') + '.'
    );
    runPipeline();
  } catch (error) {
    setProgress(el.progressPose, null);
    setStatus(
      el.statusPose,
      `Échec : ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function countLowVisibility(data: PoseFrameData): number {
  let count = 0;
  for (let i = 0; i < data.visibility.length; i++) {
    if (data.visibility[i] < 0.6) count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Pipeline (paramétrable, recalculé sans réextraire la pose)
// ---------------------------------------------------------------------------

function runPipeline(): void {
  if (!poseData || !frameIndex) return;
  const params = readParams();
  const frameTimes = computeFrameTimes(frameIndex.ptsTimes, params);

  const smoothY = smooth(poseData.footY, params.smoothWindow);
  const ground = estimateGroundLine(smoothY, frameTimes, params.groundWindowSec);
  const epsilon = adaptiveEpsilon(smoothY, ground) * params.epsilonFactor;

  let events = detectFootEvents(frameTimes, smoothY, ground, epsilon, {
    velocityThreshold: params.velocityThreshold,
    requireSettling: params.requireSettling,
    visibility: poseData.visibility,
  });
  if (params.startFrame !== null) {
    events = events.filter((e) => e.frame >= params.startFrame!);
  }

  const { jumps, rejected } = reconstructJumps(events, frameTimes, {
    minContactMs: params.minContactMs,
    maxContactMs: params.maxContactMs,
    minFlightMs: params.minFlightMs,
    maxFlightMs: params.maxFlightMs,
  });

  pipeline = { smoothY, ground, epsilon, events, jumps, rejected };

  el.chartCard.style.display = 'block';
  el.resultsCard.style.display = 'block';
  drawChart();
  drawCursor(player?.getCurrentFrame() ?? 0);
  renderResults(frameTimes);
  setStatus(
    el.jumpsSummary,
    `${jumps.length} saut(s) reconstruit(s) · ${events.length} événement(s)` +
    (rejected.length > 0 ? ` · ${rejected.length} rejeté(s)` : '') +
    ` · epsilon ${epsilon.toFixed(4)} · facteur temps ×${timeFactorValue.factor} (${timeFactorValue.label})`
  );
}

// ---------------------------------------------------------------------------
// Graphique de trajectoire
// ---------------------------------------------------------------------------

interface ChartScale {
  x: (frame: number) => number;
  y: (value: number) => number;
}

function chartScale(): ChartScale | null {
  if (!pipeline || pipeline.smoothY.length < 2) return null;
  const canvas = el.chart;
  const width = canvas.width;
  const height = canvas.height;
  const frameCount = pipeline.smoothY.length;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const v of pipeline.smoothY) {
    if (v < minY) minY = v;
    if (v > maxY) maxY = v;
  }
  const padY = (maxY - minY) * 0.1 || 0.01;
  minY -= padY;
  maxY += padY;
  return {
    x: (frame: number) => (frame / (frameCount - 1)) * width,
    y: (value: number) => height - ((value - minY) / (maxY - minY)) * height,
  };
}

function drawChart(): void {
  const canvas = el.chart;
  const ctx = canvas.getContext('2d');
  if (!ctx || !pipeline || !poseData) return;
  canvas.width = canvas.clientWidth * 2;
  canvas.height = canvas.clientHeight * 2;
  ctx.scale(1, 1);
  const scale = chartScale();
  if (!scale) return;
  const { x, y } = scale;
  const n = pipeline.smoothY.length;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Phases contact/vol (bandes)
  for (const jump of pipeline.jumps) {
    ctx.fillStyle = 'rgba(46, 204, 113, 0.15)';
    ctx.fillRect(x(jump.landingFrame), 0, x(jump.takeoffFrame) - x(jump.landingFrame), canvas.height);
    ctx.fillStyle = 'rgba(77, 159, 255, 0.12)';
    ctx.fillRect(x(jump.takeoffFrame), 0, x(jump.finalLandingFrame) - x(jump.takeoffFrame), canvas.height);
  }

  // Trajectoire brute
  ctx.strokeStyle = 'rgba(154, 161, 181, 0.5)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const px = x(i);
    const py = y(poseData.footY[i]);
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.stroke();

  // Trajectoire lissée
  ctx.strokeStyle = '#4d9fff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const px = x(i);
    const py = y(pipeline.smoothY[i]);
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.stroke();

  // Ligne de sol + seuil
  ctx.strokeStyle = '#e6a23c';
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const px = x(i);
    const py = y(pipeline.ground[i]);
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.stroke();

  ctx.setLineDash([6, 4]);
  ctx.strokeStyle = 'rgba(230, 162, 60, 0.7)';
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const px = x(i);
    const py = y(pipeline.ground[i] - pipeline.epsilon);
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.stroke();
  ctx.setLineDash([]);

  // Événements
  for (const event of pipeline.events) {
    ctx.strokeStyle = event.type === 'first-contact' ? '#2ecc71' : '#e94560';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x(event.frame), 0);
    ctx.lineTo(x(event.frame), canvas.height);
    ctx.stroke();
  }
}

/** Curseur de la frame courante (calque séparé, redessin léger) */
function drawCursor(frame: number): void {
  const canvas = el.chartCursor;
  const ctx = canvas.getContext('2d');
  const scale = chartScale();
  if (!ctx || !scale || !pipeline) return;
  if (canvas.width !== el.chart.width) canvas.width = el.chart.width;
  if (canvas.height !== el.chart.height) canvas.height = el.chart.height;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(scale.x(frame), 0);
  ctx.lineTo(scale.x(frame), canvas.height);
  ctx.stroke();
}

/** Clic / glisser sur le graphique → navigation vidéo */
function chartSeek(clientX: number): void {
  const scale = chartScale();
  if (!scale || !pipeline || !player) return;
  const rect = el.chart.getBoundingClientRect();
  const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
  player.goToFrame(Math.round(ratio * (pipeline.smoothY.length - 1)));
}

// ---------------------------------------------------------------------------
// Overlay vidéo (landmarks du pied)
// ---------------------------------------------------------------------------

function drawOverlay(frame: number): void {
  const canvas = el.overlay;
  const ctx = canvas.getContext('2d');
  if (!ctx || !poseData) return;
  if (!el.video.videoWidth) return;
  if (canvas.width !== el.video.videoWidth || canvas.height !== el.video.videoHeight) {
    canvas.width = el.video.videoWidth;
    canvas.height = el.video.videoHeight;
  }
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (frame < 0 || frame >= poseData.points.length) return;
  const points = poseData.points[frame];
  if (!points || points.length === 0) return;
  const radius = Math.max(4, canvas.width / 150);
  for (const point of points) {
    ctx.beginPath();
    ctx.arc(point.x * canvas.width, point.y * canvas.height, radius, 0, Math.PI * 2);
    ctx.fillStyle = point.v >= 0.6 ? 'rgba(46, 204, 113, 0.9)' : 'rgba(230, 162, 60, 0.9)';
    ctx.fill();
  }
}

function updateFrameInfo(frame: number): void {
  const total = frameIndex?.frameCount ?? 0;
  const event = pipeline?.events.find((e) => e.frame === frame);
  el.frameInfo.textContent =
    `Frame ${frame + 1} / ${total}` +
    (event
      ? ` — ${event.type === 'first-contact' ? 'PREMIER CONTACT' : 'DÉCOLLAGE'}` +
        ` (visibilité ${Math.round(event.visibility * 100)} %)`
      : '');
}

// ---------------------------------------------------------------------------
// Tables de résultats
// ---------------------------------------------------------------------------

function renderResults(frameTimes: Float64Array): void {
  if (!pipeline) return;

  // Sauts
  const jt = el.jumpsTable;
  jt.innerHTML =
    '<tr><th>#</th><th>Frames (A/T/S)</th><th>Contact</th><th>Vol</th>' +
    '<th>Hauteur</th><th>RSI</th><th>Note</th></tr>';
  pipeline.jumps.forEach((jump, index) => {
    const t1 = jump.landingTime;
    const t2 = jump.takeoffTime;
    const t3 = jump.finalLandingTime;
    const tr = document.createElement('tr');
    tr.className = 'clickable';
    tr.addEventListener('click', () => player?.goToFrame(jump.landingFrame));
    let cells =
      `<td>${index + 1}</td>` +
      `<td>${jump.landingFrame + 1} / ${jump.takeoffFrame + 1} / ${jump.finalLandingFrame + 1}</td>`;
    try {
      const r = formatRSIResult(calculateRSIFromTimestamps(t1, t2, t3, 9.81));
      cells +=
        `<td>${r.contactTimeMs} ms</td><td>${r.flightTimeMs} ms</td>` +
        `<td>${r.heightCm} cm</td><td>${r.rsi} m/s</td>`;
    } catch {
      cells += '<td colspan="4">erreur de calcul</td>';
    }
    cells += `<td>${jump.warning ? `<span class="warning-text">${jump.warning}</span>` : ''}</td>`;
    tr.innerHTML = cells;
    jt.appendChild(tr);
  });

  // Événements
  const et = el.eventsTable;
  et.innerHTML =
    '<tr><th>Type</th><th>Frame</th><th>Temps réel (s)</th><th>Visibilité</th></tr>';
  for (const event of pipeline.events) {
    const tr = document.createElement('tr');
    tr.className = 'clickable';
    tr.addEventListener('click', () => player?.goToFrame(event.frame));
    const time =
      event.time !== null ? event.time : frameTimes[event.frame];
    tr.innerHTML =
      `<td>${event.type === 'first-contact' ? 'Premier contact' : 'Décollage'}</td>` +
      `<td>${event.frame + 1}</td>` +
      `<td>${time.toFixed(3)}</td>` +
      `<td>${Math.round(event.visibility * 100)} %</td>`;
    et.appendChild(tr);
  }

  // Cycles rejetés
  el.rejectedList.innerHTML = '';
  if (pipeline.rejected.length > 0) {
    const title = document.createElement('p');
    title.className = 'hint';
    title.textContent = `Cycles rejetés (${pipeline.rejected.length}) :`;
    el.rejectedList.appendChild(title);
    const ul = document.createElement('ul');
    ul.className = 'hint';
    for (const r of pipeline.rejected) {
      const li = document.createElement('li');
      li.textContent = `frames ${r.from + 1}–${r.to + 1} : ${r.reason}`;
      ul.appendChild(li);
    }
    el.rejectedList.appendChild(ul);
  }
}

// ---------------------------------------------------------------------------
// Export du diagnostic
// ---------------------------------------------------------------------------

function exportDiagnostic(): void {
  if (!pipeline || !poseData || !frameIndex) {
    setStatus(el.statusPose, 'Rien à exporter — analysez d\'abord une vidéo.');
    return;
  }
  const params = readParams();
  const diagnostic = {
    date: new Date().toISOString(),
    fichier: currentFile?.name,
    frames: frameIndex.frameCount,
    intervalleMedianMs: Number((frameIndex.medianInterval * 1000).toFixed(3)),
    facteurTemps: timeFactorValue,
    parametres: params,
    epsilon: pipeline.epsilon,
    evenements: pipeline.events.map((e) => ({
      type: e.type,
      frame: e.frame,
      tempsReel: e.time,
      visibilite: Number(e.visibility.toFixed(3)),
    })),
    sauts: pipeline.jumps.map((j) => {
      const r = formatRSIResult(
        calculateRSIFromTimestamps(j.landingTime, j.takeoffTime, j.finalLandingTime, 9.81)
      );
      return {
        frames: [j.landingFrame, j.takeoffFrame, j.finalLandingFrame],
        tempsReels: [j.landingTime, j.takeoffTime, j.finalLandingTime],
        contactMs: r.contactTimeMs,
        volMs: r.flightTimeMs,
        hauteurCm: r.heightCm,
        rsi: r.rsi,
        avertissement: j.warning,
      };
    }),
    rejete: pipeline.rejected,
    // Trajectoires (arrondies) pour rejouer l'algorithme hors ligne
    footY: Array.from(poseData.footY, (v) => Number(v.toFixed(5))),
    visibilite: Array.from(poseData.visibility, (v) => Number(v.toFixed(3))),
  };
  const blob = new Blob([JSON.stringify(diagnostic)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `diagnostic-${currentFile?.name?.replace(/\.[^.]+$/, '') ?? 'video'}.json`;
  link.click();
  URL.revokeObjectURL(url);
  setStatus(el.statusPose, 'Diagnostic téléchargé — envoyez ce fichier pour ajuster l\'algorithme.');
}

// ---------------------------------------------------------------------------
// Événements
// ---------------------------------------------------------------------------

el.dropzone.addEventListener('click', () => el.fileInput.click());
el.dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  el.dropzone.classList.add('drag');
});
el.dropzone.addEventListener('dragleave', () => el.dropzone.classList.remove('drag'));
el.dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  el.dropzone.classList.remove('drag');
  const file = e.dataTransfer?.files?.[0];
  if (file) void handleFile(file);
});
el.fileInput.addEventListener('change', () => {
  const file = el.fileInput.files?.[0];
  if (file) void handleFile(file);
  el.fileInput.value = '';
});

el.btnRun.addEventListener('click', () => runPipeline());
el.btnRepose.addEventListener('click', () => void runPose(true));
el.btnExport.addEventListener('click', exportDiagnostic);
el.btnSetStart.addEventListener('click', () => {
  if (!player) return;
  el.pStart.value = String(player.getCurrentFrame() + 1);
  runPipeline();
});
el.btnClearStart.addEventListener('click', () => {
  el.pStart.value = '';
  runPipeline();
});

el.btnPrev.addEventListener('click', () => player?.jumpFrames(-1));
el.btnPrev10.addEventListener('click', () => player?.jumpFrames(-10));
el.btnNext.addEventListener('click', () => player?.jumpFrames(1));
el.btnNext10.addEventListener('click', () => player?.jumpFrames(10));
el.btnPlay.addEventListener('click', () => {
  if (el.video.paused) void el.video.play();
  else el.video.pause();
});
el.video.addEventListener('play', () => (el.btnPlay.textContent = '⏸'));
el.video.addEventListener('pause', () => (el.btnPlay.textContent = '▶'));

// Navigation sur le graphique
let chartDragging = false;
el.chartCursor.addEventListener('mousedown', (e) => {
  chartDragging = true;
  chartSeek(e.clientX);
});
window.addEventListener('mousemove', (e) => {
  if (chartDragging) chartSeek(e.clientX);
});
window.addEventListener('mouseup', () => { chartDragging = false; });
el.chartCursor.addEventListener('touchstart', (e) => chartSeek(e.touches[0].clientX), { passive: true });
el.chartCursor.addEventListener('touchmove', (e) => chartSeek(e.touches[0].clientX), { passive: true });

// Raccourcis clavier
window.addEventListener('keydown', (e) => {
  const target = e.target as HTMLElement;
  if (target.tagName === 'INPUT' || target.tagName === 'SELECT') return;
  if (e.key === 'ArrowLeft') player?.jumpFrames(e.shiftKey ? -10 : -1);
  if (e.key === 'ArrowRight') player?.jumpFrames(e.shiftKey ? 10 : 1);
  if (e.key === ' ') {
    e.preventDefault();
    if (el.video.paused) void el.video.play(); else el.video.pause();
  }
});

// Recalcul quand un paramètre change
const paramInputs = [
  el.pFps, el.pSmooth, el.pGround, el.pEps, el.pVel, el.pSettling,
  el.pCmin, el.pCmax, el.pFmin, el.pFmax, el.pStart,
];
for (const input of paramInputs) {
  input.addEventListener('change', () => runPipeline());
}
