import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import {
  FFMPEG_BIN, FFPROBE_BIN, WHISPER_PYTHON, TRANSCRIBE_SCRIPT, ESSENTIA_PYTHON, ANALYZE_AUDIO_SCRIPT
} from './config.js';

export function probeDuration(filePath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFPROBE_BIN, [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', filePath
    ]);
    let output = '';
    proc.on('error', (err) => reject(err));
    proc.stdout.on('data', (d) => { output += d.toString(); });
    proc.on('close', (code) => {
      const duration = parseFloat(output.trim());
      if (code !== 0 || !isFinite(duration)) {
        reject(new Error('Impossible de lire la durée du fichier'));
      } else {
        resolve(duration);
      }
    });
  });
}

// Débit binaire (bits/sec) — lecture de métadonnées seule, pas de décodage, donc
// beaucoup plus rapide que fpcalc/Essentia. Sert de départage qualité pour l'autopilot
// (une taille de fichier plus grosse ne veut pas dire un meilleur encodage : un
// silence de padding ou une intro plus longue en VBR gonfle la taille sans qualité).
export function probeBitrate(filePath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFPROBE_BIN, [
      '-v', 'error', '-show_entries', 'format=bit_rate',
      '-of', 'default=noprint_wrappers=1:nokey=1', filePath
    ]);
    let output = '';
    proc.on('error', (err) => reject(err));
    proc.stdout.on('data', (d) => { output += d.toString(); });
    proc.on('close', (code) => {
      const bitrate = parseInt(output.trim(), 10);
      if (code !== 0 || !Number.isFinite(bitrate)) {
        reject(new Error('Impossible de lire le débit du fichier'));
      } else {
        resolve(bitrate);
      }
    });
  });
}

export function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_BIN, args);
    let stderr = '';
    proc.on('error', (err) => reject(err));
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (code !== 0) reject(new Error(`ffmpeg a échoué (code ${code}): ${stderr.slice(-500)}`));
      else resolve();
    });
  });
}

// Exécute `worker` sur chaque item avec au plus `limit` exécutions concurrentes.
export async function runWithConcurrency(items, limit, worker) {
  let nextIndex = 0;
  async function runNext() {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      await worker(items[i], i);
    }
  }
  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, runNext));
}

// Formats audio pris en charge par le scan — chromaprint/ffmpeg/Essentia les décodent
// tous nativement, seul le tagging (server/tagging.js) a besoin de brancher par format.
export const SUPPORTED_EXTENSIONS = new Set(['.mp3', '.flac', '.wav', '.ogg']);

// Scan directory récursivement pour les formats audio supportés
export function scanDirectory(dirPath) {
  const files = [];

  function walk(dir) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.isFile() && SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
          const stat = fs.statSync(fullPath);
          files.push({
            path: fullPath,
            name: entry.name,
            size: stat.size,
            mtime: stat.mtime.getTime()
          });
        }
      }
    } catch (err) {
      console.error(`Error scanning ${dir}:`, err.message);
    }
  }

  walk(dirPath);
  return files;
}

// Étape 1: Hash par taille
export function analyzeBySize(files) {
  const sizeMap = new Map();

  for (const file of files) {
    if (!sizeMap.has(file.size)) {
      sizeMap.set(file.size, []);
    }
    sizeMap.get(file.size).push(file);
  }

  return Array.from(sizeMap.values())
    .filter(group => group.length > 1)
    .map(group => ({
      method: 'size',
      files: group
    }));
}

// Étape 2: Fuzzy match sur noms (distance de Levenshtein normalisée)
export function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array(n + 1);

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,      // suppression
        curr[j - 1] + 1,  // insertion
        prev[j - 1] + cost // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

export function normalizeTrackName(name) {
  return name
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, '')       // extension
    .replace(/^\d+[\s._-]*/, '')       // numéro de piste en tête
    .replace(/[\s._-]+/g, ' ')
    .trim();
}

export function fuzzyMatch(str1, str2) {
  const a = normalizeTrackName(str1);
  const b = normalizeTrackName(str2);
  if (a === b) return 100;
  if (!a.length || !b.length) return 0;

  const dist = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length);
  return Math.round((1 - dist / maxLen) * 100);
}

