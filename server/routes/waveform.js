import express from 'express';
import fs from 'fs';
import path from 'path';
import { WAVEFORM_CACHE_DIR } from '../config.js';
import { analysisState } from '../store.js';
import { probeDuration, runFfmpeg } from '../analysis.js';
import { waveformCachePathFor } from '../waveformCache.js';

const router = express.Router();

// API: Sonogrammes de deux fichiers rendus à la MÊME échelle px/seconde (calée sur t=0),
// pour une comparaison A/B visuelle — pas de corrélation croisée, mais un calage commun au
// début suffit à révéler d'un coup d'œil une intro coupée, un outro en plus, ou une durée
// différente entre deux candidats doublons.
router.get('/api/waveform-diff', async (req, res) => {
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
router.get('/api/waveform/:encodedPath', async (req, res) => {
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

// API: Stream MP3 — identifié par CHEMIN (base64url), jamais par index de tableau.
// Un index de position se décale à chaque quarantaine/renommage/undo et finit par
// pointer sur un fichier différent de celui qu'on croit écouter.
router.get('/api/stream/:encodedPath', (req, res) => {
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

export default router;
