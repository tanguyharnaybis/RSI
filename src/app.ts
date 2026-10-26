/**
 * Application principale RSI Calc
 * Branche l'interface (index.html) sur les modules métier :
 * vidéo, marquage, calcul, stockage, statistiques.
 */

import Chart from 'chart.js/auto';
import type { Session, Trial, VideoMetadata, VideoFrame, MarkerPoints } from './types';
import { calculateRSI, calculateRSIFromTimestamps, formatRSIResult } from './calculation';
import { estimateDuplication } from './calculation/timeSource';
import { determineTimeFactor } from './calculation/timeSource';
import type { TimeFactor } from './calculation/timeSource';
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
import { smooth, estimateGroundLine, adaptiveEpsilon, detectFootEvents, reconstructJumps } from './pose/pogoEvents';
import type { PogoJump, RejectedJump } from './pose/pogoEvents';
import { runPoseDetection } from './pose/poseEngine';
import type { PoseFrameData } from './pose/poseEngine';
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

// ============================================
// Série de sauts (protocole multi-sauts)
// ============================================

/** Un saut validé de la série en cours */
interface JumpMeasurement {
  formatted: { contactTimeMs: number; flightTimeMs: number; heightCm: number; rsi: number; modifiedRsi: number };
  markers: MarkerPoints;
  times: { landing: number; takeoff: number; finalLanding: number } | null;
  timeSourceLabel: string;
}

let jumpMeasurements: JumpMeasurement[] = [];
let currentJumpIndex = 0;

// Détection par pose IA (proposition à valider manuellement)
/** Un saut proposé par le pipeline pose IA, avec sa visibilité */
interface PoseProposal {
  jump: PogoJump;
  /** Visibilité minimale des landmarks aux 3 événements */
  visibility: number;
  /** Saut validé par l'utilisateur (traité) */
  validated: boolean;
  /** Saut rejeté par l'utilisateur (traité) */
  rejected: boolean;
}

let poseProposals: PoseProposal[] = [];
let poseRejectedCycles: RejectedJump[] = [];
let poseData: PoseFrameData | null = null;
/** Index du saut proposé actuellement chargé dans les marqueurs */
let activePoseProposal: number | null = null;
/** Frame du marqueur consulté (retour rapide après vérification) */
let referenceFrame: number | null = null;
/**
 * Duplication estimée depuis les scores de mouvement (avant navigation) :
 * 1 par défaut ; > 1 si le fichier contient des frames identiques ×N.
 */
let estimatedDuplication = 1;

const MAX_JUMPS = 15;
const DEFAULT_BEST_COUNT = 5;

function selectedJumpCount(): number {
  return clamp(parseInt(el.jumpCountSelect.value, 10) || 1, 1, MAX_JUMPS);
}

function selectedBestCount(): number {
  const jumps = selectedJumpCount();
  return clamp(parseInt(el.bestCountSelect.value, 10) || DEFAULT_BEST_COUNT, 1, jumps);
}

function seriesComplete(): boolean {
  return currentJumpIndex >= selectedJumpCount();
}

/** Initialise les listes déroulantes du protocole (persistées) */
function initJumpProtocolControls(): void {
  const savedJumps = clamp(
    parseInt(localStorage.getItem('rsi-calc-jump-count') || '', 10) || 1,
    1, MAX_JUMPS
  );
  const savedBest = clamp(
    parseInt(localStorage.getItem('rsi-calc-best-count') || '', 10) || DEFAULT_BEST_COUNT,
    1, MAX_JUMPS
  );

  el.jumpCountSelect.innerHTML = '';
  for (let i = 1; i <= MAX_JUMPS; i++) {
    const option = document.createElement('option');
    option.value = String(i);
    option.textContent = i === 1 ? '1 (saut unique)' : String(i);
    el.jumpCountSelect.appendChild(option);
  }
  el.jumpCountSelect.value = String(savedJumps);

  rebuildBestCountOptions(Math.min(savedBest, savedJumps));
  updateJumpProgress();
}

/** Reconstruit les options « moyenne des N meilleurs » (1..nb sauts) */
function rebuildBestCountOptions(value: number): void {
  const jumps = selectedJumpCount();
  el.bestCountGroup.style.display = jumps > 1 ? 'flex' : 'none';
  el.bestCountSelect.innerHTML = '';
  for (let i = 1; i <= jumps; i++) {
    const option = document.createElement('option');
    option.value = String(i);
    option.textContent = i === 1 ? '1 (RSI du meilleur saut)' : `${i} meilleurs`;
    el.bestCountSelect.appendChild(option);
  }
  el.bestCountSelect.value = String(clamp(value, 1, jumps));
}

function onJumpCountChanged(): void {
  if (jumpMeasurements.length > 0 || currentJumpIndex > 0) {
    const ok = window.confirm(
      'Changer le nombre de sauts réinitialise la série en cours ' +
      `(${jumpMeasurements.length} saut(s) validé(s) non sauvegardé(s)). Continuer ?`
    );
    if (!ok) {
      initJumpProtocolControls();
      return;
    }
  }
  localStorage.setItem('rsi-calc-jump-count', String(selectedJumpCount()));
  resetSeries();
  rebuildBestCountOptions(selectedBestCount());
  localStorage.setItem('rsi-calc-best-count', String(selectedBestCount()));
  updateJumpProgress();
}

function resetSeries(): void {
  jumpMeasurements = [];
  currentJumpIndex = 0;
  poseProposals = [];
  poseRejectedCycles = [];
  poseData = null;
  activePoseProposal = null;
  hidePosePanel();
  referenceFrame = null;
  markerManager.clearAllMarkers();
  setMarkingEnabled(true);
  el.btnRestartSeries.style.display = 'none';
  updateJumpProgress();
  displayJumpResults();
}

