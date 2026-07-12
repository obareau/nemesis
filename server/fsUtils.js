import fs from 'fs';

// Déplace un fichier même entre systèmes de fichiers différents (clé USB, réseau,
// /tmp...). fs.renameSync échoue avec EXDEV dans ce cas — fallback copie+suppression.
export function safeMoveSync(src, dest) {
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.copyFileSync(src, dest);
    fs.unlinkSync(src);
  }
}
