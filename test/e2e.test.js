// Tests E2E : lance le vrai process `node server.js` (comme en prod), sur un
// dossier temporaire avec de vrais MP3 générés via ffmpeg — aucun mock de
// fpcalc/ffmpeg/sqlite. Vérifie le parcours complet scan → doublons →
// quarantaine/undo → renommage → cycle de projet, via de vraies requêtes HTTP.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const PORT = 5810;
const BASE = `http://localhost:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, '..');

let serverProcess;
let libDir, projectsDir, trashDir;

// Bruit rose plutôt qu'un ton pur : une sinusoïde constante produit une empreinte
// Chromaprint quasi vide (3 entiers) où n'importe quelle paire de tons se ressemble
// à >90% par hasard — le bruit avec seed distinct donne une empreinte riche (~19
// entiers) qui différencie vraiment les fichiers non-doublons.
function makeAudio(filePath, seed, duration = 5) {
  execFileSync('ffmpeg', [
    '-y', '-f', 'lavfi', '-i', `anoisesrc=d=${duration}:c=pink:r=44100:a=0.5:seed=${seed}`,
    '-c:a', 'libmp3lame', '-q:a', '4', filePath
  ], { stdio: 'ignore' });
}

async function waitForServer(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/api/status`);
      if (res.ok) return;
    } catch { /* pas encore prêt */ }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('Le serveur de test ne répond pas dans le délai imparti');
}

async function waitForScanCompletion(timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`${BASE}/api/status`);
    const data = await res.json();
    if (data.status === 'completed' || data.status === 'error') return data;
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('Le scan ne termine pas dans le délai imparti');
}

beforeAll(async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nemesis-e2e-'));
  libDir = path.join(tmpRoot, 'lib');
  projectsDir = path.join(tmpRoot, 'projects');
  trashDir = path.join(tmpRoot, 'trash');
  fs.mkdirSync(libDir, { recursive: true });

  // 3 morceaux distincts + une copie exacte du premier (doublon de taille/empreinte garanti)
  makeAudio(path.join(libDir, 'song_1.mp3'), 1);
  makeAudio(path.join(libDir, 'song_2.mp3'), 2);
  makeAudio(path.join(libDir, 'song_3.mp3'), 3);
  fs.copyFileSync(path.join(libDir, 'song_1.mp3'), path.join(libDir, 'song_1_copy.mp3'));

  serverProcess = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      PROJECTS_DIR: projectsDir,
      QUARANTINE_DIR: trashDir,
      CACHE_DB_PATH: path.join(projectsDir, 'cache.db'),
      NAVIDROME_PASS: 'unused'
    },
    stdio: 'ignore'
  });

  await waitForServer();
}, 30000);

