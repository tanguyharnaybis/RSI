/**
 * Module Lecteur Vidéo Frame-par-Frame
 * Permet de naviguer frame par frame dans une vidéo
 */

import type { VideoMetadata, VideoPlayer, FrameIndex } from '../types';
import { diffRatio, FRAME_DIFF_THRESHOLD, computeDuplicationHint, computeConfirmedDuplicationFactor } from './frameDiff';

// Taille de l'empreinte visuelle d'une frame (réduite pour la rapidité)
const FP_W = 48;
const FP_H = 27;

export class FrameByFramePlayer implements VideoPlayer {
  private video: HTMLVideoElement;
  private metadata: VideoMetadata;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private frameCache: Map<number, ImageData> = new Map();
  private eventListeners: Map<string, Set<Function>> = new Map();
  private currentFrame: number = 0;
  private isInitialized: boolean = false;

  // Détection des frames dupliquées
  private fpCanvas: HTMLCanvasElement | null = null;
  private fpCtx: CanvasRenderingContext2D | null = null;
  private duplicationDistances: number[] = [];
  private duplicationHint = 1;
  private navigationBusy = false;
  private lastConfirmedSample = -1;

  // Index ffmpeg des timestamps exacts (VFR) — optionnel
  private timestampIndex: FrameIndex | null = null;

  /**
   * FPS utilisé pour la navigation frame-par-frame.
   * Il s'agit du FPS de lecture du conteneur (playbackFps) quand il est
   * connu — typiquement ~30 pour une vidéo slow-mo ralentie à l'export —
   * sinon du FPS d'enregistrement.
   */
  private get navFps(): number {
    const playback = this.metadata.playbackFps;
    return playback && playback > 0 ? playback : this.metadata.fps;
  }

  /**
   * Crée un nouveau lecteur frame-par-frame
   * @param video - Élement vidéo à contrôler
   * @param metadata - Métadonnées de la vidéo
   * @param canvas - Canvas pour l'affichage (optionnel)
   */
  constructor(video: HTMLVideoElement, metadata: VideoMetadata, canvas?: HTMLCanvasElement) {
    this.video = video;
    this.metadata = metadata;
    
    if (canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
    } else {
      this.canvas = document.createElement('canvas');
      this.ctx = this.canvas.getContext('2d');
    }
    
    this.setupVideo();
  }

  /**
   * Initialise l'écouteur d'événements vidéo
   */
  private setupVideo(): void {
    this.video.addEventListener('loadeddata', () => {
      this.isInitialized = true;
      this.emit('video:loaded', this.metadata);
    });

    this.video.addEventListener('seeked', () => {
      // Mémoriser le sample confirmé (frame affichée à jour).
      // Les seeks visent le CENTRE du sample (voir goToFrame), d'où le −0,5.
      this.lastConfirmedSample = Math.round(
        this.video.currentTime * this.navFps - 0.5
      );
      const frame = this.getCurrentFrame();
      this.emit('video:frame:changed', frame);
    });

    this.video.addEventListener('play', () => {
      this.emit('video:play');
    });

    this.video.addEventListener('pause', () => {
      this.emit('video:pause');
    });

    this.video.addEventListener('ratechange', () => {
      this.emit('video:rate:changed', this.video.playbackRate);
    });
  }

  /**
   * Charge une nouvelle vidéo
   * @param file - Fichier vidéo à charger
   * @returns Promise avec les métadonnées
   */
  async loadVideo(file: File): Promise<VideoMetadata> {
    // Nettoyer les ressources existantes
    this.clearFrameCache();
    this.currentFrame = 0;
    
    // Créer une nouvelle URL pour le fichier
    const objectUrl = URL.createObjectURL(file);
    this.video.src = objectUrl;
    
    // Attendre que les métadonnées soient chargées
    await new Promise<void>((resolve, reject) => {
      const onLoaded = () => {
        this.video.removeEventListener('loadedmetadata', onLoaded);
        resolve();
      };
      
      const onError = () => {
        this.video.removeEventListener('error', onError);
        URL.revokeObjectURL(objectUrl);
        reject(new Error('Impossible de charger la vidéo'));
      };
      
      this.video.addEventListener('loadedmetadata', onLoaded);
      this.video.addEventListener('error', onError);
    });
    
    // Mettre à jour les métadonnées
    this.metadata = {
      ...this.metadata,
      duration: this.video.duration,
      width: this.video.videoWidth,
      height: this.video.videoHeight,
    };
    
    // Recalculer le frame count
    this.metadata.frameCount = Math.round(this.metadata.duration * this.metadata.fps);
    
    this.isInitialized = true;
    this.emit('video:loaded', this.metadata);
    
    return this.metadata;
  }

