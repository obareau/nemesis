import type { Duplicate, File } from '../api';
import { formatDate, getLyricsState } from '../format';
import { moodColor } from '../moods';
import {
  StarRating, LinkIcon, PlayIcon, WaveformIcon, TrashIcon, MicIcon, MicOffIcon,
  HelpIcon, NavidromeIcon, SparkleIcon
} from '../icons';

interface GroupPanelProps {
  group: Duplicate;
  keepPaths: Set<string>;
  availableMoods: string[];
  groupQuarantine: boolean;
  groupRename: boolean;
  groupNavidrome: boolean;
  groupAuthor: string;
  groupTitle: string;
  groupMoods: Set<string>;
  groupNotice: string | null;
  groupProcessing: boolean;
  generatingAuthor: boolean;
  generatingTitle: boolean;
  generatingMood: boolean;
  analyzingPaths: Set<string>;
  playingFilePath: string | null;
  onClose: () => void;
  onToggleKeep: (filePath: string) => void;
  onPlay: (filePath: string) => void;
  onRate: (filePath: string, rating: number) => void;
  onOpenWaveformEditor: (file: File) => void;
  onQuickQuarantine: (filePaths: string[]) => void;
  onOpenInfo: (filePath: string) => void;
  onAnalyzeAudio: (filePath: string) => void;
  onSetGroupQuarantine: (checked: boolean) => void;
  onSetGroupRename: (checked: boolean) => void;
  onSetGroupNavidrome: (checked: boolean) => void;
  onSetGroupAuthor: (value: string) => void;
  onSetGroupTitle: (value: string) => void;
  onGenerateAuthor: () => void;
  onGenerateTitle: () => void;
  onGenerateMood: () => void;
  onToggleGroupMood: (mood: string) => void;
  onSkip: () => void;
  onApply: () => void;
}

