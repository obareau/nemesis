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

export async function generateTitleFromLyrics(lyrics) {
  if (!lyrics || !lyrics.trim()) throw new Error('lyrics requis (aucune parole disponible pour ce fichier)');

  const prompt = `Voici un extrait de paroles transcrites automatiquement (peut contenir des erreurs de reconnaissance vocale) :
"${lyrics.slice(0, 500)}"

Résume cet extrait en un titre court et évocateur de 3 à 4 mots MAXIMUM, sans ponctuation ni guillemets, sans explication.
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
