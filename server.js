import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import NodeID3 from 'node-id3';
import Database from 'better-sqlite3';

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:7b';

// Nombre de processus fpcalc lancés en parallèle pendant l'étape empreinte du
// scan (fpcalc est CPU-bound et indépendant par fichier, donc parallélisable
// sans risque) — bridable via env sur une machine partagée.
const FPCALC_CONCURRENCY = Math.max(1, parseInt(process.env.FPCALC_CONCURRENCY, 10) || os.cpus().length);

// Vocabulaire canonique des 17 moods Subwave (doit rester en miroir de
// SHOW_MOODS dans subwave/controller/src/settings.ts et subwave-autotag.py).
// Le mood ne correspond PAS à un genre ID3 : Subwave route les morceaux par
// appartenance à une playlist Navidrome nommée d'après le mood (name.includes),
// pas par tag de genre — donc pas de mapping mood→genre ici.
const SHOW_MOODS = [
  'energetic', 'calm', 'reflective', 'celebratory', 'romantic', 'spiritual',
  'focus', 'workout', 'driving', 'cooking', 'rainy', 'sunny', 'night',
  'morning', 'evening', 'festival', 'cultural'
];

const NAVIDROME_URL = process.env.NAVIDROME_URL || 'http://localhost:4533';
const NAVIDROME_USER = process.env.NAVIDROME_USER || 'admin';
const NAVIDROME_PASS = process.env.NAVIDROME_PASS || '';
const SUBSONIC_PARAMS = `u=${NAVIDROME_USER}&p=${encodeURIComponent(NAVIDROME_PASS)}&v=1.16.1&c=nemesis&f=json`;
const NAVIDROME_LIBRARY_ROOT = process.env.NAVIDROME_LIBRARY_ROOT || '/home/olivier/Music/NAVIDROME-SUBWAVE-MP';
const COVERS_PLAYLIST_NAME = 'Covers';

// Corbeille réversible : les doublons écartés sont déplacés ici (jamais supprimés
// directement) — l'utilisateur peut vérifier/restaurer avant toute suppression réelle.
const QUARANTINE_DIR = process.env.QUARANTINE_DIR || '/home/olivier/.nemesis-trash';
const QUARANTINE_MANIFEST = path.join(QUARANTINE_DIR, '.manifest.json');

function readQuarantineManifest() {
  try {
    return JSON.parse(fs.readFileSync(QUARANTINE_MANIFEST, 'utf-8'));
  } catch {
    return {};
  }
}

// Déplace un fichier même entre systèmes de fichiers différents (clé USB, réseau,
// /tmp...). fs.renameSync échoue avec EXDEV dans ce cas — fallback copie+suppression.
function safeMoveSync(src, dest) {
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.copyFileSync(src, dest);
    fs.unlinkSync(src);
  }
}

