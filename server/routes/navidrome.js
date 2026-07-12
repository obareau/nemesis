import express from 'express';
import path from 'path';
import { NAVIDROME_LIBRARY_ROOT, COVERS_PLAYLIST_NAME } from '../config.js';
import { analysisState, actionLog, persistProject, applyNavidromePushed } from '../store.js';
import { subsonicGet, waitForScanCompletion, findSongIdByName, ensurePlaylistAndAddSong, findExistingCatalogMatch } from '../navidrome.js';

const router = express.Router();

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
    await subsonicGet('startScan.view');
    const scanned = await waitForScanCompletion();
    if (!scanned) {
      return res.status(504).json({ error: 'Scan Navidrome trop long (timeout 30s)' });
    }

    const results = [];
    for (const filePath of filePaths) {
      const fileName = path.basename(filePath);
      try {
        const songId = await findSongIdByName(fileName);
        if (!songId) {
          results.push({ file: fileName, success: false, error: 'Morceau introuvable dans Navidrome après scan' });
          continue;
        }

        // Vérifie qu'un morceau équivalent n'est pas déjà catalogué sous un autre chemin
        const existingMatch = await findExistingCatalogMatch(filePath);

        if (existingMatch) {
          // Doublon déjà présent : mise en attente dans la playlist "Covers", pas d'ajout aux moods
          const coverResult = await ensurePlaylistAndAddSong(COVERS_PLAYLIST_NAME, songId);
          results.push({
            file: fileName,
            filePath,
            success: true,
            songId,
            alreadyInLibrary: true,
            matchedExisting: { title: existingMatch.title, path: existingMatch.path, similarity: existingMatch.similarity },
            playlists: [coverResult]
          });
          continue;
        }

        const playlistResults = [];
        for (const mood of moods) {
          const r = await ensurePlaylistAndAddSong(mood, songId);
          playlistResults.push(r);
        }
        results.push({ file: fileName, filePath, success: true, alreadyInLibrary: false, songId, playlists: playlistResults });
      } catch (err) {
        results.push({ file: fileName, filePath, success: false, error: err.message });
      }
    }

    const successResults = results.filter(r => r.success);
    if (successResults.length > 0) {
      for (const r of successResults) applyNavidromePushed(r.filePath, true);

      actionLog.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        type: 'navidrome-push',
        timestamp: new Date().toISOString(),
        description: `${successResults.length} morceau(x) envoyé(s) vers Navidrome`,
        data: { pushed: successResults.map(r => ({ filePath: r.filePath, songId: r.songId, playlists: r.playlists })) }
      });
      persistProject();
    }

    const failures = results.filter(r => !r.success);
    res.json({
      success: failures.length === 0,
      pushed: results.filter(r => r.success).length,
      failed: failures.length,
      results
    });
  } catch (err) {
    res.status(500).json({ error: `Push Navidrome échoué : ${err.message}` });
  }
});

export default router;
