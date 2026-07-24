import express from 'express';
import fs from 'fs';
import path from 'path';
import { NAVIDROME_LIBRARY_ROOT } from '../config.js';
import { analysisState } from '../store.js';
import { subsonicGet, listAllSongs } from '../navidrome.js';
import { pushProgress, pushFilesToNavidrome } from '../navidromePush.js';
import { autoProcessProgress, autoProcessAndPush } from '../autoProcess.js';
import { getCachedAnalysis } from '../cache.js';
import { allRenames } from '../rename-history.js';

const router = express.Router();

// API: catalogue complet Navidrome (titre/artiste/chemin réel) — permet de cibler le
// traitement en masse (auto-push) sur TOUTE la bibliothèque déjà importée, pas
// seulement les fichiers d'un projet Curation actuellement ouvert (scan de dossier).
//
// Navidrome ne purge pas toujours les entrées d'un fichier renommé/déplacé lors
// d'un scan rapide (startScan.view sans fullScan) — sa DB peut garder une ligne
// fantôme avec l'ancien artiste/nom pour un fichier qui n'existe plus sur disque.
// On filtre ici par fs.existsSync (source de vérité = le disque, pas la DB
// Navidrome) pour ne jamais montrer un artiste périmé. Enrichit aussi chaque
// morceau avec le cache d'analyse (bpm/tonalité/style) déjà calculé par le
// pipeline, pour afficher la même info qu'en Curation sans tout ré-analyser.
router.get('/api/navidrome/library', async (req, res) => {
  try {
    const songs = await listAllSongs();
    const renameMap = allRenames();

    // Index songId → noms de playlists : c'est là qu'on lit "dans quel mood va
    // ce morceau" — les moods (et le style, et Covers) SONT des playlists
    // Navidrome. Vide pour un morceau pas encore traité (on ne peut pas prédire
    // le mood sans lancer le LLM ; il apparaît une fois le morceau poussé).
    const songPlaylists = new Map();
    try {
      const { playlists } = await subsonicGet('getPlaylists.view');
      for (const pl of playlists?.playlist || []) {
        const { playlist } = await subsonicGet('getPlaylist.view', `&id=${pl.id}`);
        for (const entry of playlist?.entry || []) {
          if (!songPlaylists.has(entry.id)) songPlaylists.set(entry.id, []);
          const arr = songPlaylists.get(entry.id);
          if (!arr.includes(pl.name)) arr.push(pl.name);
        }
      }
    } catch { /* playlists best-effort — la liste reste utile sans elles */ }

    const enriched = songs
      .filter(s => s.path && fs.existsSync(s.path))
      .map(s => {
        const originalName = renameMap[s.path] || null;
        const currentName = path.basename(s.path);
        const playlists = songPlaylists.get(s.id) || [];
        try {
          const stat = fs.statSync(s.path);
          const cached = getCachedAnalysis({ path: s.path, size: stat.size, mtime: stat.mtimeMs });
          // cached.genre : soit { styles, moods } (nouveau), soit un tableau de styles
          // nu (ancien format en cache) — on gère les deux.
          const styleArr = Array.isArray(cached?.genre) ? cached.genre : cached?.genre?.styles;
          const genre = Array.isArray(styleArr) && styleArr[0]?.label
            ? styleArr[0].label.split('---').pop()
            : null;
          return { ...s, currentName, originalName, playlists, bpm: cached?.bpm ?? null, key: cached?.key ?? null, scale: cached?.scale ?? null, genre };
        } catch {
          return { ...s, currentName, originalName, playlists, bpm: null, key: null, scale: null, genre: null };
        }
      });
    res.json({ songs: enriched });
  } catch (err) {
    res.status(500).json({ error: `Lecture catalogue Navidrome échouée : ${err.message}` });
  }
});

// API: Progression du push Navidrome en cours (polling)
router.get('/api/navidrome/push-progress', (req, res) => {
  res.json(pushProgress);
});

// API: Contenu d'une playlist mood Navidrome — pour le panneau "voir ce qui est déjà dans ce mood"
router.get('/api/navidrome/mood/:mood', async (req, res) => {
  const { mood } = req.params;

  try {
    const { playlists } = await subsonicGet('getPlaylists.view');
    const playlist = (playlists?.playlist || []).find(
      p => p.name.toLowerCase() === mood.toLowerCase()
    );

    if (!playlist) {
      return res.json({ mood, playlistId: null, tracks: [] });
    }

    const info = await subsonicGet('getPlaylist.view', `&id=${playlist.id}`);
    const songs = info.playlist?.entry || [];

    const tracks = songs.map(song => {
      const absolutePath = song.path ? path.join(NAVIDROME_LIBRARY_ROOT, song.path) : null;
      const localFile = absolutePath ? analysisState.files.find(f => f.path === absolutePath) : null;
      return {
        songId: song.id,
        title: song.title,
        artist: song.artist,
        path: absolutePath,
        knownLocally: !!localFile,
        rating: localFile?.rating,
        bpm: localFile?.bpm
      };
    });

    res.json({ mood, playlistId: playlist.id, tracks });
  } catch (err) {
    res.status(500).json({ error: `Échec lecture playlist Navidrome: ${err.message}` });
  }
});

// API: Pousse les fichiers (déjà renommés/taggés) vers Navidrome — rescan + assignation playlist(s) par mood
router.post('/api/navidrome/push', express.json(), async (req, res) => {
  const { filePaths, moods } = req.body;

  if (!Array.isArray(filePaths) || filePaths.length === 0) {
    return res.status(400).json({ error: 'filePaths requis (array non vide)' });
  }
  if (!Array.isArray(moods) || moods.length === 0) {
    return res.status(400).json({ error: 'moods requis (au moins un mood sélectionné)' });
  }

  try {
    const result = await pushFilesToNavidrome(filePaths, moods);
    res.json(result);
  } catch (err) {
    if (err.code === 'SCAN_TIMEOUT') {
      return res.status(504).json({ error: err.message });
    }
    res.status(500).json({ error: `Push Navidrome échoué : ${err.message}` });
  }
});

// API: Progression du traitement en masse en cours (polling)
router.get('/api/navidrome/auto-push-progress', (req, res) => {
  res.json(autoProcessProgress);
});

// API: Traitement en masse pour un lot de morceaux INDÉPENDANTS (pas un
// groupe de doublons partageant un même mood) — pour chaque fichier : titre
// généré depuis ses propres paroles, mood(s) générés depuis ses propres
// paroles/BPM/tonalité, poussé vers SA PROPRE playlist Navidrome. Contraste
// avec /api/navidrome/push, qui applique les mêmes moods à tout le lot.
router.post('/api/navidrome/auto-push', express.json(), async (req, res) => {
  const { filePaths } = req.body;

  if (!Array.isArray(filePaths) || filePaths.length === 0) {
    return res.status(400).json({ error: 'filePaths requis (array non vide)' });
  }

  try {
    const result = await autoProcessAndPush(filePaths);
    res.json(result);
  } catch (err) {
    if (err.code === 'SCAN_TIMEOUT') {
      return res.status(504).json({ error: err.message });
    }
    res.status(500).json({ error: `Traitement en masse échoué : ${err.message}` });
  }
});

export default router;
