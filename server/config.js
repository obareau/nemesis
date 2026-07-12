import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

// Racine du projet (là où vivent server.js, analyze_audio.py, transcribe.py, dist/...) —
// un niveau au-dessus de ce fichier (server/config.js).
export const __dirname = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
export const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:7b';

// Nombre de processus fpcalc lancés en parallèle pendant l'étape empreinte du
// scan (fpcalc est CPU-bound et indépendant par fichier, donc parallélisable
// sans risque) — bridable via env sur une machine partagée.
export const FPCALC_CONCURRENCY = Math.max(1, parseInt(process.env.FPCALC_CONCURRENCY, 10) || os.cpus().length);

// Vocabulaire canonique des 17 moods Subwave (doit rester en miroir de
// SHOW_MOODS dans subwave/controller/src/settings.ts et subwave-autotag.py).
// Le mood ne correspond PAS à un genre ID3 : Subwave route les morceaux par
// appartenance à une playlist Navidrome nommée d'après le mood (name.includes),
// pas par tag de genre — donc pas de mapping mood→genre ici.
export const SHOW_MOODS = [
  'energetic', 'calm', 'reflective', 'celebratory', 'romantic', 'spiritual',
  'focus', 'workout', 'driving', 'cooking', 'rainy', 'sunny', 'night',
  'morning', 'evening', 'festival', 'cultural'
];

export const NAVIDROME_URL = process.env.NAVIDROME_URL || 'http://localhost:4533';
export const NAVIDROME_USER = process.env.NAVIDROME_USER || 'admin';
export const NAVIDROME_PASS = process.env.NAVIDROME_PASS || '';
export const SUBSONIC_PARAMS = `u=${NAVIDROME_USER}&p=${encodeURIComponent(NAVIDROME_PASS)}&v=1.16.1&c=nemesis&f=json`;
export const NAVIDROME_LIBRARY_ROOT = process.env.NAVIDROME_LIBRARY_ROOT || '/home/olivier/Music/NAVIDROME-SUBWAVE-MP';
export const COVERS_PLAYLIST_NAME = 'Covers';

// Corbeille réversible : les doublons écartés sont déplacés ici (jamais supprimés
// directement) — l'utilisateur peut vérifier/restaurer avant toute suppression réelle.
export const QUARANTINE_DIR = process.env.QUARANTINE_DIR || '/home/olivier/.nemesis-trash';
export const QUARANTINE_MANIFEST = path.join(QUARANTINE_DIR, '.manifest.json');

export const WHISPER_PYTHON = path.join(__dirname, 'whisper-venv', 'bin', 'python');
export const ESSENTIA_PYTHON = process.env.ESSENTIA_PYTHON || '/home/olivier/essentia-venv/bin/python3';
export const ANALYZE_AUDIO_SCRIPT = path.join(__dirname, 'analyze_audio.py');
export const TRANSCRIBE_SCRIPT = path.join(__dirname, 'transcribe.py');
export const FFMPEG_BIN = process.env.FFMPEG_BIN || 'ffmpeg';
export const FFPROBE_BIN = process.env.FFPROBE_BIN || 'ffprobe';

// Sauvegarde des fichiers avant trim/fade — permet d'annuler un montage audio
// exactement comme une quarantaine ou un renommage (jamais destructif sans filet).
export const EDITS_BACKUP_DIR = process.env.EDITS_BACKUP_DIR || '/home/olivier/.nemesis-projects/edit-backups';
// Cache des images de sonogramme (générées via ffmpeg showwavespic), indexé par
// chemin+taille+mtime — évite de regénérer l'image à chaque ouverture du panneau.
export const WAVEFORM_CACHE_DIR = process.env.WAVEFORM_CACHE_DIR || '/home/olivier/.nemesis-projects/waveform-cache';
fs.mkdirSync(EDITS_BACKUP_DIR, { recursive: true });
fs.mkdirSync(WAVEFORM_CACHE_DIR, { recursive: true });

// --- Projets persistants ---
export const PROJECTS_DIR = process.env.PROJECTS_DIR || '/home/olivier/.nemesis-projects';

// --- Cache fingerprint/paroles ---
// Indexé par chemin+taille+mtime (pas par contenu — trop lent à hasher sur des
// gros fichiers), partagé entre TOUS les projets.
export const CACHE_DB_PATH = process.env.CACHE_DB_PATH || '/home/olivier/.nemesis-projects/cache.db';
