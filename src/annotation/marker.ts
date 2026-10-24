/**
 * Module de gestion des marqueurs pour l'annotation des frames
 */

import type { VideoFrame, MarkerPoints, MarkerEvent } from '../types';

// Types de marqueurs
export const MARKER_TYPES = {
  LANDING: 'landing',
  TAKEOFF: 'takeoff',
  FINAL_LANDING: 'finalLanding',
} as const;

type MarkerType = typeof MARKER_TYPES[keyof typeof MARKER_TYPES];

/**
 * Classe de gestion des marqueurs
 */
export class MarkerManager {
  private markers: MarkerPoints;
  private videoFrameCount: number = 0;
  private eventListeners: Map<string, Set<Function>> = new Map();

  constructor() {
    this.markers = {
      landing: null,
      takeoff: null,
      finalLanding: null,
    };
  }

  /**
   * Initialise avec le nombre total de frames
   * @param frameCount - Nombre total de frames
   */
  initialize(frameCount: number): void {
    this.videoFrameCount = frameCount;
  }

  /**
   * Définit un marqueur
   * @param type - Type de marqueur
   * @param frame - Frame à marquer
   */
  setMarker(type: MarkerType, frame: VideoFrame): void {
    const marker = this.createMarkerObject(frame);
    
    switch (type) {
      case MARKER_TYPES.LANDING:
        this.markers.landing = marker;
        break;
      case MARKER_TYPES.TAKEOFF:
        this.markers.takeoff = marker;
        break;
      case MARKER_TYPES.FINAL_LANDING:
        this.markers.finalLanding = marker;
        break;
    }

    this.emitMarkerEvent(type, marker);
    this.emitChangeEvent();
  }

  /**
   * Crée un objet marqueur (clampé aux bornes de la vidéo)
   * @param frame - Frame
   * @returns Objet VideoFrame
   */
  private createMarkerObject(frame: VideoFrame): VideoFrame {
    return {
      ...frame,
      frameNumber: Math.max(0, Math.min(frame.frameNumber, this.videoFrameCount - 1)),
    };
  }

  /**
   * Récupère un marqueur
   * @param type - Type de marqueur
   * @returns Frame marqué ou null
   */
  getMarker(type: MarkerType): VideoFrame | null {
    switch (type) {
      case MARKER_TYPES.LANDING:
        return this.markers.landing;
      case MARKER_TYPES.TAKEOFF:
        return this.markers.takeoff;
      case MARKER_TYPES.FINAL_LANDING:
        return this.markers.finalLanding;
      default:
        return null;
    }
  }

  /**
   * Récupère tous les marqueurs
   * @returns Tous les marqueurs
   */
  getAllMarkers(): MarkerPoints {
    return { ...this.markers };
  }

  /**
   * Supprime un marqueur
   * @param type - Type de marqueur
   */
  clearMarker(type: MarkerType): void {
    switch (type) {
      case MARKER_TYPES.LANDING:
        this.markers.landing = null;
        break;
      case MARKER_TYPES.TAKEOFF:
        this.markers.takeoff = null;
        break;
      case MARKER_TYPES.FINAL_LANDING:
        this.markers.finalLanding = null;
        break;
    }

    this.emitChangeEvent();
  }

  /**
   * Supprime tous les marqueurs
   */
  clearAllMarkers(): void {
    this.markers.landing = null;
    this.markers.takeoff = null;
    this.markers.finalLanding = null;
    
    this.emitResetEvent();
    this.emitChangeEvent();
  }

  /**
   * Vérifie si tous les marqueurs sont positionnés
   * @returns Vrai si tous les marqueurs sont positionnés
   */
  areAllMarkersSet(): boolean {
    return (
      this.markers.landing !== null &&
      this.markers.takeoff !== null &&
      this.markers.finalLanding !== null
    );
  }

  /**
   * Vérifie si les marqueurs sont dans l'ordre correct
   * @returns Vrai si les marqueurs sont valides
   */
  areMarkersValid(): boolean {
    if (!this.areAllMarkersSet()) {
      return false;
    }

    const landingFrame = this.markers.landing!.frameNumber;
    const takeoffFrame = this.markers.takeoff!.frameNumber;
    const finalLandingFrame = this.markers.finalLanding!.frameNumber;

    return (
      landingFrame >= 0 &&
      takeoffFrame > landingFrame &&
      finalLandingFrame > takeoffFrame &&
      finalLandingFrame < this.videoFrameCount
    );
  }

  /**
   * Obtient les frames des marqueurs
   * @returns Tableau avec les numéros de frame [landing, takeoff, finalLanding]
   */
  getMarkerFrames(): [number, number, number] {
    return [
      this.markers.landing?.frameNumber || -1,
      this.markers.takeoff?.frameNumber || -1,
      this.markers.finalLanding?.frameNumber || -1,
    ];
  }

  /**
   * Émet un événement de marqueur
   * @param type - Type de marqueur
   * @param marker - Marqueur
   */
  private emitMarkerEvent(type: MarkerType, marker: VideoFrame): void {
    const event: MarkerEvent = {
      type: `marker:${type}` as 'marker:landing' | 'marker:takeoff' | 'marker:finalLanding',
      frame: marker,
    };
    this.emit(event);
  }

  /**
   * Émet un événement de réinitialisation
   */
  private emitResetEvent(): void {
    const event: MarkerEvent = { type: 'marker:reset' };
    this.emit(event);
  }

  /**
   * Émet un événement de changement
   */
  private emitChangeEvent(): void {
    this.emit({ type: 'marker:change', markers: this.getAllMarkers() } as any);
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
   * @param event - Événement à émettre
   */
  private emit(event: MarkerEvent): void {
    const eventName = event.type;
    const listeners = this.eventListeners.get(eventName);
    if (listeners) {
      listeners.forEach(callback => {
        try {
          callback(event);
        } catch (error) {
          console.error(`Erreur dans l'écouteur ${eventName}:`, error);
        }
      });
    }
  }

  /**
   * Nettoie les ressources
   */
  destroy(): void {
    this.eventListeners.clear();
  }
}

/**
 * Crée un nouveau gestionnaire de marqueurs
 * @returns Nouveau gestionnaire
 */
export function createMarkerManager(): MarkerManager {
  return new MarkerManager();
}

// Exporter le type pour utilisation externe
export type { MarkerType };
