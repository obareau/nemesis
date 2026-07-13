import { useState, useEffect, useRef } from 'react';
import * as api from '../api';
import type { DedupScanState, DedupFile } from '../api';
import { XIcon, TrashIcon, WarnIcon, CheckIcon, NavidromeIcon } from '../icons';

const STAGE_LABELS: Record<string, string> = {
  catalog: 'Lecture du catalogue Navidrome…',
  titles: 'Regroupement par titre…',
  fingerprint: 'Empreinte audio des candidats',
  confirm: 'Confirmation des doublons…',
  playlists: 'Lecture des playlists…'
};

// Meilleur fichier d'un groupe confirmé : débit binaire d'abord (proxy qualité fiable),
// taille ensuite — même logique que pickBestFile côté Curation (App.tsx), dupliquée ici
// en petit pour ne pas coupler ce composant autonome à App.tsx.
function pickBest(files: DedupFile[]): DedupFile {
  return [...files].sort((a, b) => (b.bitRate - a.bitRate) || (b.size - a.size))[0];
}

export function NavidromeDedupModal({ onClose }: { onClose: () => void }) {
  const [scan, setScan] = useState<DedupScanState | null>(null);
  const [keep, setKeep] = useState<Record<string, string>>({}); // titre du groupe -> path gardé
  const [resolving, setResolving] = useState(false);
  const [resolveResult, setResolveResult] = useState<{
    playlistRemovals: { path: string; playlist: string; success: boolean; error?: string }[];
    quarantine: { quarantined: number; failed: number };
  } | null>(null);
  const [showTitleOnly, setShowTitleOnly] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const startScan = async () => {
    setResolveResult(null);
    try {
      const res = await api.startNavidromeDedupScan();
      if (!res.ok && res.status !== 409) {
        const data = await res.json();
        throw new Error(data.error || 'Échec démarrage du scan');
      }
    } catch (err) {
      setScan({
        active: false, stage: null, done: 0, total: 0, confirmedGroups: null,
        titleOnlyGroups: null, error: String(err instanceof Error ? err.message : err), scannedAt: null
      });
      return;
    }
    poll();
  };

  const poll = () => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      const res = await api.getNavidromeDedupScan();
      const data: DedupScanState = await res.json();
      setScan(data);
      if (!data.active) {
        if (pollRef.current) clearInterval(pollRef.current);
        if (data.confirmedGroups) {
          const defaults: Record<string, string> = {};
          for (const g of data.confirmedGroups) defaults[g.title] = pickBest(g.files).path;
          setKeep(defaults);
        }
      }
    }, 1500);
  };

  useEffect(() => {
    startScan();
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resolve = async () => {
    if (!scan?.confirmedGroups) return;
    const discardPaths = scan.confirmedGroups.flatMap(g =>
      g.files.filter(f => f.path !== keep[g.title]).map(f => f.path)
    );
    if (discardPaths.length === 0) return;

    const playlistCount = scan.confirmedGroups
      .flatMap(g => g.files.filter(f => f.path !== keep[g.title]))
      .reduce((n, f) => n + f.playlists.length, 0);

    if (!window.confirm(
      `Nettoyer ${discardPaths.length} fichier(s) ?\n` +
      `Ils seront retirés de ${playlistCount} playlist(s) puis mis en quarantaine (réversible).`
    )) {
      return;
    }

    setResolving(true);
    try {
      const res = await api.resolveNavidromeDedup(discardPaths);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Échec du nettoyage');
      setResolveResult(data);
      setScan(null);
    } catch (err) {
      setResolveResult({
        playlistRemovals: [],
        quarantine: { quarantined: 0, failed: discardPaths.length }
      });
      window.alert(String(err instanceof Error ? err.message : err));
    } finally {
      setResolving(false);
    }
  };

  const discardCount = scan?.confirmedGroups
    ? scan.confirmedGroups.reduce((n, g) => n + g.files.filter(f => f.path !== keep[g.title]).length, 0)
    : 0;
  const playlistRemovalCount = scan?.confirmedGroups
    ? scan.confirmedGroups.flatMap(g => g.files.filter(f => f.path !== keep[g.title]))
        .reduce((n, f) => n + f.playlists.length, 0)
    : 0;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content dedup-modal" onClick={(e) => e.stopPropagation()}>
        <div className="waveform-header">
          <span>🧹 Dédup bibliothèque Navidrome</span>
          <button className="surprise-close" onClick={onClose} title="Fermer"><XIcon /></button>
        </div>

        <div className="dedup-body">
          {scan?.error && (
            <div className="import-error"><WarnIcon size={12} /> {scan.error}</div>
          )}

          {(!scan || scan.active) && !scan?.error && (
            <div className="dedup-progress">
              <p>{scan ? (STAGE_LABELS[scan.stage || ''] || 'Scan en cours…') : 'Démarrage…'}</p>
              {scan?.stage === 'fingerprint' && scan.total > 0 && (
                <div className="progress-bar">
                  <div className="progress-fill" style={{ width: `${Math.round((scan.done / scan.total) * 100)}%` }} />
                </div>
              )}
              {scan?.stage === 'fingerprint' && (
                <span className="dedup-progress-count">{scan.done}/{scan.total}</span>
              )}
            </div>
          )}

          {scan && !scan.active && scan.confirmedGroups && (
            <>
              {scan.confirmedGroups.length === 0 ? (
                <div className="import-empty">
                  <CheckIcon />
                  <p>Aucun doublon audio confirmé</p>
                </div>
              ) : (
                <div className="dedup-groups">
                  {scan.confirmedGroups.map(group => (
                    <div key={group.title} className="dedup-group">
                      <div className="dedup-group-title">{group.title} <span className="dedup-similarity">{group.similarity}% audio</span></div>
                      {group.files.map(file => (
                        <label key={file.path} className={`dedup-file-row ${keep[group.title] === file.path ? 'kept' : 'discarded'}`}>
                          <input
                            type="radio"
                            name={`keep-${group.title}`}
                            checked={keep[group.title] === file.path}
                            onChange={() => setKeep(prev => ({ ...prev, [group.title]: file.path }))}
                          />
                          <span className="dedup-file-path" title={file.path}>{file.relPath}</span>
                          <span className="dedup-file-meta">{file.bitRate} kbps · {(file.size / 1024 / 1024).toFixed(1)} MB</span>
                          {file.playlists.map(pl => (
                            <span key={pl.id} className="dedup-playlist-badge"><NavidromeIcon size={9} /> {pl.name}</span>
                          ))}
                          {keep[group.title] === file.path
                            ? <span className="dedup-fate keep"><CheckIcon /> gardé</span>
                            : <span className="dedup-fate discard"><TrashIcon /> quarantaine</span>}
                        </label>
                      ))}
                    </div>
                  ))}
                </div>
              )}

              {scan.titleOnlyGroups && scan.titleOnlyGroups.length > 0 && (
                <div className="dedup-titleonly">
                  <button className="dedup-titleonly-toggle" onClick={() => setShowTitleOnly(p => !p)}>
                    {showTitleOnly ? '▾' : '▸'} {scan.titleOnlyGroups.length} groupe(s) à titre similaire mais audio différent (non touchés)
                  </button>
                  {showTitleOnly && (
                    <ul className="dedup-titleonly-list">
                      {scan.titleOnlyGroups.map(g => (
                        <li key={g.title}>{g.title} <span>({g.count}x)</span></li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </>
          )}

          {resolveResult && (
            <div className="import-summary ok">
              <CheckIcon /> {resolveResult.quarantine.quarantined} fichier(s) mis en quarantaine
              {resolveResult.quarantine.failed > 0 && `, ${resolveResult.quarantine.failed} échec(s)`}
              {' · '}{resolveResult.playlistRemovals.filter(r => r.success).length} retrait(s) de playlist
              {resolveResult.playlistRemovals.some(r => !r.success) && (
                <div className="import-summary-error">
                  <WarnIcon size={11} /> {resolveResult.playlistRemovals.filter(r => !r.success).length} retrait(s) de playlist ont échoué
                </div>
              )}
            </div>
          )}
        </div>

        <div className="modal-actions">
          <button className="modal-btn-cancel" onClick={onClose}>Fermer</button>
          {scan && !scan.active && (
            <button className="modal-btn-cancel" onClick={startScan}>⟳ Relancer le scan</button>
          )}
          {scan?.confirmedGroups && scan.confirmedGroups.length > 0 && (
            <button className="modal-btn" onClick={resolve} disabled={resolving || discardCount === 0}>
              {resolving ? 'Nettoyage…' : `🧹 Nettoyer (${discardCount} fichier(s), ${playlistRemovalCount} retrait(s))`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
