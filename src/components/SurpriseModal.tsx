import type { File } from '../api';
import { formatDate, getLyricsState } from '../format';
import { StarRating, MicIcon, MicOffIcon, HelpIcon, PlayIcon, PauseIcon, TrashIcon, CheckIcon } from '../icons';

interface SurpriseModalProps {
  track: File;
  index: number;
  total: number;
  isPlaying: boolean;
  acting: boolean;
  onTogglePlayPause: () => void;
  onRate: (filePath: string, rating: number) => void;
  onClose: () => void;
  onDecide: (decision: 'keep' | 'quarantine') => void;
}

export function SurpriseModal({ track, index, total, isPlaying, acting, onTogglePlayPause, onRate, onClose, onDecide }: SurpriseModalProps) {
  const lyricsState = getLyricsState(track);
  return (
    <div className="modal-overlay">
      <div className="surprise-modal">
        <div className="surprise-header">
          <span>🎲 Surprends-moi</span>
          <span className="surprise-progress">{index + 1} / {total}</span>
          <button className="surprise-close" onClick={onClose} title="Fermer">✕</button>
        </div>

        <div className="surprise-card">
          <div className="surprise-track-name" title={track.path}>{track.name}</div>
          <div className="surprise-meta">
            <span className="meta-item">📅 {formatDate(track.mtime)}</span>
            <span className={`meta-item lyrics-${lyricsState}`}>
              {lyricsState === 'lyrics' ? <MicIcon size={11} /> : lyricsState === 'instrumental' ? <MicOffIcon size={11} /> : <HelpIcon size={11} />}
              {lyricsState === 'lyrics' ? 'Paroles' : lyricsState === 'instrumental' ? 'Instrumental' : 'Paroles inconnues'}
            </span>
            {track.bpm && <span className="meta-item">🎵 {track.bpm} BPM · {track.key}{track.scale === 'minor' ? 'm' : ''}</span>}
          </div>
          <div className="surprise-play-row">
            <button className="play-btn" onClick={onTogglePlayPause} title={isPlaying ? 'Pause' : 'Lecture'}>
              {isPlaying ? <PauseIcon /> : <PlayIcon />}
            </button>
            <StarRating value={track.rating} onChange={(n) => onRate(track.path, n)} size={16} />
          </div>
        </div>

        <div className="surprise-actions">
          <button
            className="surprise-btn-quarantine"
            onClick={() => onDecide('quarantine')}
            disabled={acting}
          >
            <TrashIcon /> Quarantaine
          </button>
          <button
            className="surprise-btn-keep"
            onClick={() => onDecide('keep')}
            disabled={acting}
          >
            <CheckIcon /> Garder
          </button>
        </div>
      </div>
    </div>
  );
}
