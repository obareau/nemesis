import fs from 'fs';
import path from 'path';
import { PROJECTS_DIR } from './config.js';
import { normalizeTrackName } from './analysis.js';

// Associe un titre de morceau (normalisé — mêmes règles que la détection de
// doublons par nom) à l'artiste fictif déjà généré pour lui. Sert à garder le
// même artiste sur toutes les versions/occurrences d'un même titre — plus
// cohérent, et ça évite aussi que Subwave rejoue la "même chanson" sous un
// autre nom juste après une autre version, puisqu'il évite déjà de rejouer le
// même artiste à la suite.
const STORE_PATH = path.join(PROJECTS_DIR, 'title-authors.json');

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

// normalizeTrackName ne retire pas les suffixes "(2)"/"(3)" qu'ajoutent à la
// fois l'OS (téléchargements en double) et rename-bulk lui-même en cas de
// collision de nom — sans ça, "Song.mp3" et "Song (2).mp3" ne matchent pas
// alors que c'est exactement le cas qu'on veut attraper ici.
function canonicalTitleKey(name) {
  return normalizeTrackName(name).replace(/\s*\(\d+\)$/, '').trim();
}

// Cherche un auteur déjà attribué à l'un de ces noms de fichier.
export function findExistingAuthor(names) {
  const map = load();
  for (const name of names) {
    const key = canonicalTitleKey(name);
    if (key && map[key]) return map[key];
  }
  return null;
}

// Associe un auteur à TOUS ces noms (titre normalisé) — pour que toute future
// occurrence du même titre, même hors du groupe courant, retombe dessus.
export function recordAuthor(names, author) {
  if (!author) return;
  const map = load();
  for (const name of names) {
    const key = canonicalTitleKey(name);
    if (key) map[key] = author;
  }
  save(map);
}
