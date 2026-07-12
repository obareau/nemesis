import type { File } from '../api';
import { formatTime } from '../format';
import { WaveformIcon, PlayIcon, PauseIcon } from '../icons';

interface WaveformEditorModalProps {
  file: File;
  duration: number;
  trimStart: number;
  trimEnd: number;
  fadeIn: number;
  fadeOut: number;
  loading: boolean;
  error: string | null;
  image: string | null;
  applying: boolean;
  isCurrentPlaying: boolean;
  isPlaying: boolean;
  onClose: () => void;
  onTogglePlayPause: () => void;
  onPlay: (filePath: string) => void;
  onSetTrimStart: (n: number) => void;
  onSetTrimEnd: (n: number) => void;
  onSetFadeIn: (n: number) => void;
  onSetFadeOut: (n: number) => void;
  onApply: () => void;
}

export function WaveformEditorModal({
  file, duration, trimStart, trimEnd, fadeIn, fadeOut, loading, error, image, applying,
  isCurrentPlaying, isPlaying, onClose, onTogglePlayPause, onPlay,
  onSetTrimStart, onSetTrimEnd, onSetFadeIn, onSetFadeOut, onApply
}: WaveformEditorModalProps) {
  const newDuration = Math.max(0, duration - trimStart - trimEnd);
  const startPct = duration > 0 ? (trimStart / duration) * 100 : 0;
  const endPct = duration > 0 ? (trimEnd / duration) * 100 : 0;
  const fadeInPct = duration > 0 ? (fadeIn / duration) * 100 : 0;
  const fadeOutPct = duration > 0 ? (fadeOut / duration) * 100 : 0;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="waveform-modal" onClick={(e) => e.stopPropagation()}>
        <div className="waveform-header">
          <span title={file.path}><WaveformIcon size={14} /> {file.name}</span>
          <button className="surprise-close" onClick={onClose} title="Fermer">✕</button>
        </div>

        {loading ? (
          <div className="waveform-loading">Génération du sonogramme…</div>
        ) : error ? (
          <div className="waveform-error">⚠️ {error}</div>
        ) : image ? (
          <>
            <div className="waveform-canvas">
              <img src={image} alt="Sonogramme" draggable={false} />
              {startPct > 0 && <div className="waveform-cut waveform-cut-start" style={{ width: `${startPct}%` }} />}
              {endPct > 0 && <div className="waveform-cut waveform-cut-end" style={{ width: `${endPct}%` }} />}
              {fadeIn > 0 && <div className="waveform-fade waveform-fade-in" style={{ left: `${startPct}%`, width: `${fadeInPct}%` }} />}
              {fadeOut > 0 && <div className="waveform-fade waveform-fade-out" style={{ right: `${endPct}%`, width: `${fadeOutPct}%` }} />}
            </div>

            <div className="waveform-play-row">
              <button
                className="play-btn"
                title={isCurrentPlaying && isPlaying ? 'Pause' : 'Écouter'}
                onClick={() => isCurrentPlaying ? onTogglePlayPause() : onPlay(file.path)}
              >
                {isCurrentPlaying && isPlaying ? <PauseIcon /> : <PlayIcon />}
              </button>
              <span className="waveform-duration">
                {formatTime(newDuration)} <span className="waveform-duration-orig">/ original {formatTime(duration)}</span>
              </span>
            </div>

            <div className="waveform-controls">
              <label>
                Couper au début (s)
                <input
                  type="number" min={0} step={0.5}
                  max={Math.max(0, duration - trimEnd - 0.5)}
                  value={trimStart}
                  onChange={(e) => onSetTrimStart(Math.max(0, Number(e.target.value) || 0))}
                />
              </label>
              <label>
                Couper à la fin (s)
                <input
                  type="number" min={0} step={0.5}
                  max={Math.max(0, duration - trimStart - 0.5)}
                  value={trimEnd}
                  onChange={(e) => onSetTrimEnd(Math.max(0, Number(e.target.value) || 0))}
                />
              </label>
              <label>
                Fade in (s)
                <input
                  type="number" min={0} step={0.5}
                  max={newDuration}
                  value={fadeIn}
                  onChange={(e) => onSetFadeIn(Math.max(0, Number(e.target.value) || 0))}
                />
              </label>
              <label>
                Fade out (s)
                <input
                  type="number" min={0} step={0.5}
                  max={newDuration}
                  value={fadeOut}
                  onChange={(e) => onSetFadeOut(Math.max(0, Number(e.target.value) || 0))}
                />
              </label>
            </div>
          </>
        ) : null}

        <div className="waveform-actions">
          <button className="modal-btn-cancel" onClick={onClose}>Annuler</button>
          <button
            className="modal-btn"
            onClick={onApply}
            disabled={applying || !image || (trimStart === 0 && trimEnd === 0 && fadeIn === 0 && fadeOut === 0)}
          >
            {applying ? 'Application…' : 'Appliquer (réversible)'}
          </button>
        </div>
      </div>
    </div>
  );
}