// ============================================
// Détection par pose IA (pipeline MediaPipe)
// ============================================

/** Temps réels de chaque frame (index ffmpeg / facteur temps) */
function realFrameTimes(): Float64Array | null {
  if (!frameIndex) return null;
  const factor = timeFactor().factor;
  const out = new Float64Array(frameIndex.ptsTimes.length);
  for (let i = 0; i < out.length; i++) {
    out[i] = frameIndex.ptsTimes[i] / factor;
  }
  return out;
}

/** Constructeur de VideoFrame depuis l'index ffmpeg */
function mkFrame(frameNumber: number): VideoFrame {
  const ptsTimes = frameIndex?.ptsTimes;
  return {
    frameNumber,
    timestamp:
      ptsTimes && frameNumber < ptsTimes.length
        ? ptsTimes[frameNumber]
        : frameNumber / (currentVideo?.fps || 240),
  };
}

let poseRunning = false;

function poseSetStatus(text: string | null): void {
  if (text) {
    el.poseStatus.textContent = text;
    el.posePanel.style.display = 'block';
  } else {
    el.poseStatus.textContent = '';
  }
}

function poseSetProgress(ratio: number | null): void {
  if (ratio === null) {
    el.poseProgress.style.display = 'none';
    el.poseProgressFill.style.width = '0%';
  } else {
    el.poseProgress.style.display = 'block';
    el.poseProgressFill.style.width = `${Math.round(ratio * 100)}%`;
  }
}

/**
 * Lance la détection par pose IA : extraction + landmarks + pipeline
 * pogoEvents, puis propose les sauts pour validation manuelle.
 */
async function runPoseJumpDetection(): Promise<void> {
  if (!frameIndex || !currentVideo || !currentFile || !videoPlayer) {
    showAlert('Importez d\'abord une vidéo et attendez la fin de son analyse.', 'error');
    return;
  }
  if (poseRunning) return;
  if (jumpMeasurements.length > 0) {
    const ok = window.confirm(
      `Relancer la détection réinitialise la série en cours ` +
      `(${jumpMeasurements.length} saut(s) validé(s) non sauvegardé(s)). Continuer ?`
    );
    if (!ok) return;
  }
  poseRunning = true;
  el.btnAutoDetect.disabled = true;
  poseSetProgress(0);
  poseSetStatus('Chargement du modèle de pose (≈9 Mo, une seule fois)…');

  try {
    const frameTimes = realFrameTimes();
    if (!frameTimes) throw new Error('Index des frames indisponible.');

    poseData = await runPoseDetection(currentFile, frameIndex.ptsTimes, (progress) => {
      if (progress.stage === 'model') {
        poseSetStatus(`Chargement du modèle de pose… ${Math.round(progress.ratio * 100)} %`);
        poseSetProgress(progress.ratio * 0.2);
      } else {
        poseSetStatus('Extraction des frames et détection de la pose…');
        poseSetProgress(0.2 + progress.ratio * 0.8);
      }
    });

    // Frames sans pose détectée
    const missing = countLowVisibilityFrames(poseData);
    if (missing > frameIndex.frameCount * 0.5) {
      throw new Error(
        'Pose non détectée sur la majorité des frames — vérifiez que le sujet ' +
        'entier (pieds compris) est visible de profil.'
      );
    }

    // Pipeline pogoEvents : lissage, ligne de sol, epsilon adaptatif,
    // détection des croisements, reconstruction cyclique.
    const smoothY = smooth(poseData.footY, 5);
    const ground = estimateGroundLine(smoothY, frameTimes, 2);
    const epsilon = adaptiveEpsilon(smoothY, ground);
    const events = detectFootEvents(frameTimes, smoothY, ground, epsilon, {
      visibility: poseData.visibility,
    });
    const { jumps, rejected } = reconstructJumps(events, frameTimes);
    poseRejectedCycles = rejected;

    poseProposals = jumps.map((jump) => ({
      jump,
      visibility: Math.min(
        poseData!.visibility[jump.landingFrame] ?? 1,
        poseData!.visibility[jump.takeoffFrame] ?? 1,
        poseData!.visibility[jump.finalLandingFrame] ?? 1
      ),
      validated: false,
      rejected: false,
    }));

    if (poseProposals.length === 0) {
      hidePosePanel();
      showAlert(
        'Aucun saut détecté par la pose IA' +
        (rejected.length > 0
          ? ` (${rejected.length} cycle(s) rejeté(s) : ${rejected[0].reason})`
          : '') +
        ' — utilisez le marquage manuel.',
        'error'
      );
      return;
    }

    jumpMeasurements = [];
    currentJumpIndex = 0;
    setMarkingEnabled(true);
    el.btnRestartSeries.style.display = 'none';

    poseSetProgress(null);
    renderPoseJumpList();
    loadPoseProposal(firstPendingProposal());

    showAlert(
      `${poseProposals.length} saut(s) proposé(s) par la pose IA` +
      (rejected.length > 0 ? `, ${rejected.length} cycle(s) rejeté(s)` : '') +
      (missing > 0 ? `, ${missing} frame(s) à faible visibilité` : '') +
      ' — vérifiez chaque saut puis validez.',
      'success'
    );
  } catch (error) {
    console.error('[RSI Calc] Détection pose :', error);
    poseSetProgress(null);
    poseSetStatus(
      `Échec de la détection : ${error instanceof Error ? error.message : String(error)}`
    );
    showAlert(
      `Détection par pose IA échouée — ${error instanceof Error ? error.message : String(error)}. ` +
      'Le marquage manuel reste fonctionnel.',
      'error'
    );
  } finally {
    poseRunning = false;
    el.btnAutoDetect.disabled = false;
  }
}

