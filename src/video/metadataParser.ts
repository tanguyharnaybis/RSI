/**
 * Parseur de métadonnées MP4 / MOV (ISO Base Media).
 *
 * L'API vidéo HTML n'expose pas le FPS d'un fichier (seule la durée l'est).
 * Ce parseur lit directement le conteneur binaire pour extraire :
 *  - le nombre exact de frames de la piste vidéo,
 *  - le FPS de lecture exact du conteneur,
 *  - la durée exacte de la piste.
 *
 * Deux structures de fichiers sont gérées :
 *  - Fichier classique : la table des frames (stts) du moov liste les
 *    samples et leurs durées.
 *  - Fichier FRAGMENTÉ (tous les iPhone) : le moov contient des tables
 *    vides et les vraies frames sont décrites dans des fragments moof
 *    (trun) dispersés dans le fichier. Le scan du fichier se fait par
 *    tranches (File.slice) pour ne jamais charger toute la vidéo en RAM.
 *
 * La cadence d'enregistrement (ex. 240 fps pour un slow-mo) n'est PAS
 * stockée dans l'export standard : elle reste une saisie manuelle.
 */

export interface ParsedVideoMetadata {
  /** FPS de lecture du conteneur (frames présentées par seconde de vidéo) */
  playbackFps: number;
  /** Nombre total de frames de la piste vidéo */
  frameCount: number;
  /** Durée de la piste vidéo en secondes */
  durationSeconds: number;
  /** Vrai si les frames ont été comptées dans les fragments moof */
  fragmented: boolean;
}

// Garde-fous de taille pour les chunks chargés en RAM
const MAX_CHUNK_BYTES = 64 * 1024 * 1024;

// ---------- Outils bas niveau ----------

/** Lit une chaîne ASCII de 4 octets (type d'atom) */
function readType(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]
  );
}

/** En-tête d'un atom contenu dans un buffer déjà chargé */
function readAtomHeader(bytes: Uint8Array, offset: number): {
  size: number;
  type: string;
  dataOffset: number;
  end: number;
} | null {
  if (offset + 8 > bytes.length) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, bytes.byteLength - offset);
  let size = view.getUint32(0);
  const type = readType(bytes, offset + 4);
  let dataOffset = offset + 8;

  if (size === 1) {
    if (offset + 16 > bytes.length) return null;
    const hi = view.getUint32(8);
    const lo = view.getUint32(12);
    size = hi * 2 ** 32 + lo;
    dataOffset = offset + 16;
  } else if (size === 0) {
    size = bytes.length - offset;
  }

  if (size < 8 || offset + size > bytes.length) return null;
  return { size, type, dataOffset, end: offset + size };
}

/**
 * Parcourt récursivement les atoms conteneurs d'une plage binaire
 * et appelle le callback sur chaque atom feuille trouvé.
 */
function walkAtoms(
  bytes: Uint8Array,
  start: number,
  end: number,
  containers: Set<string>,
  onLeaf: (type: string, dataStart: number, dataEnd: number) => void
): void {
  let offset = start;
  while (offset < end) {
    const header = readAtomHeader(bytes, offset);
    if (!header) return;
    if (containers.has(header.type)) {
      walkAtoms(bytes, header.dataOffset, header.end, containers, onLeaf);
    } else {
      onLeaf(header.type, header.dataOffset, header.end);
    }
    offset = header.end;
  }
}

// ---------- Parseur du moov (pistes vidéo) ----------

interface TrackInfo {
  trackId: number;
  handler: string;
  timescale: number;
  durationTicks: number;
  sttsSampleCount: number;
  sttsDurationTicks: number;
}

function parseTkhd(bytes: Uint8Array, start: number, end: number, info: TrackInfo): void {
  if (end - start < 16) return;
  const view = new DataView(bytes.buffer, bytes.byteOffset + start, end - start);
  const version = view.getUint8(0);
  // v0 : ver/flags(4) + creation(4) + modification(4) + track_id(4)
  // v1 : ver/flags(4) + creation(8) + modification(8) + track_id(4)
  info.trackId = version === 1 ? view.getUint32(20) : view.getUint32(12);
}

