import type { File } from './api';

export function formatTime(secs: number): string {
  if (!isFinite(secs) || secs < 0) return '0:00';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString('fr-FR', {
    day: '2-digit', month: '2-digit', year: 'numeric'
  });
}

// 'unknown' = étape Paroles jamais passée sur ce fichier (pas candidat doublon),
// 'instrumental' = transcription vide/trop courte, 'lyrics' = texte réel détecté
export function getLyricsState(file: File): 'unknown' | 'instrumental' | 'lyrics' {
  if (file.lyrics == null) return 'unknown';
  return file.lyrics.trim().length < 8 ? 'instrumental' : 'lyrics';
}
