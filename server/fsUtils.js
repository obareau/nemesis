import fs from 'fs';
import path from 'path';

// Déplace un fichier même entre systèmes de fichiers différents (clé USB, réseau,
// /tmp...). fs.renameSync échoue avec EXDEV dans ce cas — fallback copie+suppression.
export function safeMoveSync(src, dest) {
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.copyFileSync(src, dest);
    fs.unlinkSync(src);
  }
}

const MIME_BY_EXT = { '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.wav': 'audio/wav', '.ogg': 'audio/ogg' };

// Streame un fichier audio avec support des requêtes Range (seek dans le lecteur) —
// partagé entre le stream projet (routes/waveform.js) et le stream inbox (routes/import.js).
// L'appelant a déjà validé QUE ce chemin a le droit d'être servi.
export function streamAudioWithRange(req, res, filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return res.status(404).json({ error: 'Fichier introuvable sur disque' });
  }

  const fileSize = stat.size;
  const range = req.headers.range;

  res.setHeader('Content-Type', MIME_BY_EXT[path.extname(filePath).toLowerCase()] || 'audio/mpeg');
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
    stream = fs.createReadStream(filePath, { start, end });
  } else {
    res.setHeader('Content-Length', fileSize);
    stream = fs.createReadStream(filePath);
  }

  stream.on('error', () => {
    if (!res.headersSent) res.status(500);
    res.end();
  });

  stream.pipe(res);
}
