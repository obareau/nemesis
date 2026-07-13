import express from 'express';
import fs from 'fs';
import path from 'path';
import { QUARANTINE_DIR } from '../config.js';
import { analysisState, actionLog, persistProject } from '../store.js';
import { safeMoveSync } from '../fsUtils.js';
import { readQuarantineManifest, writeQuarantineManifest } from '../quarantineFs.js';
import { quarantineFiles } from '../quarantine.js';

const router = express.Router();

// API: Met en quarantaine (déplace, ne supprime jamais) les fichiers sélectionnés
router.post('/api/quarantine', express.json(), (req, res) => {
  const { filePaths } = req.body;

  if (!Array.isArray(filePaths) || filePaths.length === 0) {
    return res.status(400).json({ error: 'filePaths requis (array non vide)' });
  }

  try {
    res.json(quarantineFiles(filePaths));
  } catch (err) {
    res.status(500).json({ error: `Impossible de créer la corbeille: ${err.message}` });
  }
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
