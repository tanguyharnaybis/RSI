/**
 * Copie le runtime WASM de MediaPipe (node_modules) vers public/mediapipe/wasm.
 * Appelé avant dev/build : le runtime n'est pas versionné dans git, il
 * vient du package npm @mediapipe/tasks-vision.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd());
const srcDir = path.join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const destDir = path.join(root, 'public', 'mediapipe', 'wasm');

async function copy() {
  let files;
  try {
    files = await fs.readdir(srcDir);
  } catch {
    console.warn('⚠ @mediapipe/tasks-vision absent : le runtime WASM ne sera pas copié.');
    process.exit(0);
  }
  await fs.mkdir(destDir, { recursive: true });
  for (const file of files) {
    await fs.copyFile(path.join(srcDir, file), path.join(destDir, file));
  }
  console.log(`✓ Runtime WASM MediaPipe copié dans public/mediapipe/wasm/ (${files.length} fichiers)`);
}

copy().catch((error) => {
  console.error('✗ Copie du runtime MediaPipe échouée :', error.message);
  process.exit(1);
});
