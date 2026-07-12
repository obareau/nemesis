import express from 'express';
import fs from 'fs';
import path from 'path';
import { QUARANTINE_DIR } from '../config.js';
import { analysisState, actionLog, persistProject } from '../store.js';
import { safeMoveSync } from '../fsUtils.js';
import { readQuarantineManifest, writeQuarantineManifest } from '../quarantineFs.js';

const router = express.Router();

// API: Met en quarantaine (déplace, ne supprime jamais) les fichiers sélectionnés
router.post('/api/quarantine', express.json(), (req, res) => {
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
router.get('/api/quarantine', (req, res) => {
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
router.post('/api/quarantine/restore', express.json(), (req, res) => {
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
router.post('/api/quarantine/empty', express.json(), (req, res) => {
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

export default router;
