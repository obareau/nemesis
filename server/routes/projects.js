import express from 'express';
import fs from 'fs';
import path from 'path';
import { PROJECTS_DIR, QUARANTINE_DIR } from '../config.js';
import {
  analysisState, processedGroups, actionLog,
  setAnalysisState, bumpScanGeneration, setProcessedGroups, setActionLog,
  projectFileFor, loadProjectRaw, listProjects, persistProject, applyNavidromePushed
} from '../store.js';
import { safeMoveSync } from '../fsUtils.js';
import { readQuarantineManifest, writeQuarantineManifest } from '../quarantineFs.js';
import { subsonicGet } from '../navidrome.js';
import { writeTags } from '../tagging.js';
import { maybeBackfillBitrate } from './scan.js';

const router = express.Router();

// API: Liste des projets connus (dossiers déjà scannés, actifs ou terminés)
router.get('/api/projects', (req, res) => {
  res.json({ projects: listProjects(), currentDirPath: analysisState.dirPath });
});

// API: Marque le projet courant comme terminé (sort de la liste active par défaut)
router.post('/api/projects/close', express.json(), (req, res) => {
  if (!analysisState.dirPath) {
    return res.status(400).json({ error: 'Aucun projet actif' });
  }
  // Stoppe immédiatement toute boucle fingerprint/paroles encore en cours sur ce projet
  bumpScanGeneration();

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
router.post('/api/projects/reopen', express.json(), (req, res) => {
  const { dirPath } = req.body;
  const existing = loadProjectRaw(dirPath);
  if (!existing) {
    return res.status(404).json({ error: 'Projet introuvable' });
  }
  bumpScanGeneration(); // invalide toute boucle du projet précédemment actif
  existing.status = 'active';
  existing.updatedAt = new Date().toISOString();
  fs.writeFileSync(projectFileFor(dirPath), JSON.stringify(existing));
  setAnalysisState(existing.analysisState);
  setProcessedGroups(existing.processedGroups || []);
  setActionLog(existing.actionLog || []);
  maybeBackfillBitrate();
  res.json({ ...analysisState, resumed: true });
});

// API: Supprime le SUIVI d'un projet (fichier de métadonnées uniquement — historique
// d'actions, liste de fichiers en cache, groupes traités). Ne touche JAMAIS aux
// fichiers audio réels sur disque ni à la corbeille associée.
router.delete('/api/projects', express.json(), (req, res) => {
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
    bumpScanGeneration(); // stoppe toute boucle fingerprint/paroles encore active sur ce projet
    setAnalysisState({
      status: 'idle', currentFile: null, currentStage: null, fileProgress: 0,
      totalProgress: 0, files: [], duplicates: [], similarPairs: [], error: null, dirPath: null
    });
    setProcessedGroups([]);
    setActionLog([]);
  }

  res.json({ success: true });
});

// API: Marque un groupe comme traité/ignoré (persisté — ne réapparaît plus dans la pile)
router.post('/api/groups/skip', express.json(), (req, res) => {
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

// API: Annule la dernière action journalisée (undo générique)
router.post('/api/undo', async (req, res) => {
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
        if (r.oldTags) await writeTags(r.oldPath, r.oldTags);
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
      setProcessedGroups(processedGroups.filter(s => s !== last.data.signature));
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

// API: Export de l'historique d'actions du projet actif (audit trail) — JSON complet
// (avec `data`, utile pour rejouer/inspecter un undo) ou CSV (résumé + detail en JSON compact,
// les types d'action ont des formes trop différentes pour des colonnes dédiées propres).
router.get('/api/export/action-log', (req, res) => {
  if (!analysisState.dirPath) {
    return res.status(400).json({ error: 'Aucun projet actif' });
  }

  if (req.query.format === 'csv') {
    const header = ['id', 'type', 'timestamp', 'description', 'detail'];
    const escapeCsv = (v) => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = actionLog.map(a => [a.id, a.type, a.timestamp, a.description, JSON.stringify(a.data || {})]);
    const csv = [header, ...rows].map(r => r.map(escapeCsv).join(',')).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="nemesis-action-log-${Date.now()}.csv"`);
    return res.send('\uFEFF' + csv); // BOM — accents FR lisibles dans Excel
  }

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="nemesis-action-log-${Date.now()}.json"`);
  res.send(JSON.stringify(actionLog, null, 2));
});

export default router;
