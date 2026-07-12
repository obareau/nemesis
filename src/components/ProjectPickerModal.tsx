import type { ProjectSummary } from '../api';
import { FolderIcon, TrashIcon } from '../icons';

interface ProjectPickerModalProps {
  projects: ProjectSummary[];
  confirmDeleteProject: string | null;
  deletingProject: boolean;
  onClose: () => void;
  onSetConfirmDelete: (dirPath: string | null) => void;
  onDeleteProject: (dirPath: string) => void;
  onResume: (dirPath: string) => void;
  onReopen: (dirPath: string) => void;
  onNewFolder: () => void;
}

export function ProjectPickerModal({
  projects, confirmDeleteProject, deletingProject, onClose,
  onSetConfirmDelete, onDeleteProject, onResume, onReopen, onNewFolder
}: ProjectPickerModalProps) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content project-picker-modal" onClick={(e) => e.stopPropagation()}>
        <h2><FolderIcon size={18} /> Projets</h2>
        <p className="project-picker-hint">
          Un dossier scanné = un projet durable. Reprends où tu en étais, ou ouvre un nouveau dossier.
        </p>

        {projects.length === 0 ? (
          <div className="empty-state small">
            <FolderIcon size={22} />
            <p>Aucun projet pour l&apos;instant</p>
          </div>
        ) : (
          <div className="project-list">
            {projects.map((p) => (
              <div key={p.dirPath} className={`project-row ${p.status}`}>
                {confirmDeleteProject === p.dirPath ? (
                  <div className="project-delete-confirm">
                    <span>
                      Supprimer le <strong>suivi</strong> de ce projet ({p.actionCount} action(s) journalisée(s)) ?
                      Les fichiers audio ne seront pas touchés.
                    </span>
                    <div className="project-delete-confirm-actions">
                      <button onClick={() => onSetConfirmDelete(null)} disabled={deletingProject}>
                        Annuler
                      </button>
                      <button
                        className="project-delete-confirm-btn"
                        onClick={() => onDeleteProject(p.dirPath)}
                        disabled={deletingProject}
                      >
                        {deletingProject ? 'Suppression…' : 'Confirmer'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="project-row-info">
                      <span className="project-row-path" title={p.dirPath}>{p.dirPath}</span>
                      <span className="project-row-meta">
                        {p.filesCount} fichiers · {p.duplicatesCount} groupes · {p.actionCount} action(s)
                        {p.status === 'done' && <span className="project-done-badge"> · terminé</span>}
                      </span>
                    </div>
                    <div className="project-row-actions">
                      <button
                        className="top-btn"
                        onClick={() => p.status === 'done' ? onReopen(p.dirPath) : onResume(p.dirPath)}
                      >
                        {p.status === 'done' ? 'Rouvrir' : 'Reprendre'}
                      </button>
                      <button
                        className="project-delete-btn"
                        onClick={() => onSetConfirmDelete(p.dirPath)}
                        title="Supprimer le suivi de ce projet (pas les fichiers)"
                      >
                        <TrashIcon />
                      </button>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="modal-actions">
          <button className="modal-btn-cancel" onClick={onClose}>
            Fermer
          </button>
          <button className="modal-btn" onClick={onNewFolder}>
            <FolderIcon size={14} /> Nouveau dossier
          </button>
        </div>
      </div>
    </div>
  );
}
