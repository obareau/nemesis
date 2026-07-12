import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { CACHE_DB_PATH } from './config.js';

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

export function getCachedAnalysis(file) {
  try {
    return cacheGetStmt.get(file.path, file.size, file.mtime) || null;
  } catch {
    return null;
  }
}

export function setCachedAnalysis(file, { fingerprint, lyrics, bpm, key, scale }) {
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
