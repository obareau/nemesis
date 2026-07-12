import { describe, it, expect } from 'vitest';
import {
  levenshtein, normalizeTrackName, fuzzyMatch, analyzeBySize, analyzeByName,
  lyricsSimilarity, analyzeByLyrics, fingerprintSimilarity, analyzeByFingerprint
} from './analysis.js';

describe('levenshtein', () => {
  it('vaut 0 pour deux chaînes identiques', () => {
    expect(levenshtein('abc', 'abc')).toBe(0);
  });

  it('vaut la longueur de l\'autre pour une chaîne vide', () => {
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('abc', '')).toBe(3);
  });

  it('compte les substitutions/insertions/suppressions', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
  });
});

describe('normalizeTrackName', () => {
  it('retire extension, numéro de piste et normalise les séparateurs', () => {
    expect(normalizeTrackName('01 - Track_Name.mp3')).toBe('track name');
    expect(normalizeTrackName('Track.Name.mp3')).toBe('track name');
  });
});

describe('fuzzyMatch', () => {
  it('vaut 100 pour deux noms strictement identiques après normalisation', () => {
    expect(fuzzyMatch('01 - Song.mp3', 'Song.mp3')).toBe(100);
  });

  it('vaut 0 si une des deux chaînes est vide après normalisation', () => {
    expect(fuzzyMatch('.mp3', 'Song.mp3')).toBe(0);
  });

  it('donne un score élevé mais pas 100 pour un nom légèrement différent', () => {
    const sim = fuzzyMatch('My Track.mp3', 'My Trak.mp3');
    expect(sim).toBeGreaterThan(50);
    expect(sim).toBeLessThan(100);
  });
});

describe('analyzeBySize', () => {
  it('regroupe uniquement les fichiers de taille strictement identique', () => {
    const files = [
      { path: 'a', size: 100 },
      { path: 'b', size: 100 },
      { path: 'c', size: 200 }
    ];
    const groups = analyzeBySize(files);
    expect(groups).toHaveLength(1);
    expect(groups[0].method).toBe('size');
    expect(groups[0].files.map(f => f.path).sort()).toEqual(['a', 'b']);
  });

  it('ignore les tailles uniques (pas de doublon)', () => {
    const files = [{ path: 'a', size: 100 }, { path: 'b', size: 200 }];
    expect(analyzeBySize(files)).toHaveLength(0);
  });
});

describe('analyzeByName', () => {
  it('regroupe par transitivité (A~B, B~C >= seuil, mais A~C < seuil)', () => {
    // Vérifié : Song~Song1 = 80, Song1~Sang1 = 80, Song~Sang1 = 60 (< 75) —
    // A et C ne se rejoignent que via B, un vrai test de la transitivité union-find.
    const files = [
      { path: 'a', name: 'Song.mp3' },
      { path: 'b', name: 'Song1.mp3' },
      { path: 'c', name: 'Sang1.mp3' },
      { path: 'd', name: 'Complètement Différent.mp3' }
    ];
    const { groups } = analyzeByName(files);
    expect(groups).toHaveLength(1);
    expect(groups[0].files.map(f => f.path).sort()).toEqual(['a', 'b', 'c']);
  });

  it('capture les paires même sous le seuil de clustering, dans allPairs', () => {
    const files = [
      { path: 'a', name: 'Song.mp3' },
      { path: 'b', name: 'Totally Unrelated Name.mp3' }
    ];
    const { groups, allPairs } = analyzeByName(files, { clusterThreshold: 99, recordFloor: 0 });
    expect(groups).toHaveLength(0);
    expect(allPairs).toHaveLength(1);
  });
});

describe('lyricsSimilarity', () => {
  it('vaut 100 pour des paroles identiques', () => {
    expect(lyricsSimilarity('hello world foo', 'hello world foo')).toBe(100);
  });

  it('vaut 0 si aucun mot en commun', () => {
    expect(lyricsSimilarity('hello world', 'foo bar')).toBe(0);
  });

  it('calcule un ratio de Jaccard entre les deux', () => {
    // {hello, world} ∩ {hello, foo} = {hello} ; union = {hello, world, foo} => 1/3 ≈ 33%
    expect(lyricsSimilarity('hello world', 'hello foo')).toBe(33);
  });
});

describe('analyzeByLyrics', () => {
  it('ignore les fichiers sans paroles transcrites', () => {
    const files = [
      { path: 'a', lyrics: 'same lyrics here' },
      { path: 'b', lyrics: '' },
      { path: 'c', lyrics: null }
    ];
    const { groups } = analyzeByLyrics(files);
    expect(groups).toHaveLength(0); // un seul fichier avec paroles => pas de groupe
  });

  it('regroupe les fichiers aux paroles similaires', () => {
    const files = [
      { path: 'a', lyrics: 'un deux trois quatre cinq' },
      { path: 'b', lyrics: 'un deux trois quatre six' }
    ];
    const { groups } = analyzeByLyrics(files, { clusterThreshold: 50 });
    expect(groups).toHaveLength(1);
    expect(groups[0].files.map(f => f.path).sort()).toEqual(['a', 'b']);
  });
});

describe('fingerprintSimilarity', () => {
  it('vaut 100 pour deux empreintes identiques', () => {
    expect(fingerprintSimilarity('1,2,3', '1,2,3')).toBe(100);
  });

  it('baisse quand les bits divergent', () => {
    const sim = fingerprintSimilarity('0,0,0', '15,15,15');
    expect(sim).toBeLessThan(100);
    expect(sim).toBeGreaterThanOrEqual(0);
  });
});

describe('analyzeByFingerprint', () => {
  it('ignore les fichiers sans empreinte', () => {
    const files = [
      { path: 'a', fingerprint: '1,2,3' },
      { path: 'b' }
    ];
    const { groups } = analyzeByFingerprint(files);
    expect(groups).toHaveLength(0);
  });

  it('regroupe les empreintes quasi identiques', () => {
    const files = [
      { path: 'a', fingerprint: '1,2,3,4,5' },
      { path: 'b', fingerprint: '1,2,3,4,5' },
      { path: 'c', fingerprint: '999999,888888,777777,666666,555555' }
    ];
    const { groups } = analyzeByFingerprint(files);
    expect(groups).toHaveLength(1);
    expect(groups[0].files.map(f => f.path).sort()).toEqual(['a', 'b']);
  });
});
