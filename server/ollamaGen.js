import { OLLAMA_URL, OLLAMA_MODEL, SHOW_MOODS } from './config.js';

// Factorise l'appel Ollama JSON brut — utilisé par generateTitleFromLyrics et
// generateMoodFromSignals, elles-mêmes partagées entre les endpoints single-
// file existants (/api/generate-title, /api/generate-mood) et le traitement
// en masse (navidromePush.autoProcessAndPush) pour ne pas dupliquer le prompt
// à deux endroits qui finiraient par diverger.
async function ollamaJson(prompt, numPredict = 150) {
  const response = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // think:false coupe le raisonnement (kimi/qwen3.5 sont des modèles à "réflexion"
    // qui, sans ça, méditent 8-40s avant de répondre — cf. Subwave). num_predict borne
    // la génération : ces tâches sortent 1 ligne de JSON, inutile de laisser filer.
    body: JSON.stringify({
      model: OLLAMA_MODEL, prompt, stream: false, format: 'json',
      think: false, options: { num_predict: numPredict }
    })
  });
  if (!response.ok) throw new Error(`Ollama a répondu ${response.status}`);
  return response.json();
}

// Parse la réponse d'un modèle en tolérant un éventuel enrobage ```json ... ```
// (certains modèles l'ajoutent malgré format:"json").
function parseModelJson(raw) {
  const cleaned = String(raw || '').replace(/```json\s*|\s*```/g, '').trim();
  return JSON.parse(cleaned);
}

// Lignes qui reviennent le plus dans les paroles = le refrain/hook. Un bon titre
// de chanson en sort presque toujours. On compte les lignes normalisées (casse,
// ponctuation, espaces ignorés), on écarte les trop courtes (< 3 mots, souvent des
// interjections "oh oh oh") et on renvoie les plus fréquentes d'abord.
function recurringLines(lyrics) {
  const counts = new Map();
  const display = new Map();
  for (const raw of lyrics.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const key = line.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
    if (!key || key.split(' ').length < 3) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
    if (!display.has(key)) display.set(key, line);
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= 2)            // au moins 2 occurrences = ça revient
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([key]) => display.get(key));
}