function parseHdlr(bytes: Uint8Array, start: number, end: number, info: TrackInfo): void {
  if (end - start < 12) return;
  info.handler = readType(bytes, start + 8);
}

function parseMdhd(bytes: Uint8Array, start: number, end: number, info: TrackInfo): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset + start, end - start);
  if (end - start < 20) return;
  const version = view.getUint8(0);
  if (version === 1) {
    if (end - start < 28) return;
    info.timescale = view.getUint32(20);
    const hi = view.getUint32(24);
    const lo = view.getUint32(28);
    info.durationTicks = hi * 2 ** 32 + lo;
  } else {
    info.timescale = view.getUint32(12);
    info.durationTicks = view.getUint32(16);
  }
}

function parseStts(bytes: Uint8Array, start: number, end: number, info: TrackInfo): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset + start, end - start);
  if (end - start < 8) return;
  const entryCount = view.getUint32(4);
  let samples = 0;
  let ticks = 0;
  let offset = 8;
  for (let i = 0; i < entryCount && offset + 8 <= end - start; i++) {
    const count = view.getUint32(offset);
    const delta = view.getUint32(offset + 4);
    samples += count;
    ticks += count * delta;
    offset += 8;
  }
  info.sttsSampleCount = samples;
  info.sttsDurationTicks = ticks;
}

interface MoovInfo {
  videoTrack: TrackInfo | null;
  /** default_sample_duration du trex, par track_id (fichiers fragmentés) */
  trexDefaults: Map<number, number>;
}

function parseMoovChunk(bytes: Uint8Array, start: number, end: number): MoovInfo {
  const result: MoovInfo = { videoTrack: null, trexDefaults: new Map() };
  const tracks: TrackInfo[] = [];
  let current: TrackInfo | null = null;

  const containers = new Set(['trak', 'mdia', 'minf', 'stbl', 'mvex']);
  walkAtoms(bytes, start, end, containers, (type, dataStart, dataEnd) => {
    if (type === 'tkhd') {
      current = {
        trackId: 0, handler: '', timescale: 0,
        durationTicks: 0, sttsSampleCount: 0, sttsDurationTicks: 0,
      };
      tracks.push(current);
    }
    const track = current;
    switch (type) {
      case 'tkhd':
        if (track) parseTkhd(bytes, dataStart, dataEnd, track);
        break;
      case 'hdlr':
        if (track) parseHdlr(bytes, dataStart, dataEnd, track);
        break;
      case 'mdhd':
        if (track) parseMdhd(bytes, dataStart, dataEnd, track);
        break;
      case 'stts':
        if (track) parseStts(bytes, dataStart, dataEnd, track);
        break;
      case 'trex': {
        // trex : ver/flags(4) + track_id(4) + desc_idx(4) + default_duration(4)
        if (dataEnd - dataStart < 16) break;
        const view = new DataView(bytes.buffer, bytes.byteOffset + dataStart, dataEnd - dataStart);
        const trackId = view.getUint32(4);
        const defaultDuration = view.getUint32(12);
        result.trexDefaults.set(trackId, defaultDuration);
        break;
      }
    }
  });

  result.videoTrack =
    tracks.find((t) => t.handler === 'vide' && t.timescale > 0) || null;
  return result;
}

// ---------- Parseur des fragments moof (fichiers iPhone) ----------

/** Parse un atom tfhd : track_id + durée par défaut éventuelle */
function parseTfhd(
  bytes: Uint8Array,
  start: number,
  end: number
): { trackId: number; defaultDuration?: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset + start, end - start);
  const flags = view.getUint32(0) & 0xffffff;
  const trackId = view.getUint32(4);
  let offset = 8;
  if (flags & 0x000001) offset += 8; // base-data-offset
  if (flags & 0x000002) offset += 4; // sample-description-index
  let defaultDuration: number | undefined;
  if (flags & 0x000008) {
    defaultDuration = view.getUint32(offset);
    offset += 4;
  }
  return { trackId, defaultDuration };
}

