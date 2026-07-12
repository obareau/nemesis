import fs from 'fs';
import { QUARANTINE_MANIFEST } from './config.js';

export function readQuarantineManifest() {
  try {
    return JSON.parse(fs.readFileSync(QUARANTINE_MANIFEST, 'utf-8'));
  } catch {
    return {};
  }
}

export function writeQuarantineManifest(manifest) {
  fs.writeFileSync(QUARANTINE_MANIFEST, JSON.stringify(manifest, null, 2));
}