export async function generateTitleFromLyrics(lyrics) {
  if (!lyrics || !lyrics.trim()) throw new Error('lyrics requis (aucune parole disponible pour ce fichier)');

  const hooks = recurringLines(lyrics);
  const hookBlock = hooks.length
    ? `Lignes qui REVIENNENT le plus souvent (c'est le refrain — la source idéale d'un titre) :
${hooks.map(h => `- "${h}"`).join('\n')}

`
    : '';

  const prompt = `Voici des paroles transcrites automatiquement (peut contenir des erreurs de reconnaissance vocale) :
"${lyrics.slice(0, 600)}"

${hookBlock}Trouve un titre de chanson court et évocateur de 2 à 4 mots MAXIMUM. Privilégie une formule tirée du refrain (les lignes qui reviennent le plus), pas un résumé descriptif. Sans ponctuation ni guillemets, sans explication.
Réponds uniquement au format JSON strict : {"title": "..."}`;

  const data = await ollamaJson(prompt);
  let title;
  try {
    title = JSON.parse(data.response).title;
  } catch {
    title = data.response.replace(/[{}"]/g, '').replace(/title:?/i, '').trim();
  }
  if (!title) throw new Error('Réponse Ollama vide ou invalide');
  return title.trim();
}

// Titre pour un morceau INSTRUMENTAL (pas de paroles) : on s'appuie sur le mood
// et le style détecté plutôt que sur un texte inexistant.
export async function generateTitleFromMoodStyle({ moods = [], style = '' }) {
  if (!moods.length && !style) throw new Error('mood ou style requis (aucun signal pour titrer cet instrumental)');

  const prompt = `Tu titres un morceau INSTRUMENTAL (sans paroles) pour une radio IA underground.
Ambiance/mood : ${moods.join(', ') || 'inconnu'}
Style musical : ${style || 'inconnu'}

Invente un titre court et évocateur de 2 à 4 mots MAXIMUM qui colle à cette ambiance et ce style. Sans ponctuation ni guillemets, sans explication.
Réponds uniquement au format JSON strict : {"title": "..."}`;

  const data = await ollamaJson(prompt);
  let title;
  try {
    title = JSON.parse(data.response).title;
  } catch {
    title = data.response.replace(/[{}"]/g, '').replace(/title:?/i, '').trim();
  }
  if (!title) throw new Error('Réponse Ollama vide ou invalide');
  return title.trim();
}

export async function generateAuthorForTrack(trackNames = [], mood = '', style = '') {
  const sample = trackNames.slice(0, 8).join(', ') || 'morceaux électroniques';
  const prompt = `Tu es un générateur de noms d'artistes fictifs pour une radio IA underground.
Ambiance/mood : ${mood || 'inconnu'}
Style musical : ${style || 'inconnu'}
Morceaux concernés : ${sample}

Génère UN SEUL nom d'artiste fictif, créatif et mystérieux, qui COLLE à cette ambiance et ce style, en 1 à 4 mots (pas de ponctuation superflue, pas d'explication).
Réponds uniquement au format JSON strict : {"author": "..."}`;

  const data = await ollamaJson(prompt);
  let author;
  try {
    author = JSON.parse(data.response).author;
  } catch {
    author = data.response.replace(/[{}"]/g, '').replace(/author:?/i, '').trim();
  }
  if (!author) throw new Error('Réponse Ollama vide ou invalide');
  return author.trim();
}

export async function generateMoodFromSignals({ lyrics = '', bpm, key, scale }) {
  if (!lyrics.trim() && !bpm) throw new Error('lyrics ou bpm/tonalité requis (aucun signal disponible pour ce fichier)');

  const signals = [];
  if (lyrics.trim()) signals.push(`Paroles (extrait, transcription automatique) : "${lyrics.slice(0, 400)}"`);
  if (bpm) signals.push(`BPM : ${bpm}${key ? ` · Tonalité : ${key}${scale === 'minor' ? 'm' : ''}` : ''}`);

  const prompt = `Tu choisis l'ambiance (mood) d'un morceau pour une radio IA, à partir des signaux suivants :
${signals.join('\n')}

Choisis entre 1 et 3 moods qui correspondent le mieux, EXCLUSIVEMENT parmi cette liste (recopie les mots exactement, en anglais, minuscules) :
${SHOW_MOODS.join(', ')}

Réponds uniquement au format JSON strict : {"moods": ["...", "..."]}`;

  const data = await ollamaJson(prompt);
  let rawMoods = [];
  try {
    rawMoods = JSON.parse(data.response).moods;
  } catch {
    rawMoods = SHOW_MOODS.filter(m => data.response.toLowerCase().includes(m));
  }
  if (!Array.isArray(rawMoods)) rawMoods = [];

  const validMoods = SHOW_MOODS.filter(m =>
    rawMoods.some(r => typeof r === 'string' && r.trim().toLowerCase() === m)
  ).slice(0, 3);

  if (validMoods.length === 0) throw new Error('Aucun mood valide dans la réponse Ollama');
  return validMoods;
}

// Un SEUL appel LLM pour titre + moods + artiste — remplace les 3 appels séparés
// du traitement en masse. ~50s → ~1,5s/fichier (les modèles cloud raisonnent et
// chaque round-trip coûtait 5-36s). Renvoie { title, moods, author } ; chaque
// champ peut être null/[] si le modèle n'a pas répondu proprement (non bloquant,
// l'appelant a ses propres replis). Style détecté et BPM passés en signaux ;
// le titre sort du refrain (lignes récurrentes) si paroles, sinon du mood+style.
export async function generateTrackMetadata({ lyrics = '', bpm, key, scale, style = '' }) {
  const hasLyrics = !!lyrics.trim();
  const hooks = hasLyrics ? recurringLines(lyrics) : [];

  const parts = [];
  if (hasLyrics) {
    parts.push(`Paroles (transcription auto, peut contenir des erreurs) : "${lyrics.slice(0, 500)}"`);
    if (hooks.length) parts.push(`Lignes qui REVIENNENT le plus (le refrain — source idéale du titre) :\n${hooks.map(h => `- "${h}"`).join('\n')}`);
  }
  if (bpm) parts.push(`BPM : ${bpm}${key ? ` · Tonalité : ${key}${scale === 'minor' ? 'm' : ''}` : ''}`);
  if (style) parts.push(`Style musical détecté : ${style}`);

  const titleRule = hasLyrics
    ? `un titre de chanson de 2 à 4 mots tiré du REFRAIN (les lignes qui reviennent), pas un résumé`
    : `un titre de 2 à 4 mots qui colle au mood et au style (morceau instrumental, sans paroles)`;

  const prompt = `Tu prépares les métadonnées d'un morceau pour une radio IA underground.
${parts.join('\n')}

Donne, en JSON strict et rien d'autre :
- "title" : ${titleRule}. Sans ponctuation ni guillemets.
- "moods" : 1 à 3 ambiances EXCLUSIVEMENT parmi cette liste (mots exacts, minuscules) : ${SHOW_MOODS.join(', ')}
- "author" : UN nom d'artiste fictif, créatif et mystérieux (1 à 4 mots), qui colle au mood et au style.

{"title": "...", "moods": ["..."], "author": "..."}`;

  const data = await ollamaJson(prompt, 200);
  let parsed;
  try {
    parsed = parseModelJson(data.response);
  } catch {
    return { title: null, moods: [], author: null };
  }

  const title = typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim() : null;
  const author = typeof parsed.author === 'string' && parsed.author.trim() ? parsed.author.trim() : null;
  const rawMoods = Array.isArray(parsed.moods) ? parsed.moods : [];
  const moods = SHOW_MOODS.filter(m =>
    rawMoods.some(r => typeof r === 'string' && r.trim().toLowerCase() === m)
  ).slice(0, 3);

  return { title, moods, author };
}