/** Parse un atom trun : nombre de samples et durée cumulée en ticks */
function parseTrun(
  bytes: Uint8Array,
  start: number,
  end: number,
  fallbackDuration: number
): { sampleCount: number; totalTicks: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset + start, end - start);
  if (end - start < 8) return { sampleCount: 0, totalTicks: 0 };
  const version = view.getUint8(0);
  const flags = view.getUint32(0) & 0xffffff;
  const sampleCount = view.getUint32(4);
  let offset = 8;
  if (flags & 0x000001) offset += 4; // data-offset
  if (flags & 0x000004) offset += 4; // first-sample-flags

  const hasDuration = Boolean(flags & 0x000100);
  const hasSize = Boolean(flags & 0x000200);
  const hasFlags = Boolean(flags & 0x000400);
  const hasCto = Boolean(flags & 0x000800);
  const ctoSize = version === 1 ? 8 : 4;

  let totalTicks = 0;
  for (let i = 0; i < sampleCount; i++) {
    let duration = fallbackDuration;
    if (hasDuration) {
      if (offset + 4 > end - start) break;
      const d = view.getUint32(offset);
      offset += 4;
      if (d > 0) duration = d;
    }
    totalTicks += duration;
    if (hasSize) offset += 4;
    if (hasFlags) offset += 4;
    if (hasCto) offset += ctoSize;
    if (offset > end - start && i < sampleCount - 1) break;
  }
  return { sampleCount, totalTicks };
}

/** Compte les frames et les ticks d'un fragment moof pour la piste vidéo */
function parseMoofChunk(
  bytes: Uint8Array,
  start: number,
  end: number,
  videoTrackId: number,
  trexDefault: number
): { frames: number; ticks: number } {
  let frames = 0;
  let ticks = 0;
  let currentTrackId = -1;
  let currentDefaultDuration: number | undefined;

  walkAtoms(bytes, start, end, new Set(['traf']), (type, dataStart, dataEnd) => {
    if (type === 'tfhd') {
      const tfhd = parseTfhd(bytes, dataStart, dataEnd);
      currentTrackId = tfhd.trackId;
      currentDefaultDuration = tfhd.defaultDuration;
    } else if (type === 'trun' && currentTrackId === videoTrackId) {
      const fallback = currentDefaultDuration ?? trexDefault ?? 0;
      const trun = parseTrun(bytes, dataStart, dataEnd, fallback);
      frames += trun.sampleCount;
      ticks += trun.totalTicks;
    }
  });

  return { frames, ticks };
}

// ---------- Assemblage ----------

/**
 * Assemble le résultat à partir du moov et des éventuels fragments.
 * @returns Métadonnées de la piste vidéo, ou null si inexploitables
 */
function parseChunks(
  moovBytes: Uint8Array,
  moofChunks: Uint8Array[]
): ParsedVideoMetadata | null {
  const moov = parseMoovChunk(moovBytes, 0, moovBytes.length);
  const track = moov.videoTrack;
  if (!track) return null;

  // Cas 1 : fichier classique, table stts renseignée
  if (track.sttsSampleCount > 0 && track.sttsDurationTicks > 0) {
    const durationSeconds = track.sttsDurationTicks / track.timescale;
    const playbackFps = track.sttsSampleCount / durationSeconds;
    if (!Number.isFinite(playbackFps) || playbackFps <= 0 || playbackFps > 1000) {
      return null;
    }
    return {
      playbackFps,
      frameCount: track.sttsSampleCount,
      durationSeconds,
      fragmented: false,
    };
  }

  // Cas 2 : fichier fragmenté (iPhone) — compter dans les moof
  if (moofChunks.length === 0) return null;
  const trexDefault = moov.trexDefaults.get(track.trackId) ?? 0;

  let frames = 0;
  let ticks = 0;
  for (const chunk of moofChunks) {
    const result = parseMoofChunk(chunk, 0, chunk.length, track.trackId, trexDefault);
    frames += result.frames;
    ticks += result.ticks;
  }
  if (frames < 2 || ticks <= 0) return null;

  const durationSeconds = ticks / track.timescale;
  const playbackFps = frames / durationSeconds;
  if (!Number.isFinite(playbackFps) || playbackFps <= 0 || playbackFps > 1000) {
    return null;
  }
  return { playbackFps, frameCount: frames, durationSeconds, fragmented: true };
}