/** Nombre de frames avec visibilité des pointes < 0.6 */
function countLowVisibilityFrames(data: PoseFrameData): number {
  let count = 0;
  for (let i = 0; i < data.visibility.length; i++) {
    if (data.visibility[i] < 0.6) count++;
  }
  return count;
}

/** Premier saut proposé non encore traité */
function firstPendingProposal(): number {
  const index = poseProposals.findIndex((p) => !p.validated && !p.rejected);
  return index >= 0 ? index : -1;
}

/** Masque le panneau de validation pose */
function hidePosePanel(): void {
  el.posePanel.style.display = 'none';
  el.poseCurrent.style.display = 'none';
  el.poseJumpList.innerHTML = '';
  el.poseRejectedList.innerHTML = '';
  poseSetProgress(null);
  poseSetStatus(null);
}

/**
 * Charge un saut proposé dans les marqueurs du saut courant et positionne
 * la vidéo sur l'atterrissage proposé (vue de validation hybride).
 */
function loadPoseProposal(proposalIndex: number): void {
  activePoseProposal = null;
  if (proposalIndex < 0 || proposalIndex >= poseProposals.length || !videoPlayer) {
    // Tous les sauts proposés ont été traités
    el.poseCurrent.style.display = 'none';
    renderPoseJumpList();
    const pending = firstPendingProposal();
    if (pending < 0) {
      poseSetStatus(
        poseProposals.some((p) => p.rejected)
          ? 'Tous les sauts proposés ont été traités (certains rejetés) — ' +
            'les sauts restants peuvent être marqués manuellement.'
          : 'Tous les sauts proposés ont été traités.'
      );
      setMarkingEnabled(!seriesComplete());
    }
    updateJumpProgress();
    return;
  }

  const proposal = poseProposals[proposalIndex];
  activePoseProposal = proposalIndex;

  markerManager.clearAllMarkers();
  markerManager.setMarker(MARKER_TYPES.LANDING, mkFrame(proposal.jump.landingFrame));
  markerManager.setMarker(MARKER_TYPES.TAKEOFF, mkFrame(proposal.jump.takeoffFrame));
  markerManager.setMarker(MARKER_TYPES.FINAL_LANDING, mkFrame(proposal.jump.finalLandingFrame));

  videoPlayer.goToFrame(proposal.jump.landingFrame);
  referenceFrame = proposal.jump.landingFrame;
  el.btnReturnMarker.style.display = 'inline-flex';
  el.poseCurrent.style.display = 'block';
  renderPoseEventRows();
  updatePoseLiveMetrics();
  renderPoseJumpList();
  updateJumpProgress();
}

/** Construit les 3 lignes d'événements éditables (◀ frame ▶) */
function renderPoseEventRows(): void {
  const rows: Array<{ label: string; type: MarkerType; key: 'landing' | 'takeoff' | 'finalLanding' }> = [
    { label: '1. Atterrissage (premier contact)', type: MARKER_TYPES.LANDING, key: 'landing' },
    { label: '2. Décollage (dernier contact)', type: MARKER_TYPES.TAKEOFF, key: 'takeoff' },
    { label: '3. Atterrissage suivant', type: MARKER_TYPES.FINAL_LANDING, key: 'finalLanding' },
  ];
  const container = el.poseEventRows;
  container.innerHTML = '';
  for (const row of rows) {
    const div = document.createElement('div');
    div.className = 'pose-event-row';

    const label = document.createElement('span');
    label.className = 'pe-label';
    label.textContent = row.label;

    const prev = document.createElement('button');
    prev.className = 'btn';
    prev.textContent = '◀';
    prev.title = 'Frame précédente pour cet événement';
    prev.addEventListener('click', () => adjustPoseEvent(row.type, -1));

    const frameSpan = document.createElement('span');
    frameSpan.className = 'pe-frame';
    frameSpan.dataset.key = row.key;

    const next = document.createElement('button');
    next.className = 'btn';
    next.textContent = '▶';
    next.title = 'Frame suivante pour cet événement';
    next.addEventListener('click', () => adjustPoseEvent(row.type, +1));

    div.append(label, prev, frameSpan, next);
    container.appendChild(div);
  }
  updatePoseEventFrames();
}

/** Affiche les numéros de frames courants dans les lignes d'événements */
function updatePoseEventFrames(): void {
  const markers = markerManager.getAllMarkers();
  const keys: Array<{ key: 'landing' | 'takeoff' | 'finalLanding'; span: string }> = [
    { key: 'landing', span: 'landing' },
    { key: 'takeoff', span: 'takeoff' },
    { key: 'finalLanding', span: 'finalLanding' },
  ];
  for (const { key, span } of keys) {
    const node = el.poseEventRows.querySelector(`[data-key="${span}"]`);
    if (!node) continue;
    const m = markers[key];
    node.textContent = m ? `frame ${m.frameNumber + 1}` : '—';
  }
}

/** Déplace un événement du saut courant d'une frame et recentre la vidéo */
function adjustPoseEvent(type: MarkerType, delta: number): void {
  if (!videoPlayer || !currentVideo) return;
  const marker = markerManager.getMarker(type);
  if (!marker) return;
  const newFrame = clamp(marker.frameNumber + delta, 0, currentVideo.frameCount - 1);
  markerManager.setMarker(type, mkFrame(newFrame));
  videoPlayer.goToFrame(newFrame);
  referenceFrame = newFrame;
  el.btnReturnMarker.style.display = 'inline-flex';
  updatePoseEventFrames();
  updatePoseLiveMetrics();
}

/**
 * Temps réel d'un événement : temps interpolé sous-frame de la pose IA si
 * la frame n'a pas été corrigée, sinon temps réel de la frame corrigée.
 */
