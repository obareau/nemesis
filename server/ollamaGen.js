import { OLLAMA_URL, OLLAMA_MODEL, SHOW_MOODS } from './config.js';

// Factorise l'appel Ollama JSON brut — utilisé par generateTitleFromLyrics et
// generateMoodFromSignals, elles-mêmes partagées entre les endpoints single-
// file existants (/api/generate-title, /api/generate-mood) et le traitement
// en masse (navidromePush.autoProcessAndPush) pour ne pas dupliquer le prompt
// à deux endroits qui finiraient par diverger.
async function ollamaJson(prompt) {
  const response = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false, format: 'json' })
  });
  if (!response.ok) throw new Error(`Ollama a répondu ${response.status}`);
  return response.json();
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
