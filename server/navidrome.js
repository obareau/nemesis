import path from 'path';
import { NAVIDROME_URL, SUBSONIC_PARAMS, NAVIDROME_LIBRARY_ROOT } from './config.js';
import { fuzzyMatch } from './analysis.js';
import { readTags } from './tagging.js';

export async function subsonicGet(endpoint, extraParams = '') {
  const url = `${NAVIDROME_URL}/rest/${endpoint}?${SUBSONIC_PARAMS}${extraParams}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data['subsonic-response']?.status !== 'ok') {
    const err = data['subsonic-response']?.error?.message || 'Erreur Subsonic inconnue';
    throw new Error(err);
  }
  return data['subsonic-response'];
}

export async function waitForScanCompletion(maxWaitMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const status = await subsonicGet('getScanStatus.view');
    if (!status.scanStatus?.scanning) return true;
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

// Cherche le morceau tout juste scanné dans Navidrome. Le `path` renvoyé par l'API
// Subsonic est un chemin VIRTUEL reconstruit depuis les tags (artist/album/title), pas
// le chemin disque réel — inutilisable pour matcher par nom de fichier. Et le nom de
// fichier lui-même peut diverger du titre ID3 réel (ex: exports Suno en leetspeak style
// "[3N_R0T4T10N].mp3" pour un titre "En Rotation") — recherche donc par titre ID3 en
// priorité, avec repli sur le nom de fichier si pas de tag titre exploitable.
export async function findSongIdForFile(filePath) {
  const fileName = path.basename(filePath);
  const stem = path.basename(fileName, path.extname(fileName));

  const tags = await readTags(filePath).catch(() => ({}));
  const title = tags.title?.trim();

  const queries = title && title !== stem ? [title, stem] : [stem];
  for (const query of queries) {
    const result = await subsonicGet('search3.view', `&query=${encodeURIComponent(query)}&songCount=5`);
    const songs = result.searchResult3?.song || [];
    const match = songs.find(s => s.title === query) || songs.find(s => s.title === stem) || songs[0];
    if (match?.id) return match.id;
  }
  return null;
}

export async function ensurePlaylistAndAddSong(moodName, songId) {
  const { playlists } = await subsonicGet('getPlaylists.view');
  const existing = (playlists?.playlist || []).find(
    p => p.name.toLowerCase() === moodName.toLowerCase()
  );

  if (existing) {
    await subsonicGet('updatePlaylist.view', `&playlistId=${existing.id}&songIdToAdd=${songId}`);
    return { playlist: existing.name, id: existing.id, created: false };
  } else {
    // createPlaylist.view crée en privé par défaut (propre à Navidrome, pas standard
    // Subsonic) — invisible pour tout autre compte (ex: Subwave, qui lit ces playlists
    // mood via sa propre connexion Navidrome). Rendu public juste après création.
    const created = await subsonicGet('createPlaylist.view', `&name=${encodeURIComponent(moodName)}&songId=${songId}`);
    const playlistId = created.playlist?.id;
    if (playlistId) {
      await subsonicGet('updatePlaylist.view', `&playlistId=${playlistId}&public=true`);
    }
    return { playlist: moodName, id: playlistId, created: true };
  }
}

// Vérifie si un morceau équivalent (nom proche, chemin différent) est déjà catalogué
// dans Navidrome — sert à détecter les doublons déjà présents avant tout ajout aux
// playlists mood, pour les router vers une playlist "Covers" de mise en attente.
export async function findExistingCatalogMatch(filePath, threshold = 75) {
  const fileName = path.basename(filePath);
  const baseName = path.basename(fileName, path.extname(fileName));
  // Le "titre coeur" est le dernier segment après " - " (auteur/titre ajoutés par Nemesis)
  const coreTitle = baseName.split(' - ').pop().trim();

  const result = await subsonicGet('search3.view', `&query=${encodeURIComponent(coreTitle)}&songCount=15`);
  const songs = result.searchResult3?.song || [];

  for (const song of songs) {
    if (!song.path) continue;
    const absolutePath = path.join(NAVIDROME_LIBRARY_ROOT, song.path);
    if (absolutePath === filePath) continue; // c'est notre propre fichier tout juste indexé

    const sim = fuzzyMatch(song.title || '', coreTitle);
    if (sim >= threshold) {
      return { songId: song.id, title: song.title, path: absolutePath, similarity: sim };
    }
  }

  return null;
}
