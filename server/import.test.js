import { describe, it, expect } from 'vitest';
import { datedFolderName } from './routes/import.js';

describe('datedFolderName', () => {
  it('suit la convention des dossiers existants (jj-mois-aaaa, mois FR abrégé sans point)', () => {
    expect(datedFolderName(new Date(2026, 6, 13))).toBe('13-juil-2026');
  });

  it('zéro-padde le jour', () => {
    expect(datedFolderName(new Date(2026, 6, 5))).toBe('05-juil-2026');
  });

  it('gère les mois accentués', () => {
    expect(datedFolderName(new Date(2026, 7, 1))).toBe('01-août-2026');
    expect(datedFolderName(new Date(2026, 11, 25))).toBe('25-déc-2026');
    expect(datedFolderName(new Date(2026, 1, 3))).toBe('03-févr-2026');
  });

  it('gère janvier (index 0)', () => {
    expect(datedFolderName(new Date(2026, 0, 2))).toBe('02-janv-2026');
  });
});
