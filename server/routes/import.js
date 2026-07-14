import express from 'express';
import fs from 'fs';
import path from 'path';
import { INBOX_DIR, INBOX_EXCLUDE_DIRS, NAVIDROME_LIBRARY_ROOT } from '../config.js';
import { scanDirectory, analyzeAudioFeatures } from '../analysis.js';
import { getCachedAnalysis, setCachedAnalysis } from '../cache.js';
import { writeTags } from '../tagging.js';
import { safeMoveSync, streamAudioWithRange } from '../fsUtils.js';
import { pushFilesToNavidrome } from '../navidromePush.js';
import { readImportHistory, writeImportHistory } from '../importHistory.js';

const router = express.Router();

// Garde anti-traversée : le chemin résolu doit rester sous INBOX_DIR.
function isInboxPath(filePath) {
  const resolved = path.resolve(filePath);
  return resolved === INBOX_DIR || resolved.startsWith(INBOX_DIR + path.sep);
}

// "13-juil-2026" — convention des dossiers existants de la bibliothèque (10-juil-2026).
// PAS toLocaleDateString('fr-FR') : il produit "juil." avec un point.
const FR_MONTHS = ['janv', 'févr', 'mars', 'avr', 'mai', 'juin', 'juil', 'août', 'sept', 'oct', 'nov', 'déc'];
export function datedFolderName(d = new Date()) {
  return `${String(d.getDate()).padStart(2, '0')}-${FR_MONTHS[d.getMonth()]}-${d.getFullYear()}`;
}

// Détecte si un dossier de l'inbox a déjà été envoyé : "possible" si un import antérieur du
// même nom a le même nombre de fichiers (test rapide), "confirmed" si en plus les noms de
// fichiers correspondent exactement (analyse plus poussée sur l'historique persistant).
export function detectFolderWarning(folderName, currentFileNames, history) {
  const candidates = history.filter(h => h.folderName === folderName && h.fileCount === currentFileNames.length);
  if (candidates.length === 0) return null;

  const sortedCurrent = JSON.stringify([...currentFileNames].sort());
  const confirmed = candidates.find(c => JSON.stringify([...c.fileNames].sort()) === sortedCurrent);
  if (confirmed) {
    return { status: 'confirmed', importedAt: confirmed.importedAt, destDir: confirmed.destDir };
  }

  const latest = [...candidates].sort((a, b) => b.importedAt.localeCompare(a.importedAt))[0];
  return { status: 'possible', importedAt: latest.importedAt, destDir: latest.destDir };
}

// API: Liste de la boîte de dépôt — fichiers audio en attente d'import, hors dossiers
// d'archive (INBOX_EXCLUDE_DIRS, noms de 1er niveau). Les plus récents d'abord.
router.get('/api/import/inbox', (req, res) => {
  const files = scanDirectory(INBOX_DIR)
    .filter(f => {
      const topSegment = path.relative(INBOX_DIR, f.path).split(path.sep)[0];
      return !INBOX_EXCLUDE_DIRS.includes(topSegment);
    })
    .map(f => {
      const rel = path.dirname(path.relative(INBOX_DIR, f.path));
      return { ...f, relPath: rel === '.' ? '' : rel };
    })
    .sort((a, b) => b.mtime - a.mtime);

  // Groupe par dossier de PREMIER NIVEAU (pas le relPath complet, qui peut être imbriqué) —
  // "le dossier X a déjà été importé" se pense au niveau du dossier déposé, pas d'un
  // sous-dossier interne.
  const byFolder = new Map();
  for (const f of files) {
    if (!f.relPath) continue; // fichier à la racine de l'inbox : pas de "dossier" à suivre
    const topSegment = f.relPath.split(path.sep)[0];
    if (!byFolder.has(topSegment)) byFolder.set(topSegment, []);
    byFolder.get(topSegment).push(f.name);
  }

  const history = readImportHistory();
  const folderWarnings = [];
  for (const [folderName, fileNames] of byFolder) {
    const warning = detectFolderWarning(folderName, fileNames, history);
    if (warning) folderWarnings.push({ folderName, fileCount: fileNames.length, ...warning });
  }

  res.json({ inboxDir: INBOX_DIR, files, folderWarnings });
});

// API: BPM/tonalité d'un fichier de l'inbox (Essentia, ~6-9s, cache partagé) — alimente
// la suggestion de mood Ollama côté frontend. Écrit aussi les tags pour que le BPM
// survive au déplacement vers la bibliothèque (l'ID3 voyage avec le fichier).
router.post('/api/import/analyze', express.json(), async (req, res) => {
  const { filePath } = req.body;
  if (!filePath) {
    return res.status(400).json({ error: 'filePath requis' });
  }
  if (!isInboxPath(filePath)) {
    return res.status(403).json({ error: 'Chemin hors de la boîte de dépôt' });
  }

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return res.status(404).json({ error: 'Fichier introuvable (déplacé ou supprimé ?)' });
  }

  const fileKey = { path: filePath, size: stat.size, mtime: stat.mtime.getTime() };
  const cached = getCachedAnalysis(fileKey);
  if (cached?.bpm) {
    return res.json({ success: true, bpm: cached.bpm, key: cached.key, scale: cached.scale, cached: true });
  }

  const result = await analyzeAudioFeatures(filePath);
  if (!result) {
    return res.status(500).json({ error: 'Analyse BPM/tonalité échouée' });
  }

  // Cache AVANT le tag : l'écriture du tag change size/mtime, ce qui invaliderait la clé
  setCachedAnalysis(fileKey, result);
  try {
    await writeTags(filePath, { bpm: String(Math.round(result.bpm)), initialKey: `${result.key}${result.scale === 'minor' ? 'm' : ''}` });
  } catch {
    // tag échoué (fichier verrouillé/lecture seule) — pas bloquant, la valeur reste en cache
  }
  res.json({ success: true, ...result, cached: false });
});

