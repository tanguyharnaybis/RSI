/**
 * Module Lecteur Vidéo Frame-par-Frame
 * Permet de naviguer frame par frame dans une vidéo
 */

import type { VideoMetadata, VideoPlayer } from '../types';

export class FrameByFramePlayer implements VideoPlayer {
  private video: HTMLVideoElement;
  private metadata: VideoMetadata;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private frameCache: Map<number, ImageData> = new Map();
  private eventListeners: Map<string, Set<Function>> = new Map();
  private currentFrame: number = 0;
  private isInitialized: boolean = false;

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
   * Va à un frame spécifique
   * @param frame - Numéro du frame
   */
  goToFrame(frame: number): void {
    const clampedFrame = Math.max(0, Math.min(frame, this.metadata.frameCount - 1));
    this.currentFrame = clampedFrame;
    
    const time = this.getTimeAtFrame(clampedFrame);
    this.video.currentTime = time;
    
    this.emit('video:frame:changed', clampedFrame);
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
    const frame = Math.round(time * this.metadata.fps);
    return Math.max(0, Math.min(frame, this.metadata.frameCount - 1));
  }

  /**
   * Obtient le temps correspondant à un frame donné
   * @param frame - Numéro du frame
   * @returns Temps en secondes
   */
  getTimeAtFrame(frame: number): number {
    return frame / this.metadata.fps;
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
