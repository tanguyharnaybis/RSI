#!/usr/bin/env node
/**
 * RSI Calc — Extraction de frames fiable (ffmpeg / ffprobe)
 *
 * Conçu pour les vidéos slow-motion iPhone (120/240 fps, VFR), les vidéos
 * iPhone normales et les vidéos tierces (MP4/MKV, CFR ou VFR).
 *
 * PRINCIPES (à ne pas violer) :
 *  - Un slow-mo iPhone est un flux 120/240 fps ralenti à la lecture, PAS une
 *    vidéo étirée. Ne jamais deviner la cadence depuis la durée apparente.
 *  - Les fichiers iPhone sont majoritairement VFR : la cadence varie au fil
 *    du fichier. r_frame_rate / avg_frame_rate sont INDICATIFS : ne jamais
 *    s'en servir pour calculer un nombre de frames ou une durée.
 *  - INTERDIT : toute logique de cadence forcée (-r, fps=30, vsync cfr,
 *    "frames = durée × fps"). Elle duplique ou supprime des frames en VFR.
 *  - Référence absolue du nombre de frames : ffprobe -count_frames
 *    (nb_read_frames), comptage réel par décodage, fiable en VFR.
 *  - Extraction : -fps_mode passthrough (ou -vsync passthrough selon la
 *    version) : chaque frame décodée sort exactement une fois, avec ses
 *    timestamps d'origine. Sortie PNG (sans perte), jamais JPEG.
 *  - Validation obligatoire : le nombre de PNG doit être ÉGAL à
 *    nb_read_frames. Toute erreur de décodage est un échec, pas un warning.
 *
 * Couleur : les sources sont YUV 4:2:0 ; la conversion YUV->RGB des PNG est
 * déterministe, mais la sous-échantillonnage chroma est inhérent au fichier
 * source. Pour une fidélité bit à bit, utiliser --raw-yuv (yuv420p brut).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const execFileAsync = promisify(execFile);
const nodeRequire = createRequire(import.meta.url);

const DECODE_ERROR_PATTERNS = [
  /Invalid data found/i,
  /corrupt/i,
  /error while decoding/i,
  /non-existing PPS/i,
  /Decode returned error/i,
];

// ---------------------------------------------------------------------------
// Résolution des binaires : variable d'environnement > package statique > PATH
// ---------------------------------------------------------------------------

function resolveFfmpegBin() {
  if (process.env.RSI_FFMPEG) return process.env.RSI_FFMPEG;
  try {
    return nodeRequire('ffmpeg-static');
  } catch {
    return 'ffmpeg';
  }
}

function resolveFfprobeBin() {
  if (process.env.RSI_FFPROBE) return process.env.RSI_FFPROBE;
  try {
    return nodeRequire('ffprobe-static').path;
  } catch {
    return 'ffprobe';
  }
}

async function run(bin, args, label) {
  try {
    return await execFileAsync(bin, args, { maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    const detail = (error.stderr || error.message || '').trim();
    throw new Error(
      `${label} a échoué (${bin} ${args.slice(0, 4).join(' ')}…) : ${detail.split('\n').slice(-4).join(' | ')}`
    );
  }
}

/** Version majeure de ffmpeg (choisit -fps_mode vs -vsync) */
async function ffmpegMajorVersion(ffmpegBin) {
  const { stdout } = await run(ffmpegBin, ['-version'], 'ffmpeg -version');
  const match = /ffmpeg version (\d+)\./.exec(stdout);
  if (!match) throw new Error('Impossible de déterminer la version de ffmpeg.');
  return parseInt(match[1], 10);
}

/** Option de synchronisation : jamais de cadence forcée, toujours passthrough */
function vsyncOption(majorVersion) {
  // -fps_mode existe depuis ffmpeg 5.1 ; -vsync est son alias historique
  return majorVersion >= 6 ? ['-fps_mode', 'passthrough'] : ['-vsync', 'passthrough'];
}

