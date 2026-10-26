/**
 * Tests du parseur des logs ffmpeg (showinfo + metadata/scene_score)
 * Les lignes de test sont les sorties RÉELLES observées avec ffmpeg 6.x.
 */

import { describe, it, expect } from 'vitest';
import { parseShowinfoLine, parseSceneLogLine } from '../src/video/ffmpegIndex';

describe('parseShowinfoLine', () => {
  it('parse une ligne showinfo réelle', () => {
    const line =
      '[Parsed_showinfo_0 @ 00000299a3ce7940] n:   0 pts:      0 pts_time:0       duration:     64 duration_time:0.00416667 fmt:yuv420p';
    const parsed = parseShowinfoLine(line);
    expect(parsed).toEqual({ frameNumber: 0, pts: 0, ptsTime: 0 });
  });

  it('parse une frame intermédiaire avec pts_time décimal', () => {
    const line =
      '[Parsed_showinfo_0 @ 0x7f00] n: 120 pts: 1843200 pts_time:120      fmt:yuv420p';
    const parsed = parseShowinfoLine(line);
    expect(parsed!.frameNumber).toBe(120);
    expect(parsed!.ptsTime).toBe(120);
  });

  it('retourne null pour une ligne non showinfo', () => {
    expect(parseShowinfoLine('[Parsed_metadata_2 @ 0x1] frame:0 pts:0 pts_time:0')).toBeNull();
  });
});

describe('parseSceneLogLine (clé réelle : lavfi.scene_score)', () => {
  it('parse un bloc frame/pts_time réel', () => {
    const line = '[Parsed_metadata_2 @ 0000018b18a2be00] frame:0    pts:0       pts_time:0';
    expect(parseSceneLogLine(line)).toEqual({ kind: 'block', ptsTime: 0 });
  });

  it('parse la clé lavfi.scene_score (forme réelle du filtre select)', () => {
    const line = '[Parsed_metadata_2 @ 0000018b18a2be00] lavfi.scene_score=0.004854';
    expect(parseSceneLogLine(line)).toEqual({ kind: 'score', scene: 0.004854 });
  });

  it('accepte aussi la forme courte lavfi.scene (robustesse)', () => {
    const line = '[Parsed_metadata_2 @ 0x1] lavfi.scene=0.042000';
    expect(parseSceneLogLine(line)).toEqual({ kind: 'score', scene: 0.042 });
  });

  it('retourne null pour les lignes hors sujet', () => {
    expect(parseSceneLogLine('[Parsed_showinfo_0 @ 0x1] n:   0 pts:0 pts_time:0')).toBeNull();
    expect(parseSceneLogLine('Press [q] to stop')).toBeNull();
  });
});
