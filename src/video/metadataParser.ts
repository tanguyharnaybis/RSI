/**
 * Parseur de métadonnées MP4 / MOV (ISO Base Media).
 *
 * L'API vidéo HTML n'expose pas le FPS d'un fichier (seule la durée l'est).
 * Ce parseur lit directement le conteneur binaire pour extraire :
 *  - le nombre exact de frames de la piste vidéo (table stts),
 *  - le FPS de lecture exact du conteneur,
 *  - la durée exacte de la piste.
 *
 * La cadence d'enregistrement (ex. 240 fps pour un slow-mo) n'est PAS
 * stockée dans l'export standard : elle reste une saisie manuelle.
 *
 * Format non géré (WebM/MKV) : retourne null → repli sur la détection
 * à la lecture (requestVideoFrameCallback) ou la saisie manuelle.
 */

export interface ParsedVideoMetadata {
  /** FPS de lecture du conteneur (frames présentées par seconde de vidéo) */
  playbackFps: number;
  /** Nombre total de frames de la piste vidéo */
  frameCount: number;
  /** Durée de la piste vidéo en secondes */
  durationSeconds: number;
}

// ---------- Outils bas niveau ----------

/** Lit une chaîne ASCII de 4 octets (type d'atom) */
function readType(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]
  );
}

/** En-tête d'un atom : { size, type, headerSize } ou null si incomplet */
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
    // Taille étendue sur 64 bits
    if (offset + 16 > bytes.length) return null;
    const hi = view.getUint32(8);
    const lo = view.getUint32(12);
    size = hi * 2 ** 32 + lo;
    dataOffset = offset + 16;
  } else if (size === 0) {
    // L'atom s'étend jusqu'à la fin du fichier
    size = bytes.length - offset;
  }

  if (size < 8 || offset + size > bytes.length) return null;
  return { size, type, dataOffset, end: offset + size };
}

/**
 * Parcourt récursivement les atoms conteneurs d'une plage binaire
 * et appelle le callback sur chaque atom feuille/trouvé.
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

// ---------- Extraction des tables utiles ----------

/** Résultat partiel pour la piste vidéo */
interface TrackInfo {
  handler: string;
  timescale: number;
  durationTicks: number;
  sttsSampleCount: number;
  sttsDurationTicks: number;
}

/** Parse un atom mdhd (MediaHeader) : timescale + duration */
function parseMdhd(bytes: Uint8Array, start: number, end: number, info: TrackInfo): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset + start, end - start);
  if (end - start < 20) return;
  const version = view.getUint8(0);
  if (version === 1) {
    // v1 : creation(8) modification(8) timescale(4) duration(8)
    if (end - start < 28) return;
    info.timescale = view.getUint32(20);
    const hi = view.getUint32(24);
    const lo = view.getUint32(28);
    info.durationTicks = hi * 2 ** 32 + lo;
  } else {
    // v0 : creation(4) modification(4) timescale(4) duration(4)
    info.timescale = view.getUint32(12);
    info.durationTicks = view.getUint32(16);
  }
}

/** Parse un atom hdlr : type de piste (vide = vidéo) */
function parseHdlr(bytes: Uint8Array, start: number, end: number, info: TrackInfo): void {
  if (end - start < 12) return;
  info.handler = readType(bytes, start + 8);
}

/** Parse un atom stts : nombre de frames + durée totale en ticks */
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

// ---------- Parseur principal ----------

/**
 * Parse les octets d'un fichier MP4/MOV et retourne les métadonnées
 * de la piste vidéo, ou null si le format/les tables ne sont pas exploitables.
 */
export function parseMp4Bytes(buffer: ArrayBuffer): ParsedVideoMetadata | null {
  const bytes = new Uint8Array(buffer);

  // Signature : un MP4/MOV commence normalement par un atom "ftyp"
  // (ou "moov"/"mdat" dans de rares cas de fichiers tronqués).
  if (bytes.length < 8) return null;
  const firstType = readType(bytes, 4);
  if (!['ftyp', 'moov', 'mdat', 'styp', 'sidx', 'free'].includes(firstType)) {
    return null; // probablement WebM/MKV ou autre format
  }

  // Localiser l'atom moov au niveau racine
  let moovStart = -1;
  let moovEnd = -1;
  walkAtoms(bytes, 0, bytes.length, new Set(), (type, dataStart, dataEnd) => {
    if (type === 'moov') {
      moovStart = dataStart;
      moovEnd = dataEnd;
    }
  });
  if (moovStart < 0) return null;

  // Parcourir moov > trak > mdia > minf > stbl
  const containers = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl']);
  const tracks: TrackInfo[] = [];
  let current: TrackInfo | null = null;

  walkAtoms(bytes, moovStart, moovEnd, containers, (type, dataStart, dataEnd) => {
    // Détection implicite du début d'un trak : le conteneur est visité
    // avant ses feuilles ; on crée la piste au premier enfant rencontré.
    const depth = type;
    if (depth === 'tkhd') {
      // Début d'un nouveau trak (première feuille rencontrée)
      current = { handler: '', timescale: 0, durationTicks: 0, sttsSampleCount: 0, sttsDurationTicks: 0 };
      tracks.push(current);
    }
    const track = current;
    if (!track) return;
    switch (type) {
      case 'hdlr':
        parseHdlr(bytes, dataStart, dataEnd, track);
        break;
      case 'mdhd':
        parseMdhd(bytes, dataStart, dataEnd, track);
        break;
      case 'stts':
        parseStts(bytes, dataStart, dataEnd, track);
        break;
    }
  });

  // Sélectionner la piste vidéo avec des tables renseignées
  const videoTrack = tracks.find(
    (t) =>
      t.handler === 'vide' &&
      t.timescale > 0 &&
      t.sttsSampleCount > 0 &&
      t.sttsDurationTicks > 0
  );
  if (!videoTrack) return null;

  const durationSeconds = videoTrack.sttsDurationTicks / videoTrack.timescale;
  const playbackFps = videoTrack.sttsSampleCount / durationSeconds;

  if (!Number.isFinite(playbackFps) || playbackFps <= 0 || playbackFps > 1000) {
    return null;
  }

  return {
    playbackFps,
    frameCount: videoTrack.sttsSampleCount,
    durationSeconds,
  };
}

/**
 * Parse un fichier vidéo MP4/MOV.
 * @param file - Fichier vidéo
 * @returns Métadonnées parsées, ou null (format non MP4 / tables absentes)
 */
export async function parseMp4FileMetadata(file: File): Promise<ParsedVideoMetadata | null> {
  const buffer = await file.arrayBuffer();
  return parseMp4Bytes(buffer);
}
