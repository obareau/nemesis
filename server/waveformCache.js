import fs from 'fs';
import path from 'path';
import { WAVEFORM_CACHE_DIR } from './config.js';
import { runFfmpeg } from './analysis.js';
import { scanGeneration } from './store.js';

export function waveformCachePathFor(filePath) {
  const stat = fs.statSync(filePath);
  const cacheKey = Buffer.from(`${filePath}:${stat.size}:${Math.floor(stat.mtimeMs)}`).toString('base64url');
  return path.join(WAVEFORM_CACHE_DIR, `${cacheKey}.png`);
}

// Pré-génère les sonogrammes de tous les fichiers du scan en tâche de fond, à faible
// concurrence, pour que le scrubber/peintre/comparaison A-B les affichent instantanément
// plutôt que d'attendre un premier appel ffmpeg à la demande. Abandonne si un nouveau scan démarre.
export async function warmWaveformCache(files, generation) {
  fs.mkdirSync(WAVEFORM_CACHE_DIR, { recursive: true });
  let idx = 0;
  const concurrency = 3;
  async function worker() {
    while (idx < files.length) {
      if (scanGeneration !== generation) return;
      const file = files[idx++];
      try {
        const cachePath = waveformCachePathFor(file.path);
        if (!fs.existsSync(cachePath)) {
          await runFfmpeg([
            '-y', '-i', file.path,
            '-filter_complex', 'showwavespic=s=1200x140:colors=0x7b2cbf',
            '-frames:v', '1', cachePath
          ]);
        }
      } catch {
        // fichier illisible/corrompu — pas bloquant, le sonogramme sera régénéré à la demande
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
}
