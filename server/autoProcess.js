import fs from 'fs';
import path from 'path';
import {
  analysisState, applyAudioFeatures, applyLyrics, applyTitle, applyGenre, applyRename,
  actionLog, persistProject
} from './store.js';
import { getCachedAnalysis, setCachedAnalysis } from './cache.js';
import { analyzeAudioFeatures, transcribeLyrics, analyzeGenre } from './analysis.js';
import { readTags, writeTags } from './tagging.js';
import { safeMoveSync } from './fsUtils.js';
import { findExistingAuthor, recordAuthor } from './title-authors.js';
import { recordRename } from './rename-history.js';
import { generateTitleFromLyrics, generateMoodFromSignals, generateAuthorForTrack } from './ollamaGen.js';
import { pushItemsToNavidrome } from './navidromePush.js';

// Style Discogs ("Electronic---Techno") → juste la partie style, plus lisible
// comme genre ID3/nom de playlist qu'un couple genre---style complet.
function shortGenreLabel(topStyle) {
  if (!topStyle?.label) return null;
  const parts = topStyle.label.split('---');
  return parts[parts.length - 1];
}

// Progression du traitement en masse — même pattern que pushProgress (un seul
// traitement actif à la fois, suivi par polling côté frontend).
export const autoProcessProgress = { active: false, done: 0, total: 0, currentFile: null, stage: null };