// ---------------------------------------------------------------------------
// Étape 1 : analyse (ffprobe, comptage réel, zéro estimation)
// ---------------------------------------------------------------------------

export async function analyzeVideo(videoFile, { ffprobeBin } = {}) {
  const ffprobe = ffprobeBin || resolveFfprobeBin();

  const args = [
    '-v', 'error',
    '-count_frames', // décode le flux pour compter les frames réelles (fiable en VFR)
    '-select_streams', 'v:0',
    '-show_entries',
    'stream=nb_read_frames,r_frame_rate,avg_frame_rate,codec_name,pix_fmt,width,height',
    '-of', 'json',
    videoFile,
  ];

  const { stdout } = await run(ffprobe, args, 'ffprobe -count_frames');
  const parsed = JSON.parse(stdout);
  const stream = parsed.streams && parsed.streams[0];
  if (!stream) {
    throw new Error('Aucun flux vidéo détecté dans le fichier.');
  }

  const nbReadFrames = parseInt(stream.nb_read_frames, 10);
  if (!Number.isFinite(nbReadFrames) || nbReadFrames < 0) {
    throw new Error(
      'ffprobe n\'a pas pu compter les frames (nb_read_frames absent). Le fichier est peut-être corrompu ou le conteneur non supporté.'
    );
  }

  return {
    nbReadFrames,
    codecName: stream.codec_name,
    pixFmt: stream.pix_fmt,
    width: stream.width,
    height: stream.height,
    // Indicatifs en VFR — affichés mais JAMAIS utilisés pour un calcul
    rFrameRate: stream.r_frame_rate,
    avgFrameRate: stream.avg_frame_rate,
  };
}

// ---------------------------------------------------------------------------
// Étape 2 : extraction (passthrough, sans perte, timestamps préservés)
// ---------------------------------------------------------------------------

function parseShowinfo(stderr) {
  const entries = [];
  for (const line of stderr.split('\n')) {
    if (!line.includes('Parsed_showinfo')) continue;
    const match = /n:\s*(\d+)\s+pts:\s*(-?\d+)\s+pts_time:\s*(-?[\d.eE+-]+)/.exec(line);
    if (match) {
      entries.push({
        frameNumber: parseInt(match[1], 10),
        pts: parseInt(match[2], 10),
        ptsTime: parseFloat(match[3]),
      });
    }
  }
  return entries;
}

export async function extractFrames(
  videoFile,
  outputDir,
  { ffmpegBin, ffprobeAnalysis } = {}
) {
  const ffmpeg = ffmpegBin || resolveFfmpegBin();
  const major = await ffmpegMajorVersion(ffmpeg);
  const sync = vsyncOption(major);

  // Le dossier de sortie ne doit pas contenir de PNG d'une exécution
  // précédente : la validation compterait des fichiers étrangers.
  await fs.mkdir(outputDir, { recursive: true });
  const existing = await fs.readdir(outputDir);
  if (existing.some((f) => f.endsWith('.png'))) {
    throw new Error(
      `Le dossier ${outputDir} contient déjà des PNG. Videz-le ou choisissez un autre dossier (--out).`
    );
  }

  const args = [
    '-xerror', // toute erreur de décodage fait échouer la commande
    '-hide_banner',
    '-nostdin',
    '-i', videoFile,
    '-map', '0:v:0',
    '-vf', 'showinfo', // logge le pts de chaque frame décodée (index timestamps)
    ...sync, // passthrough : chaque frame sort exactement une fois
    '-frame_pts', '1', // nommage selon les timestamps d'origine (option image2)
    path.join(outputDir, 'frame_%06d.png'),
  ];

  const { stderr } = await run(ffmpeg, args, 'extraction ffmpeg');

  // Erreurs de décodage = échec, jamais un simple avertissement
  const decodeErrors = DECODE_ERROR_PATTERNS.filter((pattern) => pattern.test(stderr));
  if (decodeErrors.length > 0) {
    throw new Error(
      `Erreurs de décodage détectées : ${decodeErrors.map((p) => p.source).join(', ')}`
    );
  }

  const files = (await fs.readdir(outputDir)).filter((f) => f.endsWith('.png')).sort();
  const showinfo = parseShowinfo(stderr);

  return { files, showinfo, stderr, vsyncUsed: sync.join(' ') };
}

