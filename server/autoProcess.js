import path from 'path';
import { analysisState, applyAudioFeatures, applyLyrics, applyTitle } from './store.js';
import { getCachedAnalysis, setCachedAnalysis } from './cache.js';
import { analyzeAudioFeatures, transcribeLyrics } from './analysis.js';
import { writeTags } from './tagging.js';
import { generateTitleFromLyrics, generateMoodFromSignals } from './ollamaGen.js';
import { pushItemsToNavidrome } from './navidromePush.js';

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
// paroles) → titre généré depuis les paroles (si présentes, tag écrit) →
// mood(s) générés depuis paroles+bpm/tonalité (au moins un signal requis).
// Le push Navidrome se fait en UN SEUL appel groupé à la fin (un seul rescan
// bibliothèque pour tout le lot, pas un par fichier).
export async function autoProcessAndPush(filePaths) {
  Object.assign(autoProcessProgress, { active: true, done: 0, total: filePaths.length, currentFile: null, stage: 'analyze' });
  const processed = [];
  const pushItems = [];

  try {
    for (const filePath of filePaths) {
      const fileName = path.basename(filePath);
      autoProcessProgress.currentFile = fileName;
      const fileEntry = analysisState.files.find((f) => f.path === filePath);

      try {
        // BPM/tonalité — depuis l'état/cache, ou analysées si jamais fait.
        autoProcessProgress.stage = 'analyze';
        let bpm = fileEntry?.bpm, key = fileEntry?.key, scale = fileEntry?.scale;
        if (!bpm && fileEntry) {
          const cached = getCachedAnalysis(fileEntry);
          if (cached?.bpm) {
            ({ bpm, key, scale } = cached);
          } else {
            const result = await analyzeAudioFeatures(filePath);
            if (result) {
              setCachedAnalysis(fileEntry, result);
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
        if (!lyrics && fileEntry) {
          const cached = getCachedAnalysis(fileEntry);
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
                setCachedAnalysis(fileEntry, { lyrics });
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
            await writeTags(filePath, { title });
            applyTitle(filePath, title);
          } catch {
            title = null; // Ollama down ou réponse invalide — le fichier garde son titre existant
          }
        }

        // Mood(s) — paroles et/ou bpm/tonalité, au moins un signal requis.
        autoProcessProgress.stage = 'mood';
        const moods = await generateMoodFromSignals({ lyrics, bpm, key, scale });

        pushItems.push({ filePath, moods });
        processed.push({ file: fileName, filePath, success: true, title, moods });
      } catch (err) {
        processed.push({ file: fileName, filePath, success: false, error: err.message });
      } finally {
        autoProcessProgress.done++;
      }
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
