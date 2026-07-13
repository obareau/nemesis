import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { __dirname } from './server/config.js';
import { analysisState, scanGeneration, setAnalysisState, setProcessedGroups, setActionLog, listProjects, loadProjectRaw } from './server/store.js';
import { warmWaveformCache } from './server/waveformCache.js';
import browseRoutes from './server/routes/browse.js';
import scanRoutes, { maybeBackfillBitrate } from './server/routes/scan.js';
import projectsRoutes from './server/routes/projects.js';
import filesRoutes from './server/routes/files.js';
import navidromeRoutes from './server/routes/navidrome.js';
import waveformRoutes from './server/routes/waveform.js';
import quarantineRoutes from './server/routes/quarantine.js';
import importRoutes from './server/routes/import.js';

// Filet de sécurité : une exception isolée ne doit jamais tuer tout le serveur
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (serveur maintenu en vie):', err);
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection (serveur maintenu en vie):', err);
});

const app = express();
app.use(cors());
app.use(express.json());

// Sert le frontend buildé (dist/) — process unique en production, plus besoin de vite dev
const distPath = path.join(__dirname, 'dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
}

app.use(browseRoutes);
app.use(scanRoutes);
app.use(projectsRoutes);
app.use(filesRoutes);
app.use(navidromeRoutes);
app.use(waveformRoutes);
app.use(quarantineRoutes);
app.use(importRoutes);

// SPA fallback : toute route non-API renvoie index.html (React Router-less mais robuste au refresh)
app.get(/^(?!\/api).*/, (req, res) => {
  const indexPath = path.join(distPath, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send('Build frontend manquant — lance `npm run build`');
  }
});

// Recharge automatiquement le projet actif le plus récent au démarrage —
// un redémarrage du service (déploiement, watchdog, crash) ne doit jamais
// faire perdre le fil du dossier en cours de tri.
function loadMostRecentActiveProject() {
  const active = listProjects().filter(p => p.status === 'active');
  if (active.length === 0) return;

  const project = loadProjectRaw(active[0].dirPath);
  if (!project) return;

  setAnalysisState(project.analysisState);
  setProcessedGroups(project.processedGroups || []);
  setActionLog(project.actionLog || []);
  console.log(`⚖️  Projet repris automatiquement: ${project.dirPath}`);
  if (analysisState.files?.length > 0) {
    warmWaveformCache(analysisState.files, scanGeneration).catch(() => {});
    maybeBackfillBitrate();
  }
}

loadMostRecentActiveProject();

const PORT = process.env.PORT || 5693;
app.listen(PORT, () => {
  console.log(`⚖️  Nemesis server running on http://localhost:${PORT}`);
});
