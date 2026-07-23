// Couche API : un point d'entrée par endpoint backend, pour ne pas disperser
// les 40+ appels fetch() dans les composants. Chaque fonction retourne la
// Response brute (pas de .json() ni de gestion d'erreur) — les appelants
// gardent leur logique actuelle de parsing/erreur inchangée.

export interface File {
  path: string;
  name: string;
  size: number;
  mtime: number;
  bitrate?: number; // bits/sec (ffprobe format=bit_rate), pas encore extrait tant que l'étape "bitrate" du scan n'est pas passée
  fingerprint?: string;
  lyrics?: string;
  title?: string;
  rating?: number;
  bpm?: number;
  key?: string;
  scale?: string;
  pushedToNavidrome?: boolean;
  genre?: string; // style réel détecté par le classifieur audio Essentia (Discogs 400 classes), pas déduit du mood
  moods?: string[];
  playCount?: number;
}

export interface MoodTrack {
  songId: string;
  title: string;
  artist?: string;
  path: string | null;
  knownLocally: boolean;
  rating?: number;
  bpm?: number;
}

export interface WaveformDiff {
  totalWidth: number;
  height: number;
  a: { image: string; width: number; duration: number };
  b: { image: string; width: number; duration: number };
}

export type AnalysisMethod = 'size' | 'name' | 'fingerprint' | 'lyrics';

export interface Duplicate {
  method: AnalysisMethod;
  files: File[];
  similarity?: number;
}

export interface SimilarPair {
  method: AnalysisMethod;
  similarity: number;
  fileA: File;
  fileB: File;
}

export interface ActionLogEntry {
  id: string;
  type: string;
  description: string;
  timestamp: string;
}

export interface AnalysisState {
  status: 'idle' | 'scanning' | 'completed' | 'error';
  currentFile: string | null;
  currentStage: string | null;
  fileProgress: number;
  totalProgress: number;
  files: File[];
  duplicates: Duplicate[];
  similarPairs: SimilarPair[];
  error: string | null;
  dirPath?: string | null;
  processedGroups?: string[];
  actionCount?: number;
  actionLog?: ActionLogEntry[];
  resumed?: boolean;
}

export interface ProjectSummary {
  dirPath: string;
  status: 'active' | 'done';
  updatedAt: string;
  filesCount: number;
  duplicatesCount: number;
  actionCount: number;
}

export interface Shortcut {
  label: string;
  group: 'local' | 'removable' | 'network' | 'mount';
  path: string;
  detail?: string;
}

export interface QuarantineItem {
  quarantineName: string;
  originalPath: string;
  size: number;
}

// Fichier en attente dans la boîte de dépôt (onglet Import)
export interface InboxFile {
  path: string;
  name: string;
  size: number;
  mtime: number;
  relPath: string; // sous-dossier relatif dans l'inbox ('' si à la racine)
}

// Dossier de l'inbox qui ressemble à un import déjà envoyé — "confirmed" si les noms de
// fichiers correspondent exactement à un envoi précédent, "possible" si seul le nombre coïncide.
export interface FolderWarning {
  folderName: string;
  fileCount: number;
  status: 'confirmed' | 'possible';
  importedAt: string;
  destDir: string;
}

export const API = '/api';

