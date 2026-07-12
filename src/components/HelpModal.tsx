import { HelpIcon } from '../icons';

export function HelpModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="help-modal" onClick={(e) => e.stopPropagation()}>
        <div className="waveform-header">
          <span><HelpIcon size={14} /> Raccourcis clavier</span>
          <button className="surprise-close" onClick={onClose} title="Fermer">✕</button>
        </div>
        <div className="help-body">
          <div className="help-section">
            <div className="help-section-title">Note & fiche morceau</div>
            <div className="help-row"><kbd>0</kbd>–<kbd>5</kbd><span>Noter le morceau en cours (0 = effacer)</span></div>
            <div className="help-row"><kbd>I</kbd><span>Ouvrir la fiche info (paroles, bpm, tonalité...)</span></div>
          </div>
          <div className="help-section">
            <div className="help-section-title">Décision garder / quarantaine</div>
            <div className="help-row"><kbd>G</kbd><span>ou</span><kbd>K</kbd><span>Garder</span></div>
            <div className="help-row"><kbd>X</kbd><span>ou</span><kbd>Q</kbd><span>Mettre en quarantaine</span></div>
          </div>
          <div className="help-section">
            <div className="help-section-title">Lecture</div>
            <div className="help-row"><kbd>Espace</kbd><span>Lecture / pause</span></div>
            <div className="help-row"><kbd>←</kbd><span>Reculer de 10s</span></div>
            <div className="help-row"><kbd>→</kbd><span>Avancer de 10s</span></div>
            <div className="help-row"><kbd>↑</kbd><span>Morceau précédent</span></div>
            <div className="help-row"><kbd>↓</kbd><span>Morceau suivant</span></div>
          </div>
          <div className="help-section">
            <div className="help-section-title">Navigation</div>
            <div className="help-row"><kbd>Page ↑</kbd><span>Remonter dans la liste</span></div>
            <div className="help-row"><kbd>Page ↓</kbd><span>Descendre dans la liste</span></div>
            <div className="help-row"><kbd>Échap</kbd><span>Fermer le panneau ouvert</span></div>
            <div className="help-row"><kbd>?</kbd><span>Afficher/masquer cette aide</span></div>
          </div>
        </div>
        <div className="help-footer">
          Inactifs quand le focus est dans un champ de saisie. Le morceau ciblé par note/info/garder/quarantaine
          est celui en cours de lecture (ou du tirage Surprends-moi / de la fiche info ouverte).
        </div>
      </div>
    </div>
  );
}