function poseEventTime(which: 'landing' | 'takeoff' | 'finalLanding', frameNumber: number): number | null {
  const proposal = activePoseProposal !== null ? poseProposals[activePoseProposal] : null;
  if (proposal) {
    const original =
      which === 'landing' ? proposal.jump.landingFrame
      : which === 'takeoff' ? proposal.jump.takeoffFrame
      : proposal.jump.finalLandingFrame;
    const interpolated =
      which === 'landing' ? proposal.jump.landingTime
      : which === 'takeoff' ? proposal.jump.takeoffTime
      : proposal.jump.finalLandingTime;
    if (frameNumber === original && Number.isFinite(interpolated)) {
      return interpolated;
    }
  }
  return realTimeOfFrame(frameNumber);
}

/** Métriques recalculées en direct pour le saut en cours de validation */
function updatePoseLiveMetrics(): void {
  if (!markerManager.areMarkersValid()) {
    el.poseLiveMetrics.textContent = 'Marquez les 3 frames pour voir les métriques.';
    el.poseVisibilityWarning.style.display = 'none';
    return;
  }
  const markers = markerManager.getAllMarkers();
  try {
    const t1 = poseEventTime('landing', markers.landing!.frameNumber);
    const t2 = poseEventTime('takeoff', markers.takeoff!.frameNumber);
    const t3 = poseEventTime('finalLanding', markers.finalLanding!.frameNumber);
    if (t1 === null || t2 === null || t3 === null) {
      el.poseLiveMetrics.textContent = 'Temps indisponibles (index des frames manquant).';
      return;
    }
    const result = formatRSIResult(calculateRSIFromTimestamps(t1, t2, t3, gravity));
    el.poseLiveMetrics.textContent =
      `Contact ${result.contactTimeMs} ms · vol ${result.flightTimeMs} ms · ` +
      `h ${result.heightCm} cm · RSI ${result.rsi} m/s`;
  } catch (error) {
    el.poseLiveMetrics.textContent = `Erreur de calcul : ${error instanceof Error ? error.message : String(error)}`;
  }

  // Avertissement visibilité du saut proposé
  const proposal = activePoseProposal !== null ? poseProposals[activePoseProposal] : null;
  if (proposal && proposal.visibility < 0.6) {
    el.poseVisibilityWarning.style.display = 'block';
    el.poseVisibilityWarning.textContent =
      `Visibilité des landmarks faible (${Math.round(proposal.visibility * 100)} %) — ` +
      'vérifiez cet événement avec attention.';
  } else {
    el.poseVisibilityWarning.style.display = 'none';
  }
}

/** Liste des sauts proposés (cliquer pour recharger un saut non traité) */
function renderPoseJumpList(): void {
  const list = el.poseJumpList;
  list.innerHTML = '';
  poseProposals.forEach((proposal, index) => {
    const row = document.createElement('div');
    row.className = 'pose-jump-row' + (index === activePoseProposal ? ' current' : '');

    const name = document.createElement('span');
    name.className = 'pj-name';
    name.textContent = `Saut ${index + 1}`;

    const details = document.createElement('span');
    details.className = 'pj-details';
    const j = proposal.jump;
    const t1 = realTimeOfFrame(j.landingFrame);
    const t2 = realTimeOfFrame(j.takeoffFrame);
    const t3 = realTimeOfFrame(j.finalLandingFrame);
    if (t1 !== null && t2 !== null && t3 !== null) {
      try {
        const r = formatRSIResult(calculateRSIFromTimestamps(t1, t2, t3, gravity));
        details.textContent =
          `frames ${j.landingFrame + 1}/${j.takeoffFrame + 1}/${j.finalLandingFrame + 1} · ` +
          `RSI ${r.rsi} m/s`;
      } catch {
        details.textContent = `frames ${j.landingFrame + 1}/${j.takeoffFrame + 1}/${j.finalLandingFrame + 1}`;
      }
    } else {
      details.textContent = `frames ${j.landingFrame + 1}/${j.takeoffFrame + 1}/${j.finalLandingFrame + 1}`;
    }

    const status = document.createElement('span');
    status.className = 'pj-status';
    if (proposal.validated) {
      status.textContent = '✓ validé';
    } else if (proposal.rejected) {
      status.textContent = '✗ rejeté';
    } else {
      status.textContent = 'en attente';
    }

    row.append(name, details, status);
    if (!proposal.validated && !proposal.rejected) {
      row.addEventListener('click', () => loadPoseProposal(index));
      row.title = 'Cliquer pour charger ce saut dans la validation';
    }
    list.appendChild(row);
  });

  // Cycles rejetés par le pipeline (diagnostic)
  const rejectedList = el.poseRejectedList;
  rejectedList.innerHTML = '';
  if (poseRejectedCycles.length > 0) {
    const title = document.createElement('p');
    title.className = 'hint';
    title.style.marginTop = '8px';
    title.textContent = `Cycles rejetés automatiquement (${poseRejectedCycles.length}) :`;
    rejectedList.appendChild(title);
    const ul = document.createElement('ul');
    ul.className = 'hint';
    for (const r of poseRejectedCycles) {
      const li = document.createElement('li');
      li.textContent = `frames ${r.from + 1}–${r.to + 1} : ${r.reason}`;
      ul.appendChild(li);
    }
    rejectedList.appendChild(ul);
  }
}

/**
 * Valide le saut courant quand il vient de la pose IA : temps interpolés
 * sous-frame si la frame n'a pas été corrigée, temps réels sinon.
 */
