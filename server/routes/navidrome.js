import express from 'express';
import path from 'path';
import { NAVIDROME_LIBRARY_ROOT } from '../config.js';
import { analysisState } from '../store.js';
import { subsonicGet } from '../navidrome.js';
import { pushProgress, pushFilesToNavidrome } from '../navidromePush.js';
import { autoProcessProgress, autoProcessAndPush } from '../autoProcess.js';

const router = express.Router();

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
