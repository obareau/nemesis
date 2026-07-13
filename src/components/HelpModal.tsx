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
              <div className="help-section-title">1. Déposer</div>
              <div className="help-workflow-step">
                Dépose tes nouveaux fichiers audio dans <code>/home/olivier/music-import</code>
                (n'importe quel sous-dossier — <code>PLAYLISTS-RADIO</code> est ignoré). C'est tout :
                l'onglet <strong>Import</strong> les voit automatiquement au prochain retour sur la fenêtre.
              </div>
            </div>

            <div className="help-section">
              <div className="help-section-title">2. Onglet Import</div>
              <div className="help-workflow-step">
                Pré-écoute chaque morceau (bouton play), <strong>Suggérer</strong> lance l'analyse
                BPM/tonalité (~8s) puis propose des moods via Ollama — pré-coché pour ce fichier
                seul. <strong>Analyser + suggérer tout</strong> (en haut) fait pareil sur toute la
                liste en fond, annulable, sans rien pré-cocher (des dizaines de fichiers aux
                ambiances différentes n'ont pas à finir dans le même jeu de moods) : clique la
                ligne "suggéré" d'un morceau pour le cocher et reprendre son mood.
              </div>
            </div>

            <div className="help-section">
              <div className="help-section-title">3. Envoyer vers la radio</div>
              <div className="help-workflow-step">
                Un seul bouton : Nemesis déplace les fichiers vers
                <code>NAVIDROME-SUBWAVE-MP/&lt;jj-mois-aaaa&gt;/</code>, relance le scan Navidrome,
                crée les playlists mood manquantes en <strong>public</strong> et y ajoute les morceaux.
                Un doublon déjà au catalogue part en playlist <strong>Covers</strong> au lieu des moods.
              </div>
            </div>

            <div className="help-section">
              <div className="help-section-title">4. Vérifier</div>
              <div className="help-workflow-step">
                Le résumé sous le bouton dit ce qui est parti où. Côté Navidrome :
                <code>localhost:4533</code> → Playlists (Songs/Public doivent correspondre).
                Subwave lit Navidrome sous le même compte — une playlist apparaît côté radio à son
                prochain rafraîchissement (cache ~30 min, ou redémarre le service Subwave pour forcer).
              </div>
            </div>

            <div className="help-section">
              <div className="help-section-title">5. Onglet Curation (occasionnel)</div>
              <div className="help-workflow-step">
                L'écran complet historique pour les grosses sessions de tri : détection de doublons
                (Autopilot, Revue guidée), notes, renommage, trim/fade, quarantaine réversible.
                Pas nécessaire pour importer des nouveautés.
              </div>
              <div className="help-workflow-step">
                <strong>Dédup bibliothèque Navidrome</strong> (section "Bibliothèque" de la
                colonne de gauche) : compare l'empreinte audio de tout le catalogue déjà envoyé
                vers Navidrome, pas juste les titres (deux morceaux au même nom généré par Suno
                ne sont pas forcément le même son) — montre les vrais doublons confirmés avec
                leurs playlists, garde le meilleur, quarantaine le reste et le retire des
                playlists concernées.
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