// Regroupe TOUS les fichiers par similarité de nom (indépendant de la taille),
// via union-find pour gérer la transitivité (A~B, B~C => groupe {A,B,C}).
// Capture aussi TOUTES les paires >= recordFloor (pas seulement celles qui
// dépassent le seuil de clustering) pour la vue "morceaux similaires".
export function analyzeByName(files, { clusterThreshold = 75, recordFloor = 50 } = {}) {
  const parent = files.map((_, i) => i);
  function find(i) {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  }
  function union(i, j) {
    const ri = find(i), rj = find(j);
    if (ri !== rj) parent[ri] = rj;
  }

  const pairSimilarity = new Map();
  const allPairs = [];

  for (let i = 0; i < files.length; i++) {
    for (let j = i + 1; j < files.length; j++) {
      const sim = fuzzyMatch(files[i].name, files[j].name);
      if (sim >= recordFloor) {
        allPairs.push({ method: 'name', similarity: sim, fileA: files[i], fileB: files[j] });
      }
      if (sim >= clusterThreshold) {
        union(i, j);
        pairSimilarity.set(`${i}:${j}`, sim);
      }
    }
  }

  const clusters = new Map();
  for (let i = 0; i < files.length; i++) {
    const root = find(i);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root).push(i);
  }

  const groups = [];
  for (const indices of clusters.values()) {
    if (indices.length < 2) continue;

    let bestSim = 0;
    for (const [key, sim] of pairSimilarity) {
      const [i, j] = key.split(':').map(Number);
      if (indices.includes(i) && indices.includes(j)) {
        bestSim = Math.max(bestSim, sim);
      }
    }

    groups.push({
      method: 'name',
      similarity: bestSim,
      files: indices.map(i => files[i])
    });
  }

  return { groups, allPairs };
}

// Étape 3: Fingerprint audio
export function getFingerprint(filePath) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn('fpcalc', ['-raw', filePath]);
    } catch (err) {
      resolve(null);
      return;
    }

    let output = '';

    proc.on('error', () => {
      // fpcalc absent ou non exécutable : on dégrade sans planter le serveur
      resolve(null);
    });

    proc.stdout.on('data', (data) => {
      output += data.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        const match = output.match(/FINGERPRINT=(.+)/);
        resolve(match ? match[1] : null);
      } else {
        resolve(null);
      }
    });
  });
}

// Étape 4: Transcription paroles (t+15s, fenêtre 15s — saute l'intro)
// BPM + tonalité via Essentia — ~6-9s/fichier, donc calculé à la demande (pas
// pendant le scan en masse) et mis en cache par chemin+taille+mtime.
export function analyzeAudioFeatures(filePath) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(ESSENTIA_PYTHON, [ANALYZE_AUDIO_SCRIPT, filePath]);
    } catch {
      resolve(null);
      return;
    }

    let output = '';
    const timeout = setTimeout(() => {
      proc.kill();
      resolve(null);
    }, 30000);

    proc.on('error', () => {
      clearTimeout(timeout);
      resolve(null);
    });

    proc.stdout.on('data', (data) => { output += data.toString(); });

    proc.on('close', () => {
      clearTimeout(timeout);
      try {
        const parsed = JSON.parse(output.trim().split('\n').pop());
        if (parsed.error) { resolve(null); return; }
        resolve({ bpm: parsed.bpm, key: parsed.key, scale: parsed.scale });
      } catch {
        resolve(null);
      }
    });
  });
}

export function transcribeLyrics(filePath, startOffset = 15) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(WHISPER_PYTHON, [TRANSCRIBE_SCRIPT, filePath, String(startOffset)]);
    } catch {
      resolve(null);
      return;
    }

    let output = '';
    const timeout = setTimeout(() => {
      proc.kill();
      resolve(null);
    }, 45000);

    proc.on('error', () => {
      clearTimeout(timeout);
      resolve(null);
    });

    proc.stdout.on('data', (data) => {
      output += data.toString();
    });

    proc.on('close', () => {
      clearTimeout(timeout);
      try {
        const parsed = JSON.parse(output.trim().split('\n').pop());
        resolve(parsed.text || null);
      } catch {
        resolve(null);
      }
    });
  });
}

