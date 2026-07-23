import express from 'express';
import fs from 'fs';
import path from 'path';
import { EDITS_BACKUP_DIR } from '../config.js';
import {
  analysisState, actionLog, persistProject, applyAudioFeatures, applyLyrics
} from '../store.js';
import { getCachedAnalysis, setCachedAnalysis } from '../cache.js';
import { analyzeAudioFeatures, transcribeLyrics, probeDuration, probeBitrate, runFfmpeg } from '../analysis.js';
import { safeMoveSync } from '../fsUtils.js';
import { readTags, writeTags, audioCodecArgsFor } from '../tagging.js';
import { findExistingAuthor, recordAuthor } from '../title-authors.js';
import { generateTitleFromLyrics, generateMoodFromSignals, generateAuthorForTrack } from '../ollamaGen.js';

const router = express.Router();

// API: Note un fichier de 0 à 5 étoiles — pour trier vite garder/quarantaine dans un
// groupe. Pas journalisé pour undo (métadonnée légère, librement modifiable),
// mais mis à jour partout où le fichier apparaît (files + duplicates + similarPairs)
// puisqu'après un rechargement JSON les objets ne sont plus des références partagées.
router.post('/api/rating', express.json(), (req, res) => {
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
router.post('/api/play-count', express.json(), (req, res) => {
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
router.post('/api/tag-mood', express.json(), (req, res) => {
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
router.post('/api/analyze-audio', express.json(), async (req, res) => {
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
    await writeTags(filePath, { bpm: String(Math.round(result.bpm)), initialKey: `${result.key}${result.scale === 'minor' ? 'm' : ''}` });
  } catch {
    // tag échoué (fichier verrouillé/lecture seule) — pas bloquant, la valeur reste en cache app
  }
  persistProject();
  res.json({ success: true, ...result, cached: false });
});

// API: relance la transcription des paroles à un offset donné (bypass cache) — utile
// pour les morceaux à intro longue où la fenêtre par défaut (t+15s) tombe encore dans l'instru.
router.post('/api/lyrics-rescan', express.json(), async (req, res) => {
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

// API: Renommage en masse + tagging (artiste fictif + titre paroles)
router.post('/api/rename-bulk', express.json(), async (req, res) => {
  const { filePaths, author, title, moods } = req.body;

  if (!Array.isArray(filePaths) || filePaths.length === 0) {
    return res.status(400).json({ error: 'filePaths requis (array non vide)' });
  }
  if (!author || !author.trim()) {
    return res.status(400).json({ error: 'author requis' });
  }

  // Mémorise l'association titre→auteur (sur les noms d'origine, avant
  // renommage) pour que toute future occurrence du même titre — même hors de
  // ce groupe, même dans un import ultérieur — retombe sur le même artiste
  // fictif, y compris quand l'auteur a été tapé à la main plutôt que généré.
  recordAuthor(filePaths.map(p => path.basename(p)), author.trim());

  const results = [];
  const renames = [];

  for (const filePath of filePaths) {
    try {
      // Snapshot des tags d'origine pour pouvoir les restaurer via undo
      const oldTags = await readTags(filePath);

      // Tag : artiste fictif + titre (paroles). Le mood n'est PAS un genre ID3 —
      // Subwave route par appartenance à une playlist Navidrome (voir /api/navidrome/push).
      const tags = { artist: author };
      if (title && title.trim()) tags.title = title.trim();
      await writeTags(filePath, tags);

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
router.post('/api/rename-file', express.json(), (req, res) => {
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
router.post('/api/generate-author', express.json(), async (req, res) => {
  const { trackNames = [], mood = '' } = req.body;

  // Même titre (nom de fichier normalisé) déjà croisé ailleurs dans la
  // bibliothèque → réutilise le même artiste fictif plutôt que d'en inventer
  // un nouveau. Plus cohérent (deux versions d'un même morceau restent "du
  // même artiste"), et ça aide Subwave à espacer les répétitions : il évite
  // déjà de rejouer le même artiste à la suite, donc ça évite aussi de
  // rejouer la même chanson sous un nom d'artiste différent juste après.
  const existingAuthor = findExistingAuthor(trackNames);
  if (existingAuthor) {
    return res.json({ author: existingAuthor, reused: true });
  }

  try {
    const author = await generateAuthorForTrack(trackNames, mood);
    recordAuthor(trackNames, author);
    res.json({ author });
  } catch (err) {
    res.status(500).json({ error: `Génération échouée : ${err.message}` });
  }
});

// API: Génération d'un titre court (3-4 mots) résumant les paroles trouvées, via Ollama local
router.post('/api/generate-title', express.json(), async (req, res) => {
  const { lyrics = '' } = req.body;
  try {
    const title = await generateTitleFromLyrics(lyrics);
    res.json({ title });
  } catch (err) {
    res.status(err.message.includes('requis') ? 400 : 500).json({ error: `Génération échouée : ${err.message}` });
  }
});

// API: Suggestion de mood(s) via Ollama local, à partir des paroles et du BPM/tonalité déjà
// analysés — évite de parcourir les 17 moods à la main pour chaque groupe. Contraint à la
// liste canonique SHOW_MOODS : toute suggestion hors-liste (hallucination du modèle) est filtrée.
router.post('/api/generate-mood', express.json(), async (req, res) => {
  const { lyrics = '', bpm, key, scale } = req.body;
  try {
    const moods = await generateMoodFromSignals({ lyrics, bpm, key, scale });
    res.json({ moods });
  } catch (err) {
    res.status(err.message.includes('requis') ? 400 : 500).json({ error: `Génération échouée : ${err.message}` });
  }
});

// API: Trim (couper début/fin) + fade in/out — réécrit le fichier en place, l'original
// est sauvegardé à côté (EDITS_BACKUP_DIR) pour permettre un undo, jamais destructif.
router.post('/api/audio-edit', express.json(), async (req, res) => {
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
    args.push(...audioCodecArgsFor(filePath), tempPath);

    await runFfmpeg(args);
    safeMoveSync(tempPath, filePath);

    const stat = fs.statSync(filePath);
    fileEntry.size = stat.size;
    fileEntry.mtime = stat.mtimeMs;
    // Contenu audio modifié : les analyses précédentes (empreinte, paroles, bpm, tonalité)
    // ne correspondent plus au fichier — elles seront recalculées à la demande. Le débit
    // change aussi (durée/filtres différents) mais est bon marché à ré-extraire tout de
    // suite plutôt que de laisser l'heuristique autopilot tourner sur une valeur périmée.
    delete fileEntry.fingerprint;
    delete fileEntry.lyrics;
    delete fileEntry.bpm;
    delete fileEntry.key;
    delete fileEntry.scale;
    try { fileEntry.bitrate = await probeBitrate(filePath); } catch { delete fileEntry.bitrate; }

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

export default router;