// API: Stream d'un fichier de l'inbox (pré-écoute avant import) — 404 hors inbox,
// sans distinguer "hors périmètre" de "inexistant" pour ne rien révéler du disque.
router.get('/api/import/stream/:encodedPath', (req, res) => {
  let filePath;
  try {
    filePath = Buffer.from(req.params.encodedPath, 'base64url').toString('utf-8');
  } catch {
    return res.status(400).json({ error: 'Chemin invalide' });
  }

  if (!isInboxPath(filePath)) {
    return res.status(404).json({ error: 'Fichier introuvable' });
  }

  streamAudioWithRange(req, res, filePath);
});

// API: Envoi vers la radio — déplace les fichiers de l'inbox vers un dossier daté de la
// bibliothèque Navidrome (aplatis, collision → suffixe (n)) puis pousse vers les
// playlists mood. Les fichiers déplacés RESTENT déplacés même si le push échoue
// (ils sont en sécurité dans la bibliothèque, seule l'assignation playlist a raté) —
// d'où une réponse 200 avec pushError plutôt qu'un 5xx trompeur.
//
// Moods PAR FICHIER (pas un seul jeu partagé pour tout le lot) : après un "Analyser +
// suggérer tout" sur un import en masse, chaque morceau a déjà sa propre suggestion —
// forcer un mood unique pour toute la sélection bloquait inutilement l'envoi. Les fichiers
// sont regroupés par jeu de moods identique pour ne relancer le scan Navidrome qu'une fois
// par groupe (pushFilesToNavidrome rescanne à chaque appel), pas une fois par fichier.
router.post('/api/import/send', express.json(), async (req, res) => {
  const { files } = req.body;

  if (!Array.isArray(files) || files.length === 0) {
    return res.status(400).json({ error: 'files requis (array non vide)' });
  }
  for (const f of files) {
    if (!f.path || !Array.isArray(f.moods) || f.moods.length === 0) {
      return res.status(400).json({ error: `moods requis pour "${f.path ? path.basename(f.path) : 'un fichier'}"` });
    }
  }
  if (files.some(f => !isInboxPath(f.path))) {
    return res.status(403).json({ error: 'Un des chemins sort de la boîte de dépôt' });
  }

  const destDir = path.join(NAVIDROME_LIBRARY_ROOT, datedFolderName());
  fs.mkdirSync(destDir, { recursive: true });

  const moved = [];
  const moveErrors = [];

  for (const { path: filePath, moods } of files) {
    const name = path.basename(filePath);
    if (!fs.existsSync(filePath)) {
      moveErrors.push({ file: name, error: 'Fichier disparu de la boîte de dépôt (déjà déplacé ?)' });
      continue;
    }

    try {
      const ext = path.extname(name);
      const base = path.basename(name, ext);
      let finalName = name;
      let destPath = path.join(destDir, finalName);
      let n = 2;
      while (fs.existsSync(destPath)) {
        finalName = `${base} (${n})${ext}`;
        destPath = path.join(destDir, finalName);
        n++;
      }

      safeMoveSync(filePath, destPath);
      moved.push({ oldPath: filePath, newPath: destPath, name: finalName, moods });
    } catch (err) {
      moveErrors.push({ file: name, error: err.message });
    }
  }

  // Journalise l'import par dossier source (premier niveau de l'inbox) pour la détection
  // "ce dossier a déjà été envoyé" au prochain chargement de l'inbox. Les fichiers déposés
  // directement à la racine de l'inbox n'ont pas de dossier à suivre.
  if (moved.length > 0) {
    const byFolder = new Map();
    for (const m of moved) {
      const rel = path.relative(INBOX_DIR, m.oldPath);
      const topSegment = path.dirname(rel).split(path.sep)[0];
      if (topSegment === '.') continue;
      if (!byFolder.has(topSegment)) byFolder.set(topSegment, []);
      byFolder.get(topSegment).push(m.name);
    }
    if (byFolder.size > 0) {
      const history = readImportHistory();
      const importedAt = new Date().toISOString();
      for (const [folderName, fileNames] of byFolder) {
        history.push({ folderName, fileCount: fileNames.length, fileNames: [...fileNames].sort(), importedAt, destDir });
      }
      writeImportHistory(history);
    }
  }

  const moodGroups = new Map();
  for (const m of moved) {
    const key = [...m.moods].sort().join('|');
    if (!moodGroups.has(key)) moodGroups.set(key, { moods: m.moods, paths: [] });
    moodGroups.get(key).paths.push(m.newPath);
  }

  let push = null;
  let pushError = null;
  if (moved.length > 0) {
    try {
      const results = [];
      let pushed = 0;
      let failed = 0;
      for (const { moods, paths } of moodGroups.values()) {
        const r = await pushFilesToNavidrome(paths, moods);
        pushed += r.pushed;
        failed += r.failed;
        results.push(...r.results);
      }
      push = { success: failed === 0, pushed, failed, results };
    } catch (err) {
      pushError = err.message;
    }
  }

  res.json({
    success: moveErrors.length === 0 && !pushError && (push ? push.failed === 0 : true),
    destDir,
    moved,
    moveErrors,
    push,
    pushError
  });
});

export default router;
