import fs from 'fs';
import path from 'path';
import { PROJECTS_DIR } from './config.js';

// État partagé du projet actif en mémoire. Exporté en `let` : les modules
// important ces noms voient une liaison vivante (spec ES modules) — toute
// réaffectation faite ICI (via les setters ci-dessous) est immédiatement
// visible partout où ces noms sont importés, y compris dans des closures
// asynchrones (setTimeout de scan, etc.) déjà en cours d'exécution.
export let analysisState = {
  status: 'idle',
  currentFile: null,
  currentStage: null,
  fileProgress: 0,
  totalProgress: 0,
  files: [],
  duplicates: [],
  similarPairs: [],
  error: null,
  dirPath: null
};

// Compteur de génération : toute boucle de scan en arrière-plan (fingerprint/paroles)
// capture sa génération au démarrage et vérifie qu'elle est toujours la génération
// courante à chaque itération. Sans ça, "Terminer" ou un nouveau scan lancé pendant
// qu'un ancien tourne encore ne l'arrêtent jamais — il continue d'écrire dans
// analysisState (potentiellement celui d'un tout autre projet ensuite).
export let scanGeneration = 0;

export let processedGroups = []; // signatures de groupes traités/ignorés pour le projet courant
export let actionLog = [];       // historique des actions mutantes du projet courant, pour undo

export function setAnalysisState(next) { analysisState = next; }
export function bumpScanGeneration() { scanGeneration++; return scanGeneration; }
export function setProcessedGroups(next) { processedGroups = next; }
export function setActionLog(next) { actionLog = next; }

// --- Projets persistants ---
// Un dossier scanné = un projet de travail durable : reste actif entre les
// redémarrages du service et les rafraîchissements de page, tant qu'il n'est
// pas explicitement marqué "terminé". Toute action mutante (quarantaine,
// renommage, push Navidrome, groupe ignoré) est journalisée pour permettre
// un "annuler la dernière action" générique.
export function projectFileFor(dirPath) {
  const hash = Buffer.from(dirPath).toString('base64url');
  return path.join(PROJECTS_DIR, `${hash}.json`);
}

export function groupSignature(method, files) {
  return `${method}:${files.map(f => f.path).sort().join('|')}`;
}

export function persistProject() {
  if (!analysisState.dirPath) return;
  try {
    fs.mkdirSync(PROJECTS_DIR, { recursive: true });
    const existing = loadProjectRaw(analysisState.dirPath);
    const project = {
      dirPath: analysisState.dirPath,
      status: existing?.status || 'active',
      createdAt: existing?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      analysisState,
      processedGroups,
      actionLog
    };
    fs.writeFileSync(projectFileFor(analysisState.dirPath), JSON.stringify(project));
  } catch (err) {
    console.error('Erreur sauvegarde projet:', err.message);
  }
}

export function loadProjectRaw(dirPath) {
  try {
    return JSON.parse(fs.readFileSync(projectFileFor(dirPath), 'utf-8'));
  } catch {
    return null;
  }
}

export function listProjects() {
  try {
    fs.mkdirSync(PROJECTS_DIR, { recursive: true });
    return fs.readdirSync(PROJECTS_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try {
          const p = JSON.parse(fs.readFileSync(path.join(PROJECTS_DIR, f), 'utf-8'));
          return {
            dirPath: p.dirPath,
            status: p.status,
            updatedAt: p.updatedAt,
            filesCount: p.analysisState?.files?.length || 0,
            duplicatesCount: p.analysisState?.duplicates?.length || 0,
            actionCount: p.actionLog?.length || 0
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  } catch {
    return [];
  }
}

// Applique une mise à jour à un fichier partout où il apparaît dans l'état
// courant (liste principale, groupes de doublons, paires similaires) — après
// un rechargement JSON les objets ne sont plus des références partagées.
function applyToFile(filePath, mutate) {
  const apply = (f) => { if (f && f.path === filePath) mutate(f); };
  analysisState.files.forEach(apply);
  for (const dup of analysisState.duplicates) dup.files.forEach(apply);
  for (const pair of analysisState.similarPairs) { apply(pair.fileA); apply(pair.fileB); }
}

export function applyAudioFeatures(filePath, { bpm, key, scale }) {
  applyToFile(filePath, (f) => { f.bpm = bpm; f.key = key; f.scale = scale; });
}

export function applyNavidromePushed(filePath, pushedToNavidrome) {
  applyToFile(filePath, (f) => { f.pushedToNavidrome = pushedToNavidrome; });
}

export function applyLyrics(filePath, lyrics) {
  applyToFile(filePath, (f) => { f.lyrics = lyrics; });
}

export function applyBitrate(filePath, bitrate) {
  applyToFile(filePath, (f) => { f.bitrate = bitrate; });
}
