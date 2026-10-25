/**
 * Tests unitaires du parseur de métadonnées MP4/MOV
 */

import { describe, it, expect } from 'vitest';
import { parseMp4Bytes } from '../src/video/metadataParser';

// ---------- Helpers : construction d'un MP4 minimal ----------

/** Construit un atom MP4 : size(4) + type(4) + payload */
function atom(type: string, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  const out = new Uint8Array(8 + payload.length);
  new DataView(out.buffer).setUint32(0, out.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(payload, 8);
  return out;
}

/** u32 big-endian */
function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
}

/** Concatène des tableaux */
function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/**
 * Construit un MP4 minimal avec une piste vidéo :
 * timescale donné, N frames de `frameDelta` ticks chacune.
 */
function buildMp4(timescale: number, frameCount: number, frameDelta: number): Uint8Array {
  const durationTicks = frameCount * frameDelta;

  // stts : une seule entrée (frameCount frames × frameDelta ticks)
  const stts = atom('stts', concat(u32(0), u32(1), u32(frameCount), u32(frameDelta)));
  const stbl = atom('stbl', stts);

  // hdlr : version/flags + pre_defined + handler 'vide'
  const hdlr = atom('hdlr', concat(u32(0), u32(0), new TextEncoder().encode('vide'), u32(0)));

  // mdhd v0 : version/flags(4) + creation(4) + modification(4)
  //           + timescale(4) + duration(4) + langue(2) + qualité(2)
  const mdhd = atom(
    'mdhd',
    concat(u32(0), u32(0), u32(0), u32(timescale), u32(durationTicks), u32(0))
  );

  const minf = atom('minf', stbl);
  const mdia = atom('mdia', concat(mdhd, hdlr, minf));
  const tkhd = atom('tkhd', u32(0));
  const trak = atom('trak', concat(tkhd, mdia));

  const mvhd = atom('mvhd', concat(u32(0), u32(0), u32(0), u32(timescale), u32(durationTicks)));
  const moov = atom('moov', concat(mvhd, trak));

  const ftyp = atom('ftyp', new TextEncoder().encode('isom'));
  const mdat = atom('mdat', new Uint8Array(16));

  return concat(ftyp, moov, mdat);
}

// ---------- Tests ----------

describe('parseMp4Bytes', () => {
  it('devrait extraire frameCount, fps de lecture et durée exacts', () => {
    // 240 frames, timescale 600, delta 20 ticks/frame → 30 fps, 8 s
    const mp4 = buildMp4(600, 240, 20);
    const result = parseMp4Bytes(mp4.buffer as ArrayBuffer);

    expect(result).not.toBeNull();
    expect(result!.frameCount).toBe(240);
    expect(result!.playbackFps).toBeCloseTo(30, 1);
    expect(result!.durationSeconds).toBeCloseTo(8, 1);
  });

  it('devrait gérer un conteneur slow-mo (240 fps lecture)', () => {
    // 480 frames, timescale 240, delta 1 → 240 fps de lecture, 2 s
    const mp4 = buildMp4(240, 480, 1);
    const result = parseMp4Bytes(mp4.buffer as ArrayBuffer);

    expect(result).not.toBeNull();
    expect(result!.frameCount).toBe(480);
    expect(result!.playbackFps).toBeCloseTo(240, 0);
    expect(result!.durationSeconds).toBeCloseTo(2, 1);
  });

  it('devrait refléter un export iPhone slow-mo (30 fps de lecture)', () => {
    // Vidéo 240 fps d'enregistrement, exportée à 30 fps de lecture :
    // 2 s réelles → 480 frames présentées sur 16 s de lecture
    const mp4 = buildMp4(90000, 480, 3000); // 480 frames × 3000/90000 s = 16 s
    const result = parseMp4Bytes(mp4.buffer as ArrayBuffer);

    expect(result).not.toBeNull();
    expect(result!.frameCount).toBe(480);
    expect(result!.playbackFps).toBeCloseTo(30, 0);
    expect(result!.durationSeconds).toBeCloseTo(16, 0);
    // Temps réel dérivable : 480 / 240 = 2 s
  });

  it('devrait retourner null pour un format non MP4 (WebM)', () => {
    const ebml = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x96, 0xbf, 0x42, 0x86]);
    expect(parseMp4Bytes(ebml.buffer as ArrayBuffer)).toBeNull();
  });

  it('devrait retourner null pour des données trop courtes', () => {
    expect(parseMp4Bytes(new Uint8Array(4).buffer as ArrayBuffer)).toBeNull();
  });

  it('devrait retourner null si le moov est absent', () => {
    const ftyp = atom('ftyp', new TextEncoder().encode('isom'));
    const mdat = atom('mdat', new Uint8Array(16));
    const mp4 = concat(ftyp, mdat);
    expect(parseMp4Bytes(mp4.buffer as ArrayBuffer)).toBeNull();
  });
});