afterAll(() => {
  serverProcess?.kill();
  const tmpRoot = path.dirname(libDir);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('parcours E2E complet', () => {
  it('GET /api/moods retourne les 17 moods canoniques', async () => {
    const res = await fetch(`${BASE}/api/moods`);
    const data = await res.json();
    expect(data.moods).toHaveLength(17);
    expect(data.moods).toContain('energetic');
  });

  it('GET /api/browse/shortcuts inclut au moins le raccourci Accueil', async () => {
    const res = await fetch(`${BASE}/api/browse/shortcuts`);
    const data = await res.json();
    expect(data.shortcuts.some(s => s.label === 'Accueil')).toBe(true);
  });

  it('POST /api/scan détecte les 4 fichiers et les groupes de doublons (taille/nom/empreinte)', async () => {
    // Étapes fingerprint (4 process fpcalc réels) — plus lent que le timeout par défaut de 5s
    const res = await fetch(`${BASE}/api/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dirPath: libDir, force: true })
    });
    expect(res.ok).toBe(true);

    const final = await waitForScanCompletion();
    expect(final.status).toBe('completed');
    expect(final.files).toHaveLength(4);

    const methods = final.duplicates.map(d => d.method).sort();
    expect(methods).toEqual(['fingerprint', 'name', 'size']);

    const fingerprintGroup = final.duplicates.find(d => d.method === 'fingerprint');
    expect(fingerprintGroup.files.map(f => f.name).sort()).toEqual(['song_1.mp3', 'song_1_copy.mp3']);
    expect(fingerprintGroup.similarity).toBeGreaterThanOrEqual(92);
  }, 25000);

  it('POST /api/rating persiste la note et la reflète dans /api/status', async () => {
    const filePath = path.join(libDir, 'song_2.mp3');
    const res = await fetch(`${BASE}/api/rating`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath, rating: 4 })
    });
    expect((await res.json()).success).toBe(true);

    const status = await (await fetch(`${BASE}/api/status`)).json();
    const file = status.files.find(f => f.path === filePath);
    expect(file.rating).toBe(4);
  });

  it('POST /api/quarantine déplace le fichier sur disque, /api/undo le restaure', async () => {
    const filePath = path.join(libDir, 'song_3.mp3');
    expect(fs.existsSync(filePath)).toBe(true);

    const qRes = await fetch(`${BASE}/api/quarantine`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePaths: [filePath] })
    });
    const qData = await qRes.json();
    expect(qData.quarantined).toBe(1);
    expect(fs.existsSync(filePath)).toBe(false);

    const items = await (await fetch(`${BASE}/api/quarantine`)).json();
    expect(items.items.some(i => i.originalPath === filePath)).toBe(true);

    const undoRes = await fetch(`${BASE}/api/undo`, { method: 'POST' });
    const undoData = await undoRes.json();
    expect(undoData.success).toBe(true);
    expect(undoData.undone.type).toBe('quarantine');
    expect(fs.existsSync(filePath)).toBe(true);

    const itemsAfter = await (await fetch(`${BASE}/api/quarantine`)).json();
    expect(itemsAfter.items).toHaveLength(0);
  });

  it('POST /api/rename-file renomme sur disque, /api/undo restaure le nom d\'origine', async () => {
    const filePath = path.join(libDir, 'song_2.mp3');
    const res = await fetch(`${BASE}/api/rename-file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath, newName: 'renamed-song' })
    });
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(fs.existsSync(data.newPath)).toBe(true);
    expect(fs.existsSync(filePath)).toBe(false);

    const undoRes = await fetch(`${BASE}/api/undo`, { method: 'POST' });
    const undoData = await undoRes.json();
    expect(undoData.undone.type).toBe('rename');
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.existsSync(data.newPath)).toBe(false);
  });

  it('POST /api/groups/skip marque le groupe comme traité (persisté dans /api/status)', async () => {
    const status = await (await fetch(`${BASE}/api/status`)).json();
    const sizeGroup = status.duplicates.find(d => d.method === 'size');

    const res = await fetch(`${BASE}/api/groups/skip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'size', filePaths: sizeGroup.files.map(f => f.path) })
    });
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.processedGroups.length).toBeGreaterThan(0);

    const statusAfter = await (await fetch(`${BASE}/api/status`)).json();
    expect(statusAfter.processedGroups).toEqual(data.processedGroups);
  });

  it('cycle projet : close => done, reopen => active', async () => {
    const closeRes = await fetch(`${BASE}/api/projects/close`, { method: 'POST' });
    expect((await closeRes.json()).success).toBe(true);

    const listAfterClose = await (await fetch(`${BASE}/api/projects`)).json();
    const project = listAfterClose.projects.find(p => p.dirPath === libDir);
    expect(project.status).toBe('done');

    const reopenRes = await fetch(`${BASE}/api/projects/reopen`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dirPath: libDir })
    });
    const reopenData = await reopenRes.json();
    expect(reopenData.resumed).toBe(true);

    const listAfterReopen = await (await fetch(`${BASE}/api/projects`)).json();
    expect(listAfterReopen.projects.find(p => p.dirPath === libDir).status).toBe('active');
  });
});
