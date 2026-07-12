import type { File } from '../api';
import { formatDate, getLyricsState } from '../format';
import {
  StarRating, HelpIcon, PlayIcon, WaveformIcon, MicIcon, MicOffIcon, TrashIcon, CheckIcon
} from '../icons';

interface InfoPanelModalProps {
  file: File;
  isAnalyzing: boolean;
  isRescanningLyrics: boolean;
  onClose: () => void;
  onPlay: (filePath: string) => void;
  onOpenWaveformEditor: (file: File) => void;
  onRate: (filePath: string, rating: number) => void;
  onAnalyzeAudio: (filePath: string) => void;
  onRescanLyrics: (filePath: string, startOffset: number) => void;
  onQuickQuarantine: (filePaths: string[]) => void;
}

export function InfoPanelModal({
  file, isAnalyzing, isRescanningLyrics, onClose, onPlay, onOpenWaveformEditor,
  onRate, onAnalyzeAudio, onRescanLyrics, onQuickQuarantine
}: InfoPanelModalProps) {
  const lyricsState = getLyricsState(file);
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="info-modal" onClick={(e) => e.stopPropagation()}>
        <div className="info-header">
          <span title={file.path}><HelpIcon size={14} /> {file.name}</span>
          <div className="info-header-actions">
            <button className="play-btn" onClick={() => onPlay(file.path)} title="Écouter">
              <PlayIcon />
            </button>
            <button className="waveform-btn" onClick={() => { onClose(); onOpenWaveformEditor(file); }} title="Sonogramme — trim / fade">
              <WaveformIcon />
            </button>
            <button className="surprise-close" onClick={onClose} title="Fermer">✕</button>
          </div>
        </div>

        <div className="info-body">
          <div className="info-row">
            <span className="info-label">Chemin</span>
            <span className="info-value info-path" title={file.path}>{file.path}</span>
          </div>
          <div className="info-row">
            <span className="info-label">Date de création</span>
            <span className="info-value">{formatDate(file.mtime)}</span>
          </div>
          <div className="info-row">
            <span className="info-label">Taille</span>
            <span className="info-value">{(file.size / 1024 / 1024).toFixed(1)} MB</span>
          </div>
          <div className="info-row">
            <span className="info-label">Note</span>
            <span className="info-value">
              <StarRating value={file.rating} onChange={(n) => onRate(file.path, n)} size={14} />
            </span>
          </div>
          <div className="info-row">
            <span className="info-label">BPM / Tonalité</span>
            <span className="info-value">
              {file.bpm ? (
                `${file.bpm} BPM · ${file.key}${file.scale === 'minor' ? 'm' : ''}`
              ) : (
                <button className="meta-analyze-btn" onClick={() => onAnalyzeAudio(file.path)} disabled={isAnalyzing}>
                  {isAnalyzing ? '…analyse' : '🎵 Analyser BPM/tonalité'}
                </button>
              )}
            </span>
          </div>

          <div className="info-lyrics-section">
            <div className="info-label">
              {lyricsState === 'lyrics' ? <MicIcon size={12} /> : lyricsState === 'instrumental' ? <MicOffIcon size={12} /> : <HelpIcon size={12} />}
              {' '}Paroles
              {lyricsState === 'instrumental' && ' — instrumental'}
              {lyricsState === 'unknown' && ' — pas encore analysé (étape Paroles non passée sur ce fichier)'}
            </div>
            {lyricsState === 'lyrics' ? (
              <div className="info-lyrics-text">{file.lyrics}</div>
            ) : (
              <div className="info-lyrics-empty">
                {lyricsState === 'instrumental' ? 'Aucune parole détectée sur ce morceau.' : 'Ce fichier n\'a pas encore été passé au crible de la transcription (étape Paroles du scan).'}
              </div>
            )}
            {lyricsState !== 'lyrics' && (
              <button
                className="meta-analyze-btn"
                onClick={() => onRescanLyrics(file.path, 30)}
                disabled={isRescanningLyrics}
                title="Relancer la transcription plus loin dans le morceau (utile si l'intro est longue)"
              >
                {isRescanningLyrics ? '…transcription' : '🎤 Réessayer (intro longue)'}
              </button>
            )}
          </div>
        </div>

        <div className="surprise-actions">
          <button
            className="surprise-btn-quarantine"
            onClick={() => { onClose(); onQuickQuarantine([file.path]); }}
            title="Mettre en quarantaine"
          >
            <TrashIcon /> Quarantaine
          </button>
          <button
            className="surprise-btn-keep"
            onClick={onClose}
            title="Garder — fermer sans action"
          >
            <CheckIcon /> Garder
          </button>
        </div>
      </div>
    </div>
  );
}
