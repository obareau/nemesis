import type { RefObject } from 'react';
import type { File, WaveformDiff } from '../api';
import { API, toBase64Url } from '../api';
import { formatTime } from '../format';
import { WaveIcon, WarnIcon, PlayIcon, PauseIcon } from '../icons';

interface CompareModalProps {
  fileA: File;
  fileB: File;
  diffView: boolean;
  diffLoading: boolean;
  diffData: WaveformDiff | null;
  muteLeft: boolean;
  muteRight: boolean;
  compareWaveformA: string | null;
  compareWaveformB: string | null;
  compareCurrentTime: number;
  compareDuration: number;
  comparePlaying: boolean;
  compareBalance: number;
  audioARef: RefObject<HTMLAudioElement | null>;
  audioBRef: RefObject<HTMLAudioElement | null>;
  onClose: () => void;
  onToggleDiffView: () => void;
  onToggleMuteLeft: () => void;
  onToggleMuteRight: () => void;
  onTogglePlay: () => void;
  onScrub: (e: React.MouseEvent<HTMLDivElement>) => void;
  onBalanceChange: (value: number) => void;
}

export function CompareModal({
  fileA, fileB, diffView, diffLoading, diffData, muteLeft, muteRight,
  compareWaveformA, compareWaveformB, compareCurrentTime, compareDuration, comparePlaying, compareBalance,
  audioARef, audioBRef, onClose, onToggleDiffView, onToggleMuteLeft, onToggleMuteRight,
  onTogglePlay, onScrub, onBalanceChange
}: CompareModalProps) {
  const pct = compareDuration ? (compareCurrentTime / compareDuration) * 100 : 0;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="compare-modal" onClick={(e) => e.stopPropagation()}>
        <div className="waveform-header">
          <span>🎧 Comparaison A/B stéréo</span>
          <div className="compare-header-actions">
            <button
              className={`diff-toggle-btn ${diffView ? 'active' : ''}`}
              onClick={onToggleDiffView}
              title="Superposer les deux sonogrammes calés sur t=0 pour repérer une intro coupée, un outro en plus ou une durée différente"
            >
              🔍 Vue diff
            </button>
            <button className="surprise-close" onClick={onClose} title="Fermer">✕</button>
          </div>
        </div>

        {diffView && (
          <div className="diff-section">
            {diffLoading ? (
              <div className="empty-state small"><WaveIcon size={16} /><p>Génération des sonogrammes alignés…</p></div>
            ) : diffData ? (
              <>
                <div className="diff-overlay">
                  <img
                    className="diff-layer"
                    src={diffData.a.image}
                    style={{ width: `${(diffData.a.width / diffData.totalWidth) * 100}%` }}
                    alt=""
                    draggable={false}
                  />
                  <img
                    className="diff-layer"
                    src={diffData.b.image}
                    style={{ width: `${(diffData.b.width / diffData.totalWidth) * 100}%` }}
                    alt=""
                    draggable={false}
                  />
                </div>
                <div className="diff-legend">
                  <span className="diff-legend-item a">■ A seul ({formatTime(diffData.a.duration)})</span>
                  <span className="diff-legend-item both">■ Les deux se recouvrent</span>
                  <span className="diff-legend-item b">■ B seul ({formatTime(diffData.b.duration)})</span>
                </div>
              </>
            ) : (
              <div className="empty-state small"><WarnIcon size={16} /><p>Sonogrammes indisponibles</p></div>
            )}
          </div>
        )}

        <div className="compare-split">
          <div className="compare-side">
            <div className="compare-side-head">
              <span className="compare-channel-label">⬅ Canal gauche</span>
              <button className={`compare-mute-btn ${muteLeft ? 'active' : ''}`} onClick={onToggleMuteLeft} title={muteLeft ? 'Réactiver le canal gauche' : 'Couper le canal gauche'}>
                {muteLeft ? '🔇' : '🔊'}
              </button>
            </div>
            <span className="compare-filename" title={fileA.name}>{fileA.name}</span>
            <div className="compare-mini-waveform">
              {compareWaveformA ? <img src={compareWaveformA} alt="" draggable={false} /> : <div className="scrubber-waveform-placeholder" />}
              <div className="scrubber-head" style={{ left: `${pct}%` }} />
            </div>
          </div>
          <div className="compare-side">
            <div className="compare-side-head">
              <span className="compare-channel-label">Canal droit ➡</span>
              <button className={`compare-mute-btn ${muteRight ? 'active' : ''}`} onClick={onToggleMuteRight} title={muteRight ? 'Réactiver le canal droit' : 'Couper le canal droit'}>
                {muteRight ? '🔇' : '🔊'}
              </button>
            </div>
            <span className="compare-filename" title={fileB.name}>{fileB.name}</span>
            <div className="compare-mini-waveform">
              {compareWaveformB ? <img src={compareWaveformB} alt="" draggable={false} /> : <div className="scrubber-waveform-placeholder" />}
              <div className="scrubber-head" style={{ left: `${pct}%` }} />
            </div>
          </div>
        </div>

        <div className="compare-controls">
          <button className="control-btn primary" onClick={onTogglePlay}>
            {comparePlaying ? <PauseIcon /> : <PlayIcon />}
          </button>
          <div className="scrubber-track compare-scrubber" onClick={onScrub}>
            <div className="scrubber-progress" style={{ width: `${pct}%` }} />
            <div className="scrubber-head" style={{ left: `${pct}%` }} />
          </div>
          <span className="player-scrubber-times compare-times">
            <span>{formatTime(compareCurrentTime)}</span>
            <span>{formatTime(compareDuration)}</span>
          </span>
        </div>

        <div className="compare-crossfader">
          <span className="crossfader-label">A</span>
          <input
            type="range"
            className="crossfader-slider"
            min={-1}
            max={1}
            step={0.01}
            value={compareBalance}
            onChange={(e) => onBalanceChange(Number(e.target.value))}
            title="Balance A/B façon crossfader DJ"
          />
          <span className="crossfader-label">B</span>
        </div>

        <audio ref={audioARef} src={`${API}/stream/${toBase64Url(fileA.path)}`} />
        <audio ref={audioBRef} src={`${API}/stream/${toBase64Url(fileB.path)}`} />
      </div>
    </div>
  );
}
