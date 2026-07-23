import fs from 'fs';
import path from 'path';
import { PROJECTS_DIR } from './config.js';

// Historique des renommages : chemin ACTUEL → nom d'origine (basename avant
// renommage). Après un renommage physique, l'ancien fichier n'existe plus sur
// disque — la seule façon d'afficher "avant → après" dans la Bibliothèque est
// de mémoriser le nom d'origine ici, persisté entre les redémarrages.
const STORE_PATH = path.join(PROJECTS_DIR, 'rename-history.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function save(map) {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(map, null, 2));
}

// Enregistre qu'un fichier a été renommé oldPath → newPath. On garde le nom
// d'origine LE PLUS ancien : si newPath avait déjà une entrée (renommé une
// première fois puis re-traité), l'ancien nom initial est préservé plutôt
// qu'écrasé par un nom intermédiaire.
export function recordRename(oldPath, newPath) {
  const map = load();
  const oldName = path.basename(oldPath);
  // Si oldPath était lui-même le résultat d'un renommage antérieur, remonte à
  // son nom d'origine ; sinon oldName est déjà l'original.
  const originalName = map[oldPath] || oldName;
  delete map[oldPath];
  map[newPath] = originalName;
  save(map);
}

// Nom d'origine d'un fichier (avant tout renommage Nemesis), ou null s'il n'a
// jamais été renommé.
export function originalNameFor(currentPath) {
  return load()[currentPath] || null;
}

// Table complète { chemin actuel → nom d'origine } — pour enrichir la liste
// bibliothèque en une seule lecture plutôt qu'un load() par morceau.
export function allRenames() {
  return load();
}