// ---------------------------------------------------------------------------
// Étape 3 : validation obligatoire (échouer bruyamment plutôt que livrer faux)
// ---------------------------------------------------------------------------

async function pngDimensions(file) {
  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.alloc(24);
    await handle.read(buffer, 0, 24, 0);
    if (buffer.toString('ascii', 1, 4) !== 'PNG' || buffer.toString('ascii', 12, 16) !== 'IHDR') {
      throw new Error(`${file} n'est pas un PNG valide.`);
    }
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  } finally {
    await handle.close();
  }
}

export async function validateExtraction(
  analysis,
  extraction,
  outputDir,
  { sampleCount = 3 } = {}
) {
  const problems = [];
  const { files, showinfo } = extraction;

  // 1. Le nombre de PNG doit être ÉGAL au comptage réel ffprobe
  if (files.length !== analysis.nbReadFrames) {
    problems.push(
      `Nombre de frames incohérent : ${files.length} PNG extraits ≠ ${analysis.nbReadFrames} frames réelles (ffprobe nb_read_frames). ` +
      'Le décodage a dupliqué ou perdu des frames — résultat NON livré.'
    );
  }

  // 2. L'index showinfo doit couvrir chaque frame exactement une fois
  if (showinfo.length !== analysis.nbReadFrames) {
    problems.push(
      `Index showinfo incohérent : ${showinfo.length} frames loggées ≠ ${analysis.nbReadFrames} attendues.`
    );
  }
  const uniquePts = new Set(showinfo.map((e) => e.pts));
  if (uniquePts.size !== showinfo.length) {
    problems.push(
      `Timestamps dupliqués dans le flux (${showinfo.length} frames, ${uniquePts.size} pts uniques).`
    );
  }

  // 3. Échantillon de PNG : dimensions cohérentes avec le flux
  const samples = new Set();
  if (files.length > 0) {
    const step = Math.max(1, Math.floor(files.length / sampleCount));
    for (let i = 0; i < files.length && samples.size < sampleCount; i += step) {
      samples.add(files[i]);
    }
    samples.add(files[files.length - 1]);
  }
  for (const file of samples) {
    const dims = await pngDimensions(path.join(outputDir, file));
    if (dims.width !== analysis.width || dims.height !== analysis.height) {
      problems.push(
        `Dimensions incohérentes pour ${file} : ${dims.width}×${dims.height} ≠ ${analysis.width}×${analysis.height} (flux).`
      );
    }
  }

  return { ok: problems.length === 0, problems, checkedSamples: [...samples] };
}

// ---------------------------------------------------------------------------
// Déterminisme : deux exécutions → ensembles de PNG identiques bit à bit
// ---------------------------------------------------------------------------

async function md5OfDirectory(dir) {
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.png')).sort();
  const hashes = new Map();
  for (const file of files) {
    const buffer = await fs.readFile(path.join(dir, file));
    hashes.set(file, crypto.createHash('md5').update(buffer).digest('hex'));
  }
  const combined = [...hashes.entries()]
    .map(([file, hash]) => `${file}:${hash}`)
    .sort()
    .join('\n');
  return {
    fileCount: files.length,
    fileHashes: hashes,
    combinedHash: crypto.createHash('md5').update(combined).digest('hex'),
  };
}