// Traite chaque fichier INDÉPENDAMMENT — contrairement à /api/navidrome/push
// qui applique le même mood à tout le lot (le cas d'un groupe de doublons
// déjà trié à la main), ici chaque fichier obtient SON titre et SES moods,
// puis est routé vers SA PROPRE playlist Navidrome. Pensé pour un lot de
// morceaux "inconnus" fraîchement importés, pas encore triés un par un.
//
// Par fichier : BPM/tonalité (cache ou analyse) → paroles (état, cache, ou
// transcription — non bloquant, un instrumental n'a simplement pas de
// paroles) → titre généré depuis les paroles (si présentes) → mood(s)
// générés depuis paroles+bpm/tonalité → style réel via Essentia (contenu
// audio, pas le nom de fichier) → artiste fictif (réutilisé si ce nom de
// fichier a déjà été vu ailleurs, sinon généré) → renommage physique
// "{artiste} - {titre}" + tags ID3 (artiste/titre/genre) → playlist(s)
// Navidrome (moods + le style comme playlist supplémentaire).
// Le push Navidrome se fait en UN SEUL appel groupé à la fin (un seul rescan
// bibliothèque pour tout le lot, pas un par fichier).
export async function autoProcessAndPush(filePaths) {
  Object.assign(autoProcessProgress, { active: true, done: 0, total: filePaths.length, currentFile: null, stage: 'analyze' });
  const processed = [];
  const pushItems = [];
  const renames = [];

  try {
    for (const originalPath of filePaths) {
      const originalName = path.basename(originalPath);
      autoProcessProgress.currentFile = originalName;
      const fileEntry = analysisState.files.find((f) => f.path === originalPath);
      let filePath = originalPath;

      // Clé de cache (path+size+mtime) : un fileEntry du projet Curation ouvert
      // si dispo, sinon reconstruite depuis le disque — permet d'appliquer tout
      // le pipeline à N'IMPORTE QUEL fichier (toute la bibliothèque Navidrome,
      // pas seulement les fichiers d'un projet Curation actuellement ouvert).
      // Les applyXxx(store.js) restent des no-op silencieux si le fichier n'est
      // pas dans analysisState — seul le cache SQLite (par path/size/mtime) sert
      // alors de mémoire d'une exécution à l'autre.
      let cacheRef = fileEntry;
      if (!cacheRef) {
        try {
          const stat = fs.statSync(filePath);
          cacheRef = { path: filePath, size: stat.size, mtime: stat.mtimeMs };
        } catch {
          cacheRef = null;
        }
      }

      try {
        // Snapshot des tags d'origine — nécessaire pour un éventuel undo du
        // renommage (même mécanisme générique que /api/rename-bulk).
        const oldTags = await readTags(filePath).catch(() => null);

        // BPM/tonalité — depuis l'état/cache, ou analysées si jamais fait.
        autoProcessProgress.stage = 'analyze';
        let bpm = fileEntry?.bpm, key = fileEntry?.key, scale = fileEntry?.scale;
        if (!bpm && cacheRef) {
          const cached = getCachedAnalysis(cacheRef);
          if (cached?.bpm) {
            ({ bpm, key, scale } = cached);
          } else {
            const result = await analyzeAudioFeatures(filePath);
            if (result) {
              setCachedAnalysis(cacheRef, result);
              ({ bpm, key, scale } = result);
            }
          }
          if (bpm) applyAudioFeatures(filePath, { bpm, key, scale });
        }

        // Paroles — depuis l'état/cache, ou transcrites si jamais fait. Non
        // bloquant : un échec (ou un instrumental sans paroles détectables)
        // laisse juste le titre et le mood retomber sur les autres signaux.
        autoProcessProgress.stage = 'lyrics';
        let lyrics = fileEntry?.lyrics || '';
        if (!lyrics && cacheRef) {
          const cached = getCachedAnalysis(cacheRef);
          if (cached?.lyrics) {
            lyrics = cached.lyrics;
            applyLyrics(filePath, lyrics);
          } else {
            try {
              // transcribeLyrics résout à null (jamais de rejet) en cas d'échec,
              // timeout, ou simplement aucune parole détectable (instrumental) —
              // toujours normaliser en chaîne vide, jamais laisser passer null.
              lyrics = (await transcribeLyrics(filePath)) || '';
              if (lyrics) {
                setCachedAnalysis(cacheRef, { lyrics });
                applyLyrics(filePath, lyrics);
              }
            } catch {
              lyrics = '';
            }
          }
        }

        // Titre — seulement s'il y a des paroles à résumer.
        autoProcessProgress.stage = 'title';
        let title = null;
        if (lyrics && lyrics.trim()) {
          try {
            title = await generateTitleFromLyrics(lyrics);
            applyTitle(filePath, title);
          } catch {
            title = null; // Ollama down ou réponse invalide — le fichier garde son titre existant
          }
        }

        // Mood(s) — paroles et/ou bpm/tonalité, au moins un signal requis.
        autoProcessProgress.stage = 'mood';
        const moods = await generateMoodFromSignals({ lyrics, bpm, key, scale });

        // Style réel (contenu audio) — Essentia/Discogs-Effnet, jamais déduit
        // du nom de fichier ou du BPM. Non bloquant : un échec laisse juste
        // le fichier sans genre ID3 ni playlist de style.
        autoProcessProgress.stage = 'genre';
        let genre = null;
        let styles = null;
        if (cacheRef) {
          const cached = getCachedAnalysis(cacheRef);
          styles = cached?.genre || null;
          if (!styles) {
            styles = await analyzeGenre(filePath);
            if (styles) setCachedAnalysis(cacheRef, { genre: styles });
          }
          genre = shortGenreLabel(styles?.[0]);
          if (genre) applyGenre(filePath, genre);
        }

        // Artiste fictif — réutilisé si ce nom de fichier a déjà été vu
        // ailleurs (title-authors.js), sinon généré et mémorisé AVANT le
        // renommage (sur le nom d'origine, comme /api/rename-bulk).
        autoProcessProgress.stage = 'author';
        let author = findExistingAuthor([originalName]);
        let authorReused = !!author;
        if (!author) {
          try {
            author = await generateAuthorForTrack([originalName], moods.join(', ') || genre || '');
            recordAuthor([originalName], author);
          } catch {
            author = null; // Ollama down — pas de renommage possible sans artiste
          }
        }

        // Tags ID3 (artiste/titre/genre) puis renommage physique
        // "{artiste} - {titre}" — même schéma que /api/rename-bulk (suffixe
        // numérique si collision), pour que Nemesis normalise vraiment le nom
        // de fichier au lieu de se contenter de tags sur un nom en leetspeak.
        autoProcessProgress.stage = 'rename';
        if (author) {
          const tags = { artist: author };
          if (title) tags.title = title;
          if (genre) tags.genre = genre;
          await writeTags(filePath, tags);

          const dir = path.dirname(filePath);
          const ext = path.extname(filePath);
          const prefix = title ? `${author} - ${title}` : author;
          let newName = `${prefix}${ext}`;
          let newPath = path.join(dir, newName);
          let n = 2;
          while (newPath !== filePath && fs.existsSync(newPath)) {
            newName = `${prefix} (${n})${ext}`;
            newPath = path.join(dir, newName);
            n++;
          }

          if (newPath !== filePath) {
            safeMoveSync(filePath, newPath);
            applyRename(filePath, newPath, newName);
            recordRename(filePath, newPath);
            renames.push({ oldPath: filePath, newPath, oldTags });

            // Le cache est clé par path+size+mtime — l'ancienne clé devient
            // orphelinée après le renommage (le fichier à cette clé n'existe
            // plus), donc /api/navidrome/library ne retrouverait plus ni le BPM
            // ni le style qu'on vient de calculer. Réécrit sous la NOUVELLE clé
            // avec ce qu'on a déjà en mémoire — pas besoin de tout ré-analyser.
            try {
              const newStat = fs.statSync(newPath);
              setCachedAnalysis(
                { path: newPath, size: newStat.size, mtime: newStat.mtimeMs },
                { bpm, key, scale, genre: styles, lyrics: lyrics || null }
              );
            } catch { /* pas bloquant — juste un cache de confort */ }

            filePath = newPath;
          }
        }

        const pushMoods = genre ? [...moods, genre] : moods;
        pushItems.push({ filePath, moods: pushMoods });
        processed.push({ file: originalName, filePath, success: true, title, author, authorReused, genre, moods });
      } catch (err) {
        processed.push({ file: originalName, filePath, success: false, error: err.message });
      } finally {
        autoProcessProgress.done++;
      }
    }

    if (renames.length > 0) {
      actionLog.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        type: 'rename',
        timestamp: new Date().toISOString(),
        description: `${renames.length} fichier(s) renommé(s) (traitement en masse)`,
        data: { renames }
      });
      persistProject();
    }

    autoProcessProgress.stage = 'push';
    const pushResult = pushItems.length > 0
      ? await pushItemsToNavidrome(pushItems)
      : { success: true, pushed: 0, failed: 0, results: [] };

    return { processed, push: pushResult };
  } finally {
    Object.assign(autoProcessProgress, { active: false, done: 0, total: 0, currentFile: null, stage: null });
  }
}
