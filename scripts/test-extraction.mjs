#!/usr/bin/env node
/**
 * Test des critères d'acceptation de l'extraction de frames.
 *
 * Génère trois vidéos de référence puis vérifie la méthode sur chacune :
 *  1. CFR 240 fps (analogue slow-mo iPhone en flux constant)
 *  2. VFR mixte : segment 240 fps + segment 30 fps (structure iPhone slow-mo
 *     réel : cadence variable au fil du fichier)
 *  3. CFR 30 fps (vidéo iPhone normale)
 *
 * Pour chaque vidéo :
 *  - le nombre de PNG extraits est ÉGAL au comptage réel ffprobe
 *  - aucune estimation fps × durée n'intervient (aucune cadence forcée)
 *  - déterminisme : deux exécutions produisent des PNG md5-identiques
 *
 * Usage : npm run frames:test
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  analyzeVideo,
  processVideo,
} from './extract-frames.mjs';

const execFileAsync = promisify(execFile);
const nodeRequire = createRequire(import.meta.url);

const WORK_DIR = path.join(process.cwd(), 'tmp', 'frames-test');

function resolveFfmpegBin() {
  if (process.env.RSI_FFMPEG) return process.env.RSI_FFMPEG;
  try {
    return nodeRequire('ffmpeg-static');
  } catch {
    return 'ffmpeg';
  }
}

async function generateFixtures(ffmpeg) {
  const fixtures = [
    {
      name: 'cfr_240fps.mp4',
      // 2 s à 240 fps constant → 480 frames
      build: () => [
        '-y', '-hide_banner', '-nostdin',
        '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=240:duration=2',
        '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast',
        path.join(WORK_DIR, 'cfr_240fps.mp4'),
      ],
      expectedFrames: 480,
    },
    {
      name: 'vfr_mixte_240_30.mkv',
      // 1 s à 240 fps puis 1 s à 30 fps, timestamps préservés → 270 frames VFR
      build: async () => {
        const seg240 = path.join(WORK_DIR, 'seg_240.mp4');
        const seg30 = path.join(WORK_DIR, 'seg_30.mp4');
        const concatList = path.join(WORK_DIR, 'concat.txt');

        await execFileAsync(ffmpeg, [
          '-y', '-hide_banner', '-nostdin',
          '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=240:duration=1',
          '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', seg240,
        ]);
        await execFileAsync(ffmpeg, [
          '-y', '-hide_banner', '-nostdin',
          '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=1',
          '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', seg30,
        ]);

        // Concaténation en préservant les timestamps (passthrough) → VFR réel
        await fs.writeFile(concatList, `file '${seg240.replace(/\\/g, '/')}'\nfile '${seg30.replace(/\\/g, '/')}'\n`);
        const output = path.join(WORK_DIR, 'vfr_mixte_240_30.mkv');
        const major = /ffmpeg version (\d+)\./.exec(
          (await execFileAsync(ffmpeg, ['-version'])).stdout
        )[1];
        const sync = parseInt(major, 10) >= 6
          ? ['-fps_mode', 'passthrough']
          : ['-vsync', 'passthrough'];
        await execFileAsync(ffmpeg, [
          '-y', '-hide_banner', '-nostdin',
          '-f', 'concat', '-safe', '0', '-i', concatList,
          ...sync,
          '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
          output,
        ]);
        return null;
      },
      expectedFrames: 270,
    },
    {
      name: 'normale_30fps.mp4',
      // 2 s à 30 fps (vidéo iPhone normale) → 60 frames
      build: () => [
        '-y', '-hide_banner', '-nostdin',
        '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=2',
        '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast',
        path.join(WORK_DIR, 'normale_30fps.mp4'),
      ],
      expectedFrames: 60,
    },
  ];

  const results = [];
  for (const fixture of fixtures) {
    const videoFile = path.join(WORK_DIR, fixture.name);
    const args = await fixture.build();
    if (args) {
      await execFileAsync(ffmpeg, args, { maxBuffer: 64 * 1024 * 1024 });
    }
    results.push({ ...fixture, videoFile, args: undefined });
  }
  return results;
}

async function main() {
  console.log('── Test extraction de frames (critères d\'acceptation) ─────\n');

  const ffmpeg = resolveFfmpegBin();
  await fs.mkdir(WORK_DIR, { recursive: true });

  console.log('Génération des vidéos de référence…');
  const fixtures = await generateFixtures(ffmpeg);

  let allOk = true;
  const reports = [];

  for (const fixture of fixtures) {
    console.log(`\n▶ ${fixture.name} (attendu : ${fixture.expectedFrames} frames réelles)`);
    const outDir = path.join(WORK_DIR, `out_${path.basename(fixture.name, path.extname(fixture.name))}`);

    // Analyse indépendante : le comptage réel doit correspondre à la fixture
    const analysis = await analyzeVideo(fixture.videoFile);
    if (analysis.nbReadFrames !== fixture.expectedFrames) {
      allOk = false;
      console.error(
        `  ✗ ffprobe compte ${analysis.nbReadFrames} frames ≠ ${fixture.expectedFrames} attendues (fixture invalide ?)`
      );
      continue;
    }
    console.log(`  Comptage réel ffprobe : ${analysis.nbReadFrames} frames — conforme`);

    // Extraction complète avec déterminisme + validation brute (YUV)
    const report = await processVideo(fixture.videoFile, {
      outputDir: outDir,
      verifyDeterminism: true,
      rawYuv: true,
    });

    const checks = [
      report.analysis.realFrameCount === fixture.expectedFrames,
      report.extraction.pngCount === report.analysis.realFrameCount,
      report.validation.ok,
      report.determinism && report.determinism.ok,
      report.rawYuv && report.rawYuv.ok,
    ];
    const ok = checks.every(Boolean);
    allOk = allOk && ok;

    console.log(`  Extraction            : ${report.extraction.pngCount} PNG (${report.extraction.vsync})`);
    console.log(`  Validation count/errs : ${report.validation.ok ? 'OK' : 'ÉCHEC'}`);
    console.log(`  Déterminisme md5      : ${report.determinism.ok ? `OK (${report.determinism.identicalFiles}/${report.determinism.run1Count} identiques)` : 'ÉCHEC'}`);
    console.log(`  YUV brut (bit à bit)  : ${report.rawYuv.ok ? `OK (${report.rawYuv.byteSize} octets)` : 'ÉCHEC'}`);
    console.log(`  fps indicatifs        : r=${report.analysis.rFrameRate}, avg=${report.analysis.avgFrameRate} (non utilisés)`);
    console.log(ok ? '  ✓ CRITÈRES SATISFAITS' : '  ✗ ÉCHEC');

    reports.push({ fixture: fixture.name, ok, report });
  }

  console.log('\n──────────────────────────────────────────────────────────');
  if (allOk) {
    console.log('RÉSULTAT GLOBAL : ✓ tous les critères d\'acceptation sont satisfaits');
    process.exit(0);
  } else {
    console.log('RÉSULTAT GLOBAL : ✗ au moins un critère a échoué');
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`✗ Erreur pendant le test : ${error.message}`);
  process.exit(1);
});
