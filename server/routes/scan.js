import express from 'express';
import { FPCALC_CONCURRENCY } from '../config.js';
import {
  analysisState, scanGeneration, processedGroups, actionLog, setAnalysisState, bumpScanGeneration,
  setProcessedGroups, setActionLog, loadProjectRaw, persistProject
} from '../store.js';
import {
  scanDirectory, analyzeBySize, analyzeByName, analyzeByFingerprint, analyzeByLyrics,
  getFingerprint, transcribeLyrics, runWithConcurrency
} from '../analysis.js';
import { getCachedAnalysis, setCachedAnalysis } from '../cache.js';
import { warmWaveformCache } from '../waveformCache.js';

const router = express.Router();

// API: Scan directory
router.post('/api/scan', express.json(), async (req, res) => {
  const { dirPath, force } = req.body;

  if (!dirPath) {
    return res.status(400).json({ error: 'dirPath required' });
  }

  // Invalide toute boucle de scan en arrière-plan encore active (ancien projet,
  // ou celui qu'on quitte) — sans ça elle continue d'écrire dans analysisState
  // même après qu'on soit passé à autre chose.
  bumpScanGeneration();

  // Reprise de projet : si ce dossier a déjà un projet sauvegardé et qu'on ne
  // force pas un rescan complet, on recharge l'état tel quel (fichiers,
  // doublons, groupes déjà traités, historique d'actions) au lieu de relancer
  // toute l'analyse — le travail déjà fait n'est jamais perdu.
  if (!force) {
    const existing = loadProjectRaw(dirPath);
    if (existing) {
      setAnalysisState(existing.analysisState);
      setProcessedGroups(existing.processedGroups || []);
      setActionLog(existing.actionLog || []);
      return res.json({ ...analysisState, resumed: true });
    }
  }

  const myGeneration = scanGeneration;

  try {
    setAnalysisState({
      status: 'scanning',
      currentFile: null,
      currentStage: null,
      fileProgress: 0,
      totalProgress: 0,
      files: [],
      duplicates: [],
      similarPairs: [],
      error: null,
      dirPath
    });
    setProcessedGroups([]);
    setActionLog([]);

    // Scan files
    const files = scanDirectory(dirPath);
    analysisState.files = files;

    // Étape 1: Size (groupes de fichiers de taille strictement identique)
    const sizeGroups = analyzeBySize(files);
    analysisState.totalProgress = 25;

    // Étape 2: Name (comparaison sur TOUS les fichiers, indépendamment de la taille)
    const { groups: nameGroups, allPairs: namePairs } = analyzeByName(files);
    analysisState.duplicates = [...sizeGroups, ...nameGroups];
    analysisState.similarPairs = [...namePairs];
    analysisState.totalProgress = 50;
    persistProject();

    // Étape 3 + 4: Fingerprint puis Paroles (async, background) — ne bloque jamais le serveur
    setTimeout(async () => {
      try {
        // Fingerprinte tous les fichiers candidats (uniques, dédupliqués par chemin)
        const candidatesByPath = new Map();
        for (const dup of analysisState.duplicates) {
          for (const file of dup.files) candidatesByPath.set(file.path, file);
        }
        const candidates = Array.from(candidatesByPath.values());

        let fpCacheHits = 0, lyricsCacheHits = 0;

        analysisState.currentStage = 'fingerprint';
        let fpDone = 0;
        // Empreintes calculées avec FPCALC_CONCURRENCY processus fpcalc en parallèle
        // (CPU-bound, indépendant par fichier) au lieu d'un fichier à la fois.
        await runWithConcurrency(candidates, FPCALC_CONCURRENCY, async (file) => {
          if (scanGeneration !== myGeneration) return; // projet fermé/rescanné entretemps — on abandonne

          const cached = getCachedAnalysis(file);
          if (cached?.fingerprint) {
            file.fingerprint = cached.fingerprint;
            fpCacheHits++;
          } else {
            try {
              file.fingerprint = await getFingerprint(file.path);
              setCachedAnalysis(file, { fingerprint: file.fingerprint });
            } catch (e) {
              console.error('Fingerprint error:', e.message);
            }
          }
          fpDone++;
          analysisState.currentFile = `${fpDone}/${candidates.length}`;
          analysisState.fileProgress = Math.round((fpDone / candidates.length) * 100);
        });
        if (scanGeneration !== myGeneration) return;
        if (fpCacheHits > 0) console.log(`⚖️  Cache fingerprint: ${fpCacheHits}/${candidates.length} réutilisés`);

        const { groups: fingerprintGroups, allPairs: fingerprintPairs } = analyzeByFingerprint(candidates);
        analysisState.duplicates = [...analysisState.duplicates, ...fingerprintGroups];
        analysisState.similarPairs = [...analysisState.similarPairs, ...fingerprintPairs];
        analysisState.totalProgress = 75;
        persistProject();

        // Étape 4 : Paroles — transcrit uniquement les candidats déjà remontés par taille/nom/audio
        analysisState.currentStage = 'lyrics';
        for (let i = 0; i < candidates.length; i++) {
          if (scanGeneration !== myGeneration) return;
          const file = candidates[i];
          analysisState.currentFile = `${i + 1}/${candidates.length}`;

          const cached = getCachedAnalysis(file);
          if (cached?.lyrics) {
            file.lyrics = cached.lyrics;
            lyricsCacheHits++;
          } else {
            try {
              file.lyrics = await transcribeLyrics(file.path);
              setCachedAnalysis(file, { lyrics: file.lyrics });
            } catch (e) {
              console.error('Lyrics error:', e.message);
            }
          }
          analysisState.fileProgress = Math.round(((i + 1) / candidates.length) * 100);
        }
        if (scanGeneration !== myGeneration) return;
        if (lyricsCacheHits > 0) console.log(`⚖️  Cache paroles: ${lyricsCacheHits}/${candidates.length} réutilisés`);

        const { groups: lyricsGroups, allPairs: lyricsPairs } = analyzeByLyrics(candidates);
        analysisState.duplicates = [...analysisState.duplicates, ...lyricsGroups];
        analysisState.similarPairs = [...analysisState.similarPairs, ...lyricsPairs];
      } catch (err) {
        console.error('Erreur étapes fingerprint/paroles (analyse conservée):', err.message);
      }
      if (scanGeneration !== myGeneration) return;
      analysisState.status = 'completed';
      analysisState.totalProgress = 100;
      analysisState.currentStage = null;
      persistProject();
      warmWaveformCache(analysisState.files, myGeneration).catch(() => {});
    }, 100);

    res.json(analysisState);
  } catch (err) {
    analysisState.status = 'error';
    analysisState.error = err.message;
    res.status(500).json(analysisState);
  }
});

// API: Status (inclut les groupes déjà traités/ignorés + l'historique d'actions du projet courant)
router.get('/api/status', (req, res) => {
  const projectRecord = analysisState.dirPath ? loadProjectRaw(analysisState.dirPath) : null;
  res.json({
    ...analysisState,
    processedGroups,
    actionCount: actionLog.length,
    // Historique léger (sans les snapshots de données) pour le panneau d'annulation multi-niveaux
    actionLog: actionLog.map(a => ({ id: a.id, type: a.type, description: a.description, timestamp: a.timestamp })),
    projectStatus: projectRecord?.status || (analysisState.dirPath ? 'active' : null)
  });
});

export default router;
