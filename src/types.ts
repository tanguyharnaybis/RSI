/**
 * Types principaux pour l'application RSI Calc
 */

// ============================================
// Types de base
// ============================================

/** Frame identifiée dans la vidéo */
export interface VideoFrame {
  frameNumber: number;
  timestamp: number; // en secondes
  imageData?: ImageData; // pour affichage
}

/** Points de marquage pour le calcul RSI */
export interface MarkerPoints {
  landing: VideoFrame | null;
  takeoff: VideoFrame | null;
  finalLanding: VideoFrame | null;
}

// ============================================
// Métadonnées vidéo
// ============================================

/** Métadonnées de la vidéo chargée */
export interface VideoMetadata {
  duration: number; // en secondes
  fps: number;
  frameCount: number;
  width: number;
  height: number;
  isSlowMotion: boolean;
  detectedFps?: number; // FPS détecté automatiquement
  playbackFps?: number; // FPS de lecture du conteneur (navigation frame-par-frame)
}

// ============================================
// Calculs RSI
// ============================================

/** Résultats d'un calcul RSI */
export interface RSIResult {
  contactTime: number; // en secondes
  flightTime: number; // en secondes
  height: number; // en mètres
  rsi: number; // en m/s
  modifiedRsi: number; // en m/s
  totalTime: number; // en secondes
  dropHeight?: number; // en mètres (optionnel)
}

/** Résultats formatés pour affichage */
export interface FormattedRSIResult {
  contactTimeMs: number; // en millisecondes
  flightTimeMs: number; // en millisecondes
  heightCm: number; // en centimètres
  rsi: number;
  modifiedRsi: number;
}

// ============================================
// Sessions et stockage
// ============================================

/** Un essai individuel */
export interface Trial {
  id: string;
  sessionId: string;
  timestamp: number; // Date.now()
  markers: MarkerPoints;
  metadata: VideoMetadata;
  result: RSIResult;
  formattedResult: FormattedRSIResult;
  notes?: string;
}

/** Une session d'entraînement */
export interface Session {
  id: string;
  name: string;
  dropHeightCm: number; // hauteur de drop en cm
  date: string; // format YYYY-MM-DD
  trials: Trial[];
  createdAt: number; // Date.now()
  updatedAt: number; // Date.now()
}

/** Statistiques pour une session */
export interface SessionStats {
  sessionId: string;
  meanRsi: number;
  stdDevRsi: number;
  meanModifiedRsi: number;
  stdDevModifiedRsi: number;
  meanHeight: number;
  meanContactTime: number;
  meanFlightTime: number;
  trialCount: number;
}

// ============================================
// État de l'application
// ============================================

/** État global de l'application */
export interface AppState {
  currentSession: Session | null;
  sessions: Session[];
  currentVideo: VideoMetadata | null;
  markers: MarkerPoints;
  currentFrame: number;
  isPlaying: boolean;
  playbackRate: number;
  zoomEnabled: boolean;
  zoomRect: { x: number; y: number; width: number; height: number } | null;
  gravity: number; // g en m/s² (9.81 par défaut)
}

// ============================================
// Événements UI
// ============================================

/** Types d'événements pour la communication entre modules */
export type VideoEvent = 
  | { type: 'video:loaded'; metadata: VideoMetadata }
  | { type: 'video:frame:changed'; frame: number }
  | { type: 'video:play' }
  | { type: 'video:pause' }
  | { type: 'video:rate:changed'; rate: number };

export type MarkerEvent = 
  | { type: 'marker:landing'; frame: VideoFrame }
  | { type: 'marker:takeoff'; frame: VideoFrame }
  | { type: 'marker:finalLanding'; frame: VideoFrame }
  | { type: 'marker:reset' };

export type CalculationEvent = 
  | { type: 'calculation:result'; result: RSIResult; formatted: FormattedRSIResult }
  | { type: 'calculation:error'; error: string };

export type SessionEvent = 
  | { type: 'session:created'; session: Session }
  | { type: 'session:selected'; session: Session }
  | { type: 'session:trial:added'; trial: Trial }
  | { type: 'session:deleted'; sessionId: string };

/** Événement générique de l'application */
export type AppEvent = VideoEvent | MarkerEvent | CalculationEvent | SessionEvent;

// ============================================
// Configuration
// ============================================

/** Configuration de l'application */
export interface AppConfig {
  gravity: number;
  minFps: number; // FPS minimum pour être considéré comme slow-motion
  defaultPlaybackRate: number;
  theme: 'light' | 'dark';
  language: string;
}

// ============================================
// Classes de service
// ============================================

/** Interface pour le stockage */
export interface StorageService {
  saveSession(session: Session): Promise<Session>;
  getSession(sessionId: string): Promise<Session | null>;
  getAllSessions(): Promise<Session[]>;
  deleteSession(sessionId: string): Promise<void>;
  updateTrial(sessionId: string, trial: Trial): Promise<Trial>;
  deleteTrial(sessionId: string, trialId: string): Promise<void>;
}

/** Interface pour le lecteur vidéo */
export interface VideoPlayer {
  loadVideo(file: File): Promise<VideoMetadata>;
  play(): void;
  pause(): void;
  goToFrame(frame: number): void;
  nextFrame(): void;
  previousFrame(): void;
  setPlaybackRate(rate: number): void;
  getCurrentFrame(): number;
  getFrameAtTime(time: number): number;
  getTimeAtFrame(frame: number): number;
  addEventListener(event: string, callback: (...args: any[]) => void): void;
  removeEventListener(event: string, callback: (...args: any[]) => void): void;
  destroy(): void;
}

/** Interface pour le calcul RSI */
export interface RSICalculator {
  calculate(
    landingFrame: number,
    takeoffFrame: number,
    finalLandingFrame: number,
    fps: number,
    gravity?: number
  ): RSIResult;
  formatResult(result: RSIResult): FormattedRSIResult;
}
