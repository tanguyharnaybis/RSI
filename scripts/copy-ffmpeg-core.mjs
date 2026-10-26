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
  // Le core UMD (chemin classic) + le core ESM (chemin module worker,
  // requis par Safari) partagent le même binaire WASM.
  await fs.mkdir(path.join(destDir, 'esm'), { recursive: true });
  await fs.copyFile(path.join(coreDir, 'ffmpeg-core.js'), path.join(destDir, 'ffmpeg-core.js'));
  await fs.copyFile(path.join(coreDir, 'ffmpeg-core.wasm'), path.join(destDir, 'ffmpeg-core.wasm'));
  await fs.copyFile(
    path.join(root, 'node_modules', '@ffmpeg', 'core', 'dist', 'esm', 'ffmpeg-core.js'),
    path.join(destDir, 'esm', 'ffmpeg-core.js')
  );
  console.log(`✓ Core ffmpeg copié dans public/ffmpeg/ (UMD + ESM + wasm)`);
}

copy().catch((error) => {
  console.error('✗ Copie du core ffmpeg échouée :', error.message);
  process.exit(1);
});
