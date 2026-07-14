import fs from 'fs';
import { IMPORT_HISTORY_FILE } from './config.js';

export function readImportHistory() {
  try {
    return JSON.parse(fs.readFileSync(IMPORT_HISTORY_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

export function writeImportHistory(history) {
  fs.writeFileSync(IMPORT_HISTORY_FILE, JSON.stringify(history, null, 2));
}
