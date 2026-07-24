import { SHOW_MOODS } from './config.js';

// Traduit les 56 tags mood/thème mtg_jamendo (tirés de l'AUDIO par analyze_genre.py)
// vers les 17 SHOW_MOODS de Subwave. Plusieurs tags peuvent pointer sur un même mood
// (leurs scores s'additionnent). Les tags "thème/usage" (film, christmas, corporate,
// advertising, documentary, game, movie, background, commercial, soundscape, trailer,
// children, holiday partiel...) sont volontairement absents : ce ne sont pas des
// ambiances audio. 'melodic' aussi est écarté (trop générique, il ressort partout).
const JAMENDO_TO_SHOW = {
  energetic: 'energetic', fast: 'energetic', upbeat: 'energetic', powerful: 'energetic', heavy: 'energetic', action: 'energetic', epic: 'energetic',
  calm: 'calm', relaxing: 'calm', soft: 'calm', slow: 'calm', ballad: 'calm',
  meditative: 'reflective', deep: 'reflective', emotional: 'reflective', melancholic: 'reflective', sad: 'reflective', drama: 'reflective', dramatic: 'reflective', dream: 'reflective',
  happy: 'celebratory', fun: 'celebratory', funny: 'celebratory', positive: 'celebratory', uplifting: 'celebratory', hopeful: 'celebratory',
  romantic: 'romantic', love: 'romantic', sexy: 'romantic',
  inspiring: 'spiritual',
  motivational: 'workout', sport: 'workout',
  groovy: 'driving', cool: 'driving', retro: 'driving',
  party: 'festival',
  dark: 'night', space: 'night',
  summer: 'sunny',
  adventure: 'cultural', travel: 'cultural', nature: 'cultural',
};

// moodTags : [{ label, score }] (tags Jamendo bruts, triés par score décroissant).
// Renvoie 1 à `max` SHOW_MOODS au-dessus du seuil, par score agrégé décroissant.
// Toujours au moins un mood si un tag mappe (le meilleur), sinon [] (l'appelant a
// son repli BPM).
export function mapAudioMoods(moodTags = [], { max = 3, threshold = 0.04 } = {}) {
  const agg = new Map();
  for (const { label, score } of moodTags) {
    const sm = JAMENDO_TO_SHOW[label];
    if (!sm) continue;
    agg.set(sm, (agg.get(sm) || 0) + (Number(score) || 0));
  }
  const ranked = [...agg.entries()].sort((a, b) => b[1] - a[1]);
  const kept = ranked.filter(([, v]) => v >= threshold).slice(0, max).map(([m]) => m);
  const result = kept.length ? kept : (ranked[0] ? [ranked[0][0]] : []);
  // Garde-fou : ne renvoyer que des moods réellement dans la taxonomie Subwave.
  return result.filter(m => SHOW_MOODS.includes(m));
}
