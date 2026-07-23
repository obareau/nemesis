import { useState, useEffect, useCallback, useMemo } from 'react';
import * as api from '../api';
import type { NavidromeSong } from '../api';
import { moodColor } from '../moods';
import { WarnIcon, CheckIcon } from '../icons';

type SortKey = 'title' | 'artist' | 'genre' | 'bpm' | 'key' | 'size' | 'original';

interface AutoProcessResult {
  processed: {
    file: string;
    filePath: string;
    success: boolean;
    title?: string | null;
    author?: string | null;
    authorReused?: boolean;
    genre?: string | null;
    moods?: string[];
    error?: string;
  }[];
  push: { success: boolean; pushed: number; failed: number };
}

// Onglet Bibliothèque : le catalogue Navidrome COMPLET (pas seulement le dossier
// ouvert dans Curation) — pour appliquer le traitement en masse (style réel,
// artiste fictif, renommage, tags, playlists) à des morceaux déjà importés il y a
// longtemps, avant que ce pipeline n'existe.
export function LibraryPanel() {
  const [songs, setSongs] = useState<NavidromeSong[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; currentFile: string | null; stage: string | null } | null>(null);
  const [result, setResult] = useState<AutoProcessResult | null>(null);
  const [resultError, setResultError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const loadLibrary = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await api.getNavidromeLibrary();
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Échec lecture catalogue Navidrome');
      setSongs(data.songs.filter((s: NavidromeSong) => !!s.path));
    } catch (err) {
      setLoadError(String(err instanceof Error ? err.message : err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadLibrary(); }, [loadLibrary]);

  const q = search.trim().toLowerCase();
  const filtered = useMemo(() => {
    const base = q
      ? songs.filter(s => s.title?.toLowerCase().includes(q) || s.artist?.toLowerCase().includes(q) || s.relPath?.toLowerCase().includes(q) || s.originalName?.toLowerCase().includes(q))
      : songs;
    if (!sortKey) return base;
    const dir = sortDir === 'asc' ? 1 : -1;
    const str = (v?: string | null) => (v || '').toLowerCase();
    return [...base].sort((a, b) => {
      switch (sortKey) {
        case 'title': return str(a.title).localeCompare(str(b.title)) * dir;
        case 'artist': return str(a.artist).localeCompare(str(b.artist)) * dir;
        case 'genre': return str(a.genre).localeCompare(str(b.genre)) * dir;
        case 'key': return str(a.key).localeCompare(str(b.key)) * dir;
        case 'original': return str(a.originalName || a.currentName).localeCompare(str(b.originalName || b.currentName)) * dir;
        case 'bpm': return ((a.bpm ?? -1) - (b.bpm ?? -1)) * dir;
        case 'size': return ((a.size ?? -1) - (b.size ?? -1)) * dir;
        default: return 0;
      }
    });
  }, [songs, q, sortKey, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      if (sortDir === 'asc') setSortDir('desc');
      else { setSortKey(null); setSortDir('asc'); }
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  };
  const arrow = (key: SortKey) => (sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');

  const toggleSelect = (path: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  };

  const toggleSelectAll = () => {
    setSelected(prev =>
      prev.size === filtered.length && filtered.length > 0
        ? new Set()
        : new Set(filtered.map(s => s.path as string))
    );
  };

  const process = async (explicitTargets?: string[]) => {
    const targets = explicitTargets ?? [...selected];
    if (targets.length === 0 || processing) return;

    setProcessing(true);
    setResult(null);
    setResultError(null);
    const interval = setInterval(async () => {
      try {
        const res = await api.getAutoPushProgress();
        const data = await res.json();
        setProgress(data.active ? data : null);
      } catch { /* sondage best-effort */ }
    }, 400);

    try {
      const res = await api.autoPushBatch(targets);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Échec traitement en masse');
      setResult(data);
      setSelected(new Set());
      loadLibrary();
    } catch (err) {
      setResultError(String(err instanceof Error ? err.message : err));
    } finally {
      clearInterval(interval);
      setProgress(null);
      setProcessing(false);
    }
  };

  const failures = result?.processed.filter(p => !p.success) || [];

  return (
    <div className="import-panel">
      <div className="import-toolbar">
        <h2>🗄️ Bibliothèque Navidrome</h2>
        <button className="top-btn" onClick={loadLibrary} disabled={loading}>
          {loading ? '…' : '⟳ Rafraîchir'}
        </button>
        <div className="library-search">
          <input
            type="text"
            placeholder="Filtrer par titre, artiste, chemin…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <span className="import-count">{filtered.length} morceau(x){q && ` (sur ${songs.length})`}</span>
      </div>

      <p className="library-hint">
        Catalogue complet déjà importé dans Navidrome — pas seulement le dossier ouvert dans
        Curation. Sélectionne des morceaux déjà là depuis longtemps (nom brut, jamais retraités)
        pour leur appliquer le même traitement : style réel détecté (Essentia), artiste fictif,
        renommage physique + tags, playlists mood et style.
      </p>

      {loadError && <div className="import-error"><WarnIcon size={12} /> {loadError}</div>}

      {!loading && filtered.length === 0 && !loadError ? (
        <div className="import-empty">
          <p>Aucun morceau</p>
          <span>{q ? 'Aucun résultat pour ce filtre.' : 'Le catalogue Navidrome semble vide.'}</span>
        </div>
      ) : (
        <div className="lib-table">
          <div className="lib-row lib-head">
            <span className="lib-cell lib-cell-check">
              <input
                type="checkbox"
                checked={filtered.length > 0 && selected.size === filtered.length}
                onChange={toggleSelectAll}
                title="Tout sélectionner"
              />
            </span>
            <button className="lib-cell col-sortable" onClick={() => toggleSort('original')}>Ancien nom{arrow('original')}</button>
            <button className="lib-cell col-sortable" onClick={() => toggleSort('title')}>Nouveau nom{arrow('title')}</button>
            <button className="lib-cell col-sortable" onClick={() => toggleSort('artist')}>Artiste{arrow('artist')}</button>
            <span className="lib-cell">Mood / playlists</span>
            <button className="lib-cell col-sortable" onClick={() => toggleSort('genre')}>Style{arrow('genre')}</button>
            <button className="lib-cell lib-cell-num col-sortable" onClick={() => toggleSort('bpm')}>BPM{arrow('bpm')}</button>
            <button className="lib-cell lib-cell-num col-sortable" onClick={() => toggleSort('size')}>Taille{arrow('size')}</button>
          </div>
          {filtered.map(s => (
            <div key={s.path} className={`lib-row ${selected.has(s.path as string) ? 'selected' : ''}`}>
              <span className="lib-cell lib-cell-check">
                <input
                  type="checkbox"
                  checked={selected.has(s.path as string)}
                  onChange={() => toggleSelect(s.path as string)}
                />
              </span>
              <span className="lib-cell lib-muted" title={s.originalName ? `Nom avant traitement : ${s.originalName}` : 'Jamais renommé par Nemesis'}>
                {s.originalName || <span className="lib-unchanged">—</span>}
              </span>
              <span className="lib-cell" title={s.path || ''}>
                {s.currentName || s.title || '(sans titre)'}
              </span>
              <span className="lib-cell lib-muted">{s.artist || '—'}</span>
              <span
                className="lib-cell lib-cell-moods"
                title={s.playlists?.length ? `Playlists Navidrome : ${s.playlists.join(', ')}` : 'Pas encore traité — le mood sera déterminé au traitement'}
              >
                {s.playlists?.length
                  ? s.playlists.map(p => (
                      <span key={p} className="mood-chip-tiny" style={{ borderColor: moodColor(p) }}>
                        <span className="mood-dot-mini" style={{ background: moodColor(p) }} />{p}
                      </span>
                    ))
                  : <span className="lib-unchanged">à traiter</span>}
              </span>
              <span className="lib-cell" title={s.genre ? `Style détecté (Essentia) : ${s.genre}` : 'Style non détecté'}>
                {s.genre && <span className="genre-badge">{s.genre}</span>}
              </span>
              <span className="lib-cell lib-cell-num">
                {s.bpm ? `${Math.round(s.bpm)}${s.key ? ` · ${s.key}${s.scale === 'minor' ? 'm' : ''}` : ''}` : '—'}
              </span>
              <span className="lib-cell lib-cell-num">{s.size ? `${(s.size / 1024 / 1024).toFixed(1)} MB` : '—'}</span>
            </div>
          ))}
        </div>
      )}

      <div className="import-footer">
        <div className="library-actions">
          <button
            className="import-send-btn"
            onClick={() => process()}
            disabled={selected.size === 0 || processing}
            title="Style réel, artiste fictif, renommage + tags, playlists — un fichier à la fois"
          >
            {processing
              ? progress
                ? `${progress.stage ?? 'Traitement'}… ${progress.done}/${progress.total}${progress.currentFile ? ` — ${progress.currentFile}` : ''}`
                : 'Traitement…'
              : `Traiter la sélection (${selected.size})`}
          </button>
          <button
            className="import-send-btn library-process-all-btn"
            onClick={() => process(songs.map(s => s.path as string))}
            disabled={songs.length === 0 || processing}
            title="Reanalyse + renomme + réimporte TOUTE la bibliothèque en un clic, sans rien cocher — peut prendre longtemps (BPM/paroles/style par fichier)"
          >
            {processing ? '…' : `Traiter TOUTE la bibliothèque (${songs.length})`}
          </button>
        </div>

        {processing && (
          <div className="import-batch-progress">
            <div className="progress-bar">
              <div
                className={`progress-fill ${!progress?.total ? 'indeterminate' : ''}`}
                style={progress?.total ? { width: `${Math.round((progress.done / progress.total) * 100)}%` } : undefined}
              />
            </div>
          </div>
        )}

        {resultError && <div className="import-summary warn"><WarnIcon size={11} /> {resultError}</div>}

        {result && (
          <div className={`import-summary ${failures.length > 0 ? 'warn' : 'ok'}`}>
            <div>
              <CheckIcon /> {result.processed.length - failures.length}/{result.processed.length} traité(s)
              · {result.push.pushed} envoyé(s) vers Navidrome
            </div>
            {failures.map(f => (
              <div key={f.filePath} className="import-summary-error"><WarnIcon size={11} /> {f.file} : {f.error}</div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