// Similarité textuelle des paroles : ratio de mots communs (Jaccard),
// plus robuste aux erreurs de reconnaissance vocale que Levenshtein caractère par caractère
export function lyricsSimilarity(text1, text2) {
  const words1 = new Set(text1.toLowerCase().match(/[a-zà-ÿ']+/g) || []);
  const words2 = new Set(text2.toLowerCase().match(/[a-zà-ÿ']+/g) || []);
  if (words1.size === 0 || words2.size === 0) return 0;

  let intersection = 0;
  for (const w of words1) if (words2.has(w)) intersection++;
  const union = new Set([...words1, ...words2]).size;

  return Math.round((intersection / union) * 100);
}

// Regroupe par similarité de paroles les fichiers candidats, via union-find.
// Capture aussi TOUTES les paires >= recordFloor pour la vue "morceaux similaires".
export function analyzeByLyrics(candidateFiles, { clusterThreshold = 60, recordFloor = 30 } = {}) {
  const files = candidateFiles.filter(f => f.lyrics && f.lyrics.trim().length > 0);
  const parent = files.map((_, i) => i);
  function find(i) {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  }
  function union(i, j) {
    const ri = find(i), rj = find(j);
    if (ri !== rj) parent[ri] = rj;
  }

  const pairSimilarity = new Map();
  const allPairs = [];

  for (let i = 0; i < files.length; i++) {
    for (let j = i + 1; j < files.length; j++) {
      const sim = lyricsSimilarity(files[i].lyrics, files[j].lyrics);
      if (sim >= recordFloor) {
        allPairs.push({ method: 'lyrics', similarity: sim, fileA: files[i], fileB: files[j] });
      }
      if (sim >= clusterThreshold) {
        union(i, j);
        pairSimilarity.set(`${i}:${j}`, sim);
      }
    }
  }

  const clusters = new Map();
  for (let i = 0; i < files.length; i++) {
    const root = find(i);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root).push(i);
  }

  const groups = [];
  for (const indices of clusters.values()) {
    if (indices.length < 2) continue;

    let bestSim = 0;
    for (const [key, sim] of pairSimilarity) {
      const [i, j] = key.split(':').map(Number);
      if (indices.includes(i) && indices.includes(j)) bestSim = Math.max(bestSim, sim);
    }

    groups.push({
      method: 'lyrics',
      similarity: bestSim,
      files: indices.map(i => files[i])
    });
  }

  return { groups, allPairs };
}

// Compare deux empreintes Chromaprint (listes d'entiers 32 bits) par distance de Hamming
export function fingerprintSimilarity(fp1, fp2) {
  const a = fp1.split(',').map(Number);
  const b = fp2.split(',').map(Number);
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;

  let diffBits = 0;
  for (let i = 0; i < len; i++) {
    let xor = (a[i] ^ b[i]) >>> 0;
    while (xor) {
      diffBits += xor & 1;
      xor >>>= 1;
    }
  }
  const totalBits = len * 32;
  return Math.round((1 - diffBits / totalBits) * 100);
}

// Regroupe par similarité audio les fichiers déjà candidats (taille/nom), via union-find.
// Capture aussi TOUTES les paires >= recordFloor pour la vue "morceaux similaires".
export function analyzeByFingerprint(candidateFiles, { clusterThreshold = 92, recordFloor = 70 } = {}) {
  const files = candidateFiles.filter(f => f.fingerprint);
  const parent = files.map((_, i) => i);
  function find(i) {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  }
  function union(i, j) {
    const ri = find(i), rj = find(j);
    if (ri !== rj) parent[ri] = rj;
  }

  const pairSimilarity = new Map();
  const allPairs = [];

  for (let i = 0; i < files.length; i++) {
    for (let j = i + 1; j < files.length; j++) {
      const sim = fingerprintSimilarity(files[i].fingerprint, files[j].fingerprint);
      if (sim >= recordFloor) {
        allPairs.push({ method: 'fingerprint', similarity: sim, fileA: files[i], fileB: files[j] });
      }
      if (sim >= clusterThreshold) {
        union(i, j);
        pairSimilarity.set(`${i}:${j}`, sim);
      }
    }
  }

  const clusters = new Map();
  for (let i = 0; i < files.length; i++) {
    const root = find(i);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root).push(i);
  }

  const groups = [];
  for (const indices of clusters.values()) {
    if (indices.length < 2) continue;

    let bestSim = 0;
    for (const [key, sim] of pairSimilarity) {
      const [i, j] = key.split(':').map(Number);
      if (indices.includes(i) && indices.includes(j)) bestSim = Math.max(bestSim, sim);
    }

    groups.push({
      method: 'fingerprint',
      similarity: bestSim,
      files: indices.map(i => files[i])
    });
  }

  return { groups, allPairs };
}