// Encode un chemin de fichier en base64url (compatible UTF-8) pour l'URL de streaming —
// doit rester en miroir de Buffer.from(str, 'utf-8').toString('base64url') côté serveur.
export function toBase64Url(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  bytes.forEach(b => { binary += String.fromCharCode(b); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function postJson(path: string, body: unknown) {
  return fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

export function getMoods() {
  return fetch(`${API}/moods`);
}

export function getQuarantineItems() {
  return fetch(`${API}/quarantine`);
}

export function getStatus() {
  return fetch(`${API}/status`);
}

export function getProjects() {
  return fetch(`${API}/projects`);
}

export function deleteProject(dirPath: string) {
  return fetch(`${API}/projects`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dirPath })
  });
}

export function scan(dirPath: string, force?: boolean) {
  return postJson('/scan', { dirPath, force });
}

export function reopenProject(dirPath: string) {
  return postJson('/projects/reopen', { dirPath });
}

export function closeProject() {
  return fetch(`${API}/projects/close`, { method: 'POST' });
}

export function undo() {
  return fetch(`${API}/undo`, { method: 'POST' });
}

// Retourne l'URL directe (pas un fetch) — le navigateur gère le téléchargement
// nativement via le Content-Disposition renvoyé par le serveur.
export function exportActionLogUrl(format: 'json' | 'csv'): string {
  return `${API}/export/action-log?format=${format}`;
}

export function getWaveform(filePath: string) {
  return fetch(`${API}/waveform/${toBase64Url(filePath)}`);
}

export function incrementPlayCount(filePath: string) {
  return postJson('/play-count', { filePath });
}

export function getWaveformDiff(pathA: string, pathB: string) {
  return fetch(`${API}/waveform-diff?pathA=${encodeURIComponent(pathA)}&pathB=${encodeURIComponent(pathB)}`);
}

export function getNavidromeMood(mood: string) {
  return fetch(`${API}/navidrome/mood/${encodeURIComponent(mood)}`);
}

export function tagMood(filePaths: string[], mood: string, action: 'add' | 'remove') {
  return postJson('/tag-mood', { filePaths, mood, action });
}

export function renameBulk(filePaths: string[], author: string, title: string, moods: string[]) {
  return postJson('/rename-bulk', { filePaths, author, title, moods });
}

export function generateAuthor(trackNames: string[], mood: string) {
  return postJson('/generate-author', { trackNames, mood });
}

export function generateTitle(lyrics: string) {
  return postJson('/generate-title', { lyrics });
}

export function generateMood(lyrics: string, bpm?: number, key?: string, scale?: string) {
  return postJson('/generate-mood', { lyrics, bpm, key, scale });
}

export function navidromePush(filePaths: string[], moods: string[]) {
  return postJson('/navidrome/push', { filePaths, moods });
}

export function getNavidromePushProgress() {
  return fetch(`${API}/navidrome/push-progress`);
}

// Traitement en masse : contrairement à navidromePush (mêmes moods pour tout
// le lot), chaque fichier obtient son propre titre (paroles) et ses propres
// moods (paroles + bpm/tonalité), puis sa propre playlist Navidrome.
export function autoPushBatch(filePaths: string[]) {
  return postJson('/navidrome/auto-push', { filePaths });
}

export function getAutoPushProgress() {
  return fetch(`${API}/navidrome/auto-push-progress`);
}

export function getImportInbox() {
  return fetch(`${API}/import/inbox`);
}

export function importAnalyze(filePath: string) {
  return postJson('/import/analyze', { filePath });
}

// Moods par fichier — chaque morceau garde sa propre suggestion plutôt qu'un mood
// unique forcé sur tout le lot envoyé.
export function importSend(files: { path: string; moods: string[] }[]) {
  return postJson('/import/send', { files });
}

// URL directe (pas un fetch) — passée telle quelle à l'élément <audio> de pré-écoute
export function importStreamUrl(filePath: string): string {
  return `${API}/import/stream/${toBase64Url(filePath)}`;
}

export interface DedupFile {
  id: string;
  title: string;
  artist?: string;
  relPath: string;
  path: string;
  size: number;
  bitRate: number;
  playlists: { id: string; name: string }[];
}

export interface DedupGroup {
  title: string;
  similarity: number;
  files: DedupFile[];
}

export interface DedupScanState {
  active: boolean;
  stage: 'catalog' | 'titles' | 'fingerprint' | 'confirm' | 'playlists' | null;
  done: number;
  total: number;
  confirmedGroups: DedupGroup[] | null;
  titleOnlyGroups: { title: string; count: number }[] | null;
  error: string | null;
  scannedAt: string | null;
}

export function startNavidromeDedupScan() {
  return fetch(`${API}/navidrome-dedup/scan`, { method: 'POST' });
}

export function getNavidromeDedupScan() {
  return fetch(`${API}/navidrome-dedup/scan`);
}

export function resolveNavidromeDedup(discardPaths: string[]) {
  return postJson('/navidrome-dedup/resolve', { discardPaths });
}

export function skipGroup(method: string, filePaths: string[]) {
  return postJson('/groups/skip', { method, filePaths });
}

export function quarantine(filePaths: string[]) {
  return postJson('/quarantine', { filePaths });
}

export function rating(filePath: string, value: number) {
  return postJson('/rating', { filePath, rating: value });
}

export function analyzeAudio(filePath: string) {
  return postJson('/analyze-audio', { filePath });
}

export function lyricsRescan(filePath: string, startOffset: number) {
  return postJson('/lyrics-rescan', { filePath, startOffset });
}

export function renameFile(filePath: string, newName: string) {
  return postJson('/rename-file', { filePath, newName });
}

export function audioEdit(filePath: string, trimStart: number, trimEnd: number, fadeIn: number, fadeOut: number) {
  return postJson('/audio-edit', { filePath, trimStart, trimEnd, fadeIn, fadeOut });
}

export function restoreQuarantine(quarantineNames: string[]) {
  return postJson('/quarantine/restore', { quarantineNames });
}

export function emptyQuarantine() {
  return fetch(`${API}/quarantine/empty`, { method: 'POST' });
}

export function browse(targetPath: string) {
  return fetch(`${API}/browse?path=${encodeURIComponent(targetPath)}`);
}

export function browseShortcuts() {
  return fetch(`${API}/browse/shortcuts`);
}

export interface NavidromeSong {
  id: string;
  title: string;
  artist?: string;
  relPath: string | null;
  path: string | null;
  size?: number;
  bitRate?: number;
}

// Catalogue complet Navidrome (pas limité au projet Curation ouvert) — sert de source
// pour traiter en masse des morceaux déjà importés (style, renommage, tags, playlists).
export function getNavidromeLibrary() {
  return fetch(`${API}/navidrome/library`);
}