  /**
   * Joue la vidéo
   */
  play(): void {
    this.video.play();
    this.emit('video:play');
  }

  /**
   * Met en pause la vidéo
   */
  pause(): void {
    this.video.pause();
    this.emit('video:pause');
  }

  /**
   * Va à un frame spécifique.
   * Le seek vise le CENTRE de la frame : (frame + 0,5) / fps pour un flux
   * à cadence constante, ou le milieu de [pts_n, pts_{n+1}] quand l'index
   * ffmpeg des timestamps exacts est disponible (cadence variable gérée).
   * Viser la frontière exacte provoque des erreurs d'arrondi où le
   * navigateur affiche la frame précédente.
   * @param frame - Numéro du frame
   */
  goToFrame(frame: number): void {
    const clampedFrame = Math.max(0, Math.min(frame, this.metadata.frameCount - 1));
    this.currentFrame = clampedFrame;

    this.video.currentTime = this.frameTime(clampedFrame);

    this.emit('video:frame:changed', clampedFrame);
  }

  /**
   * Temps vidéo exact du centre d'une frame :
   * - avec l'index ffmpeg : milieu des timestamps réels [pts_n, pts_{n+1}]
   *   (correct en VFR, quand l'intervalle varie au fil du fichier)
   * - sinon : centre à cadence constante supposée
   */
  private frameTime(frame: number): number {
    const index = this.timestampIndex;
    if (index && frame < index.ptsTimes.length) {
      const start = index.ptsTimes[frame];
      const end =
        frame + 1 < index.ptsTimes.length
          ? index.ptsTimes[frame + 1]
          : start + (index.medianInterval || 1 / this.navFps);
      return (start + end) / 2;
    }
    return (frame + 0.5) / this.navFps;
  }

  /**
   * Fournit l'index ffmpeg des timestamps exacts (active le seek VFR).
   * @param index - Index des frames, ou null pour le désactiver
   */
  setTimestampIndex(index: FrameIndex | null): void {
    this.timestampIndex = index;
    this.lastConfirmedSample = -1; // forcer un re-seek exact
  }