// ---------- Scan top-level ----------

/**
 * Extrait les chunks moov/moof d'un buffer complet en RAM.
 */
export function parseMp4Bytes(buffer: ArrayBuffer): ParsedVideoMetadata | null {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 8) return null;
  const firstType = readType(bytes, 4);
  if (!['ftyp', 'moov', 'mdat', 'styp', 'sidx', 'free'].includes(firstType)) {
    return null; // probablement WebM/MKV ou autre format
  }

  let moovChunk: Uint8Array | null = null;
  const moofChunks: Uint8Array[] = [];

  walkAtoms(bytes, 0, bytes.length, new Set(), (type, dataStart, dataEnd) => {
    if (type === 'moov' && !moovChunk) {
      moovChunk = bytes.subarray(dataStart, dataEnd);
    } else if (type === 'moof') {
      moofChunks.push(bytes.subarray(dataStart, dataEnd));
    }
  });

  if (!moovChunk) return null;
  return parseChunks(moovChunk, moofChunks);
}

/** Lit des octets d'un fichier via slice (sans charger tout le fichier) */
async function readBytes(file: File, start: number, end: number): Promise<Uint8Array> {
  const buffer = await file.slice(start, end).arrayBuffer();
  return new Uint8Array(buffer);
}

/**
 * Parse un fichier vidéo MP4/MOV en scannant le fichier par tranches :
 * seuls le moov et les fragments moof sont chargés en RAM.
 * @returns Métadonnées parsées, ou null (format non MP4 / illisible)
 */
export async function parseMp4FileMetadata(file: File): Promise<ParsedVideoMetadata | null> {
  // Vérifier la signature MP4/MOV
  const head = await readBytes(file, 0, Math.min(16, file.size));
  if (head.length < 8) return null;
  const firstType = readType(head, 4);
  if (!['ftyp', 'moov', 'mdat', 'styp', 'sidx', 'free'].includes(firstType)) {
    return null;
  }

  let moovChunk: Uint8Array | null = null;
  const moofChunks: Uint8Array[] = [];

  // Scanner les atoms de premier niveau par sauts successifs
  let offset = 0;
  let guard = 0;
  while (offset + 8 <= file.size && guard < 100000) {
    guard++;
    const headerBytes = await readBytes(file, offset, Math.min(offset + 16, file.size));
    if (headerBytes.length < 8) break;
    const view = new DataView(headerBytes.buffer, headerBytes.byteOffset, headerBytes.length);
    let size = view.getUint32(0);
    const type = readType(headerBytes, 4);

    if (size === 1) {
      if (headerBytes.length < 16) break;
      const hi = view.getUint32(8);
      const lo = view.getUint32(12);
      size = hi * 2 ** 32 + lo;
    } else if (size === 0) {
      size = file.size - offset;
    }
    if (size < 8) break;

    if ((type === 'moov' && !moovChunk) || type === 'moof') {
      if (size <= MAX_CHUNK_BYTES) {
        const chunk = await readBytes(file, offset, offset + size);
        if (type === 'moov') {
          moovChunk = chunk;
        } else {
          moofChunks.push(chunk);
        }
      }
    }

    offset = offset + size;
  }

  if (!moovChunk) return null;
  return parseChunks(moovChunk, moofChunks);
}
