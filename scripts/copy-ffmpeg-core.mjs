/**
 * Copie le core ffmpeg.wasm dans public/ffmpeg/ (servi par la PWA).
 * Appelé au postinstall et avant build/dev : le core (~32 Mo) n'est pas
 * versionné dans git, il vient du package npm @ffmpeg/core.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd());
const destDir = path.join(root, 'public', 'ffmpeg');

async function copy() {
  // @ffmpeg/core restreint son champ "exports" : résolution par chemin direct
  const coreDir = path.join(root, 'node_modules', '@ffmpeg', 'core', 'dist', 'umd');
  const probe = path.join(coreDir, 'ffmpeg-core.wasm');
  try {
    await fs.access(probe);
  } catch {
    console.warn('⚠ @ffmpeg/core absent : le core ffmpeg ne sera pas copié (npm install requis).');
    process.exit(0);
  }

  await fs.mkdir(destDir, { recursive: true });
  for (const file of ['ffmpeg-core.js', 'ffmpeg-core.wasm']) {
    await fs.copyFile(path.join(coreDir, file), path.join(destDir, file));
  }
  console.log(`✓ Core ffmpeg copié dans public/ffmpeg/ (depuis ${coreDir})`);
}

copy().catch((error) => {
  console.error('✗ Copie du core ffmpeg échouée :', error.message);
  process.exit(1);
});
