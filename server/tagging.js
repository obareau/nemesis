import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import NodeID3 from 'node-id3';
import { FFPROBE_BIN } from './config.js';
import { runFfmpeg } from './analysis.js';
import { safeMoveSync } from './fsUtils.js';

// Point de passage unique pour lire/écrire des tags — MP3 utilise ID3v2 (node-id3),
// les autres formats (FLAC/OGG/WAV) n'ont pas d'ID3v2 natif et passent par les
// métadonnées génériques ffmpeg (Vorbis comments pour FLAC/OGG, chunk LIST/INFO pour WAV).
export function isMp3(filePath) {
  return path.extname(filePath).toLowerCase() === '.mp3';
}

function probeFormatTags(filePath) {
  return new Promise((resolve) => {
    const proc = spawn(FFPROBE_BIN, ['-v', 'error', '-show_entries', 'format_tags', '-of', 'json', filePath]);
    let out = '';
    proc.on('error', () => resolve({}));
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.on('close', () => {
      try {
        const tags = JSON.parse(out).format?.tags || {};
        const lower = {};
        for (const [k, v] of Object.entries(tags)) lower[k.toLowerCase()] = v;
        resolve({
          artist: lower.artist || '', title: lower.title || '', bpm: lower.bpm || '',
          initialKey: lower.initialkey || '', genre: lower.genre || ''
        });
      } catch {
        resolve({});
      }
    });
  });
}

export async function readTags(filePath) {
  if (isMp3(filePath)) {
    try {
      const t = NodeID3.read(filePath);
      return { artist: t.artist || '', title: t.title || '', bpm: t.bpm || '', initialKey: t.initialKey || '', genre: t.genre || '' };
    } catch {
      return {};
    }
  }
  return probeFormatTags(filePath);
}

// Écriture : MP3 en place (node-id3) ; FLAC/OGG/WAV réécrits par ffmpeg (-metadata,
// -codec copy, donc pas de perte de qualité) vers un temp file puis remplacement
// atomique — même filet de sécurité que le trim/fade (server/routes/files.js).
//
// Convention interne pour BPM/tonalité en Vorbis comments/WAV INFO (pas de norme
// officielle comme TBPM/TKEY en ID3v2) : clés libres BPM/INITIALKEY, cohérentes entre
// écriture (ici) et lecture (probeFormatTags ci-dessus, lower-casée avant lookup).
export async function writeTags(filePath, tags) {
  if (isMp3(filePath)) {
    const out = {};
    if (tags.artist !== undefined) out.artist = tags.artist;
    if (tags.title !== undefined) out.title = tags.title;
    if (tags.bpm !== undefined) out.bpm = String(tags.bpm);
    if (tags.initialKey !== undefined) out.initialKey = tags.initialKey;
    if (tags.genre !== undefined) out.genre = tags.genre;
    NodeID3.update(out, filePath);
    return;
  }

  const meta = {};
  if (tags.artist !== undefined) meta.ARTIST = tags.artist;
  if (tags.title !== undefined) meta.TITLE = tags.title;
  if (tags.bpm !== undefined) meta.BPM = String(tags.bpm);
  if (tags.initialKey !== undefined) meta.INITIALKEY = tags.initialKey;
  if (tags.genre !== undefined) meta.GENRE = tags.genre;

  const tempPath = path.join(path.dirname(filePath), `.nemesis-tag-${Date.now()}${path.extname(filePath)}`);
  const args = ['-y', '-i', filePath, '-map', '0', '-codec', 'copy'];
  for (const [k, v] of Object.entries(meta)) args.push('-metadata', `${k}=${v}`);
  args.push(tempPath);

  try {
    await runFfmpeg(args);
    safeMoveSync(tempPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tempPath); } catch { /* rien à nettoyer */ }
    throw err;
  }
}

// Codec de ré-encodage pour /api/audio-edit (trim/fade force toujours un ré-encodage,
// jamais -codec copy, puisque le filtre afade doit s'appliquer aux échantillons).
export function audioCodecArgsFor(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case '.flac': return ['-codec:a', 'flac'];
    case '.wav': return ['-codec:a', 'pcm_s16le'];
    case '.ogg': return ['-codec:a', 'libvorbis', '-q:a', '6'];
    default: return ['-codec:a', 'libmp3lame', '-q:a', '2'];
  }
}
