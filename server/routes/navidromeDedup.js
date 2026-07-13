import express from 'express';
import fs from 'fs';
import { FPCALC_CONCURRENCY } from '../config.js';
import { listAllSongs, subsonicGet, removeSongFromPlaylist } from '../navidrome.js';
import { getFingerprint, analyzeByFingerprint, runWithConcurrency } from '../analysis.js';
import { getCachedAnalysis, setCachedAnalysis } from '../cache.js';
import { quarantineFiles } from '../quarantine.js';

const router = express.Router();

// État du scan en cours — un seul à la fois (single-user), suivi par polling comme le
// scan initial et le push Navidrome (server/routes/scan.js, server/navidromePush.js).
let dedupScan = {
  active: false, stage: null, done: 0, total: 0,
  confirmedGroups: null, titleOnlyGroups: null, error: null, scannedAt: null
};

// Regroupe les variantes évidentes du même titre ("Static Horizon" / "Static Horizon ok",
// "Chrome Candy Bruise (Cover)") sous une clé commune — préfiltre bon marché avant la
// confirmation coûteuse par empreinte audio (entonnoir, même philosophie que
// size→name→fingerprint dans analysis.js).
export function normalizeTitle(title) {
  let t = (title || '').toLowerCase().trim();
  t = t.replace(/\s*\(cover\)\s*/g, ' ');
  t = t.replace(/\s*\(extended.*?\)\s*/g, ' ');
  t = t.replace(/\s*\bok\b\s*$/g, '');
  t = t.replace(/[^\w\s]/g, '');
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

router.post('/api/navidrome-dedup/scan', express.json(), (req, res) => {
  if (dedupScan.active) {
    return res.status(409).json({ error: 'Un scan est déjà en cours' });
  }

  dedupScan = {
    active: true, stage: 'catalog', done: 0, total: 0,
    confirmedGroups: null, titleOnlyGroups: null, error: null, scannedAt: null
  };
  res.json({ started: true });

  runDedupScan().catch(err => {
    dedupScan.active = false;
    dedupScan.error = err.message;
  });
});

async function runDedupScan() {
  const songs = await listAllSongs();

  dedupScan.stage = 'titles';
  const byTitle = new Map();
  for (const song of songs) {
    if (!song.path) continue;
    const key = normalizeTitle(song.title);
    if (!key) continue;
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key).push(song);
  }
  const titleGroups = [...byTitle.entries()].filter(([, v]) => v.length > 1);

  dedupScan.stage = 'fingerprint';
  // Enrichit chaque candidat avec les vraies size/mtime disque (le cache est indexé
  // dessus, pas sur les métadonnées Navidrome qui n'ont pas de mtime fichier) — ignore
  // silencieusement les entrées dont le fichier n'existe plus sur disque.
  const candidates = [];
  for (const [key, group] of titleGroups) {
    const withStat = [];
    for (const song of group) {
      try {
        const stat = fs.statSync(song.path);
        withStat.push({ ...song, size: stat.size, mtime: stat.mtime.getTime() });
      } catch {
        // fichier disparu du disque depuis l'indexation Navidrome — ignoré
      }
    }
    if (withStat.length > 1) candidates.push([key, withStat]);
  }

  const allCandidateFiles = candidates.flatMap(([, group]) => group);
  dedupScan.total = allCandidateFiles.length;
  let done = 0;
  await runWithConcurrency(allCandidateFiles, FPCALC_CONCURRENCY, async (file) => {
    const cached = getCachedAnalysis(file);
    if (cached?.fingerprint) {
      file.fingerprint = cached.fingerprint;
    } else {
      try {
        file.fingerprint = await getFingerprint(file.path);
        if (file.fingerprint) setCachedAnalysis(file, { fingerprint: file.fingerprint });
      } catch {
        // dégrade en silence — ce fichier restera hors groupe confirmé
      }
    }
    done++;
    dedupScan.done = done;
  });

  dedupScan.stage = 'confirm';
  // Confirmation PAR groupe de titre — jamais entre deux groupes de titres différents,
  // pour ne pas fusionner deux chansons distinctes qui partageraient une empreinte
  // proche par coïncidence.
  const confirmedGroups = [];
  const titleOnlyGroups = [];
  for (const [key, group] of candidates) {
    const { groups } = analyzeByFingerprint(group);
    if (groups.length > 0) {
      for (const g of groups) {
        confirmedGroups.push({ title: group[0].title, files: g.files, similarity: g.similarity });
      }
    } else {
      titleOnlyGroups.push({ title: group[0].title, count: group.length });
    }
  }

  dedupScan.stage = 'playlists';
  const { playlists } = await subsonicGet('getPlaylists.view');
  const songPlaylists = new Map();
  for (const pl of playlists?.playlist || []) {
    const { playlist } = await subsonicGet('getPlaylist.view', `&id=${pl.id}`);
    for (const entry of playlist?.entry || []) {
      if (!songPlaylists.has(entry.id)) songPlaylists.set(entry.id, []);
      // Un morceau peut être présent plusieurs fois dans la même playlist Navidrome
      // (doublon d'entrée, indépendant de notre dédup) — pas la peine de le montrer 2x ici
      const already = songPlaylists.get(entry.id);
      if (!already.some(p => p.id === pl.id)) already.push({ id: pl.id, name: pl.name });
    }
  }

  for (const group of confirmedGroups) {
    for (const file of group.files) {
      file.playlists = songPlaylists.get(file.id) || [];
      delete file.fingerprint; // volumineux, plus utile une fois la confirmation faite
    }
  }

  dedupScan.confirmedGroups = confirmedGroups;
  dedupScan.titleOnlyGroups = titleOnlyGroups;
  dedupScan.active = false;
  dedupScan.stage = null;
  dedupScan.scannedAt = new Date().toISOString();
}

router.get('/api/navidrome-dedup/scan', (req, res) => {
  res.json(dedupScan);
});

// API: applique le nettoyage — retire chaque fichier écarté des playlists où il apparaît
// (retrait NON journalisé dans le système d'undo générique, limitation connue) puis le
// quarantaine (ça, réversible via le mécanisme existant).
router.post('/api/navidrome-dedup/resolve', express.json(), async (req, res) => {
  const { discardPaths } = req.body;
  if (!Array.isArray(discardPaths) || discardPaths.length === 0) {
    return res.status(400).json({ error: 'discardPaths requis (array non vide)' });
  }
  if (!dedupScan.confirmedGroups) {
    return res.status(400).json({ error: 'Aucun scan terminé — lance un scan avant de nettoyer' });
  }

  const byPath = new Map();
  for (const group of dedupScan.confirmedGroups) {
    for (const file of group.files) byPath.set(file.path, file);
  }

  const playlistRemovals = [];
  for (const filePath of discardPaths) {
    const file = byPath.get(filePath);
    if (!file) continue;
    for (const pl of file.playlists || []) {
      try {
        const removed = await removeSongFromPlaylist(pl.id, file.id);
        playlistRemovals.push({ path: filePath, playlist: pl.name, success: removed });
      } catch (err) {
        playlistRemovals.push({ path: filePath, playlist: pl.name, success: false, error: err.message });
      }
    }
  }

  const quarantine = quarantineFiles(discardPaths);

  res.json({ playlistRemovals, quarantine });
});

export default router;