  /**
   * Index de la frame couvrant un temps vidéo donné.
   * Avec l'index ffmpeg : recherche binaire dans les timestamps réels
   * (exact en VFR). Sans index : cadence constante supposée.
   */
  private frameAtVideoTime(time: number): number {
    const index = this.timestampIndex;
    if (!index || index.ptsTimes.length === 0) {
      return Math.max(0, Math.round(time * this.navFps));
    }
    const pts = index.ptsTimes;
    let lo = 0;
    let hi = pts.length - 1;
    if (time < pts[0]) return 0;
    if (time >= pts[hi]) return hi;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (pts[mid] <= time) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  /**
   * Frame suivant
   */
  nextFrame(): void {
    if (this.currentFrame < this.metadata.frameCount - 1) {
      this.goToFrame(this.currentFrame + 1);
    }
  }

  /**
   * Frame précédent
   */
  previousFrame(): void {
    if (this.currentFrame > 0) {
      this.goToFrame(this.currentFrame - 1);
    }
  }

  /**
   * Définit la vitesse de lecture
   * @param rate - Vitesse de lecture
   */
  setPlaybackRate(rate: number): void {
    this.video.playbackRate = rate;
    this.emit('video:rate:changed', rate);
  }

  /**
   * Obtient le frame courant
   * @returns Numéro du frame
   */
  getCurrentFrame(): number {
    return this.currentFrame;
  }

  /**
   * Obtient le frame correspondant à un temps donné
   * @param time - Temps en secondes
   * @returns Numéro du frame
   */
  getFrameAtTime(time: number): number {
    const frame = Math.round(time * this.navFps);
    return Math.max(0, Math.min(frame, this.metadata.frameCount - 1));
  }

  /**
   * Obtient le temps correspondant à un frame donné
   * @param frame - Numéro du frame
   * @returns Temps en secondes
   */
  getTimeAtFrame(frame: number): number {
    return frame / this.navFps;
  }

  /**
   * Obtient les dimensions de la vidéo
   * @returns Dimensions {width, height}
   */
  getDimensions(): { width: number; height: number } {
    return {
      width: this.metadata.width,
      height: this.metadata.height,
    };
  }

  /**
   * Capture le frame courant dans un canvas
   * @returns Promise avec l'ImageData du frame
   */
  async captureCurrentFrame(): Promise<ImageData | null> {
    if (!this.ctx || !this.isInitialized) {
      return null;
    }

    // S'assurer que la vidéo est à jour
    await this.ensureVideoReady();
    
    // Configurer le canvas
    this.canvas.width = this.metadata.width;
    this.canvas.height = this.metadata.height;
    
    // Dessiner le frame courant
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.drawImage(
      this.video,
      0, 0,
      this.canvas.width,
      this.canvas.height
    );
    
    // Récupérer l'ImageData
    return this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
  }

  /**
   * Capture une région spécifique du frame courant
   * @param x - Coordonnée X
   * @param y - Coordonnée Y
   * @param width - Largeur
   * @param height - Hauteur
   * @returns Promise avec l'ImageData de la région
   */
  async captureFrameRegion(
    x: number,
    y: number,
    width: number,
    height: number
  ): Promise<ImageData | null> {
    if (!this.ctx || !this.isInitialized) {
      return null;
    }

    await this.ensureVideoReady();
    
    // Créer un canvas temporaire pour la région
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = width;
    tempCanvas.height = height;
    const tempCtx = tempCanvas.getContext('2d');
    
    if (!tempCtx) {
      return null;
    }
    
    // Dessiner la région
    tempCtx.drawImage(
      this.video,
      x, y, width, height,
      0, 0, width, height
    );
    
    return tempCtx.getImageData(0, 0, width, height);
  }

  /**
   * S'assure que la vidéo est prête pour la capture
   */
  private async ensureVideoReady(): Promise<void> {
    if (this.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      await new Promise<void>((resolve) => {
        const onCanPlay = () => {
          this.video.removeEventListener('canplay', onCanPlay);
          resolve();
        };
        this.video.addEventListener('canplay', onCanPlay);
        
        // Si déjà en cours de lecture, essayer de forcer le chargement
        if (this.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
          this.video.load();
        }
      });
    }
    
    // Attendre que la vidéo soit en pause (pour éviter le flou)
    if (!this.video.paused) {
      this.video.pause();
      await new Promise<void>((resolve) => {
        const onPause = () => {
          this.video.removeEventListener('pause', onPause);
          resolve();
        };
        this.video.addEventListener('pause', onPause);
      });
    }
  }

  /**
   * Nettoie le cache des frames
   */
  clearFrameCache(): void {
    this.frameCache.clear();
  }

  /**
   * Ajoute un écouteur d'événement
   * @param event - Nom de l'événement
   * @param callback - Fonction de rappel
   */
  addEventListener(event: string, callback: (...args: any[]) => void): void {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, new Set());
    }
    this.eventListeners.get(event)!.add(callback);
  }

  /**
   * Supprime un écouteur d'événement
   * @param event - Nom de l'événement
   * @param callback - Fonction de rappel
   */
  removeEventListener(event: string, callback: (...args: any[]) => void): void {
    const listeners = this.eventListeners.get(event);
    if (listeners) {
      listeners.delete(callback);
    }
  }

  /**
   * Émet un événement
   * @param event - Nom de l'événement
   * @param args - Arguments de l'événement
   */
  private emit(event: string, ...args: any[]): void {
    const listeners = this.eventListeners.get(event);
    if (listeners) {
      listeners.forEach(callback => {
        try {
          callback(...args);
        } catch (error) {
          console.error(`Erreur dans l'écouteur ${event}:`, error);
        }
      });
    }
  }

  /**
   * Nettoie toutes les ressources
   */
  destroy(): void {
    this.pause();
    this.clearFrameCache();
    this.eventListeners.clear();
    
    if (this.video.src) {
      this.video.removeAttribute('src');
      this.video.load();
    }
  }

  /**
   * Obtient les métadonnées actuelles
   */
  getMetadata(): VideoMetadata {
    return this.metadata;
  }

  /**
   * Saute de N frames d'un coup (saut direct, instantané — contrairement
   * à la navigation frame par frame qui vérifie chaque image). Le pas est
   * multiplié par le facteur de duplication estimé : dans un fichier où
   * chaque image est dupliquée ×N, « 10 frames » déplace de 10 images
   * réelles, pas de 10 samples identiques.
   * @param delta - Nombre de frames (négatif pour reculer)
   */
  jumpFrames(delta: number): void {
    const frames = Math.max(1, Math.abs(Math.round(delta))) * Math.max(1, this.duplicationHint);
    const sign = delta < 0 ? -1 : 1;
    const target = this.currentFrame + sign * frames;
    this.goToFrame(target);
  }

  // ============================================
  // Navigation sur frames uniques (anti-duplication)
  // ============================================

  /**
   * Facteur de duplication estimé : nombre de samples consécutifs
   * partageant la même image (1 = aucune duplication).
   */
  getDuplicationHint(): number {
    return this.duplicationHint;
  }

  /**
   * Facteur de duplication CONFIRMÉ (majorité claire des observations).
   * C'est celui utilisé pour les calculs de temps : un facteur > 1
   * n'est retenu que si la duplication est systématique.
   */
  getConfirmedDuplicationFactor(): number {
    return computeConfirmedDuplicationFactor(this.duplicationDistances);
  }

  /**
   * Empreinte visuelle de la frame affichée (niveaux de gris réduits)
   */
  private grabFingerprint(): Uint8Array | null {
    if (this.video.readyState < 2 || !this.video.videoWidth) return null;
    if (!this.fpCanvas) {
      this.fpCanvas = document.createElement('canvas');
      this.fpCanvas.width = FP_W;
      this.fpCanvas.height = FP_H;
      this.fpCtx = this.fpCanvas.getContext('2d');
    }
    if (!this.fpCtx) return null;
    this.fpCtx.drawImage(this.video, 0, 0, FP_W, FP_H);
    const data = this.fpCtx.getImageData(0, 0, FP_W, FP_H).data;
    const gray = new Uint8Array(FP_W * FP_H);
    for (let i = 0; i < gray.length; i++) {
      gray[i] = (data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2]) / 3 | 0;
    }
    return gray;
  }

  /**
   * Positionne la vidéo sur un sample et attend que la frame soit
   * réellement affichée (via requestVideoFrameCallback si disponible).
   */
  private async seekAndWait(sample: number): Promise<void> {
    if (sample === this.lastConfirmedSample) return;
    // Viser le centre de la frame (timestamps exacts si index ffmpeg)
    const time = this.frameTime(sample);
    const video = this.video;
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        this.lastConfirmedSample = sample;
        resolve();
      };
      // Timeout court avec résolution best-effort (la frame la plus proche
      // est affichée) : une égalité stricte entre les timelines conteneur
      // et lecteur (edit lists, arrondis) bloquerait la navigation.
      const timeoutId = window.setTimeout(done, 800);

      if (typeof video.requestVideoFrameCallback === 'function') {
        const check = (_now: number, meta: { mediaTime: number }) => {
          if (settled) return;
          // Tolérance ±1 frame : la frame présentée correspond au sample
          // visé (ou sa voisine immédiate en cas de décalage de timeline)
          if (Math.abs(this.frameAtVideoTime(meta.mediaTime) - sample) <= 1) {
            window.clearTimeout(timeoutId);
            done();
          } else {
            video.requestVideoFrameCallback(check);
          }
        };
        video.requestVideoFrameCallback(check);
      } else {
        video.addEventListener('seeked', () => {
          window.clearTimeout(timeoutId);
          done();
        }, { once: true });
      }
      video.currentTime = time;
    });
  }

  /**
   * Enregistre la distance observée entre deux frames uniques et met
   * à jour le facteur de duplication estimé.
   */
  private recordDistance(distance: number): void {
    if (distance < 1) return;
    this.duplicationDistances.push(distance);
    if (this.duplicationDistances.length > 50) {
      this.duplicationDistances.shift();
    }
    this.duplicationHint = computeDuplicationHint(this.duplicationDistances);
  }

  /**
   * Frame suivante visuellement différente (saute les samples dupliqués).
   * Recherche exponentielle puis dichotomie pour rester rapide même avec
   * un facteur de duplication élevé.
   * @returns Le sample atteint
   */
  async nextUniqueFrame(): Promise<number> {
    if (this.navigationBusy) return this.currentFrame;
    this.navigationBusy = true;
    try {
      if (!this.video.paused) this.video.pause();

      const total = this.metadata.frameCount;
      const start = this.currentFrame;
      await this.seekAndWait(start);
      const startFp = this.grabFingerprint();
      if (!startFp) return start;

      // Recherche exponentielle du premier sample différent
      let lastSame = start;
      let step = Math.max(1, this.duplicationHint);
      while (true) {
        const candidate = Math.min(start + step, total - 1);
        if (candidate <= lastSame) break; // fin de vidéo sans changement
        await this.seekAndWait(candidate);
        const fp = this.grabFingerprint();
        if (fp && diffRatio(startFp, fp) > FRAME_DIFF_THRESHOLD) {
          // Premier changement ∈ (lastSame, candidate] : dichotomie
          let first = candidate;
          while (first - lastSame > 1) {
            const mid = Math.floor((lastSame + first) / 2);
            await this.seekAndWait(mid);
            const midFp = this.grabFingerprint();
            if (midFp && diffRatio(startFp, midFp) > FRAME_DIFF_THRESHOLD) {
              first = mid;
            } else {
              lastSame = mid;
            }
          }
          this.recordDistance(first - start);
          this.goToFrame(first);
          return first;
        }
        lastSame = candidate;
        step *= 2;
        if (step > 4096) break;
      }

      // Aucun changement trouvé : aller à la dernière frame
      this.goToFrame(total - 1);
      return total - 1;
    } finally {
      this.navigationBusy = false;
    }
  }

  /**
   * Frame précédente visuellement différente (saute les samples dupliqués).
   * @returns Le sample atteint
   */
  async previousUniqueFrame(): Promise<number> {
    if (this.navigationBusy) return this.currentFrame;
    this.navigationBusy = true;
    try {
      if (!this.video.paused) this.video.pause();

      const start = this.currentFrame;
      if (start <= 0) return 0;
      await this.seekAndWait(start);
      const startFp = this.grabFingerprint();
      if (!startFp) return start;

      // Reculer par bonds croissants jusqu'à trouver une image différente
      let step = Math.max(1, this.duplicationHint);
      let candidate = Math.max(start - step, 0);
      while (true) {
        await this.seekAndWait(candidate);
        const fp = this.grabFingerprint();
        if (fp && diffRatio(startFp, fp) > FRAME_DIFF_THRESHOLD) {
          this.recordDistance(start - candidate);
          this.goToFrame(candidate);
          return candidate;
        }
        if (candidate === 0) break;
        step = Math.min(step * 2, 2048);
        candidate = Math.max(candidate - step, 0);
      }

      this.goToFrame(0);
      return 0;
    } finally {
      this.navigationBusy = false;
    }
  }

  /**
   * Définit les métadonnées
   * @param metadata - Nouvelles métadonnées
   */
  setMetadata(metadata: Partial<VideoMetadata>): void {
    this.metadata = { ...this.metadata, ...metadata };
  }
}

/**
 * Crée un nouveau lecteur frame-par-frame
 * @param videoElement - Élement vidéo HTML
 * @param metadata - Métadonnées de la vidéo
 * @param canvas - Canvas pour l'affichage (optionnel)
 * @returns Nouveau lecteur
 */
export function createFrameByFramePlayer(
  videoElement: HTMLVideoElement,
  metadata: VideoMetadata,
  canvas?: HTMLCanvasElement
): FrameByFramePlayer {
  return new FrameByFramePlayer(videoElement, metadata, canvas);
}
