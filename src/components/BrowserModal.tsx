import type { Shortcut } from '../api';
import { FolderIcon, WarnIcon } from '../icons';

interface BrowserModalProps {
  pathInput: string;
  browseError: string | null;
  shortcuts: Shortcut[];
  browsePath: string;
  browseParent: string | null;
  browseDirs: string[];
  onPathInputChange: (value: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  onLoadPath: (path: string) => void;
  onClose: () => void;
  onConfirmScan: (path: string) => void;
}

export function BrowserModal({
  pathInput, browseError, shortcuts, browsePath, browseParent, browseDirs,
  onPathInputChange, onSubmit, onLoadPath, onClose, onConfirmScan
}: BrowserModalProps) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content browser-modal" onClick={(e) => e.stopPropagation()}>
        <h2><FolderIcon size={18} /> Sélectionner un répertoire</h2>

        <form className="browse-path-form" onSubmit={onSubmit}>
          <input
            className="browse-path-input"
            value={pathInput}
            onChange={(e) => onPathInputChange(e.target.value)}
            spellCheck={false}
          />
          <button type="submit" className="browse-go-btn">Aller</button>
        </form>

        {browseError && <div className="browse-error"><WarnIcon /> {browseError}</div>}

        <div className="browse-body">
          <div className="browse-shortcuts">
            {(['local', 'removable', 'network', 'mount'] as const).map((group) => {
              const items = shortcuts.filter(s => s.group === group);
              if (items.length === 0) return null;
              return (
                <div key={group} className="shortcut-group">
                  <div className="shortcut-group-label">
                    {group === 'local' && 'Local'}
                    {group === 'removable' && 'Clés USB'}
                    {group === 'network' && 'Réseau'}
                    {group === 'mount' && 'Montages'}
                  </div>
                  {items.map((sc) => (
                    <button
                      key={sc.path}
                      className={`shortcut-item ${browsePath === sc.path ? 'active' : ''}`}
                      onClick={() => onLoadPath(sc.path)}
                      title={sc.detail ? `${sc.path} (${sc.detail})` : sc.path}
                    >
                      {sc.label}
                    </button>
                  ))}
                </div>
              );
            })}
          </div>

          <div className="browse-list">
            {browseParent && browseParent !== browsePath && (
              <button className="browse-item browse-up" onClick={() => onLoadPath(browseParent)}>
                <FolderIcon size={14} /> ..
              </button>
            )}
            {browseDirs.map((dir) => (
              <button
                key={dir}
                className="browse-item"
                onClick={() => onLoadPath(`${browsePath}/${dir}`.replace(/\/+/g, '/'))}
              >
                <FolderIcon size={14} /> {dir}
              </button>
            ))}
            {browseDirs.length === 0 && !browseError && (
              <div className="browse-empty">Aucun sous-répertoire</div>
            )}
          </div>
        </div>

        <div className="modal-actions">
          <button className="modal-btn-cancel" onClick={onClose}>
            Annuler
          </button>
          <button className="modal-btn" onClick={() => onConfirmScan(browsePath)}>
            Scanner ce dossier
          </button>
        </div>
      </div>
    </div>
  );
}