export async function verifyDeterminism(videoFile, outputDir, { ffmpegBin } = {}) {
  const run1Dir = path.join(outputDir, 'determinism-run-1');
  const run2Dir = path.join(outputDir, 'determinism-run-2');

  await extractFrames(videoFile, run1Dir, { ffmpegBin });
  await extractFrames(videoFile, run2Dir, { ffmpegBin });

  const hash1 = await md5OfDirectory(run1Dir);
  const hash2 = await md5OfDirectory(run2Dir);

  let identicalFiles = 0;
  let differingFiles = [];
  for (const [file, hash] of hash1.fileHashes) {
    if (hash2.fileHashes.get(file) === hash) {
      identicalFiles++;
    } else {
      differingFiles.push(file);
    }
  }

  return {
    ok: hash1.combinedHash === hash2.combinedHash && hash1.fileCount === hash2.fileCount,
    run1: hash1,
    run2: hash2,
    identicalFiles,
    differingFiles,
  };
}

// ---------------------------------------------------------------------------
// Option : sortie YUV brut (fidélité bit à bit, yuv420p)
// ---------------------------------------------------------------------------

export async function extractRawYuv(videoFile, outputFile, { ffmpegBin } = {}) {
  const ffmpeg = ffmpegBin || resolveFfmpegBin();
  const major = await ffmpegMajorVersion(ffmpeg);
  const sync = vsyncOption(major);

  const args = [
    '-xerror', '-hide_banner', '-nostdin',
    '-i', videoFile,
    '-map', '0:v:0',
    ...sync,
    '-f', 'rawvideo',
    '-pix_fmt', 'yuv420p',
    outputFile,
  ];
  await run(ffmpeg, args, 'extraction raw YUV');

  const stats = await fs.stat(outputFile);
  return stats.size;
}

// ---------------------------------------------------------------------------
// Pipeline complet + rapport
// ---------------------------------------------------------------------------

