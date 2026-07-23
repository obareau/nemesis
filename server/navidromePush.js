import path from 'path';
import { COVERS_PLAYLIST_NAME } from './config.js';
import { actionLog, persistProject, applyNavidromePushed } from './store.js';
import {
  subsonicGet, waitForScanCompletion, findSongIdForFile,
  ensurePlaylistAndAddSong, findExistingCatalogMatch
} from './navidrome.js';

// Progression du push en cours — un seul push actif à la fois (single-user), suivi via
// polling côté frontend (pas de WebSocket ici, même pattern que le scan initial).
// Muté en place (Object.assign) pour que les routes qui l'importent voient toujours
// le même objet, jamais une réaffectation locale.
export const pushProgress = { active: false, done: 0, total: 0, currentFile: null, stage: null };

// Coeur du push Navidrome, partagé entre le push curation (/api/navidrome/push),
// l'onglet Import (/api/import/send) et le traitement en masse
// (autoProcess.autoProcessAndPush) : rescan bibliothèque → pour chaque item,
// retrouve le morceau par titre ID3, route les doublons déjà catalogués vers
// "Covers", sinon ajoute aux playlists mood DE CET ITEM (créées publiques au
// besoin). Journalise dans l'actionLog du projet actif (no-op sans projet :
// applyNavidromePushed ne trouve rien, persistProject sort sans dirPath).
//
// items: [{ filePath, moods }] — moods est propre à CHAQUE item, contrairement
// à l'ancienne signature (filePaths, moods) qui appliquait les mêmes moods à
// tout le lot (toujours valable pour un groupe de doublons déjà trié à la
// main — voir pushFilesToNavidrome ci-dessous, conservée telle quelle).
export async function pushItemsToNavidrome(items) {
  Object.assign(pushProgress, { active: true, done: 0, total: items.length, currentFile: null, stage: 'scan' });
  try {
    await subsonicGet('startScan.view');
    const scanned = await waitForScanCompletion();
    if (!scanned) {
      const e = new Error('Scan Navidrome trop long (timeout 30s)');
      e.code = 'SCAN_TIMEOUT';
      throw e;
    }

    pushProgress.stage = 'push';
    const results = [];
    for (const { filePath, moods } of items) {
      const fileName = path.basename(filePath);
      pushProgress.currentFile = fileName;
      try {
        const songId = await findSongIdForFile(filePath);
        if (!songId) {
          results.push({ file: fileName, success: false, error: 'Morceau introuvable dans Navidrome après scan' });
          continue;
        }

        // Vérifie qu'un morceau équivalent n'est pas déjà catalogué (auto-exclusion par songId)
        const existingMatch = await findExistingCatalogMatch(filePath, { selfSongId: songId });

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
      } finally {
        pushProgress.done++;
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
    return {
      success: failures.length === 0,
      pushed: results.filter(r => r.success).length,
      failed: failures.length,
      results
    };
  } finally {
    Object.assign(pushProgress, { active: false, done: 0, total: 0, currentFile: null, stage: null });
  }
}

// Conservée pour compat : un même mood partagé par tout le lot — le cas d'un
// groupe déjà trié à la main (Import, push curation).
export function pushFilesToNavidrome(filePaths, moods) {
  return pushItemsToNavidrome(filePaths.map((filePath) => ({ filePath, moods })));
}