function validatePoseProposal(useCurrentMarkers: boolean): boolean {
  const index = activePoseProposal;
  if (index === null || !poseProposals[index]) return false;
  const proposal = poseProposals[index];

  const landingFrame = useCurrentMarkers
    ? markerManager.getMarker(MARKER_TYPES.LANDING)?.frameNumber ?? proposal.jump.landingFrame
    : proposal.jump.landingFrame;
  const takeoffFrame = useCurrentMarkers
    ? markerManager.getMarker(MARKER_TYPES.TAKEOFF)?.frameNumber ?? proposal.jump.takeoffFrame
    : proposal.jump.takeoffFrame;
  const finalLandingFrame = useCurrentMarkers
    ? markerManager.getMarker(MARKER_TYPES.FINAL_LANDING)?.frameNumber ?? proposal.jump.finalLandingFrame
    : proposal.jump.finalLandingFrame;

  const t1 = poseEventTime('landing', landingFrame);
  const t2 = poseEventTime('takeoff', takeoffFrame);
  const t3 = poseEventTime('finalLanding', finalLandingFrame);

  if (t1 === null || t2 === null || t3 === null) {
    showAlert('Temps réels indisponibles pour ce saut — vérifiez l\'analyse de la vidéo.', 'error');
    return false;
  }

  const result = calculateRSIFromTimestamps(t1, t2, t3, gravity);
  const interpolatedUsed =
    landingFrame === proposal.jump.landingFrame && takeoffFrame === proposal.jump.takeoffFrame &&
    finalLandingFrame === proposal.jump.finalLandingFrame;
  const label = interpolatedUsed
    ? `Pose IA, temps interpolés sous-frame (${timeFactor().label})`
    : `Pose IA, frames vérifiées (${timeFactor().label})`;

  jumpMeasurements.push({
    formatted: formatRSIResult(result),
    markers: {
      landing: mkFrame(landingFrame),
      takeoff: mkFrame(takeoffFrame),
      finalLanding: mkFrame(finalLandingFrame),
    },
    times: { landing: t1, takeoff: t2, finalLanding: t3 },
    timeSourceLabel: label,
  });

  proposal.validated = true;
  currentJumpIndex++;
  updateJumpProgress();
  displayJumpResults();
  return true;
}

/** Valide tous les sauts proposés restants (jusqu'à la fin de la série) */
function validateAllPoseJumps(): void {
  if (activePoseProposal === null) return;
  let validatedCount = 0;
  while (activePoseProposal !== null && !seriesComplete()) {
    // Le saut courant garde les éventuelles corrections ; les suivants
    // sont validés tels que proposés.
    if (!validatePoseProposal(validatedCount === 0)) break;
    validatedCount++;
    const next = firstPendingProposal();
    if (next < 0) {
      activePoseProposal = null;
      break;
    }
    loadPoseProposal(next);
  }
  if (validatedCount > 0) {
    showAlert(`${validatedCount} saut(s) validé(s) d'un clic.`, 'success');
  }
  checkSeriesEnd();
  if (activePoseProposal !== null && !seriesComplete()) {
    showAlert(`Saut ${currentJumpIndex + 1} pré-chargé — vérifiez puis validez.`, 'info');
  }
}

/** Rejette le saut courant : il n'entre pas dans les mesures */
function rejectPoseProposal(): void {
  if (activePoseProposal === null || !poseProposals[activePoseProposal]) return;
  poseProposals[activePoseProposal].rejected = true;
  markerManager.clearAllMarkers();
  const next = firstPendingProposal();
  loadPoseProposal(next);
  showAlert('Saut rejeté — il ne sera pas mesuré.', 'info');
}

/** Fin de série : désactive le marquage et résume les N meilleurs */
function checkSeriesEnd(): void {
  if (!seriesComplete()) return;
  setMarkingEnabled(false);
  el.btnRestartSeries.style.display = 'block';
  renderPoseJumpList();
  const best = bestJumpStats();
  showAlert(
    `Série complète : ${jumpMeasurements.length} sauts — moyenne des ${best.count} meilleurs : ` +
    `${best.mean} ± ${best.stdDev} m/s.`,
    'success'
  );
}

function setMarkingEnabled(enabled: boolean): void {
  el.btnMarkLanding.disabled = !enabled;
  el.btnMarkTakeoff.disabled = !enabled;
  el.btnMarkFinalLanding.disabled = !enabled;
  el.btnResetMarkers.disabled = !enabled;
  if (!enabled) {
    el.btnCalculate.disabled = true;
  }
}

function updateJumpProgress(): void {
  const total = selectedJumpCount();
  if (seriesComplete()) {
    el.jumpProgress.textContent = `Série terminée — ${jumpMeasurements.length}/${total} saut(s) validé(s)`;
  } else {
    el.jumpProgress.textContent = `Saut ${currentJumpIndex + 1} / ${total}` +
      (jumpMeasurements.length > 0 ? ` — ${jumpMeasurements.length} validé(s)` : '');
  }
}