function writeQuarantineManifest(manifest) {
  fs.writeFileSync(QUARANTINE_MANIFEST, JSON.stringify(manifest, null, 2));
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WHISPER_PYTHON = path.join(__dirname, 'whisper-venv', 'bin', 'python');
const ESSENTIA_PYTHON = process.env.ESSENTIA_PYTHON || '/home/olivier/essentia-venv/bin/python3';
const ANALYZE_AUDIO_SCRIPT = path.join(__dirname, 'analyze_audio.py');
const TRANSCRIBE_SCRIPT = path.join(__dirname, 'transcribe.py');
const FFMPEG_BIN = process.env.FFMPEG_BIN || 'ffmpeg';
const FFPROBE_BIN = process.env.FFPROBE_BIN || 'ffprobe';

// Sauvegarde des fichiers avant trim/fade — permet d'annuler un montage audio
// exactement comme une quarantaine ou un renommage (jamais destructif sans filet).
const EDITS_BACKUP_DIR = process.env.EDITS_BACKUP_DIR || '/home/olivier/.nemesis-projects/edit-backups';
// Cache des images de sonogramme (générées via ffmpeg showwavespic), indexé par
// chemin+taille+mtime — évite de regénérer l'image à chaque ouverture du panneau.
const WAVEFORM_CACHE_DIR = process.env.WAVEFORM_CACHE_DIR || '/home/olivier/.nemesis-projects/waveform-cache';
fs.mkdirSync(EDITS_BACKUP_DIR, { recursive: true });
fs.mkdirSync(WAVEFORM_CACHE_DIR, { recursive: true });

function probeDuration(filePath) {
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

function runFfmpeg(args) {
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
async function runWithConcurrency(items, limit, worker) {
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

// --- Cache fingerprint/paroles ---
// Indexé par chemin+taille+mtime (pas par contenu — trop lent à hasher sur des
// gros fichiers), partagé entre TOUS les projets. Un rescan du même dossier, ou
// un scan d'un dossier qui recoupe un précédent, réutilise ce qui a déjà été
// calculé au lieu de rappeler fpcalc/whisper — gain énorme sur les rescans.
const CACHE_DB_PATH = process.env.CACHE_DB_PATH || '/home/olivier/.nemesis-projects/cache.db';
fs.mkdirSync(path.dirname(CACHE_DB_PATH), { recursive: true });
const cacheDb = new Database(CACHE_DB_PATH);
cacheDb.pragma('journal_mode = WAL');
cacheDb.exec(`
  CREATE TABLE IF NOT EXISTS analysis_cache (
    path TEXT NOT NULL,
    size INTEGER NOT NULL,
    mtime INTEGER NOT NULL,
    fingerprint TEXT,
    lyrics TEXT,
    bpm REAL,
    key TEXT,
    scale TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (path, size, mtime)
  )
`);
// Ajoute les colonnes bpm/key/scale si la base existait déjà sans (migration silencieuse)
for (const col of ['bpm REAL', 'key TEXT', 'scale TEXT']) {
  try { cacheDb.exec(`ALTER TABLE analysis_cache ADD COLUMN ${col}`); } catch { /* déjà présente */ }
}

const cacheGetStmt = cacheDb.prepare(
  'SELECT fingerprint, lyrics, bpm, key, scale FROM analysis_cache WHERE path = ? AND size = ? AND mtime = ?'
);
const cacheSetStmt = cacheDb.prepare(`
  INSERT INTO analysis_cache (path, size, mtime, fingerprint, lyrics, bpm, key, scale, updated_at)
  VALUES (@path, @size, @mtime, @fingerprint, @lyrics, @bpm, @key, @scale, @updatedAt)
  ON CONFLICT(path, size, mtime) DO UPDATE SET
    fingerprint = COALESCE(excluded.fingerprint, analysis_cache.fingerprint),
    lyrics = COALESCE(excluded.lyrics, analysis_cache.lyrics),
    bpm = COALESCE(excluded.bpm, analysis_cache.bpm),
    key = COALESCE(excluded.key, analysis_cache.key),
    scale = COALESCE(excluded.scale, analysis_cache.scale),
    updated_at = excluded.updated_at
`);

function getCachedAnalysis(file) {
  try {
    return cacheGetStmt.get(file.path, file.size, file.mtime) || null;
  } catch {
    return null;
  }
}

function setCachedAnalysis(file, { fingerprint, lyrics, bpm, key, scale }) {
  try {
    cacheSetStmt.run({
      path: file.path,
      size: file.size,
      mtime: file.mtime,
      fingerprint: fingerprint ?? null,
      lyrics: lyrics ?? null,
      bpm: bpm ?? null,
      key: key ?? null,
      scale: scale ?? null,
      updatedAt: new Date().toISOString()
    });
  } catch (err) {
    console.error('Erreur écriture cache analyse:', err.message);
  }
}

// Filet de sécurité : une exception isolée ne doit jamais tuer tout le serveur
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (serveur maintenu en vie):', err);
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection (serveur maintenu en vie):', err);
});

const app = express();
app.use(cors());
app.use(express.json());

// Sert le frontend buildé (dist/) — process unique en production, plus besoin de vite dev
const distPath = path.join(__dirname, 'dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
}

// API: Lister le contenu d'un répertoire (navigation serveur)
app.get('/api/browse', (req, res) => {
  const dirPath = req.query.path || '/home/olivier';

  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const dirs = entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => e.name)
      .sort((a, b) => a.localeCompare(b));

    res.json({
      currentPath: path.resolve(dirPath),
      parent: path.dirname(path.resolve(dirPath)),
      dirs
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// API: Raccourcis (home, clés USB, disques, partages réseau — détectés dynamiquement)
const NETWORK_FSTYPES = new Set(['cifs', 'smb3', 'nfs', 'nfs4', 'smbfs', 'sshfs', 'davfs', 'fuse.sshfs']);
const PSEUDO_FSTYPES = new Set([
  'proc', 'sysfs', 'devtmpfs', 'devpts', 'tmpfs', 'cgroup', 'cgroup2', 'securityfs',
  'pstore', 'bpf', 'debugfs', 'tracefs', 'configfs', 'fusectl', 'mqueue', 'hugetlbfs',
  'binfmt_misc', 'autofs', 'overlay', 'squashfs', 'ramfs', 'efivarfs'
]);

function unescapeMountField(str) {
  // /proc/mounts encode espaces/tabs/backslashes en octal (\040 = espace, etc.)
  return str.replace(/\\([0-7]{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
}

function readMountPoints() {
  const raw = fs.readFileSync('/proc/mounts', 'utf-8');
  return raw.split('\n').filter(Boolean).map(line => {
    const [source, target, fstype] = line.split(' ');
    return {
      source: unescapeMountField(source),
      target: unescapeMountField(target),
      fstype
    };
  });
}

// API: Liste des moods canoniques Subwave (source de vérité unique, évite la duplication frontend)
app.get('/api/moods', (req, res) => {
  res.json({ moods: SHOW_MOODS });
});

app.get('/api/browse/shortcuts', (req, res) => {
  const shortcuts = [];
  const home = process.env.HOME || '/home/olivier';

  shortcuts.push({ label: 'Accueil', group: 'local', path: home });

  try {
    const mounts = readMountPoints();

    for (const { source, target, fstype } of mounts) {
      if (PSEUDO_FSTYPES.has(fstype)) continue;
      if (target === '/' || target === '/boot' || target.startsWith('/boot/')) continue;
      if (target.startsWith('/var/') || target.startsWith('/run/') && !target.includes('/media/')) continue;
      if (target.startsWith('/snap/')) continue;

      const isNetwork = NETWORK_FSTYPES.has(fstype);
      const isRemovable = target.startsWith('/media/') || target.startsWith('/run/media/');
      const label = path.basename(target) || target;

      if (isNetwork) {
        shortcuts.push({ label: `🌐 ${label}`, group: 'network', path: target, detail: source });
      } else if (isRemovable) {
        shortcuts.push({ label: `💾 ${label}`, group: 'removable', path: target, detail: fstype });
      } else if (target.startsWith('/mnt/')) {
        shortcuts.push({ label: `📦 ${label}`, group: 'mount', path: target, detail: fstype });
      }
    }
  } catch (err) {
    console.error('Erreur lecture /proc/mounts:', err.message);
  }

  res.json({ shortcuts });
});

let analysisState = {
  status: 'idle',
  currentFile: null,
  currentStage: null,
  fileProgress: 0,
  totalProgress: 0,
  files: [],
  duplicates: [],
  similarPairs: [],
  error: null,
  dirPath: null
};

// Compteur de génération : toute boucle de scan en arrière-plan (fingerprint/paroles)
// capture sa génération au démarrage et vérifie qu'elle est toujours la génération
// courante à chaque itération. Sans ça, "Terminer" ou un nouveau scan lancé pendant
// qu'un ancien tourne encore ne l'arrêtent jamais — il continue d'écrire dans
// analysisState (potentiellement celui d'un tout autre projet ensuite).
let scanGeneration = 0;

// --- Projets persistants ---
// Un dossier scanné = un projet de travail durable : reste actif entre les
// redémarrages du service et les rafraîchissements de page, tant qu'il n'est
// pas explicitement marqué "terminé". Toute action mutante (quarantaine,
// renommage, push Navidrome, groupe ignoré) est journalisée pour permettre
// un "annuler la dernière action" générique.
const PROJECTS_DIR = process.env.PROJECTS_DIR || '/home/olivier/.nemesis-projects';

function projectFileFor(dirPath) {
  const hash = Buffer.from(dirPath).toString('base64url');
  return path.join(PROJECTS_DIR, `${hash}.json`);
}

let processedGroups = []; // signatures de groupes traités/ignorés pour le projet courant
let actionLog = [];       // historique des actions mutantes du projet courant, pour undo

function groupSignature(method, files) {
  return `${method}:${files.map(f => f.path).sort().join('|')}`;
}

function persistProject() {
  if (!analysisState.dirPath) return;
  try {
    fs.mkdirSync(PROJECTS_DIR, { recursive: true });
    const existing = loadProjectRaw(analysisState.dirPath);
    const project = {
      dirPath: analysisState.dirPath,
      status: existing?.status || 'active',
      createdAt: existing?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      analysisState,
      processedGroups,
      actionLog
    };
    fs.writeFileSync(projectFileFor(analysisState.dirPath), JSON.stringify(project));
  } catch (err) {
    console.error('Erreur sauvegarde projet:', err.message);
  }
}

function loadProjectRaw(dirPath) {
  try {
    return JSON.parse(fs.readFileSync(projectFileFor(dirPath), 'utf-8'));
  } catch {
    return null;
  }
}

function listProjects() {
  try {
    fs.mkdirSync(PROJECTS_DIR, { recursive: true });
    return fs.readdirSync(PROJECTS_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try {
          const p = JSON.parse(fs.readFileSync(path.join(PROJECTS_DIR, f), 'utf-8'));
          return {
            dirPath: p.dirPath,
            status: p.status,
            updatedAt: p.updatedAt,
            filesCount: p.analysisState?.files?.length || 0,
            duplicatesCount: p.analysisState?.duplicates?.length || 0,
            actionCount: p.actionLog?.length || 0
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  } catch {
    return [];
  }
}

// Scan directory récursivement pour MP3s
function scanDirectory(dirPath) {
  const files = [];

  function walk(dir) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.mp3')) {
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
function analyzeBySize(files) {
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
function levenshtein(a, b) {
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

function normalizeTrackName(name) {
  return name
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, '')       // extension
    .replace(/^\d+[\s._-]*/, '')       // numéro de piste en tête
    .replace(/[\s._-]+/g, ' ')
    .trim();
}

function fuzzyMatch(str1, str2) {
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
function analyzeByName(files, { clusterThreshold = 75, recordFloor = 50 } = {}) {
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
function getFingerprint(filePath) {
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
function analyzeAudioFeatures(filePath) {
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

function transcribeLyrics(filePath, startOffset = 15) {
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
function lyricsSimilarity(text1, text2) {
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
function analyzeByLyrics(candidateFiles, { clusterThreshold = 60, recordFloor = 30 } = {}) {
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
function fingerprintSimilarity(fp1, fp2) {
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
function analyzeByFingerprint(candidateFiles, { clusterThreshold = 92, recordFloor = 70 } = {}) {
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

// API: Scan directory
app.post('/api/scan', express.json(), async (req, res) => {
  const { dirPath, force } = req.body;

  if (!dirPath) {
    return res.status(400).json({ error: 'dirPath required' });
  }

  // Invalide toute boucle de scan en arrière-plan encore active (ancien projet,
  // ou celui qu'on quitte) — sans ça elle continue d'écrire dans analysisState
  // même après qu'on soit passé à autre chose.
  scanGeneration++;

  // Reprise de projet : si ce dossier a déjà un projet sauvegardé et qu'on ne
  // force pas un rescan complet, on recharge l'état tel quel (fichiers,
  // doublons, groupes déjà traités, historique d'actions) au lieu de relancer
  // toute l'analyse — le travail déjà fait n'est jamais perdu.
  if (!force) {
    const existing = loadProjectRaw(dirPath);
    if (existing) {
      analysisState = existing.analysisState;
      processedGroups = existing.processedGroups || [];
      actionLog = existing.actionLog || [];
      return res.json({ ...analysisState, resumed: true });
    }
  }

  const myGeneration = scanGeneration;

  try {
    analysisState = {
      status: 'scanning',
      currentFile: null,
      currentStage: null,
      fileProgress: 0,
      totalProgress: 0,
      files: [],
      duplicates: [],
      similarPairs: [],
      error: null,
      dirPath
    };
    processedGroups = [];
    actionLog = [];

    // Scan files
    const files = scanDirectory(dirPath);
    analysisState.files = files;

    // Étape 1: Size (groupes de fichiers de taille strictement identique)
    const sizeGroups = analyzeBySize(files);
    analysisState.totalProgress = 25;

    // Étape 2: Name (comparaison sur TOUS les fichiers, indépendamment de la taille)
    const { groups: nameGroups, allPairs: namePairs } = analyzeByName(files);
    analysisState.duplicates = [...sizeGroups, ...nameGroups];
    analysisState.similarPairs = [...namePairs];
    analysisState.totalProgress = 50;
    persistProject();

    // Étape 3 + 4: Fingerprint puis Paroles (async, background) — ne bloque jamais le serveur
    setTimeout(async () => {
      try {
        // Fingerprinte tous les fichiers candidats (uniques, dédupliqués par chemin)
        const candidatesByPath = new Map();
        for (const dup of analysisState.duplicates) {
          for (const file of dup.files) candidatesByPath.set(file.path, file);
        }
        const candidates = Array.from(candidatesByPath.values());

        let fpCacheHits = 0, lyricsCacheHits = 0;

        analysisState.currentStage = 'fingerprint';
        let fpDone = 0;
        // Empreintes calculées avec FPCALC_CONCURRENCY processus fpcalc en parallèle
        // (CPU-bound, indépendant par fichier) au lieu d'un fichier à la fois.
        await runWithConcurrency(candidates, FPCALC_CONCURRENCY, async (file) => {
          if (scanGeneration !== myGeneration) return; // projet fermé/rescanné entretemps — on abandonne

          const cached = getCachedAnalysis(file);
          if (cached?.fingerprint) {
            file.fingerprint = cached.fingerprint;
            fpCacheHits++;
          } else {
            try {
              file.fingerprint = await getFingerprint(file.path);
              setCachedAnalysis(file, { fingerprint: file.fingerprint });
            } catch (e) {
              console.error('Fingerprint error:', e.message);
            }
          }
          fpDone++;
          analysisState.currentFile = `${fpDone}/${candidates.length}`;
          analysisState.fileProgress = Math.round((fpDone / candidates.length) * 100);
        });
        if (scanGeneration !== myGeneration) return;
        if (fpCacheHits > 0) console.log(`⚖️  Cache fingerprint: ${fpCacheHits}/${candidates.length} réutilisés`);

        const { groups: fingerprintGroups, allPairs: fingerprintPairs } = analyzeByFingerprint(candidates);
        analysisState.duplicates = [...analysisState.duplicates, ...fingerprintGroups];
        analysisState.similarPairs = [...analysisState.similarPairs, ...fingerprintPairs];
        analysisState.totalProgress = 75;
        persistProject();

        // Étape 4 : Paroles — transcrit uniquement les candidats déjà remontés par taille/nom/audio
        analysisState.currentStage = 'lyrics';
        for (let i = 0; i < candidates.length; i++) {
          if (scanGeneration !== myGeneration) return;
          const file = candidates[i];
          analysisState.currentFile = `${i + 1}/${candidates.length}`;

          const cached = getCachedAnalysis(file);
          if (cached?.lyrics) {
            file.lyrics = cached.lyrics;
            lyricsCacheHits++;
          } else {
            try {
              file.lyrics = await transcribeLyrics(file.path);
              setCachedAnalysis(file, { lyrics: file.lyrics });
            } catch (e) {
              console.error('Lyrics error:', e.message);
            }
          }
          analysisState.fileProgress = Math.round(((i + 1) / candidates.length) * 100);
        }
        if (scanGeneration !== myGeneration) return;
        if (lyricsCacheHits > 0) console.log(`⚖️  Cache paroles: ${lyricsCacheHits}/${candidates.length} réutilisés`);

        const { groups: lyricsGroups, allPairs: lyricsPairs } = analyzeByLyrics(candidates);
        analysisState.duplicates = [...analysisState.duplicates, ...lyricsGroups];
        analysisState.similarPairs = [...analysisState.similarPairs, ...lyricsPairs];
      } catch (err) {
        console.error('Erreur étapes fingerprint/paroles (analyse conservée):', err.message);
      }
      if (scanGeneration !== myGeneration) return;
      analysisState.status = 'completed';
      analysisState.totalProgress = 100;
      analysisState.currentStage = null;
      persistProject();
      warmWaveformCache(analysisState.files, myGeneration).catch(() => {});
    }, 100);

    res.json(analysisState);
  } catch (err) {
    analysisState.status = 'error';
    analysisState.error = err.message;
    res.status(500).json(analysisState);
  }
});

// API: Status (inclut les groupes déjà traités/ignorés + l'historique d'actions du projet courant)
app.get('/api/status', (req, res) => {
  const projectRecord = analysisState.dirPath ? loadProjectRaw(analysisState.dirPath) : null;
  res.json({
    ...analysisState,
    processedGroups,
    actionCount: actionLog.length,
    // Historique léger (sans les snapshots de données) pour le panneau d'annulation multi-niveaux
    actionLog: actionLog.map(a => ({ id: a.id, type: a.type, description: a.description, timestamp: a.timestamp })),
    projectStatus: projectRecord?.status || (analysisState.dirPath ? 'active' : null)
  });
});

// API: Liste des projets connus (dossiers déjà scannés, actifs ou terminés)
app.get('/api/projects', (req, res) => {
  res.json({ projects: listProjects(), currentDirPath: analysisState.dirPath });
});

// API: Marque le projet courant comme terminé (sort de la liste active par défaut)
app.post('/api/projects/close', express.json(), (req, res) => {
  if (!analysisState.dirPath) {
    return res.status(400).json({ error: 'Aucun projet actif' });
  }
  // Stoppe immédiatement toute boucle fingerprint/paroles encore en cours sur ce projet
  scanGeneration++;

  const existing = loadProjectRaw(analysisState.dirPath) || {};
  const project = {
    dirPath: analysisState.dirPath,
    status: 'done',
    createdAt: existing.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    analysisState,
    processedGroups,
    actionLog
  };
  fs.mkdirSync(PROJECTS_DIR, { recursive: true });
  fs.writeFileSync(projectFileFor(analysisState.dirPath), JSON.stringify(project));
  res.json({ success: true });
});

// API: Rouvre un projet marqué terminé (repasse en "active")
app.post('/api/projects/reopen', express.json(), (req, res) => {
  const { dirPath } = req.body;
  const existing = loadProjectRaw(dirPath);
  if (!existing) {
    return res.status(404).json({ error: 'Projet introuvable' });
  }
  scanGeneration++; // invalide toute boucle du projet précédemment actif
  existing.status = 'active';
  existing.updatedAt = new Date().toISOString();
  fs.writeFileSync(projectFileFor(dirPath), JSON.stringify(existing));
  analysisState = existing.analysisState;
  processedGroups = existing.processedGroups || [];
  actionLog = existing.actionLog || [];
  res.json({ ...analysisState, resumed: true });
});

// API: Supprime le SUIVI d'un projet (fichier de métadonnées uniquement — historique
// d'actions, liste de fichiers en cache, groupes traités). Ne touche JAMAIS aux
// fichiers audio réels sur disque ni à la corbeille associée.
app.delete('/api/projects', express.json(), (req, res) => {
  const { dirPath } = req.body || {};
  if (!dirPath) {
    return res.status(400).json({ error: 'dirPath requis' });
  }

  const file = projectFileFor(dirPath);
  if (!fs.existsSync(file)) {
    return res.status(404).json({ error: 'Projet introuvable' });
  }

  fs.unlinkSync(file);

  // Si c'était le projet actif en mémoire, revient à l'état vide (les fichiers
  // audio et la corbeille ne sont pas affectés, uniquement le suivi du projet)
  if (analysisState.dirPath === dirPath) {
    scanGeneration++; // stoppe toute boucle fingerprint/paroles encore active sur ce projet
    analysisState = {
      status: 'idle', currentFile: null, currentStage: null, fileProgress: 0,
      totalProgress: 0, files: [], duplicates: [], similarPairs: [], error: null, dirPath: null
    };
    processedGroups = [];
    actionLog = [];
  }

  res.json({ success: true });
});

// API: Marque un groupe comme traité/ignoré (persisté — ne réapparaît plus dans la pile)
app.post('/api/groups/skip', express.json(), (req, res) => {
  const { method, filePaths } = req.body;
  if (!method || !Array.isArray(filePaths)) {
    return res.status(400).json({ error: 'method et filePaths requis' });
  }
  const sig = `${method}:${[...filePaths].sort().join('|')}`;
  if (!processedGroups.includes(sig)) {
    processedGroups.push(sig);
    actionLog.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: 'skip-group',
      timestamp: new Date().toISOString(),
      description: `Groupe ignoré (${method}, ${filePaths.length} fichiers)`,
      data: { signature: sig }
    });
    persistProject();
  }
  res.json({ success: true, processedGroups });
});

// API: Note un fichier de 0 à 5 étoiles — pour trier vite garder/quarantaine dans un
// groupe. Pas journalisé pour undo (métadonnée légère, librement modifiable),
// mais mis à jour partout où le fichier apparaît (files + duplicates + similarPairs)
// puisqu'après un rechargement JSON les objets ne sont plus des références partagées.
app.post('/api/rating', express.json(), (req, res) => {
  const { filePath, rating } = req.body;
  if (!filePath || typeof rating !== 'number' || rating < 0 || rating > 5) {
    return res.status(400).json({ error: 'filePath et rating (0-5) requis' });
  }

  let updated = 0;
  const applyRating = (f) => {
    if (f && f.path === filePath) { f.rating = rating; updated++; }
  };

  analysisState.files.forEach(applyRating);
  for (const dup of analysisState.duplicates) dup.files.forEach(applyRating);
  for (const pair of analysisState.similarPairs) {
    applyRating(pair.fileA);
    applyRating(pair.fileB);
  }

  if (updated === 0) {
    return res.status(404).json({ error: 'Fichier introuvable dans le projet courant' });
  }

  persistProject();
  res.json({ success: true, rating });
});

// API: Incrémente le compteur d'écoutes d'un fichier — appelé une fois par sélection de lecture
// (pas par event 'play' du <audio>, pour ne pas recompter une pause/reprise du même morceau).
app.post('/api/play-count', express.json(), (req, res) => {
  const { filePath } = req.body;
  if (!filePath) {
    return res.status(400).json({ error: 'filePath requis' });
  }

  let playCount = null;
  const applyPlay = (f) => {
    if (f && f.path === filePath) { f.playCount = (f.playCount || 0) + 1; playCount = f.playCount; }
  };

  analysisState.files.forEach(applyPlay);
  for (const dup of analysisState.duplicates) dup.files.forEach(applyPlay);
  for (const pair of analysisState.similarPairs) {
    applyPlay(pair.fileA);
    applyPlay(pair.fileB);
  }

  if (playCount === null) {
    return res.status(404).json({ error: 'Fichier introuvable dans le projet courant' });
  }

  persistProject();
  res.json({ success: true, playCount });
});

// API: Tag/untag local d'un mood sur un ou plusieurs fichiers (glisser-déposer sur le panneau mood) —
// n'appelle PAS Navidrome, juste une étiquette locale en attendant le push explicite.
app.post('/api/tag-mood', express.json(), (req, res) => {
  const { filePaths, mood, action = 'add' } = req.body;
  if (!Array.isArray(filePaths) || filePaths.length === 0 || !mood) {
    return res.status(400).json({ error: 'filePaths (array non vide) et mood requis' });
  }

  let updated = 0;
  const applyTag = (f) => {
    if (!f || !filePaths.includes(f.path)) return;
    const moods = new Set(f.moods || []);
    if (action === 'remove') moods.delete(mood); else moods.add(mood);
    f.moods = Array.from(moods);
    updated++;
  };

  analysisState.files.forEach(applyTag);
  for (const dup of analysisState.duplicates) dup.files.forEach(applyTag);
  for (const pair of analysisState.similarPairs) {
    applyTag(pair.fileA);
    applyTag(pair.fileB);
  }

  if (updated === 0) {
    return res.status(404).json({ error: 'Aucun fichier trouvé dans le projet courant' });
  }

  persistProject();
  res.json({ success: true, mood, action, updated });
});

// API: BPM + tonalité à la demande (Essentia, ~6-9s si pas en cache).
// Jamais dans le pipeline de scan en masse — bien trop lent pour des centaines
// de fichiers. Calculé seulement quand l'utilisateur consulte ce fichier précis.
app.post('/api/analyze-audio', express.json(), async (req, res) => {
  const { filePath } = req.body;
  if (!filePath) {
    return res.status(400).json({ error: 'filePath requis' });
  }

  const fileEntry = analysisState.files.find(f => f.path === filePath);
  if (!fileEntry) {
    return res.status(404).json({ error: 'Fichier introuvable dans le projet courant' });
  }

  const cached = getCachedAnalysis(fileEntry);
  if (cached?.bpm) {
    const result = { bpm: cached.bpm, key: cached.key, scale: cached.scale };
    applyAudioFeatures(filePath, result);
    return res.json({ success: true, ...result, cached: true });
  }

  const result = await analyzeAudioFeatures(filePath);
  if (!result) {
    return res.status(500).json({ error: 'Analyse BPM/tonalité échouée' });
  }

  setCachedAnalysis(fileEntry, result);
  applyAudioFeatures(filePath, result);
  try {
    NodeID3.update({ bpm: String(Math.round(result.bpm)), initialKey: `${result.key}${result.scale === 'minor' ? 'm' : ''}` }, filePath);
  } catch {
    // tag ID3 échoué (fichier verrouillé/lecture seule) — pas bloquant, la valeur reste en cache app
  }
  persistProject();
  res.json({ success: true, ...result, cached: false });
});

function applyAudioFeatures(filePath, { bpm, key, scale }) {
  const apply = (f) => {
    if (f && f.path === filePath) { f.bpm = bpm; f.key = key; f.scale = scale; }
  };
  analysisState.files.forEach(apply);
  for (const dup of analysisState.duplicates) dup.files.forEach(apply);
  for (const pair of analysisState.similarPairs) { apply(pair.fileA); apply(pair.fileB); }
}

function applyNavidromePushed(filePath, pushedToNavidrome) {
  const apply = (f) => {
    if (f && f.path === filePath) f.pushedToNavidrome = pushedToNavidrome;
  };
  analysisState.files.forEach(apply);
  for (const dup of analysisState.duplicates) dup.files.forEach(apply);
  for (const pair of analysisState.similarPairs) { apply(pair.fileA); apply(pair.fileB); }
}

function applyLyrics(filePath, lyrics) {
  const apply = (f) => {
    if (f && f.path === filePath) f.lyrics = lyrics;
  };
  analysisState.files.forEach(apply);
  for (const dup of analysisState.duplicates) dup.files.forEach(apply);
  for (const pair of analysisState.similarPairs) { apply(pair.fileA); apply(pair.fileB); }
}

// API: relance la transcription des paroles à un offset donné (bypass cache) — utile
// pour les morceaux à intro longue où la fenêtre par défaut (t+15s) tombe encore dans l'instru.
app.post('/api/lyrics-rescan', express.json(), async (req, res) => {
  const { filePath, startOffset = 30 } = req.body;
  if (!filePath) {
    return res.status(400).json({ error: 'filePath requis' });
  }

  const fileEntry = analysisState.files.find(f => f.path === filePath);
  if (!fileEntry) {
    return res.status(404).json({ error: 'Fichier introuvable dans le projet courant' });
  }

  try {
    const lyrics = await transcribeLyrics(filePath, Number(startOffset));
    setCachedAnalysis(fileEntry, { lyrics });
    applyLyrics(filePath, lyrics);
    persistProject();
    res.json({ success: true, lyrics, startOffset: Number(startOffset) });
  } catch (err) {
    res.status(500).json({ error: `Échec transcription: ${err.message}` });
  }
});

function waveformCachePathFor(filePath) {
  const stat = fs.statSync(filePath);
  const cacheKey = Buffer.from(`${filePath}:${stat.size}:${Math.floor(stat.mtimeMs)}`).toString('base64url');
  return path.join(WAVEFORM_CACHE_DIR, `${cacheKey}.png`);
}

// Pré-génère les sonogrammes de tous les fichiers du scan en tâche de fond, à faible
// concurrence, pour que le scrubber/peintre/comparaison A-B les affichent instantanément
// plutôt que d'attendre un premier appel ffmpeg à la demande. Abandonne si un nouveau scan démarre.
async function warmWaveformCache(files, generation) {
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

// API: Sonogrammes de deux fichiers rendus à la MÊME échelle px/seconde (calée sur t=0),
// pour une comparaison A/B visuelle — pas de corrélation croisée, mais un calage commun au
// début suffit à révéler d'un coup d'œil une intro coupée, un outro en plus, ou une durée
// différente entre deux candidats doublons.
app.get('/api/waveform-diff', async (req, res) => {
  const { pathA, pathB } = req.query;
  if (!pathA || !pathB) {
    return res.status(400).json({ error: 'pathA et pathB requis' });
  }
  if (!analysisState.files.some(f => f.path === pathA) || !analysisState.files.some(f => f.path === pathB)) {
    return res.status(404).json({ error: 'Fichier introuvable dans le projet courant' });
  }

  try {
    const [durationA, durationB] = await Promise.all([probeDuration(pathA), probeDuration(pathB)]);
    const maxDuration = Math.max(durationA, durationB, 1);
    const PX_PER_SEC = 12;
    const totalWidth = Math.max(200, Math.min(4000, Math.round(maxDuration * PX_PER_SEC)));
    const height = 100;

    const genAligned = async (filePath, duration, color) => {
      const width = Math.max(20, Math.round((duration / maxDuration) * totalWidth));
      const stat = fs.statSync(filePath);
      const cacheKey = Buffer.from(`diff:${filePath}:${stat.size}:${Math.floor(stat.mtimeMs)}:${width}x${height}:${color}`).toString('base64url');
      const cachePath = path.join(WAVEFORM_CACHE_DIR, `${cacheKey}.png`);
      if (!fs.existsSync(cachePath)) {
        fs.mkdirSync(WAVEFORM_CACHE_DIR, { recursive: true });
        await runFfmpeg([
          '-y', '-i', filePath,
          '-filter_complex', `showwavespic=s=${width}x${height}:colors=${color}`,
          '-frames:v', '1', cachePath
        ]);
      }
      return { image: `data:image/png;base64,${fs.readFileSync(cachePath).toString('base64')}`, width };
    };

    const [a, b] = await Promise.all([
      genAligned(pathA, durationA, '0x3b82f6'),
      genAligned(pathB, durationB, '0xf59e0b')
    ]);

    res.json({
      totalWidth,
      height,
      a: { ...a, duration: durationA },
      b: { ...b, duration: durationB }
    });
  } catch (err) {
    res.status(500).json({ error: `Échec génération sonogrammes alignés: ${err.message}` });
  }
});

// API: Sonogramme (waveform PNG) d'un fichier, mis en cache disque par chemin+taille+mtime.
// Retourne aussi la durée (ffprobe) pour que le frontend positionne les poignées de trim.
app.get('/api/waveform/:encodedPath', async (req, res) => {
  let filePath;
  try {
    filePath = Buffer.from(req.params.encodedPath, 'base64url').toString('utf-8');
  } catch {
    return res.status(400).json({ error: 'Chemin invalide' });
  }

  const fileEntry = analysisState.files.find(f => f.path === filePath);
  if (!fileEntry) {
    return res.status(404).json({ error: 'Fichier introuvable dans le projet courant' });
  }

  try {
    const cachePath = waveformCachePathFor(filePath);
    const duration = await probeDuration(filePath);

    if (!fs.existsSync(cachePath)) {
      fs.mkdirSync(WAVEFORM_CACHE_DIR, { recursive: true });
      await runFfmpeg([
        '-y', '-i', filePath,
        '-filter_complex', 'showwavespic=s=1200x140:colors=0x7b2cbf',
        '-frames:v', '1', cachePath
      ]);
    }

    const image = fs.readFileSync(cachePath).toString('base64');
    res.json({ image: `data:image/png;base64,${image}`, duration });
  } catch (err) {
    res.status(500).json({ error: `Échec génération sonogramme: ${err.message}` });
  }
});

// API: Trim (couper début/fin) + fade in/out — réécrit le fichier en place, l'original
// est sauvegardé à côté (EDITS_BACKUP_DIR) pour permettre un undo, jamais destructif.
app.post('/api/audio-edit', express.json(), async (req, res) => {
  const { filePath, trimStart = 0, trimEnd = 0, fadeIn = 0, fadeOut = 0 } = req.body;
  if (!filePath) {
    return res.status(400).json({ error: 'filePath requis' });
  }

  const fileEntry = analysisState.files.find(f => f.path === filePath);
  if (!fileEntry) {
    return res.status(404).json({ error: 'Fichier introuvable dans le projet courant' });
  }

  try {
    const duration = await probeDuration(filePath);
    const newDuration = duration - trimStart - trimEnd;
    if (newDuration <= 0.5) {
      return res.status(400).json({ error: 'Découpe trop importante — il ne resterait presque rien du morceau' });
    }

    // Snapshot complet avant modification — nécessaire pour l'undo (métadonnées ET fichier)
    const prevSnapshot = { ...fileEntry };
    fs.mkdirSync(EDITS_BACKUP_DIR, { recursive: true });
    const backupPath = path.join(EDITS_BACKUP_DIR, `${Buffer.from(filePath).toString('base64url')}${path.extname(filePath)}`);
    fs.copyFileSync(filePath, backupPath);

    const filters = [];
    if (fadeIn > 0) filters.push(`afade=t=in:st=0:d=${fadeIn}`);
    if (fadeOut > 0) filters.push(`afade=t=out:st=${Math.max(0, newDuration - fadeOut)}:d=${fadeOut}`);

    const tempPath = path.join(path.dirname(filePath), `.nemesis-edit-${Date.now()}${path.extname(filePath)}`);
    const args = ['-y', '-i', filePath, '-ss', String(trimStart), '-t', String(newDuration)];
    if (filters.length > 0) args.push('-af', filters.join(','));
    args.push('-codec:a', 'libmp3lame', '-q:a', '2', tempPath);

    await runFfmpeg(args);
    safeMoveSync(tempPath, filePath);

    const stat = fs.statSync(filePath);
    fileEntry.size = stat.size;
    fileEntry.mtime = stat.mtimeMs;
    // Contenu audio modifié : les analyses précédentes (empreinte, paroles, bpm, tonalité)
    // ne correspondent plus au fichier — elles seront recalculées à la demande.
    delete fileEntry.fingerprint;
    delete fileEntry.lyrics;
    delete fileEntry.bpm;
    delete fileEntry.key;
    delete fileEntry.scale;

    actionLog.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: 'audio-edit',
      timestamp: new Date().toISOString(),
      description: `Montage audio (trim/fade) sur "${path.basename(filePath)}"`,
      data: { filePath, backupPath, prevSnapshot }
    });
    persistProject();

    res.json({ success: true, size: fileEntry.size, mtime: fileEntry.mtime });
  } catch (err) {
    res.status(500).json({ error: `Échec montage audio: ${err.message}` });
  }
});

// API: Annule la dernière action journalisée (undo générique)
app.post('/api/undo', async (req, res) => {
  const last = actionLog[actionLog.length - 1];
  if (!last) {
    return res.status(400).json({ error: 'Aucune action à annuler' });
  }

  try {
    if (last.type === 'quarantine') {
      for (const { quarantineName, originalPath } of last.data.moves) {
        const manifest = readQuarantineManifest();
        const quarantinePath = path.join(QUARANTINE_DIR, quarantineName);
        fs.mkdirSync(path.dirname(originalPath), { recursive: true });
        safeMoveSync(quarantinePath, originalPath);
        delete manifest[quarantineName];
        writeQuarantineManifest(manifest);

        const fileEntry = last.data.fileSnapshots?.find(f => f.path === originalPath);
        if (fileEntry) analysisState.files.push(fileEntry);
      }
    } else if (last.type === 'rename') {
      for (const r of last.data.renames) {
        safeMoveSync(r.newPath, r.oldPath);
        if (r.oldTags) NodeID3.update(r.oldTags, r.oldPath);
        const fileEntry = analysisState.files.find(f => f.path === r.newPath);
        if (fileEntry) {
          fileEntry.path = r.oldPath;
          fileEntry.name = path.basename(r.oldPath);
        }
      }
    } else if (last.type === 'navidrome-push') {
      for (const p of last.data.pushed) {
        for (const pl of p.playlists) {
          if (pl.created) {
            await subsonicGet('deletePlaylist.view', `&id=${pl.id}`);
          } else {
            const info = await subsonicGet('getPlaylist.view', `&id=${pl.id}`);
            const entries = info.playlist?.entry || [];
            const idx = entries.findIndex(e => e.id === p.songId);
            if (idx >= 0) {
              await subsonicGet('updatePlaylist.view', `&playlistId=${pl.id}&songIndexToRemove=${idx}`);
            }
          }
        }
        if (p.filePath) applyNavidromePushed(p.filePath, false);
      }
    } else if (last.type === 'skip-group') {
      processedGroups = processedGroups.filter(s => s !== last.data.signature);
    } else if (last.type === 'audio-edit') {
      const { filePath, backupPath, prevSnapshot } = last.data;
      safeMoveSync(backupPath, filePath);
      const fileEntry = analysisState.files.find(f => f.path === filePath);
      if (fileEntry) Object.assign(fileEntry, prevSnapshot);
    }

    actionLog.pop();
    persistProject();
    res.json({ success: true, undone: last, status: analysisState, processedGroups });
  } catch (err) {
    res.status(500).json({ error: `Échec undo: ${err.message}` });
  }
});

// API: Renommage en masse + tagging ID3 (artiste fictif + titre paroles + genre(s) depuis mood(s))
app.post('/api/rename-bulk', express.json(), (req, res) => {
  const { filePaths, author, title, moods } = req.body;

  if (!Array.isArray(filePaths) || filePaths.length === 0) {
    return res.status(400).json({ error: 'filePaths requis (array non vide)' });
  }
  if (!author || !author.trim()) {
    return res.status(400).json({ error: 'author requis' });
  }

  const results = [];
  const renames = [];

  for (const filePath of filePaths) {
    try {
      // Snapshot des tags ID3 d'origine pour pouvoir les restaurer via undo
      let oldTags = {};
      try {
        const read = NodeID3.read(filePath);
        oldTags = { artist: read.artist || '', title: read.title || '', genre: read.genre || '' };
      } catch { /* pas de tags existants, undo restaurera vide */ }

      // Tag ID3 : artiste fictif + titre (paroles). Le mood n'est PAS un genre ID3 —
      // Subwave route par appartenance à une playlist Navidrome (voir /api/navidrome/push).
      const tags = { artist: author };
      if (title && title.trim()) tags.title = title.trim();
      NodeID3.update(tags, filePath);

      // Renommage physique : "{author} - [{titre}]" remplace le nom d'origine
      // (pas de concaténation) — suffixe numérique si collision avec un fichier existant.
      const dir = path.dirname(filePath);
      const ext = path.extname(filePath);
      const prefix = title && title.trim() ? `${author} - ${title.trim()}` : author;
      let newName = `${prefix}${ext}`;
      let newPath = path.join(dir, newName);
      let n = 2;
      while (newPath !== filePath && fs.existsSync(newPath)) {
        newName = `${prefix} (${n})${ext}`;
        newPath = path.join(dir, newName);
        n++;
      }

      if (newPath !== filePath) {
        safeMoveSync(filePath, newPath);
      }

      results.push({ success: true, oldPath: filePath, newPath });
      renames.push({ oldPath: filePath, newPath, oldTags });

      // Met à jour l'état en mémoire pour refléter le nouveau chemin/nom
      const fileEntry = analysisState.files.find(f => f.path === filePath);
      if (fileEntry) {
        fileEntry.path = newPath;
        fileEntry.name = newName;
      }
    } catch (err) {
      results.push({ success: false, oldPath: filePath, error: err.message });
    }
  }

  if (renames.length > 0) {
    actionLog.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: 'rename',
      timestamp: new Date().toISOString(),
      description: `${renames.length} fichier(s) renommé(s) → "${author}"`,
      data: { renames }
    });
    persistProject();
  }

  const failures = results.filter(r => !r.success);
  res.json({
    success: failures.length === 0,
    renamed: results.filter(r => r.success).length,
    failed: failures.length,
    results
  });
});

// API: Renommage simple d'un seul fichier (juste un nouveau nom, pas d'auteur/tags requis)
app.post('/api/rename-file', express.json(), (req, res) => {
  const { filePath, newName } = req.body;

  if (!filePath) {
    return res.status(400).json({ error: 'filePath requis' });
  }
  if (!newName || !newName.trim()) {
    return res.status(400).json({ error: 'newName requis' });
  }
  if (!analysisState.files.some(f => f.path === filePath)) {
    return res.status(404).json({ error: 'Fichier introuvable dans le projet courant' });
  }

  try {
    const dir = path.dirname(filePath);
    const ext = path.extname(filePath);
    // Débarrasse le nom saisi de tout séparateur de chemin (pas de traversée de dossier)
    const cleaned = newName.trim().replace(/[/\\]/g, '-');
    const base = cleaned.toLowerCase().endsWith(ext.toLowerCase()) ? cleaned.slice(0, -ext.length) : cleaned;

    let finalName = `${base}${ext}`;
    let newPath = path.join(dir, finalName);
    let n = 2;
    while (newPath !== filePath && fs.existsSync(newPath)) {
      finalName = `${base} (${n})${ext}`;
      newPath = path.join(dir, finalName);
      n++;
    }

    if (newPath !== filePath) {
      safeMoveSync(filePath, newPath);
    }

    const fileEntry = analysisState.files.find(f => f.path === filePath);
    if (fileEntry) {
      fileEntry.path = newPath;
      fileEntry.name = finalName;
    }

    if (newPath !== filePath) {
      actionLog.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        type: 'rename',
        timestamp: new Date().toISOString(),
        description: `1 fichier renommé → "${finalName}"`,
        data: { renames: [{ oldPath: filePath, newPath, oldTags: null }] }
      });
      persistProject();
    }

    res.json({ success: true, newPath, newName: finalName });
  } catch (err) {
    res.status(500).json({ error: `Échec renommage: ${err.message}` });
  }
});

// API: Génération d'un nom d'artiste fictif via Ollama local
app.post('/api/generate-author', express.json(), async (req, res) => {
  const { trackNames = [], mood = '' } = req.body;

  const sample = trackNames.slice(0, 8).join(', ') || 'morceaux électroniques';
  const prompt = `Tu es un générateur de noms d'artistes fictifs pour une radio IA underground.
Ambiance/mood : ${mood || 'inconnu'}
Morceaux concernés : ${sample}

Génère UN SEUL nom d'artiste fictif, créatif et mystérieux, en 1 à 4 mots (pas de ponctuation superflue, pas d'explication).
Réponds uniquement au format JSON strict : {"author": "..."}`;

  try {
    const response = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt,
        stream: false,
        format: 'json'
      })
    });

    if (!response.ok) {
      throw new Error(`Ollama a répondu ${response.status}`);
    }

    const data = await response.json();
    let author;
    try {
      author = JSON.parse(data.response).author;
    } catch {
      // Fallback si le modèle n'a pas respecté le JSON strict
      author = data.response.replace(/[{}"]/g, '').replace(/author:?/i, '').trim();
    }

    if (!author) throw new Error('Réponse Ollama vide ou invalide');

    res.json({ author: author.trim() });
  } catch (err) {
    res.status(500).json({ error: `Génération échouée : ${err.message}` });
  }
});

// API: Génération d'un titre court (3-4 mots) résumant les paroles trouvées, via Ollama local
app.post('/api/generate-title', express.json(), async (req, res) => {
  const { lyrics = '' } = req.body;

  if (!lyrics.trim()) {
    return res.status(400).json({ error: 'lyrics requis (aucune parole disponible pour ce fichier)' });
  }

  const prompt = `Voici un extrait de paroles transcrites automatiquement (peut contenir des erreurs de reconnaissance vocale) :
"${lyrics.slice(0, 500)}"

Résume cet extrait en un titre court et évocateur de 3 à 4 mots MAXIMUM, sans ponctuation ni guillemets, sans explication.
Réponds uniquement au format JSON strict : {"title": "..."}`;

  try {
    const response = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt,
        stream: false,
        format: 'json'
      })
    });

    if (!response.ok) {
      throw new Error(`Ollama a répondu ${response.status}`);
    }

    const data = await response.json();
    let title;
    try {
      title = JSON.parse(data.response).title;
    } catch {
      title = data.response.replace(/[{}"]/g, '').replace(/title:?/i, '').trim();
    }

    if (!title) throw new Error('Réponse Ollama vide ou invalide');

    res.json({ title: title.trim() });
  } catch (err) {
    res.status(500).json({ error: `Génération échouée : ${err.message}` });
  }
});

// --- Intégration Navidrome (API Subsonic) ---

async function subsonicGet(endpoint, extraParams = '') {
  const url = `${NAVIDROME_URL}/rest/${endpoint}?${SUBSONIC_PARAMS}${extraParams}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data['subsonic-response']?.status !== 'ok') {
    const err = data['subsonic-response']?.error?.message || 'Erreur Subsonic inconnue';
    throw new Error(err);
  }
  return data['subsonic-response'];
}

async function waitForScanCompletion(maxWaitMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const status = await subsonicGet('getScanStatus.view');
    if (!status.scanStatus?.scanning) return true;
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

async function findSongIdByName(fileName) {
  const query = path.basename(fileName, path.extname(fileName));
  const result = await subsonicGet('search3.view', `&query=${encodeURIComponent(query)}&songCount=5`);
  const songs = result.searchResult3?.song || [];
  const match = songs.find(s => s.title === query || s.path?.endsWith(fileName)) || songs[0];
  return match?.id || null;
}

async function ensurePlaylistAndAddSong(moodName, songId) {
  const { playlists } = await subsonicGet('getPlaylists.view');
  const existing = (playlists?.playlist || []).find(
    p => p.name.toLowerCase() === moodName.toLowerCase()
  );

  if (existing) {
    await subsonicGet('updatePlaylist.view', `&playlistId=${existing.id}&songIdToAdd=${songId}`);
    return { playlist: existing.name, id: existing.id, created: false };
  } else {
    const created = await subsonicGet('createPlaylist.view', `&name=${encodeURIComponent(moodName)}&songId=${songId}`);
    return { playlist: moodName, id: created.playlist?.id, created: true };
  }
}

// API: Contenu d'une playlist mood Navidrome — pour le panneau "voir ce qui est déjà dans ce mood"
app.get('/api/navidrome/mood/:mood', async (req, res) => {
  const { mood } = req.params;

  try {
    const { playlists } = await subsonicGet('getPlaylists.view');
    const playlist = (playlists?.playlist || []).find(
      p => p.name.toLowerCase() === mood.toLowerCase()
    );

    if (!playlist) {
      return res.json({ mood, playlistId: null, tracks: [] });
    }

    const info = await subsonicGet('getPlaylist.view', `&id=${playlist.id}`);
    const songs = info.playlist?.entry || [];

    const tracks = songs.map(song => {
      const absolutePath = song.path ? path.join(NAVIDROME_LIBRARY_ROOT, song.path) : null;
      const localFile = absolutePath ? analysisState.files.find(f => f.path === absolutePath) : null;
      return {
        songId: song.id,
        title: song.title,
        artist: song.artist,
        path: absolutePath,
        knownLocally: !!localFile,
        rating: localFile?.rating,
        bpm: localFile?.bpm
      };
    });

    res.json({ mood, playlistId: playlist.id, tracks });
  } catch (err) {
    res.status(500).json({ error: `Échec lecture playlist Navidrome: ${err.message}` });
  }
});

// Vérifie si un morceau équivalent (nom proche, chemin différent) est déjà catalogué
// dans Navidrome — sert à détecter les doublons déjà présents avant tout ajout aux
// playlists mood, pour les router vers une playlist "Covers" de mise en attente.
async function findExistingCatalogMatch(filePath, threshold = 75) {
  const fileName = path.basename(filePath);
  const baseName = path.basename(fileName, path.extname(fileName));
  // Le "titre coeur" est le dernier segment après " - " (auteur/titre ajoutés par Nemesis)
  const coreTitle = baseName.split(' - ').pop().trim();

  const result = await subsonicGet('search3.view', `&query=${encodeURIComponent(coreTitle)}&songCount=15`);
  const songs = result.searchResult3?.song || [];

  for (const song of songs) {
    if (!song.path) continue;
    const absolutePath = path.join(NAVIDROME_LIBRARY_ROOT, song.path);
    if (absolutePath === filePath) continue; // c'est notre propre fichier tout juste indexé

    const sim = fuzzyMatch(song.title || '', coreTitle);
    if (sim >= threshold) {
      return { songId: song.id, title: song.title, path: absolutePath, similarity: sim };
    }
  }

  return null;
}

// API: Pousse les fichiers (déjà renommés/taggés) vers Navidrome — rescan + assignation playlist(s) par mood
app.post('/api/navidrome/push', express.json(), async (req, res) => {
  const { filePaths, moods } = req.body;

  if (!Array.isArray(filePaths) || filePaths.length === 0) {
    return res.status(400).json({ error: 'filePaths requis (array non vide)' });
  }
  if (!Array.isArray(moods) || moods.length === 0) {
    return res.status(400).json({ error: 'moods requis (au moins un mood sélectionné)' });
  }

  try {
    await subsonicGet('startScan.view');
    const scanned = await waitForScanCompletion();
    if (!scanned) {
      return res.status(504).json({ error: 'Scan Navidrome trop long (timeout 30s)' });
    }

    const results = [];
    for (const filePath of filePaths) {
      const fileName = path.basename(filePath);
      try {
        const songId = await findSongIdByName(fileName);
        if (!songId) {
          results.push({ file: fileName, success: false, error: 'Morceau introuvable dans Navidrome après scan' });
          continue;
        }

        // Vérifie qu'un morceau équivalent n'est pas déjà catalogué sous un autre chemin
        const existingMatch = await findExistingCatalogMatch(filePath);

        if (existingMatch) {
          // Doublon déjà présent : mise en attente dans la playlist "Covers", pas d'ajout aux moods
          const coverResult = await ensurePlaylistAndAddSong(COVERS_PLAYLIST_NAME, songId);
          results.push({
            file: fileName,
            filePath,
            success: true,
            songId,
            alreadyInLibrary: true,
            matchedExisting: { title: existingMatch.title, path: existingMatch.path, similarity: existingMatch.similarity },
            playlists: [coverResult]
          });
          continue;
        }

        const playlistResults = [];
        for (const mood of moods) {
          const r = await ensurePlaylistAndAddSong(mood, songId);
          playlistResults.push(r);
        }
        results.push({ file: fileName, filePath, success: true, alreadyInLibrary: false, songId, playlists: playlistResults });
      } catch (err) {
        results.push({ file: fileName, filePath, success: false, error: err.message });
      }
    }

    const successResults = results.filter(r => r.success);
    if (successResults.length > 0) {
      for (const r of successResults) applyNavidromePushed(r.filePath, true);

      actionLog.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        type: 'navidrome-push',
        timestamp: new Date().toISOString(),
        description: `${successResults.length} morceau(x) envoyé(s) vers Navidrome`,
        data: { pushed: successResults.map(r => ({ filePath: r.filePath, songId: r.songId, playlists: r.playlists })) }
      });
      persistProject();
    }

    const failures = results.filter(r => !r.success);
    res.json({
      success: failures.length === 0,
      pushed: results.filter(r => r.success).length,
      failed: failures.length,
      results
    });
  } catch (err) {
    res.status(500).json({ error: `Push Navidrome échoué : ${err.message}` });
  }
});

// API: Stream MP3 — identifié par CHEMIN (base64url), jamais par index de tableau.
// Un index de position se décale à chaque quarantaine/renommage/undo et finit par
// pointer sur un fichier différent de celui qu'on croit écouter.
app.get('/api/stream/:encodedPath', (req, res) => {
  let filePath;
  try {
    filePath = Buffer.from(req.params.encodedPath, 'base64url').toString('utf-8');
  } catch {
    return res.status(400).json({ error: 'Chemin invalide' });
  }

  const file = analysisState.files.find(f => f.path === filePath);
  if (!file) {
    return res.status(404).json({ error: 'File not found' });
  }

  let stat;
  try {
    stat = fs.statSync(file.path);
  } catch (err) {
    return res.status(404).json({ error: 'Fichier introuvable sur disque' });
  }

  const fileSize = stat.size;
  const range = req.headers.range;

  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Accept-Ranges', 'bytes');

  let stream;
  if (range) {
    const match = range.match(/bytes=(\d*)-(\d*)/);
    const start = match && match[1] ? parseInt(match[1], 10) : 0;
    const end = match && match[2] ? parseInt(match[2], 10) : fileSize - 1;
    const chunkSize = end - start + 1;

    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
    res.setHeader('Content-Length', chunkSize);
    stream = fs.createReadStream(file.path, { start, end });
  } else {
    res.setHeader('Content-Length', fileSize);
    stream = fs.createReadStream(file.path);
  }

  stream.on('error', () => {
    if (!res.headersSent) res.status(500);
    res.end();
  });

  stream.pipe(res);
});

// API: Met en quarantaine (déplace, ne supprime jamais) les fichiers sélectionnés
app.post('/api/quarantine', express.json(), (req, res) => {
  const { filePaths } = req.body;

  if (!Array.isArray(filePaths) || filePaths.length === 0) {
    return res.status(400).json({ error: 'filePaths requis (array non vide)' });
  }

  try {
    fs.mkdirSync(QUARANTINE_DIR, { recursive: true });
  } catch (err) {
    return res.status(500).json({ error: `Impossible de créer la corbeille: ${err.message}` });
  }

  const manifest = readQuarantineManifest();
  const results = [];
  const moves = [];
  const fileSnapshots = [];

  for (const filePath of filePaths) {
    try {
      const fileEntry = analysisState.files.find(f => f.path === filePath);
      if (fileEntry) fileSnapshots.push({ ...fileEntry });

      const base = path.basename(filePath);
      let quarantineName = base;
      let counter = 1;
      while (fs.existsSync(path.join(QUARANTINE_DIR, quarantineName))) {
        const ext = path.extname(base);
        quarantineName = `${path.basename(base, ext)} (${counter})${ext}`;
        counter++;
      }

      const quarantinePath = path.join(QUARANTINE_DIR, quarantineName);
      safeMoveSync(filePath, quarantinePath);
      manifest[quarantineName] = filePath;
      moves.push({ quarantineName, originalPath: filePath });

      // Retire le fichier de l'état en mémoire (il n'est plus scanné dans le dossier d'origine)
      analysisState.files = analysisState.files.filter(f => f.path !== filePath);
      for (const dup of analysisState.duplicates) {
        dup.files = dup.files.filter(f => f.path !== filePath);
      }
      analysisState.duplicates = analysisState.duplicates.filter(d => d.files.length > 1);

      results.push({ success: true, oldPath: filePath, quarantinePath });
    } catch (err) {
      results.push({ success: false, oldPath: filePath, error: err.message });
    }
  }

  writeQuarantineManifest(manifest);

  if (moves.length > 0) {
    actionLog.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: 'quarantine',
      timestamp: new Date().toISOString(),
      description: `${moves.length} fichier(s) mis en quarantaine`,
      data: { moves, fileSnapshots }
    });
    persistProject();
  }

  const failures = results.filter(r => !r.success);
  res.json({
    success: failures.length === 0,
    quarantined: results.filter(r => r.success).length,
    failed: failures.length,
    results
  });
});

// API: Liste le contenu de la corbeille
app.get('/api/quarantine', (req, res) => {
  const manifest = readQuarantineManifest();
  const items = [];

  for (const [quarantineName, originalPath] of Object.entries(manifest)) {
    const quarantinePath = path.join(QUARANTINE_DIR, quarantineName);
    try {
      const stat = fs.statSync(quarantinePath);
      items.push({ quarantineName, originalPath, size: stat.size });
    } catch {
      // fichier déjà retiré manuellement — nettoie le manifest en silence
    }
  }

  res.json({ items });
});

// API: Restaure un ou plusieurs fichiers depuis la corbeille vers leur emplacement d'origine
app.post('/api/quarantine/restore', express.json(), (req, res) => {
  const { quarantineNames } = req.body;

  if (!Array.isArray(quarantineNames) || quarantineNames.length === 0) {
    return res.status(400).json({ error: 'quarantineNames requis (array non vide)' });
  }

  const manifest = readQuarantineManifest();
  const results = [];

  for (const quarantineName of quarantineNames) {
    const originalPath = manifest[quarantineName];
    if (!originalPath) {
      results.push({ success: false, quarantineName, error: 'Introuvable dans le manifest' });
      continue;
    }

    try {
      const quarantinePath = path.join(QUARANTINE_DIR, quarantineName);
      fs.mkdirSync(path.dirname(originalPath), { recursive: true });
      safeMoveSync(quarantinePath, originalPath);
      delete manifest[quarantineName];

      // Réintègre le fichier dans le projet courant (retrouve son snapshot d'origine si possible)
      if (analysisState.dirPath) {
        let snapshot = null;
        for (const entry of actionLog) {
          if (entry.type === 'quarantine') {
            const found = entry.data.fileSnapshots?.find(f => f.path === originalPath);
            if (found) { snapshot = found; break; }
          }
        }
        if (!analysisState.files.some(f => f.path === originalPath)) {
          if (snapshot) {
            analysisState.files.push(snapshot);
          } else {
            const stat = fs.statSync(originalPath);
            analysisState.files.push({ path: originalPath, name: path.basename(originalPath), size: stat.size, mtime: stat.mtime.getTime() });
          }
        }
      }

      results.push({ success: true, quarantineName, restoredTo: originalPath });
    } catch (err) {
      results.push({ success: false, quarantineName, error: err.message });
    }
  }

  writeQuarantineManifest(manifest);
  persistProject();

  const failures = results.filter(r => !r.success);
  res.json({
    success: failures.length === 0,
    restored: results.filter(r => r.success).length,
    failed: failures.length,
    results
  });
});

// API: Suppression PHYSIQUE et DÉFINITIVE des fichiers en corbeille — irréversible,
// contrairement à toutes les autres actions du système. Pas de journalisation undo
// possible (le fichier n'existe simplement plus). Accepte une liste précise de
// quarantineNames, ou vide tout si non fourni.
app.post('/api/quarantine/empty', express.json(), (req, res) => {
  const { quarantineNames } = req.body || {};
  const manifest = readQuarantineManifest();
  const targets = Array.isArray(quarantineNames) && quarantineNames.length > 0
    ? quarantineNames
    : Object.keys(manifest);

  if (targets.length === 0) {
    return res.json({ success: true, deleted: 0, failed: 0, results: [] });
  }

  const results = [];
  for (const quarantineName of targets) {
    const quarantinePath = path.join(QUARANTINE_DIR, quarantineName);
    try {
      fs.unlinkSync(quarantinePath);
      delete manifest[quarantineName];
      results.push({ success: true, quarantineName });
    } catch (err) {
      results.push({ success: false, quarantineName, error: err.message });
    }
  }

  writeQuarantineManifest(manifest);

  const failures = results.filter(r => !r.success);
  res.json({
    success: failures.length === 0,
    deleted: results.filter(r => r.success).length,
    failed: failures.length,
    results
  });
});

// SPA fallback : toute route non-API renvoie index.html (React Router-less mais robuste au refresh)
app.get(/^(?!\/api).*/, (req, res) => {
  const indexPath = path.join(distPath, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send('Build frontend manquant — lance `npm run build`');
  }
});

// Recharge automatiquement le projet actif le plus récent au démarrage —
// un redémarrage du service (déploiement, watchdog, crash) ne doit jamais
// faire perdre le fil du dossier en cours de tri.
function loadMostRecentActiveProject() {
  const active = listProjects().filter(p => p.status === 'active');
  if (active.length === 0) return;

  const project = loadProjectRaw(active[0].dirPath);
  if (!project) return;

  analysisState = project.analysisState;
  processedGroups = project.processedGroups || [];
  actionLog = project.actionLog || [];
  console.log(`⚖️  Projet repris automatiquement: ${project.dirPath}`);
  if (analysisState.files?.length > 0) {
    warmWaveformCache(analysisState.files, scanGeneration).catch(() => {});
  }
}

loadMostRecentActiveProject();

const PORT = process.env.PORT || 5693;
app.listen(PORT, () => {
  console.log(`⚖️  Nemesis server running on http://localhost:${PORT}`);
});
