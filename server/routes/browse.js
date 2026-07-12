import express from 'express';
import fs from 'fs';
import path from 'path';
import { SHOW_MOODS } from '../config.js';

const router = express.Router();

// API: Lister le contenu d'un répertoire (navigation serveur)
router.get('/api/browse', (req, res) => {
  const dirPath = req.query.path || '/home/olivier';

  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const dirs = entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => e.name)
      .sort((a, b) => a.localeCompare(b));

    res.json({
      currentPath: path.resolve(dirPath),
      parent: path.dirname(path.resolve(dirPath)),
      dirs
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// API: Raccourcis (home, clés USB, disques, partages réseau — détectés dynamiquement)
const NETWORK_FSTYPES = new Set(['cifs', 'smb3', 'nfs', 'nfs4', 'smbfs', 'sshfs', 'davfs', 'fuse.sshfs']);
const PSEUDO_FSTYPES = new Set([
  'proc', 'sysfs', 'devtmpfs', 'devpts', 'tmpfs', 'cgroup', 'cgroup2', 'securityfs',
  'pstore', 'bpf', 'debugfs', 'tracefs', 'configfs', 'fusectl', 'mqueue', 'hugetlbfs',
  'binfmt_misc', 'autofs', 'overlay', 'squashfs', 'ramfs', 'efivarfs'
]);

function unescapeMountField(str) {
  // /proc/mounts encode espaces/tabs/backslashes en octal (\040 = espace, etc.)
  return str.replace(/\\([0-7]{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
}

function readMountPoints() {
  const raw = fs.readFileSync('/proc/mounts', 'utf-8');
  return raw.split('\n').filter(Boolean).map(line => {
    const [source, target, fstype] = line.split(' ');
    return {
      source: unescapeMountField(source),
      target: unescapeMountField(target),
      fstype
    };
  });
}

// API: Liste des moods canoniques Subwave (source de vérité unique, évite la duplication frontend)
router.get('/api/moods', (req, res) => {
  res.json({ moods: SHOW_MOODS });
});

router.get('/api/browse/shortcuts', (req, res) => {
  const shortcuts = [];
  const home = process.env.HOME || '/home/olivier';

  shortcuts.push({ label: 'Accueil', group: 'local', path: home });

  try {
    const mounts = readMountPoints();

    for (const { source, target, fstype } of mounts) {
      if (PSEUDO_FSTYPES.has(fstype)) continue;
      if (target === '/' || target === '/boot' || target.startsWith('/boot/')) continue;
      if (target.startsWith('/var/') || target.startsWith('/run/') && !target.includes('/media/')) continue;
      if (target.startsWith('/snap/')) continue;

      const isNetwork = NETWORK_FSTYPES.has(fstype);
      const isRemovable = target.startsWith('/media/') || target.startsWith('/run/media/');
      const label = path.basename(target) || target;

      if (isNetwork) {
        shortcuts.push({ label: `🌐 ${label}`, group: 'network', path: target, detail: source });
      } else if (isRemovable) {
        shortcuts.push({ label: `💾 ${label}`, group: 'removable', path: target, detail: fstype });
      } else if (target.startsWith('/mnt/')) {
        shortcuts.push({ label: `📦 ${label}`, group: 'mount', path: target, detail: fstype });
      }
    }
  } catch (err) {
    console.error('Erreur lecture /proc/mounts:', err.message);
  }

  res.json({ shortcuts });
});

export default router;