/** Valide le saut courant : calcule son RSI et passe au suivant */
function validateJump(): void {
  if (!currentVideo || !markerManager.areMarkersValid()) {
    showAlert('Marquez les 3 frames du saut courant avant de valider.', 'error');
    return;
  }
  if (seriesComplete()) {
    showAlert('Série complète — utilisez « Recommencer la série » pour reprendre.', 'info');
    return;
  }

  const markers = markerManager.getAllMarkers();
  const landing = markers.landing!;
  const takeoff = markers.takeoff!;
  const finalLanding = markers.finalLanding!;

  try {
    // Saut proposé par la pose IA : temps interpolés sous-frame si les
    // frames n'ont pas été corrigées, temps réels sinon.
    if (activePoseProposal !== null) {
      if (!validatePoseProposal(true)) return;
      markerManager.clearAllMarkers();
      const next = firstPendingProposal();
      if (next >= 0 && !seriesComplete()) {
        loadPoseProposal(next);
        showAlert(`Saut ${currentJumpIndex + 1} pré-chargé — vérifiez puis validez.`, 'info');
      } else {
        activePoseProposal = null;
        loadPoseProposal(next);
      }
      checkSeriesEnd();
      return;
    }

    const t1 = realTimeOfFrame(landing.frameNumber);
    const t2 = realTimeOfFrame(takeoff.frameNumber);
    const t3 = realTimeOfFrame(finalLanding.frameNumber);

    let result;
    let times: { landing: number; takeoff: number; finalLanding: number } | null = null;
    let label: string;
    if (t1 !== null && t2 !== null && t3 !== null) {
      result = calculateRSIFromTimestamps(t1, t2, t3, gravity);
      times = { landing: t1, takeoff: t2, finalLanding: t3 };
      label = timeFactor().label;
    } else {
      const effectiveFps = currentVideo.fps * getDuplicationFactor();
      result = calculateRSI(
        landing.frameNumber,
        takeoff.frameNumber,
        finalLanding.frameNumber,
        effectiveFps,
        gravity
      );
      label = `FPS d'enregistrement saisi (${currentVideo.fps}) — cadence constante supposée`;
    }

    jumpMeasurements.push({
      formatted: formatRSIResult(result),
      markers: { landing, takeoff, finalLanding },
      times,
      timeSourceLabel: label,
    });

    markerManager.clearAllMarkers();
    currentJumpIndex++;
    updateJumpProgress();
    displayJumpResults();

    showAlert(
      `Saut ${currentJumpIndex} validé : RSI ${formatRSIResult(result).rsi} m/s (${label}).`,
      'success'
    );

    if (seriesComplete()) {
      checkSeriesEnd();
    } else {
      // Proposition pose IA suivante : pré-charger le saut suivant
      const next = firstPendingProposal();
      if (next >= 0) {
        loadPoseProposal(next);
        showAlert(`Saut ${currentJumpIndex + 1} pré-chargé — vérifiez puis validez.`, 'info');
      }
    }
  } catch (error) {
    console.error(error);
    showAlert(`Erreur de calcul : ${error instanceof Error ? error.message : String(error)}`, 'error');
  }
}

/** Moyenne et écart-type des N meilleurs RSI (N = sélection utilisateur) */
function bestJumpStats(): { count: number; mean: number; stdDev: number } {
  const best = clamp(selectedBestCount(), 1, Math.max(1, jumpMeasurements.length));
  const sorted = [...jumpMeasurements]
    .map((m) => m.formatted.rsi)
    .sort((a, b) => b - a);
  const top = sorted.slice(0, best);
  const mean = top.reduce((sum, r) => sum + r, 0) / top.length;
  const variance =
    top.length > 1
      ? top.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / (top.length - 1)
      : 0;
  return {
    count: top.length,
    mean: parseFloat(mean.toFixed(2)),
    stdDev: parseFloat(Math.sqrt(variance).toFixed(2)),
  };
}

/** Affiche la liste des sauts validés + la moyenne des N meilleurs */
function displayJumpResults(): void {
  const container = el.resultsContent;
  container.innerHTML = '';

  if (jumpMeasurements.length === 0) {
    container.innerHTML =
      '<p class="empty-state">Marquez les 3 frames d\'un saut puis validez-le.</p>';
    return;
  }

  // Liste des sauts
  const list = document.createElement('div');
  list.className = 'jump-list';
  jumpMeasurements.forEach((measurement, index) => {
    const row = document.createElement('div');
    row.className = 'jump-row';
    const name = document.createElement('span');
    name.className = 'jump-name';
    name.textContent = `Saut ${index + 1}`;
    const details = document.createElement('span');
    details.className = 'jump-details';
    details.textContent =
      `RSI ${measurement.formatted.rsi} m/s · contact ${measurement.formatted.contactTimeMs} ms · ` +
      `vol ${measurement.formatted.flightTimeMs} ms · h ${measurement.formatted.heightCm} cm`;
    row.append(name, details);
    list.appendChild(row);
  });
  container.appendChild(list);

  // Résumé : moyenne des N meilleurs
  const best = bestJumpStats();
  const summary = document.createElement('div');
  summary.className = 'result-item';
  summary.style.marginTop = '10px';
  const label = document.createElement('span');
  label.className = 'result-label';
  label.textContent =
    `Moyenne des ${best.count} meilleurs` +
    (jumpMeasurements.length > best.count
      ? ` (sur ${jumpMeasurements.length} mesurés${seriesComplete() ? '' : ' — série en cours'})`
      : '');
  const value = document.createElement('span');
  value.className = 'result-value highlight';
  value.textContent = String(best.mean);
  const unit = document.createElement('span');
  unit.className = 'result-unit';
  unit.textContent = `± ${best.stdDev} m/s`;
  summary.append(label, value, unit);
  container.appendChild(summary);

  // Source des temps
  const source = document.createElement('p');
  source.className = 'hint';
  source.style.marginTop = '8px';
  source.textContent = `Source des temps : ${jumpMeasurements[0].timeSourceLabel}`;
  container.appendChild(source);
}
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
  get btnPrev10() { return $<HTMLButtonElement>('btn-prev-10'); },
  get btnNext10() { return $<HTMLButtonElement>('btn-next-10'); },
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
  get jumpCountSelect() { return $<HTMLSelectElement>('jump-count'); },
  get bestCountSelect() { return $<HTMLSelectElement>('best-count'); },
  get bestCountGroup() { return $('best-count-group'); },
  get jumpProgress() { return $('jump-progress'); },
  get btnRestartSeries() { return $<HTMLButtonElement>('btn-restart-series'); },
  get btnAutoDetect() { return $<HTMLButtonElement>('btn-auto-detect'); },
  get btnReturnMarker() { return $<HTMLButtonElement>('btn-return-marker'); },
  get posePanel() { return $('pose-panel'); },
  get poseStatus() { return $('pose-status'); },
  get poseProgress() { return $('pose-progress'); },
  get poseProgressFill() { return $('pose-progress-fill'); },
  get poseJumpList() { return $('pose-jump-list'); },
  get poseCurrent() { return $('pose-current'); },
  get poseEventRows() { return $('pose-event-rows'); },
  get poseLiveMetrics() { return $('pose-live-metrics'); },
  get poseVisibilityWarning() { return $('pose-visibility-warning'); },
  get poseRejectedList() { return $('pose-rejected-list'); },
  get poseOverlay() { return $<HTMLCanvasElement>('pose-overlay'); },
  get btnPoseValidate() { return $<HTMLButtonElement>('btn-pose-validate'); },
  get btnPoseValidateAll() { return $<HTMLButtonElement>('btn-pose-validate-all'); },
  get btnPoseReject() { return $<HTMLButtonElement>('btn-pose-reject'); },
};

