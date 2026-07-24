import fs from 'fs';
import path from 'path';
import {
  analysisState, applyAudioFeatures, applyLyrics, applyTitle, applyGenre, applyRename,
  actionLog, persistProject
} from './store.js';
import { getCachedAnalysis, setCachedAnalysis } from './cache.js';
import { analyzeAudioFeatures, transcribeLyrics, analyzeAudioContent, getFingerprint, fingerprintSimilarity } from './analysis.js';
import { mapAudioMoods } from './moodMap.js';
import { readTags, writeTags } from './tagging.js';
import { safeMoveSync } from './fsUtils.js';
import { findExistingAuthor, recordAuthor } from './title-authors.js';
import { recordRename } from './rename-history.js';
import { generateTrackMetadata } from './ollamaGen.js';
import { pushItemsToNavidrome } from './navidromePush.js';
import { NAVIDROME_LIBRARY_ROOT } from './config.js';

// Style Discogs ("Electronic---Techno") → juste la partie style, plus lisible
// comme genre ID3/nom de playlist qu'un couple genre---style complet.
function shortGenreLabel(topStyle) {
  if (!topStyle?.label) return null;
  const parts = topStyle.label.split('---');
  return parts[parts.length - 1];
}

// Repli quand le LLM ne donne pas de mood valide : une association déterministe
// au BPM, toujours dans la liste SHOW_MOODS. Vide seulement si le BPM est inconnu
// (morceau non analysable) — le fichier est quand même renommé et taggé.
function fallbackMood(bpm) {
  if (!bpm) return [];
  if (bpm >= 130) return ['energetic'];
  if (bpm >= 100) return ['driving'];
  if (bpm >= 76) return ['reflective'];
  return ['calm'];
}

// Clé de nom normalisée pour détecter les collisions "artiste - titre" — casse,
// espaces, ponctuation et suffixe (N) ignorés, comme le renommage.
function nameKey(author, title) {
  const s = `${author || ''} - ${title || ''}`.toLowerCase()
    .replace(/\s*\(\d+\)\s*$/, '')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ').trim();
  return s;
}

// Ensemble des noms "artiste - titre" DÉJÀ présents dans la bibliothèque (depuis
// les noms de fichier sur disque), pour que la génération évite de recréer un nom
// déjà pris (le LLM, sans mémoire, ressort sans cesse le même vocabulaire → plein
// de morceaux différents finissaient avec le même nom). Reconstruit à chaque run.
function buildUsedNames() {
  const used = new Set();
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && /\.(mp3|flac|wav|ogg)$/i.test(e.name)) {
        const base = e.name.replace(/\.[^.]+$/, '');
        const m = base.match(/^(.*?) - (.*)$/); // "Artiste - Titre"
        if (m) used.add(nameKey(m[1], m[2]));
        else used.add(nameKey('', base));
      }
    }
  };
  walk(NAVIDROME_LIBRARY_ROOT);
  return used;
}

// Progression du traitement en masse — même pattern que pushProgress (un seul
// traitement actif à la fois, suivi par polling côté frontend).
// recent = journal roulant des derniers fichiers traités (le plus récent en tête),
// pour une fenêtre de log en direct côté frontend SANS recharger toute la liste.
// pushed: null tant que le push Navidrome final n'a pas eu lieu, puis true/false.
export const autoProcessProgress = { active: false, done: 0, total: 0, currentFile: null, stage: null, recent: [] };
const RECENT_MAX = 8;

function logRecent(entry) {
  autoProcessProgress.recent.unshift(entry);
  autoProcessProgress.recent = autoProcessProgress.recent.slice(0, RECENT_MAX);
}

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
// Taille des paquets de push : on pousse vers Navidrome tous les PUSH_CHUNK
// fichiers renommés plutôt qu'en un seul bloc à la fin. Ainsi les morceaux passent
// au vert "Navidrome ✓" en direct, et un arrêt en cours de route n'annule pas le
// push des paquets déjà envoyés (résilience). Coût : un rescan Navidrome par
// paquet — mais incrémental, donc rapide.
const PUSH_CHUNK = 20;

