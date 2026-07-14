import { describe, it, expect } from 'vitest';
import { detectFolderWarning } from './routes/import.js';

describe('detectFolderWarning', () => {
  it('renvoie null sans historique', () => {
    expect(detectFolderWarning('Breakcore', ['a.mp3', 'b.mp3'], [])).toBeNull();
  });

  it('renvoie null si le nombre de fichiers diffère', () => {
    const history = [{ folderName: 'Breakcore', fileCount: 3, fileNames: ['a.mp3', 'b.mp3', 'c.mp3'], importedAt: '2026-07-14T10:00:00.000Z', destDir: '/dest' }];
    expect(detectFolderWarning('Breakcore', ['a.mp3', 'b.mp3'], history)).toBeNull();
  });

  it('"possible" si même nom et même nombre mais fichiers différents', () => {
    const history = [{ folderName: 'Breakcore', fileCount: 2, fileNames: ['x.mp3', 'y.mp3'], importedAt: '2026-07-14T10:00:00.000Z', destDir: '/dest' }];
    const result = detectFolderWarning('Breakcore', ['a.mp3', 'b.mp3'], history);
    expect(result).toEqual({ status: 'possible', importedAt: '2026-07-14T10:00:00.000Z', destDir: '/dest' });
  });

  it('"confirmed" si mêmes fichiers exacts (ordre indifférent)', () => {
    const history = [{ folderName: 'Breakcore', fileCount: 2, fileNames: ['b.mp3', 'a.mp3'], importedAt: '2026-07-14T10:00:00.000Z', destDir: '/dest' }];
    const result = detectFolderWarning('Breakcore', ['a.mp3', 'b.mp3'], history);
    expect(result).toEqual({ status: 'confirmed', importedAt: '2026-07-14T10:00:00.000Z', destDir: '/dest' });
  });

  it('prend le plus récent en cas de plusieurs imports "possible" du même dossier', () => {
    const history = [
      { folderName: 'Breakcore', fileCount: 2, fileNames: ['x.mp3', 'y.mp3'], importedAt: '2026-07-10T10:00:00.000Z', destDir: '/old' },
      { folderName: 'Breakcore', fileCount: 2, fileNames: ['p.mp3', 'q.mp3'], importedAt: '2026-07-14T10:00:00.000Z', destDir: '/new' }
    ];
    const result = detectFolderWarning('Breakcore', ['a.mp3', 'b.mp3'], history);
    expect(result).toEqual({ status: 'possible', importedAt: '2026-07-14T10:00:00.000Z', destDir: '/new' });
  });

  it('ignore les dossiers de nom différent', () => {
    const history = [{ folderName: 'Lounge', fileCount: 2, fileNames: ['a.mp3', 'b.mp3'], importedAt: '2026-07-14T10:00:00.000Z', destDir: '/dest' }];
    expect(detectFolderWarning('Breakcore', ['a.mp3', 'b.mp3'], history)).toBeNull();
  });
});