// ============================================
// Initialisation
// ============================================

export async function initApp(): Promise<void> {
  applySavedTheme();
  bindEvents();
  markerManager.addEventListener('marker:change', () => updateMarkerChips());
  initJumpProtocolControls();
  await refreshSessions();
  updateHistory();
  updateChart();
  updateMarkerChips();
  displayJumpResults();
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
  el.btnPrev10.addEventListener('click', () => videoPlayer?.jumpFrames(-10));
  el.btnNext10.addEventListener('click', () => videoPlayer?.jumpFrames(10));
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
  el.btnCalculate.addEventListener('click', validateJump);
  el.btnRestartSeries.addEventListener('click', resetSeries);

  // Protocole multi-sauts
  el.jumpCountSelect.addEventListener('change', onJumpCountChanged);
  el.bestCountSelect.addEventListener('change', () => {
    localStorage.setItem('rsi-calc-best-count', String(selectedBestCount()));
    displayJumpResults();
    updateJumpProgress();
  });

  // Détection par pose IA + validation hybride
  el.btnAutoDetect.addEventListener('click', () => void runPoseJumpDetection());
  el.btnReturnMarker.addEventListener('click', () => {
    if (referenceFrame !== null && videoPlayer) {
      videoPlayer.goToFrame(referenceFrame);
    }
  });
  el.btnPoseValidate.addEventListener('click', () => validateJump());
  el.btnPoseValidateAll.addEventListener('click', () => validateAllPoseJumps());
  el.btnPoseReject.addEventListener('click', () => rejectPoseProposal());

  // Chips cliquables : afficher la frame d'un marqueur (et la mémoriser
  // comme référence pour le bouton « Revenir au marqueur »)
  const markerChips: Array<{ id: string; type: MarkerType }> = [
    { id: 'chip-landing', type: MARKER_TYPES.LANDING },
    { id: 'chip-takeoff', type: MARKER_TYPES.TAKEOFF },
    { id: 'chip-finalLanding', type: MARKER_TYPES.FINAL_LANDING },
  ];
  for (const { id, type } of markerChips) {
    document.getElementById(id)?.addEventListener('click', () => {
      const marker = markerManager.getMarker(type);
      if (marker && videoPlayer) {
        videoPlayer.goToFrame(marker.frameNumber);
        referenceFrame = marker.frameNumber;
        el.btnReturnMarker.style.display = 'inline-flex';
      }
    });
  }

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
    if (e.key === 'ArrowLeft' && !e.shiftKey) void goToPreviousUniqueFrame();
    if (e.key === 'ArrowRight' && !e.shiftKey) void goToNextUniqueFrame();
    if (e.key === 'ArrowLeft' && e.shiftKey) videoPlayer?.jumpFrames(-10);
    if (e.key === 'ArrowRight' && e.shiftKey) videoPlayer?.jumpFrames(10);
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

  // Une nouvelle vidéo = une nouvelle série : confirmer la perte des
  // sauts validés non sauvegardés.
  if (jumpMeasurements.length > 0) {
    const ok = window.confirm(
      `Importer une nouvelle vidéo réinitialise la série en cours ` +
      `(${jumpMeasurements.length} saut(s) validé(s) non sauvegardé(s)). Continuer ?`
    );
    if (!ok) return;
  }
  resetSeries();

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

  el.btnAutoDetect.style.display = 'none';
  el.btnReturnMarker.style.display = 'none';
  referenceFrame = null;
  void runFfmpegAnalysis();
}

/**
 * Active/désactive la navigation frame par frame (l'index ffmpeg des
 * timestamps est indispensable — pas de méthode de substitution).
 */
function setNavigationEnabled(enabled: boolean): void {
  el.btnPrevFrame.disabled = !enabled;
  el.btnNextFrame.disabled = !enabled;
  el.btnPrev10.disabled = !enabled;
  el.btnNext10.disabled = !enabled;
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
  const tf = timeFactor();
  // Durée réelle de la scène = durée vidéo / facteur
  const realDuration = (currentVideo.frameCount * frameIndex.medianInterval) / tf.factor;
  const sourceMark = tf.source === 'timestamps' ? '✓' : '⚠';
  el.videoInfo.textContent =
    `${currentVideo.width}×${currentVideo.height} · ${formatDuration(currentVideo.duration)} · ` +
    `${currentVideo.frameCount} frames (timestamps exacts) · lecture ${Math.round(currentVideo.playbackFps)} fps` +
    (tf.factor > 1 ? ` · facteur ×${tf.factor}` : '') +
    ` · temps réel ≈ ${realDuration.toFixed(1)} s — ${sourceMark} ${tf.label}`;
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
  drawPoseOverlay(frame);
}

