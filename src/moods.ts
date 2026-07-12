// Couleur par mood — regroupées par famille d'énergie/caractère plutôt qu'arbitraire :
// rouge/orange = haute énergie, jaune/terracotta = chaud, bleu/vert = calme/posé,
// violet/indigo = introspectif/nocturne.
const MOOD_COLORS: Record<string, string> = {
  energetic: '#e63946',
  workout: '#f3722c',
  driving: '#f8961e',
  festival: '#f72585',
  celebratory: '#ffb703',
  sunny: '#ffd60a',
  morning: '#ffb4a2',
  cooking: '#e07a5f',
  cultural: '#2a9d8f',
  focus: '#457b9d',
  romantic: '#d81159',
  calm: '#8ecae6',
  reflective: '#6d6875',
  spiritual: '#7b2cbf',
  rainy: '#6c757d',
  night: '#22223b',
  evening: '#3a0ca3'
};

export function moodColor(mood: string): string {
  return MOOD_COLORS[mood] || '#888';
}
