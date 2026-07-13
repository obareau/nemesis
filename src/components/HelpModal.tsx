import { useState } from 'react';
import { HelpIcon } from '../icons';

export function HelpModal({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<'shortcuts' | 'workflow'>('workflow');

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="help-modal" onClick={(e) => e.stopPropagation()}>
        <div className="waveform-header">
          <span><HelpIcon size={14} /> Aide</span>
          <button className="surprise-close" onClick={onClose} title="Fermer">✕</button>
        </div>
        <div className="help-tabs">
          <button className={`help-tab ${tab === 'workflow' ? 'active' : ''}`} onClick={() => setTab('workflow')}>
            📋 Workflow d'import
          </button>
          <button className={`help-tab ${tab === 'shortcuts' ? 'active' : ''}`} onClick={() => setTab('shortcuts')}>
            ⌨️ Raccourcis
          </button>
        </div>

        {tab === 'workflow' && (
          <div className="help-body">
            <div className="help-section">
              <div className="help-section-title">1. Où déposer les nouveaux fichiers</div>
              <div className="help-workflow-step">
                Dans un sous-dossier de <code>/home/olivier/Music/NAVIDROME-SUBWAVE-MP/</code> —
                <strong> jamais ailleurs</strong>. C'est le seul dossier que le conteneur Navidrome
                voit (monté en <code>/music</code>) ; un fichier déposé hors de ce dossier ne sera
                jamais indexé, quoi que fasse Nemesis derrière.
              </div>
              <div className="help-workflow-step help-workflow-example">
                Ex : <code>/home/olivier/Music/NAVIDROME-SUBWAVE-MP/13-juil-2026/</code>
              </div>
            </div>

            <div className="help-section">
              <div className="help-section-title">2. Scanner avec Nemesis</div>
              <div className="help-workflow-step">
                Bouton <strong>Projets</strong> (en haut) → choisis ce nouveau sous-dossier. Laisse
                l'analyse tourner (doublons, débit, empreinte audio, paroles) jusqu'à "Terminé".
              </div>
            </div>

            <div className="help-section">
              <div className="help-section-title">3. Trier et taguer</div>
              <div className="help-workflow-step">
                Traite les doublons détectés (groupe par groupe, Autopilot, ou Revue guidée), puis
                assigne un ou plusieurs <strong>moods</strong> à chaque morceau — colonne "Mood"
                dans la liste, ou panneau Renommage / Peintre. Un morceau sans mood n'ira dans
                aucune playlist Navidrome au push.
              </div>
            </div>

            <div className="help-section">
              <div className="help-section-title">4. Envoyer vers Navidrome</div>
              <div className="help-workflow-step">
                Coche <strong>Envoyer vers Navidrome (playlists mood)</strong> dans le panneau
                Renommage, ou dans "Traiter le groupe". Nemesis relance lui-même le scan Navidrome,
                retrouve chaque morceau par son titre réel (pas son nom de fichier), crée les
                playlists mood manquantes en <strong>public</strong> et y ajoute les morceaux.
              </div>
            </div>

            <div className="help-section">
              <div className="help-section-title">5. Vérifier</div>
              <div className="help-workflow-step">
                Colonne "Mood" pour voir ce qui est assigné localement · icône Navidrome (colonne
                à côté) pour voir ce qui a été poussé · <code>localhost:4533</code> directement
                pour voir les playlists côté Navidrome (Songs / Public doivent correspondre).
              </div>
              <div className="help-workflow-step">
                Subwave lit Navidrome sous le même compte — une playlist mood apparaît côté radio
                dès son prochain rafraîchissement (cache ~30 min, ou redémarre le service Subwave
                pour forcer).
              </div>
            </div>
          </div>
        )}

        {tab === 'shortcuts' && (
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
        )}

        <div className="help-footer">
          {tab === 'shortcuts'
            ? "Inactifs quand le focus est dans un champ de saisie. Le morceau ciblé par note/info/garder/quarantaine est celui en cours de lecture (ou du tirage Surprends-moi / de la fiche info ouverte)."
            : "Le chemin du dossier Navidrome et les identifiants sont fixes pour ce setup — voir README.md si tu changes de machine."}
        </div>
      </div>
    </div>
  );
}
