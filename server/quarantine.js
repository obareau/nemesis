import fs from 'fs';
import path from 'path';
import { QUARANTINE_DIR } from './config.js';
import { analysisState, actionLog, persistProject } from './store.js';
import { safeMoveSync } from './fsUtils.js';
import { readQuarantineManifest, writeQuarantineManifest } from './quarantineFs.js';

// Met en quarantaine (déplace, ne supprime jamais) les fichiers donnés — réutilisable en
// dehors du projet actif (ex: dédup bibliothèque Navidrome) puisqu'elle ne fait rien de plus
// que chercher un snapshot optionnel dans analysisState.files (no-op silencieux si absent).
export function quarantineFiles(filePaths) {
  fs.mkdirSync(QUARANTINE_DIR, { recursive: true });

  const manifest = readQuarantineManifest();
  const results = [];
  const moves = [];
  const fileSnapshots = [];

  for (const filePath of filePaths) {
    try {
      const fileEntry = analysisState.files.find(f => f.path === filePath);
      if (fileEntry) fileSnapshots.push({ ...fileEntry });

      const base = path.basename(filePath);
      let quarantineName = base;
      let counter = 1;
      while (fs.existsSync(path.join(QUARANTINE_DIR, quarantineName))) {
        const ext = path.extname(base);
        quarantineName = `${path.basename(base, ext)} (${counter})${ext}`;
        counter++;
      }

      const quarantinePath = path.join(QUARANTINE_DIR, quarantineName);
      safeMoveSync(filePath, quarantinePath);
      manifest[quarantineName] = filePath;
      moves.push({ quarantineName, originalPath: filePath });

      // Retire le fichier de l'état en mémoire (il n'est plus scanné dans le dossier d'origine)
      analysisState.files = analysisState.files.filter(f => f.path !== filePath);
      for (const dup of analysisState.duplicates) {
        dup.files = dup.files.filter(f => f.path !== filePath);
      }
      analysisState.duplicates = analysisState.duplicates.filter(d => d.files.length > 1);

      results.push({ success: true, oldPath: filePath, quarantinePath });
    } catch (err) {
      results.push({ success: false, oldPath: filePath, error: err.message });
    }
  }

  writeQuarantineManifest(manifest);

  if (moves.length > 0) {
    actionLog.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: 'quarantine',
      timestamp: new Date().toISOString(),
      description: `${moves.length} fichier(s) mis en quarantaine`,
      data: { moves, fileSnapshots }
    });
    persistProject();
  }

  const failures = results.filter(r => !r.success);
  return {
    success: failures.length === 0,
    quarantined: results.filter(r => r.success).length,
    failed: failures.length,
    results
  };
}