export async function autoProcessAndPush(filePaths) {
  Object.assign(autoProcessProgress, { active: true, done: 0, total: filePaths.length, currentFile: null, stage: 'analyze', recent: [] });
  const processed = [];
  const renames = [];
  const allPushResults = [];
  let pushBatch = [];
  // Registre des morceaux déjà vus dans ce lot, par empreinte audio (Chromaprint) :
  // deux morceaux musicalement identiques ont une empreinte quasi identique, MÊME
  // avec des titres différents. Le premier vu est le canonique ; tout doublon
  // reprend son titre + artiste et part en Covers (Subwave ne le rejouera pas).
  const seenTracks = []; // [{ fingerprint, title, author }]
  const DUP_SIMILARITY = 92; // seuil Hamming (identique à la dédup Curation)
  // Noms "artiste - titre" déjà pris (bibliothèque actuelle + ceux générés dans ce
  // run) → anti-collision : deux morceaux DIFFÉRENTS ne doivent pas hériter du même
  // nom juste parce que le LLM ressort le même vocabulaire.
  const usedNames = buildUsedNames();

  // Pousse le paquet courant vers Navidrome, met à jour le statut des entrées
  // encore visibles dans le journal roulant (elles passent au vert), puis vide
  // le paquet. Non bloquant en cas d'échec Navidrome : les fichiers restent
  // renommés, seul le statut push le reflète.
  const flushPush = async () => {
    if (pushBatch.length === 0) return;
    autoProcessProgress.stage = 'push';
    let res;
    try {
      res = await pushItemsToNavidrome(pushBatch);
    } catch (err) {
      res = { results: pushBatch.map(it => ({ filePath: it.filePath, success: false, error: err.message })) };
    }
    allPushResults.push(...(res.results || []));
    const byName = new Map((res.results || []).map(r => [path.basename(r.filePath || r.file || ''), r]));
    for (const entry of autoProcessProgress.recent) {
      if (entry.newName && byName.has(entry.newName)) {
        const r = byName.get(entry.newName);
        entry.pushed = !!r.success;
        entry.alreadyInLibrary = !!r.alreadyInLibrary;
      }
    }
    pushBatch = [];
  };

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

        // Style réel (contenu audio) — Essentia/Discogs-Effnet, jamais déduit
        // du nom de fichier ou du BPM. Deux têtes (style + mood) sur le MÊME
        // embedding, calculé une fois. Non bloquant : un échec laisse le fichier
        // sans style et retombe sur le mood BPM.
        autoProcessProgress.stage = 'genre';
        let genre = null;
        let styles = null;
        let audioMoodTags = [];
        if (cacheRef) {
          const cached = getCachedAnalysis(cacheRef);
          // Le cache 'genre' contient soit { styles, moods } (nouveau), soit un
          // tableau de styles nu (ancien format) — on normalise les deux.
          let audio = cached?.genre || null;
          if (audio && Array.isArray(audio)) audio = { styles: audio, moods: [] };
          if (!audio || !audio.styles) {
            audio = await analyzeAudioContent(filePath);
            if (audio) setCachedAnalysis(cacheRef, { genre: audio });
          }
          styles = audio?.styles || null;
          audioMoodTags = audio?.moods || [];
          genre = shortGenreLabel(styles?.[0]);
          if (genre) applyGenre(filePath, genre);
        }

        // Empreinte audio (Chromaprint) — pour détecter les DOUBLONS MUSICAUX
        // (même son, titre différent), que la détection par titre ne voit pas.
        // Depuis le cache si dispo, sinon calculée (~1s) et mise en cache.
        autoProcessProgress.stage = 'fingerprint';
        let fingerprint = null;
        if (cacheRef) {
          const cached = getCachedAnalysis(cacheRef);
          fingerprint = cached?.fingerprint || null;
          if (!fingerprint) {
            fingerprint = await getFingerprint(filePath);
            if (fingerprint) setCachedAnalysis(cacheRef, { fingerprint });
          }
        }

        // Ce morceau est-il un doublon musical d'un morceau déjà traité dans ce
        // lot ? Si oui, il reprend le titre + l'artiste du canonique (au lieu d'un
        // nom aléatoire différent) et ira en Covers uniquement (Subwave ne le
        // rejouera pas). Comparaison par distance de Hamming sur l'empreinte.
        let dupOf = null;
        if (fingerprint) {
          for (const seen of seenTracks) {
            if (fingerprintSimilarity(fingerprint, seen.fingerprint) >= DUP_SIMILARITY) { dupOf = seen; break; }
          }
        }

        // Mood dérivé de l'AUDIO (classifieur mtg_jamendo mappé sur les SHOW_MOODS),
        // pas deviné par le LLM. Repli déterministe sur le BPM si l'audio n'a rien
        // donné d'exploitable (sinon Subwave ne piochera le morceau dans aucune
        // playlist mood).
        const audioMoods = mapAudioMoods(audioMoodTags);
        const moods = audioMoods.length ? audioMoods : fallbackMood(bpm);

        // Titre + artiste. Doublon musical → on reprend ceux du canonique, pas
        // d'appel LLM. Sinon UN SEUL appel LLM (le mood vient de l'audio, plus du
        // LLM) ; le style et les moods détectés lui servent de contexte.
        let title, author, authorReused;
        if (dupOf) {
          title = dupOf.title;
          author = dupOf.author;
          authorReused = true;
        } else {
          autoProcessProgress.stage = 'metadata';
          // Artiste réutilisé si ce nom de fichier d'origine a déjà été vu ailleurs
          // (title-authors.js — deux versions d'un même titre → même artiste).
          const reusedAuthor = findExistingAuthor([originalName]);
          authorReused = !!reusedAuthor;

          // Génération avec ANTI-COLLISION : si le "artiste - titre" produit est
          // déjà pris (par la bibliothèque ou un fichier déjà traité dans ce run),
          // on régénère en donnant au LLM les noms à éviter + plus de température.
          // Jusqu'à 4 tentatives, puis on laisse le suffixe (N) trancher.
          let meta = { title: null, author: null };
          const avoid = [];
          for (let attempt = 0; attempt < 4; attempt++) {
            try {
              meta = await generateTrackMetadata({
                lyrics, bpm, key, scale, style: genre || '', moods,
                avoid, temperature: attempt === 0 ? 0.8 : 1.1
              });
            } catch { break; /* Ollama down — replis ci-dessous */ }
            const candAuthor = reusedAuthor || meta.author;
            if (!meta.title || !candAuthor) break; // rien à vérifier
            const k = nameKey(candAuthor, meta.title);
            if (!usedNames.has(k)) break; // nom libre → on le garde
            avoid.push(`${candAuthor} - ${meta.title}`); // collision → régénère en l'évitant
          }

          title = meta.title;
          author = reusedAuthor || meta.author;
          if (!authorReused && author) recordAuthor([originalName], author);

          // Réserve le nom pour que les fichiers suivants du run ne le reprennent pas.
          if (author && title) usedNames.add(nameKey(author, title));
          // Premier exemplaire de cette empreinte → il devient le canonique.
          if (fingerprint && title && author) {
            seenTracks.push({ fingerprint, title, author });
          }
        }
        if (title) applyTitle(filePath, title);

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
                { bpm, key, scale, genre: { styles, moods: audioMoodTags }, lyrics: lyrics || null }
              );
            } catch { /* pas bloquant — juste un cache de confort */ }

            filePath = newPath;
          }
        }

        // Doublon musical → Covers uniquement (coversOnly), pas les playlists mood :
        // Subwave ne rejouera pas deux fois le même enregistrement. Le canonique, lui,
        // va dans ses playlists mood normalement.
        const pushMoods = genre ? [...moods, genre] : moods;
        pushBatch.push({ filePath, moods: pushMoods, coversOnly: !!dupOf });
        processed.push({ file: originalName, filePath, success: true, title, author, authorReused, genre, moods, duplicate: !!dupOf });
        logRecent({ oldName: originalName, newName: path.basename(filePath), genre, moods, success: true, pushed: null, duplicate: !!dupOf });
      } catch (err) {
        processed.push({ file: originalName, filePath, success: false, error: err.message });
        logRecent({ oldName: originalName, newName: null, success: false, error: err.message, pushed: false });
      } finally {
        autoProcessProgress.done++;
      }

      // Push par paquets : dès que PUSH_CHUNK fichiers sont prêts, on les envoie
      // (les entrées correspondantes du journal passent au vert), puis on continue.
      if (pushBatch.length >= PUSH_CHUNK) await flushPush();
    }

    // Dernier paquet (< PUSH_CHUNK) — les derniers fichiers passent au vert.
    await flushPush();

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

    const pushedCount = allPushResults.filter(r => r.success).length;
    const pushResult = {
      success: allPushResults.every(r => r.success),
      pushed: pushedCount,
      failed: allPushResults.length - pushedCount,
      results: allPushResults
    };
    return { processed, push: pushResult };
  } finally {
    // On garde `recent` intact après la fin : la fenêtre de log reste lisible
    // une fois le traitement terminé, jusqu'au prochain lancement.
    Object.assign(autoProcessProgress, { active: false, done: 0, total: 0, currentFile: null, stage: null });
  }
}
