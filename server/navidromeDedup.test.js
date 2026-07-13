import { describe, it, expect } from 'vitest';
import { normalizeTitle } from './routes/navidromeDedup.js';

describe('normalizeTitle', () => {
  it('regroupe une variante "ok" sous la même clé', () => {
    expect(normalizeTitle('Static Horizon')).toBe(normalizeTitle('Static Horizon ok'));
  });

  it('retire le suffixe (Cover)', () => {
    expect(normalizeTitle('Chrome Candy Bruise (Cover)')).toBe(normalizeTitle('Chrome Candy Bruise'));
  });

  it('retire les suffixes (Extended ...)', () => {
    expect(normalizeTitle('VHS Drapeau Rouge (Extended Groove Cut)')).toBe(normalizeTitle('VHS Drapeau Rouge'));
  });

  it('ignore la ponctuation et la casse', () => {
    expect(normalizeTitle('Night Circuit!')).toBe(normalizeTitle('night circuit'));
  });

  it('ne confond pas deux titres réellement différents', () => {
    expect(normalizeTitle('Night Circuit')).not.toBe(normalizeTitle('Shatter Pulse'));
  });
});
