import { useState, useEffect, useRef, useCallback } from 'react';
import * as api from '../api';
import type { InboxFile } from '../api';
import { moodColor } from '../moods';
import { PlayIcon, PauseIcon, SparkleIcon, FolderIcon, WarnIcon, CheckIcon } from '../icons';

interface SendResult {
  success: boolean;
  destDir: string;
  moved: { oldPath: string; newPath: string; name: string }[];
  moveErrors: { file: string; error: string }[];
  push: {
    success: boolean;
    pushed: number;
    failed: number;
    results: { file: string; success: boolean; alreadyInLibrary?: boolean; error?: string }[];
  } | null;
  pushError: string | null;
}

// Onglet Import : le flux quotidien "je dépose des morceaux → moods → radio" en un seul
// écran, sans aucun concept de curation (doublons, projets, renommage). Autonome : tout
// l'état vit ici, App.tsx ne fournit que la liste des moods disponibles.
export function ImportPanel({ availableMoods }: { availableMoods: string[] }) {
  const [inboxDir, setInboxDir] = useState('');
  const [files, setFiles] = useState<InboxFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [analysis, setAnalysis] = useState<Record<string, { bpm: number; key: string; scale: string }>>({});
  const [analyzing, setAnalyzing] = useState<Set<string>>(new Set());
  const [suggested, setSuggested] = useState<Record<string, string[]>>({});
  const [rowNotices, setRowNotices] = useState<Record<string, string>>({});
  const [selectedMoods, setSelectedMoods] = useState<Set<string>>(new Set());
  const [playingPath, setPlayingPath] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sendProgress, setSendProgress] = useState<{ done: number; total: number; currentFile: string | null } | null>(null);
  const [sendResult, setSendResult] = useState<SendResult | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  const loadInbox = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await api.getImportInbox();
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Échec lecture inbox');
      setInboxDir(data.inboxDir);
      setFiles(data.files);
      // Purge la sélection des fichiers qui ne sont plus listés
      setSelected(prev => {
        const listed = new Set(data.files.map((f: InboxFile) => f.path));
        return new Set([...prev].filter(p => listed.has(p)));
      });
    } catch (err) {
      setLoadError(String(err instanceof Error ? err.message : err));
    } finally {
      setLoading(false);
    }
  }, []);

  // Chargement au montage + refetch quand la fenêtre reprend le focus (dépôt de
  // fichiers dans Nautilus puis alt-tab vers l'appli) — pas de watcher.
  useEffect(() => {
    loadInbox();
    window.addEventListener('focus', loadInbox);
    return () => window.removeEventListener('focus', loadInbox);
  }, [loadInbox]);

  const toggleSelect = (path: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  };

  const toggleSelectAll = () => {
    setSelected(prev => prev.size === files.length ? new Set() : new Set(files.map(f => f.path)));
  };

  const togglePlay = (path: string) => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playingPath === path) {
      audio.pause();
      setPlayingPath(null);
    } else {
      audio.src = api.importStreamUrl(path);
      audio.play();
      setPlayingPath(path);
    }
  };

  const analyzeAndSuggest = async (path: string) => {
    setAnalyzing(prev => new Set(prev).add(path));
    setRowNotices(prev => ({ ...prev, [path]: '' }));
    try {
      const res = await api.importAnalyze(path);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Échec analyse');
      setAnalysis(prev => ({ ...prev, [path]: { bpm: data.bpm, key: data.key, scale: data.scale } }));

      try {
        const moodRes = await api.generateMood('', data.bpm, data.key, data.scale);
        const moodData = await moodRes.json();
        if (!moodRes.ok) throw new Error(moodData.error || 'Échec suggestion');
        setSuggested(prev => ({ ...prev, [path]: moodData.moods }));
        // Union dans la sélection partagée — la suggestion pré-coche, l'utilisateur ajuste
        setSelectedMoods(prev => new Set([...prev, ...moodData.moods]));
      } catch (err) {
        // BPM acquis mais suggestion Ollama ratée — garde le BPM, signale la suggestion
        setRowNotices(prev => ({ ...prev, [path]: `⚠️ Suggestion : ${String(err instanceof Error ? err.message : err)}` }));
      }
    } catch (err) {
      setRowNotices(prev => ({ ...prev, [path]: `⚠️ ${String(err instanceof Error ? err.message : err)}` }));
    } finally {
      setAnalyzing(prev => {
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
    }
  };

  const toggleMood = (m: string) => {
    setSelectedMoods(prev => {
      const next = new Set(prev);
      if (next.has(m)) next.delete(m); else next.add(m);
      return next;
    });
  };

  const send = async () => {
    if (selected.size === 0 || selectedMoods.size === 0 || sending) return;
    setSending(true);
    setSendResult(null);
    const interval = setInterval(async () => {
      try {
        const res = await api.getNavidromePushProgress();
        const data = await res.json();
        setSendProgress(data.active ? { done: data.done, total: data.total, currentFile: data.currentFile } : null);
      } catch { /* sondage best-effort */ }
    }, 400);
    try {
      const res = await api.importSend([...selected], [...selectedMoods]);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Échec envoi');
      setSendResult(data);
      setSelected(new Set());
      loadInbox();
    } catch (err) {
      setSendResult({
        success: false, destDir: '', moved: [], moveErrors: [],
        push: null, pushError: String(err instanceof Error ? err.message : err)
      });
    } finally {
      clearInterval(interval);
      setSendProgress(null);
      setSending(false);
    }
  };

  const coveredCount = sendResult?.push?.results.filter(r => r.alreadyInLibrary).length || 0;
  const pushedToMoods = (sendResult?.push?.pushed || 0) - coveredCount;
  const destFolder = sendResult?.destDir ? sendResult.destDir.split('/').pop() : '';

  return (
    <div className="import-panel">
      <audio ref={audioRef} onEnded={() => setPlayingPath(null)} />

      <div className="import-toolbar">
        <h2>📥 Nouveaux morceaux</h2>
        <button className="top-btn" onClick={loadInbox} disabled={loading}>
          {loading ? '…' : '⟳ Rafraîchir'}
        </button>
        <span className="import-count">{files.length} fichier(s) en attente</span>
      </div>

      {loadError && <div className="import-error"><WarnIcon size={12} /> {loadError}</div>}

      {!loading && files.length === 0 && !loadError ? (
        <div className="import-empty">
          <FolderIcon size={28} />
          <p>Boîte de dépôt vide</p>
          <span>Dépose des fichiers audio dans <code>{inboxDir}</code> puis clique Rafraîchir (ou reviens sur cette fenêtre)</span>
        </div>
      ) : (
        <div className="import-file-list">
          <div className="import-row import-row-head">
            <input
              type="checkbox"
              checked={files.length > 0 && selected.size === files.length}
              onChange={toggleSelectAll}
              title="Tout sélectionner"
            />
            <span className="import-col-name">Nom</span>
            <span className="import-col-bpm">BPM</span>
            <span className="import-col-size">Taille</span>
            <span className="import-col-actions" />
          </div>
          {files.map(f => (
            <div key={f.path} className={`import-row ${selected.has(f.path) ? 'selected' : ''} ${playingPath === f.path ? 'playing' : ''}`}>
              <input
                type="checkbox"
                checked={selected.has(f.path)}
                onChange={() => toggleSelect(f.path)}
              />
              <button className="play-btn" onClick={() => togglePlay(f.path)} title="Pré-écouter">
                {playingPath === f.path ? <PauseIcon /> : <PlayIcon />}
              </button>
              <span className="import-col-name" title={f.path}>
                {f.name}
                {f.relPath && <span className="import-relpath">{f.relPath}/</span>}
              </span>
              <span className="import-col-bpm">
                {analysis[f.path]
                  ? `${Math.round(analysis[f.path].bpm)} · ${analysis[f.path].key}${analysis[f.path].scale === 'minor' ? 'm' : ''}`
                  : '—'}
              </span>
              <span className="import-col-size">{(f.size / 1024 / 1024).toFixed(1)} MB</span>
              <span className="import-col-actions">
                <button
                  className="generate-btn generate-mood-btn"
                  onClick={() => analyzeAndSuggest(f.path)}
                  disabled={analyzing.has(f.path)}
                  title="Analyser le BPM/tonalité (~8s) puis suggérer des moods via Ollama"
                >
                  {analyzing.has(f.path) ? '…analyse' : <><SparkleIcon /> Suggérer</>}
                </button>
              </span>
              {suggested[f.path] && (
                <span className="import-suggested">
                  {suggested[f.path].map(m => (
                    <span key={m} className="mood-dot-mini" style={{ background: moodColor(m) }} title={m} />
                  ))}
                  {suggested[f.path].join(', ')}
                </span>
              )}
              {rowNotices[f.path] && <span className="import-row-notice">{rowNotices[f.path]}</span>}
            </div>
          ))}
        </div>
      )}

      <div className="import-footer">
        <div className="import-moods">
          <span className="import-moods-label">Mood(s) :</span>
          {availableMoods.map(m => (
            <button
              key={m}
              type="button"
              className={`mood-chip small ${selectedMoods.has(m) ? 'active' : ''}`}
              style={{
                background: selectedMoods.has(m) ? moodColor(m) : undefined,
                borderColor: moodColor(m)
              } as React.CSSProperties}
              onClick={() => toggleMood(m)}
            >
              {m}
            </button>
          ))}
        </div>

        <button
          className="import-send-btn"
          onClick={send}
          disabled={selected.size === 0 || selectedMoods.size === 0 || sending}
          title={selected.size === 0 ? 'Sélectionne au moins un fichier' : selectedMoods.size === 0 ? 'Choisis au moins un mood' : 'Déplace les fichiers dans la bibliothèque et les ajoute aux playlists mood'}
        >
          {sending
            ? sendProgress
              ? `Envoi… ${sendProgress.done}/${sendProgress.total}${sendProgress.currentFile ? ` — ${sendProgress.currentFile}` : ''}`
              : 'Envoi… déplacement + scan'
            : `🚀 Envoyer vers la radio (${selected.size})`}
        </button>

        {sendResult && (
          <div className={`import-summary ${sendResult.success ? 'ok' : 'warn'}`}>
            {sendResult.moved.length > 0 && (
              <div><CheckIcon /> {sendResult.moved.length} déplacé(s) vers {destFolder}
                {sendResult.push && <> · {pushedToMoods} dans les playlists {[...selectedMoods].join(', ') || 'mood'}{coveredCount > 0 && <> · {coveredCount} déjà au catalogue → Covers</>}</>}
              </div>
            )}
            {sendResult.moveErrors.map(e => (
              <div key={e.file} className="import-summary-error"><WarnIcon size={11} /> {e.file} : {e.error}</div>
            ))}
            {sendResult.push?.results.filter(r => !r.success).map(r => (
              <div key={r.file} className="import-summary-error"><WarnIcon size={11} /> {r.file} : {r.error}</div>
            ))}
            {sendResult.pushError && (
              <div className="import-summary-error">
                <WarnIcon size={11} /> Fichiers déplacés dans la bibliothèque mais push Navidrome échoué ({sendResult.pushError}) — réessaie ou passe par l'onglet Curation.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