/**
 * Dessine l'overlay des landmarks du pied (pose IA) sur la frame courante :
 * vert si visibilité ≥ 0.6, orange sinon. Repère image : y vers le bas.
 */
function drawPoseOverlay(frame: number): void {
  const canvas = el.poseOverlay;
  const video = el.videoElement;
  if (!poseData || !video.videoWidth) {
    canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }
  if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
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
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.stroke();
  }
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

  // Activer le bouton de validation si les marqueurs du saut sont valides
  // et que la série n'est pas terminée
  el.btnCalculate.disabled = !markerManager.areMarkersValid() || seriesComplete();

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

  // Panneau pose IA : frames éditables + métriques recalculées en direct
  if (activePoseProposal !== null) {
    updatePoseEventFrames();
    updatePoseLiveMetrics();
  }
}

// ============================================
// Navigation frame-par-frame (saute les frames dupliquées)
// ============================================

/** Facteur de duplication confirmé (1 = aucune duplication) */
function getDuplicationFactor(): number {
  const confirmed = videoPlayer?.getConfirmedDuplicationFactor() ?? 1;
  if (confirmed > 1) return confirmed;
  // Estimation automatique depuis les scores de mouvement (avant
  // navigation) — évite des temps ×N dans un fichier dupliqué
  return estimatedDuplication;
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
/**
 * Facteur temps réel et SOURCE des données (timestamps exacts ou FPS saisi).
 * Utilisé pour la conversion temps vidéo → temps réel, et affiché partout
 * pour que l'utilisateur sache toujours quelle donnée fonde les calculs.
 */
function timeFactor(): TimeFactor {
  const containerFps =
    frameIndex && frameIndex.medianInterval > 0 ? 1 / frameIndex.medianInterval : 0;
  return determineTimeFactor(containerFps, getDuplicationFactor(), currentVideo?.fps ?? 240);
}

/** Temps réel d'une frame depuis l'index ffmpeg (VFR-exact) */
function realTimeOfFrame(frameNumber: number): number | null {
  if (!frameIndex || frameNumber < 0 || frameNumber >= frameIndex.ptsTimes.length) {
    return null;
  }
  return frameIndex.ptsTimes[frameNumber] / timeFactor().factor;
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
    estimatedDuplication = 1;

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

    // Estimer la duplication depuis les scores (avant toute navigation) :
    // les temps réels en dépendent même si l'utilisateur n'a pas encore
    // navigué frame par frame.
    if (frameIndex.sceneScores) {
      estimatedDuplication = estimateDuplication(frameIndex.sceneScores);
      videoPlayer?.seedDuplicationHint(estimatedDuplication);
      if (estimatedDuplication > 1) {
        showAlert(
          `Frames dupliquées ×${estimatedDuplication} détectées automatiquement — ` +
          'temps réels et navigation ajustés.',
          'info'
        );
      }
    } else {
      estimatedDuplication = 1;
    }

    // Détection par pose IA : disponible dès que l'index des frames est
    // prêt (aucune dépendance aux scores de mouvement).
    el.btnAutoDetect.style.display = 'block';

    const tf = timeFactor();
    const realDuration = (index.frameCount * index.medianInterval) / tf.factor;
    showAlert(
      `Vidéo analysée : ${index.frameCount} frames réelles (timestamps exacts)` +
      (tf.factor > 1 ? `, facteur ×${tf.factor}` : '') +
      ` — temps réel ≈ ${realDuration.toFixed(1)} s.` +
      ` Temps réels : ${tf.label}.`,
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
  if (!currentVideo) {
    showAlert('Importez une vidéo.', 'error');
    return;
  }
  if (jumpMeasurements.length === 0) {
    showAlert('Aucun saut validé à sauvegarder — marquez les 3 frames puis « Valider le saut ».', 'error');
    return;
  }

  try {
    const total = jumpMeasurements.length;
    for (let i = 0; i < total; i++) {
      const measurement = jumpMeasurements[i];
      let trial: Trial;
      if (measurement.times) {
        trial = createTrialFromTimestamps(
          currentSession.id,
          {
            landing: measurement.markers.landing!.frameNumber,
            takeoff: measurement.markers.takeoff!.frameNumber,
            finalLanding: measurement.markers.finalLanding!.frameNumber,
          },
          measurement.times,
          currentVideo,
          gravity,
          `Saut ${i + 1}/${total} — ${measurement.timeSourceLabel}`
        );
      } else {
        const effectiveMetadata = { ...currentVideo, fps: currentVideo.fps * getDuplicationFactor() };
        trial = createTrialFromMarkers(currentSession.id, measurement.markers, effectiveMetadata, gravity);
        trial.notes = `Saut ${i + 1}/${total} — ${measurement.timeSourceLabel}`;
      }
      await storage.addTrial(currentSession.id, trial);
      currentSession.trials.push(trial);
    }
    currentSession.updatedAt = Date.now();
    await storage.saveSession(currentSession);

    // Rafraîchir la session depuis le stockage pour rester cohérent
    const stored = await storage.getSession(currentSession.id);
    if (stored) currentSession = stored;

    updateHistory();
    updateChart();
    updateSessionStatsDisplay();
    showAlert(
      `${total} saut(s) sauvegardé(s) dans « ${currentSession.name} » — ` +
      `moyenne des ${bestJumpStats().count} meilleurs : ${bestJumpStats().mean} m/s.`,
      'success'
    );
  } catch (error) {
    console.error(error);
    showAlert('Erreur lors de la sauvegarde des sauts.', 'error');
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