export async function processVideo(videoFile, options = {}) {
  const {
    outputDir,
    verifyDeterminism: withDeterminism = false,
    rawYuv = false,
    keepDirs = false,
  } = options;

  const ffmpegBin = resolveFfmpegBin();
  const analysis = await analyzeVideo(videoFile);

  const extraction = await extractFrames(videoFile, outputDir, { ffmpegBin });
  const validation = await validateExtraction(analysis, extraction, outputDir);

  const report = {
    file: path.basename(videoFile),
    analysis: {
      realFrameCount: analysis.nbReadFrames,
      codec: analysis.codecName,
      pixFmt: analysis.pixFmt,
      resolution: `${analysis.width}×${analysis.height}`,
      // Indicatifs (surtout en VFR) — jamais utilisés pour un calcul
      rFrameRate: analysis.rFrameRate,
      avgFrameRate: analysis.avgFrameRate,
    },
    extraction: {
      outputDir,
      pngCount: extraction.files.length,
      vsync: extraction.vsyncUsed,
      timestampIndex: extraction.showinfo.length,
    },
    validation: {
      ok: validation.ok,
      problems: validation.problems,
      checkedSamples: validation.checkedSamples,
    },
    determinism: null,
    rawYuv: null,
  };

  if (!validation.ok) {
    if (!keepDirs) {
      await fs.rm(outputDir, { recursive: true, force: true }).catch(() => {});
    }
    throw new Error(`Validation échouée pour ${videoFile} : ${validation.problems.join(' | ')}`);
  }

  if (withDeterminism) {
    const det = await verifyDeterminism(videoFile, outputDir, { ffmpegBin });
    report.determinism = {
      ok: det.ok,
      run1Count: det.run1.fileCount,
      run2Count: det.run2.fileCount,
      identicalFiles: det.identicalFiles,
      differingFiles: det.differingFiles.slice(0, 5),
      combinedMd5: det.run1.combinedHash,
    };
    if (!det.ok) {
      throw new Error(
        `Non-déterminisme détecté pour ${videoFile} : ${det.differingFiles.length} fichiers diffèrent entre deux exécutions.`
      );
    }
  }

  if (rawYuv) {
    const yuvFile = path.join(outputDir, 'frames.yuv');
    const byteSize = await extractRawYuv(videoFile, yuvFile, { ffmpegBin });
    const expected = analysis.nbReadFrames * analysis.width * analysis.height * 1.5; // yuv420p
    const rawOk = byteSize === expected;
    report.rawYuv = {
      file: yuvFile,
      byteSize,
      expectedByteSize: expected,
      ok: rawOk,
    };
    if (!rawOk) {
      throw new Error(
        `Taille YUV brut incohérente : ${byteSize} octets ≠ ${expected} attendus (${analysis.nbReadFrames} frames yuv420p).`
      );
    }
  }

  return report;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage() {
  console.log(`Usage : node scripts/extract-frames.mjs VIDEO [options]

Options :
  --out DIR               Dossier de sortie pour les PNG (défaut : ./frames)
  --verify-determinism    Extrait 2 fois et compare les md5 (bit à bit)
  --raw-yuv               Sort aussi les frames en YUV 4:2:0 brut (fidélité max)
  --json FILE             Écrit le rapport JSON dans FILE
  --keep-dirs             Conserve les dossiers même si la validation échoue

Exemples :
  node scripts/extract-frames.mjs ma_video_slowmo.mov --out out/ --verify-determinism
  npm run frames:extract -- ma_video.mp4 --out out/`);
}

async function main(argv) {
  const positional = [];
  let outDir = 'frames';
  let withDeterminism = false;
  let rawYuv = false;
  let jsonFile = null;
  let keepDirs = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--out': outDir = argv[++i]; break;
      case '--verify-determinism': withDeterminism = true; break;
      case '--raw-yuv': rawYuv = true; break;
      case '--json': jsonFile = argv[++i]; break;
      case '--keep-dirs': keepDirs = true; break;
      case '--help': case '-h': usage(); process.exit(0);
      default:
        if (arg.startsWith('--')) {
          console.error(`Option inconnue : ${arg}`); usage(); process.exit(1);
        }
        positional.push(arg);
    }
  }

  if (positional.length !== 1) {
    usage();
    process.exit(1);
  }

  try {
    const report = await processVideo(positional[0], {
      outputDir: outDir,
      verifyDeterminism: withDeterminism,
      rawYuv,
      keepDirs,
    });

    const a = report.analysis;
    const e = report.extraction;
    console.log('── RSI Calc — Extraction de frames (ffmpeg) ──────────────');
    console.log(`Fichier          : ${report.file}`);
    console.log(`Codec            : ${a.codec} (${a.pixFmt}, ${a.resolution})`);
    console.log(`Frames réelles   : ${a.realFrameCount} (ffprobe nb_read_frames — comptage réel)`);
    console.log(`fps (indicatifs) : r_frame_rate=${a.rFrameRate}, avg_frame_rate=${a.avgFrameRate} — non utilisés pour tout calcul`);
    console.log(`Extraction       : ${e.pngCount} PNG (${e.vsync}, sans perte, timestamps préservés)`);
    console.log(`Index timestamps : ${e.timestampIndex} entrées (showinfo pts/pts_time)`);
    console.log(`Validation       : ${report.validation.ok ? 'OK — count == nb_read_frames, aucune erreur de décodage, dimensions cohérentes' : 'ÉCHEC'}`);
    if (report.determinism) {
      console.log(`Déterminisme     : ${report.determinism.ok ? `OK — 2 exécutions, ${report.determinism.identicalFiles}/${report.determinism.run1Count} fichiers md5-identiques` : 'ÉCHEC'}`);
    }
    if (report.rawYuv) {
      console.log(`YUV brut         : ${report.rawYuv.ok ? `OK — ${report.rawYuv.byteSize} octets (${a.realFrameCount} frames yuv420p)` : 'ÉCHEC'}`);
    }
    console.log('──────────────────────────────────────────────────────────');

    if (jsonFile) {
      await fs.writeFile(jsonFile, JSON.stringify(report, null, 2));
      console.log(`Rapport JSON     : ${jsonFile}`);
    }
    process.exit(0);
  } catch (error) {
    console.error(`\n✗ ÉCHEC : ${error.message}`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('extract-frames.mjs')) {
  main(process.argv.slice(2));
}