export function GroupPanel({
  group, keepPaths, availableMoods, groupQuarantine, groupRename, groupNavidrome,
  groupAuthor, groupTitle, groupMoods, groupNotice, groupProcessing,
  generatingAuthor, generatingTitle, generatingMood, analyzingPaths, playingFilePath,
  onClose, onToggleKeep, onPlay, onRate, onOpenWaveformEditor, onQuickQuarantine,
  onOpenInfo, onAnalyzeAudio, onSetGroupQuarantine, onSetGroupRename, onSetGroupNavidrome,
  onSetGroupAuthor, onSetGroupTitle, onGenerateAuthor, onGenerateTitle, onGenerateMood, onToggleGroupMood,
  onSkip, onApply
}: GroupPanelProps) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content group-modal" onClick={(e) => e.stopPropagation()}>
        <h2>
          <LinkIcon size={16} /> Traiter le groupe
          <span className={`group-method-badge method-${group.method}`}>
            {group.method}{group.similarity ? ` · ${group.similarity}%` : ''}
          </span>
        </h2>

        <div className="group-files">
          <div className="group-files-hint">
            Note pour comparer, coche les fichiers à <strong>garder</strong> — les autres partent en corbeille (réversible)
          </div>
          {[...group.files]
            .sort((a, b) => (b.rating || 0) - (a.rating || 0))
            .map((file) => {
              const lyricsState = getLyricsState(file);
              const isAnalyzing = analyzingPaths.has(file.path);
              return (
            <div key={file.path} className={`group-file-card ${keepPaths.has(file.path) ? 'kept' : 'discarded'} ${playingFilePath === file.path ? 'playing' : ''}`}>
              <div className="group-file-row">
                <input
                  type="checkbox"
                  checked={keepPaths.has(file.path)}
                  onChange={() => onToggleKeep(file.path)}
                />
                <button className="play-btn" onClick={() => onPlay(file.path)} title="Écouter">
                  <PlayIcon />
                </button>
                <StarRating value={file.rating} onChange={(n) => onRate(file.path, n)} size={12} />
                <span className="group-file-name" title={file.path}>{file.name}</span>
                <span className="group-file-size">{(file.size / 1024 / 1024).toFixed(1)} MB</span>
                <span className="group-file-fate">{keepPaths.has(file.path) ? 'gardé' : groupQuarantine ? 'corbeille' : 'inchangé'}</span>
                <button
                  className="waveform-btn"
                  title="Sonogramme — trim / fade"
                  onClick={() => onOpenWaveformEditor(file)}
                >
                  <WaveformIcon />
                </button>
                <button
                  className="group-file-trash"
                  title="Mettre ce fichier en quarantaine tout de suite"
                  onClick={() => onQuickQuarantine([file.path])}
                >
                  <TrashIcon />
                </button>
              </div>
              <div className="group-file-meta">
                <span className="meta-item" title="Date de création">
                  📅 {formatDate(file.mtime)}
                </span>
                <button className={`meta-item meta-item-btn lyrics-${lyricsState}`} onClick={() => onOpenInfo(file.path)} title="Voir les infos complètes">
                  {lyricsState === 'lyrics' ? <MicIcon size={11} /> : lyricsState === 'instrumental' ? <MicOffIcon size={11} /> : <HelpIcon size={11} />}
                  {lyricsState === 'lyrics' ? 'Paroles' : lyricsState === 'instrumental' ? 'Instrumental' : 'Paroles inconnues'}
                </button>
                {file.bpm ? (
                  <span className="meta-item">🎵 {file.bpm} BPM · {file.key}{file.scale === 'minor' ? 'm' : ''}</span>
                ) : (
                  <button className="meta-analyze-btn" onClick={() => onAnalyzeAudio(file.path)} disabled={isAnalyzing}>
                    {isAnalyzing ? '…analyse' : '🎵 Analyser BPM/tonalité'}
                  </button>
                )}
                {file.pushedToNavidrome && (
                  <span className="meta-item navidrome-pushed" title="Déjà envoyé vers Navidrome">
                    <NavidromeIcon size={11} /> Envoyé
                  </span>
                )}
              </div>
            </div>
              );
            })}
        </div>

        <div className="group-options">
          <label className="group-check">
            <input
              type="checkbox"
              checked={groupQuarantine}
              onChange={(e) => onSetGroupQuarantine(e.target.checked)}
            />
            Mettre les non-gardés en corbeille
          </label>

          <label className="group-check">
            <input
              type="checkbox"
              checked={groupRename}
              onChange={(e) => onSetGroupRename(e.target.checked)}
            />
            Renommer + taguer les gardés
          </label>

          {groupRename && (
            <div className="group-rename-fields">
              <div className="author-input-row">
                <input
                  type="text"
                  placeholder="Auteur fictif"
                  value={groupAuthor}
                  onChange={(e) => onSetGroupAuthor(e.target.value)}
                />
                <button className="generate-btn" onClick={onGenerateAuthor} disabled={generatingAuthor} title="Générer via Ollama">
                  {generatingAuthor ? '…' : <SparkleIcon />}
                </button>
              </div>
              <div className="author-input-row">
                <input
                  type="text"
                  placeholder="Titre (3-4 mots depuis paroles)"
                  value={groupTitle}
                  onChange={(e) => onSetGroupTitle(e.target.value)}
                />
                <button className="generate-btn" onClick={onGenerateTitle} disabled={generatingTitle} title="Générer depuis les paroles">
                  {generatingTitle ? '…' : <MicIcon />}
                </button>
              </div>
            </div>
          )}

          <label className="group-check">
            <input
              type="checkbox"
              checked={groupNavidrome}
              onChange={(e) => onSetGroupNavidrome(e.target.checked)}
            />
            Envoyer les gardés vers Navidrome
          </label>

          {(groupNavidrome || groupRename) && (
            <>
              <button
                className="generate-btn generate-mood-btn"
                onClick={onGenerateMood}
                disabled={generatingMood}
                title="Suggérer le(s) mood(s) via Ollama, à partir des paroles et du BPM/tonalité déjà analysés"
              >
                {generatingMood ? '…' : <SparkleIcon />} Suggérer via Ollama
              </button>
              <div className="mood-checkboxes">
              {availableMoods.map((m) => (
                <button
                  key={m}
                  type="button"
                  className={`mood-chip ${groupMoods.has(m) ? 'active' : ''}`}
                  style={{
                    background: groupMoods.has(m) ? moodColor(m) : undefined,
                    borderColor: moodColor(m)
                  } as React.CSSProperties}
                  onClick={() => onToggleGroupMood(m)}
                >
                  <span className="mood-dot" style={{ background: moodColor(m) }} />
                  {m}
                </button>
              ))}
              </div>
            </>
          )}
        </div>

        {groupNotice && <div className="group-notice">{groupNotice}</div>}

        <div className="modal-actions">
          <button className="modal-btn-cancel" onClick={onClose} disabled={groupProcessing}>
            Annuler
          </button>
          <button className="modal-btn-cancel" onClick={onSkip} disabled={groupProcessing}>
            Ignorer ce groupe
          </button>
          <button className="modal-btn" onClick={onApply} disabled={groupProcessing}>
            {groupProcessing ? 'Traitement…' : 'Appliquer'}
          </button>
        </div>
      </div>
    </div>
  );
}
