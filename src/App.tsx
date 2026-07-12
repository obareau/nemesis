import { useState, useEffect, useRef } from 'react';
import './App.css';

interface File {
  path: string;
  name: string;
  size: number;
  mtime: number;
  fingerprint?: string;
  lyrics?: string;
  rating?: number;
  bpm?: number;
  key?: string;
  scale?: string;
}

type AnalysisMethod = 'size' | 'name' | 'fingerprint' | 'lyrics';

// Miroir de SHOW_MOODS (server.js / subwave settings.ts) — source de vérité réelle
// récupérée via GET /api/moods au montage ; cette liste ne sert que de fallback.
const DEFAULT_MOODS = [
  'energetic', 'calm', 'reflective', 'celebratory', 'romantic', 'spiritual',
  'focus', 'workout', 'driving', 'cooking', 'rainy', 'sunny', 'night',
  'morning', 'evening', 'festival', 'cultural'
];

// Couleur par mood — regroupées par famille d'énergie/caractère plutôt qu'arbitraire :
// rouge/orange = haute énergie, jaune/terracotta = chaud, bleu/vert = calme/posé,
// violet/indigo = introspectif/nocturne.
const MOOD_COLORS: Record<string, string> = {
  energetic: '#e63946',
  workout: '#f3722c',
  driving: '#f8961e',
  festival: '#f72585',
  celebratory: '#ffb703',
  sunny: '#ffd60a',
  morning: '#ffb4a2',
  cooking: '#e07a5f',
  cultural: '#2a9d8f',
  focus: '#457b9d',
  romantic: '#d81159',
  calm: '#8ecae6',
  reflective: '#6d6875',
  spiritual: '#7b2cbf',
  rainy: '#6c757d',
  night: '#22223b',
  evening: '#3a0ca3'
};

function moodColor(mood: string): string {
  return MOOD_COLORS[mood] || '#888';
}

interface Duplicate {
  method: AnalysisMethod;
  files: File[];
  similarity?: number;
}

interface SimilarPair {
  method: AnalysisMethod;
  similarity: number;
  fileA: File;
  fileB: File;
}

interface AnalysisState {
  status: 'idle' | 'scanning' | 'completed' | 'error';
  currentFile: string | null;
  currentStage: string | null;
  fileProgress: number;
  totalProgress: number;
  files: File[];
  duplicates: Duplicate[];
  similarPairs: SimilarPair[];
  error: string | null;
  dirPath?: string | null;
  processedGroups?: string[];
  actionCount?: number;
  resumed?: boolean;
}

interface ProjectSummary {
  dirPath: string;
  status: 'active' | 'done';
  updatedAt: string;
  filesCount: number;
  duplicatesCount: number;
  actionCount: number;
}

interface Shortcut {
  label: string;
  group: 'local' | 'removable' | 'network' | 'mount';
  path: string;
  detail?: string;
}

interface QuarantineItem {
  quarantineName: string;
  originalPath: string;
  size: number;
}

const API = '/api';

// Encode un chemin de fichier en base64url (compatible UTF-8) pour l'URL de streaming —
// doit rester en miroir de Buffer.from(str, 'utf-8').toString('base64url') côté serveur.
function toBase64Url(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  bytes.forEach(b => { binary += String.fromCharCode(b); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Note en étoiles compacte et cliquable — pour trier vite garder/quarantaine
function StarRating({ value = 0, onChange, size = 13 }: { value?: number; onChange: (n: number) => void; size?: number }) {
  return (
    <div className="star-rating" onClick={(e) => e.stopPropagation()}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          className={`star-btn ${n <= value ? 'filled' : ''}`}
          onClick={() => onChange(n === value ? 0 : n)}
          title={`${n} étoile${n > 1 ? 's' : ''}`}
        >
          <svg width={size} height={size} viewBox="0 0 24 24" fill={n <= value ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
            <path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2Z" />
          </svg>
        </button>
      ))}
    </div>
  );
}

function App() {
  const [state, setState] = useState<AnalysisState>({
    status: 'idle',
    currentFile: null,
    currentStage: null,
    fileProgress: 0,
    totalProgress: 0,
    files: [],
    duplicates: [],
    similarPairs: [],
    error: null
  });

  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [playingFilePath, setPlayingFilePath] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [analysisMode, setAnalysisMode] = useState<AnalysisMethod>('size');
  const [authorName, setAuthorName] = useState('');
  const [titleName, setTitleName] = useState('');
  const [selectedMoods, setSelectedMoods] = useState<Set<string>>(new Set());
  const [availableMoods, setAvailableMoods] = useState<string[]>(DEFAULT_MOODS);
  const [generatingAuthor, setGeneratingAuthor] = useState(false);
  const [generatingTitle, setGeneratingTitle] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [pushToNavidrome, setPushToNavidrome] = useState(false);
  const [pushingNavidrome, setPushingNavidrome] = useState(false);
  const [similarMin, setSimilarMin] = useState(80);
  const [similarMax, setSimilarMax] = useState(95);
  const [showSimilar, setShowSimilar] = useState(false);
  const [quarantineItems, setQuarantineItems] = useState<QuarantineItem[]>([]);
  const [showQuarantine, setShowQuarantine] = useState(false);
  const [confirmEmptyTrash, setConfirmEmptyTrash] = useState(false);
  const [emptyingTrash, setEmptyingTrash] = useState(false);
  // Panneau de travail de groupe : traiter un groupe de doublons de bout en bout
  const [workingGroup, setWorkingGroup] = useState<Duplicate | null>(null);
  const [keepPaths, setKeepPaths] = useState<Set<string>>(new Set());
  const [groupAuthor, setGroupAuthor] = useState('');
  const [groupTitle, setGroupTitle] = useState('');
  const [groupMoods, setGroupMoods] = useState<Set<string>>(new Set());
  const [groupQuarantine, setGroupQuarantine] = useState(true);
  const [groupRename, setGroupRename] = useState(false);
  const [groupNavidrome, setGroupNavidrome] = useState(false);
  const [groupProcessing, setGroupProcessing] = useState(false);
  const [groupNotice, setGroupNotice] = useState<string | null>(null);
  const [analyzingPaths, setAnalyzingPaths] = useState<Set<string>>(new Set());
  // Panneau sonogramme — trim (couper début/fin) + fade in/out, réécrit le fichier
  // en place côté serveur (réversible via undo, l'original est sauvegardé à côté).
  const [waveformFile, setWaveformFile] = useState<File | null>(null);
  const [waveformImage, setWaveformImage] = useState<string | null>(null);
  const [waveformDuration, setWaveformDuration] = useState(0);
  const [waveformLoading, setWaveformLoading] = useState(false);
  const [waveformError, setWaveformError] = useState<string | null>(null);
  const [waveformApplying, setWaveformApplying] = useState(false);
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(0);
  const [fadeIn, setFadeIn] = useState(0);
  const [fadeOut, setFadeOut] = useState(0);
  // Panneau info fichier : nom, date, paroles complètes, bpm/tonalité — accessible
  // depuis n'importe quelle ligne (pas seulement les groupes de doublons). Identifié
  // par chemin (pas par objet snapshot) pour rester à jour si le fichier est noté/analysé
  // pendant que le panneau est ouvert.
  const [infoFilePath, setInfoFilePath] = useState<string | null>(null);
  const [processedGroups, setProcessedGroups] = useState<Set<string>>(new Set());
  const [renameNotice, setRenameNotice] = useState<string | null>(null);
  // Projets persistants : un dossier scanné reste un projet de travail durable
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [showProjectPicker, setShowProjectPicker] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [closingProject, setClosingProject] = useState(false);
  const [projectStatus, setProjectStatus] = useState<'active' | 'done' | null>(null);
  const [topNotice, setTopNotice] = useState<string | null>(null);

  const showTopNotice = (msg: string) => {
    setTopNotice(msg);
    setTimeout(() => setTopNotice(null), 5000);
  };
  const [confirmDeleteProject, setConfirmDeleteProject] = useState<string | null>(null);
  const [deletingProject, setDeletingProject] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [browsePath, setBrowsePath] = useState('/home/olivier');
  const [pathInput, setPathInput] = useState('/home/olivier');
  const [browseParent, setBrowseParent] = useState<string | null>(null);
  const [browseDirs, setBrowseDirs] = useState<string[]>([]);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [shortcuts, setShortcuts] = useState<Shortcut[]>([]);
  const audioRef = useRef<HTMLAudioElement>(null);
  const fileListRef = useRef<HTMLDivElement>(null);
  const [showHelp, setShowHelp] = useState(false);

  useEffect(() => {
    fetch(`${API}/moods`)
      .then(res => res.json())
      .then(data => {
        if (Array.isArray(data.moods) && data.moods.length > 0) setAvailableMoods(data.moods);
      })
      .catch(() => { /* garde la liste de secours */ });

    fetch(`${API}/quarantine`)
      .then(res => res.json())
      .then(data => setQuarantineItems(data.items || []))
      .catch(() => { /* panneau optionnel */ });

    // Recharge l'état d'un scan déjà en cours ou terminé côté serveur — sans ça,
    // tout rafraîchissement de page perd l'affichage alors que le backend a gardé les résultats.
    fetch(`${API}/status`)
      .then(res => res.json())
      .then(data => {
        setState(data);
        if (Array.isArray(data.processedGroups)) setProcessedGroups(new Set(data.processedGroups));
        if (data.projectStatus) setProjectStatus(data.projectStatus);
        // Aucun projet actif en mémoire → propose de reprendre un projet existant ou d'en ouvrir un
        if (!data.dirPath) {
          fetch(`${API}/projects`)
            .then(r => r.json())
            .then(pdata => {
              setProjects(pdata.projects || []);
              if ((pdata.projects || []).some((p: ProjectSummary) => p.status === 'active')) {
                setShowProjectPicker(true);
              }
            })
            .catch(() => { /* pas grave, l'utilisateur peut scanner un nouveau dossier */ });
        }
      })
      .catch(() => { /* reste sur l'état idle par défaut */ });
  }, []);

  const loadProjects = async () => {
    try {
      const res = await fetch(`${API}/projects`);
      const data = await res.json();
      setProjects(data.projects || []);
    } catch {
      // liste optionnelle
    }
  };

  // Supprime uniquement le SUIVI du projet (historique d'actions, cache de scan) —
  // ne touche jamais aux fichiers audio réels ni à la corbeille.
  const deleteProject = async (dirPath: string) => {
    setDeletingProject(true);
    try {
      const res = await fetch(`${API}/projects`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dirPath })
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Échec suppression projet');
      }
      setConfirmDeleteProject(null);
      loadProjects();
      if (state.dirPath === dirPath) {
        setState({
          status: 'idle', currentFile: null, currentStage: null, fileProgress: 0,
          totalProgress: 0, files: [], duplicates: [], similarPairs: [], error: null, dirPath: null
        });
        setProcessedGroups(new Set());
      }
    } catch (err) {
      setRenameNotice(`⚠️ ${String(err instanceof Error ? err.message : err)}`);
    } finally {
      setDeletingProject(false);
    }
  };

  const resumeProject = async (dirPath: string, force = false) => {
    setShowProjectPicker(false);
    try {
      const res = await fetch(`${API}/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dirPath, force })
      });
      const data = await res.json();
      setState(data);
      setProjectStatus('active');
      if (Array.isArray(data.processedGroups)) setProcessedGroups(new Set(data.processedGroups));
      showTopNotice(data.resumed ? `✓ Projet repris — ${data.files?.length ?? 0} fichiers` : '✓ Nouveau scan lancé');
    } catch (err) {
      showTopNotice(`⚠️ ${String(err instanceof Error ? err.message : err)}`);
    }
  };

  const reopenDoneProject = async (dirPath: string) => {
    setShowProjectPicker(false);
    try {
      const res = await fetch(`${API}/projects/reopen`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dirPath })
      });
      const data = await res.json();
      setState(data);
      setProjectStatus('active');
      if (Array.isArray(data.processedGroups)) setProcessedGroups(new Set(data.processedGroups));
      showTopNotice('✓ Projet rouvert (repasse actif)');
    } catch (err) {
      showTopNotice(`⚠️ ${String(err instanceof Error ? err.message : err)}`);
    }
  };

  const closeProject = async () => {
    setClosingProject(true);
    try {
      const res = await fetch(`${API}/projects/close`, { method: 'POST' });
      if (!res.ok) throw new Error('Échec clôture projet');
      setProjectStatus('done');
      showTopNotice('✓ Projet marqué comme terminé');
      loadProjects();
    } catch (err) {
      showTopNotice(`⚠️ ${String(err instanceof Error ? err.message : err)}`);
    } finally {
      setClosingProject(false);
    }
  };

  const handleUndo = async () => {
    setUndoing(true);
    try {
      const res = await fetch(`${API}/undo`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Échec undo');

      showTopNotice(`↩️ Annulé : ${data.undone.description}`);
      setState(data.status);
      if (Array.isArray(data.processedGroups)) setProcessedGroups(new Set(data.processedGroups));
    } catch (err) {
      showTopNotice(`⚠️ ${String(err instanceof Error ? err.message : err)}`);
    } finally {
      setUndoing(false);
    }
  };

  useEffect(() => {
    if (state.status !== 'scanning') return;

    const interval = setInterval(async () => {
      try {
        const res = await fetch(`${API}/status`);
        const newState = await res.json();
        setState(newState);
      } catch {
        // backend momentanément injoignable : on garde le dernier état connu
      }
    }, 500);

    return () => clearInterval(interval);
  }, [state.status]);

  // Charge et lance la lecture dès qu'un nouveau fichier est sélectionné.
  // Identifié par CHEMIN, pas par index — un index de position se décale à
  // chaque quarantaine/renommage/undo et finit par (re)jouer le mauvais fichier.
  useEffect(() => {
    if (playingFilePath === null || !audioRef.current) return;
    const audio = audioRef.current;
    audio.load();
    audio.play().then(() => setIsPlaying(true)).catch(() => setIsPlaying(false));
  }, [playingFilePath]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onTimeUpdate = () => setCurrentTime(audio.currentTime);
    const onLoadedMetadata = () => setDuration(audio.duration || 0);
    const onEnded = () => handleNextTrack();
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);

    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('loadedmetadata', onLoadedMetadata);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);

    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('loadedmetadata', onLoadedMetadata);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playingFilePath, state.files.length]);

  const formatTime = (secs: number) => {
    if (!isFinite(secs) || secs < 0) return '0:00';
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const formatDate = (ms: number) => new Date(ms).toLocaleDateString('fr-FR', {
    day: '2-digit', month: '2-digit', year: 'numeric'
  });

  // 'unknown' = étape Paroles jamais passée sur ce fichier (pas candidat doublon),
  // 'instrumental' = transcription vide/trop courte, 'lyrics' = texte réel détecté
  const getLyricsState = (file: File): 'unknown' | 'instrumental' | 'lyrics' => {
    if (file.lyrics == null) return 'unknown';
    return file.lyrics.trim().length < 8 ? 'instrumental' : 'lyrics';
  };

  const togglePlayPause = () => {
    const audio = audioRef.current;
    if (!audio) return;

    if (playingFilePath === null) {
      if (state.files.length > 0) setPlayingFilePath(state.files[0].path);
      return;
    }

    if (audio.paused) {
      audio.play().catch(() => setIsPlaying(false));
    } else {
      audio.pause();
    }
  };

  const handlePrevTrack = () => {
    if (playingFilePath === null || state.files.length === 0) return;
    const idx = state.files.findIndex(f => f.path === playingFilePath);
    if (idx < 0) return;
    setPlayingFilePath(state.files[(idx - 1 + state.files.length) % state.files.length].path);
  };

  const handleNextTrack = () => {
    if (playingFilePath === null || state.files.length === 0) return;
    const idx = state.files.findIndex(f => f.path === playingFilePath);
    if (idx < 0) return;
    setPlayingFilePath(state.files[(idx + 1) % state.files.length].path);
  };


  const selectedFileObjects = state.files.filter(f => selectedFiles.has(f.path));

  // Retrouve l'objet File à jour pour un chemin donné, où qu'il vive dans l'état
  // (liste principale, groupe de doublons, paires similaires, groupe de travail, tirage surprise).
  const findFileByPath = (filePath: string): File | null => {
    for (const f of state.files) if (f.path === filePath) return f;
    for (const d of state.duplicates) for (const f of d.files) if (f.path === filePath) return f;
    for (const p of state.similarPairs) {
      if (p.fileA.path === filePath) return p.fileA;
      if (p.fileB.path === filePath) return p.fileB;
    }
    if (workingGroup) for (const f of workingGroup.files) if (f.path === filePath) return f;
    for (const f of surpriseQueue) if (f.path === filePath) return f;
    return null;
  };

  const toggleMood = (m: string) => {
    const next = new Set(selectedMoods);
    if (next.has(m)) next.delete(m); else next.add(m);
    setSelectedMoods(next);
  };

  const handleGenerateAuthor = async () => {
    setGeneratingAuthor(true);
    setRenameNotice(null);
    try {
      const trackNames = (selectedFileObjects.length > 0 ? selectedFileObjects : state.files)
        .slice(0, 8)
        .map(f => f.name);
      const moodLabel = Array.from(selectedMoods).join(', ');

      const res = await fetch(`${API}/generate-author`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trackNames, mood: moodLabel })
      });
      const data = await res.json();

      if (!res.ok) throw new Error(data.error || 'Échec génération');
      setAuthorName(data.author);
    } catch (err) {
      setRenameNotice(`⚠️ ${String(err instanceof Error ? err.message : err)}`);
    } finally {
      setGeneratingAuthor(false);
    }
  };

  const handleGenerateTitle = async () => {
    setGeneratingTitle(true);
    setRenameNotice(null);
    try {
      const withLyrics = selectedFileObjects.find(f => f.lyrics && f.lyrics.trim());
      if (!withLyrics) {
        throw new Error('Aucun fichier sélectionné n\'a de paroles transcrites (lance l\'étape "Paroles" d\'abord)');
      }

      const res = await fetch(`${API}/generate-title`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lyrics: withLyrics.lyrics })
      });
      const data = await res.json();

      if (!res.ok) throw new Error(data.error || 'Échec génération');
      setTitleName(data.title);
    } catch (err) {
      setRenameNotice(`⚠️ ${String(err instanceof Error ? err.message : err)}`);
    } finally {
      setGeneratingTitle(false);
    }
  };

  const handleBulkRename = async () => {
    if (selectedFiles.size === 0) {
      setRenameNotice('⚠️ Sélectionne au moins un fichier');
      return;
    }
    if (!authorName.trim()) {
      setRenameNotice('⚠️ Renseigne un auteur (ou génère-en un)');
      return;
    }

    setRenaming(true);
    setRenameNotice(null);
    try {
      const moodsArray = Array.from(selectedMoods);

      const res = await fetch(`${API}/rename-bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filePaths: Array.from(selectedFiles),
          author: authorName.trim(),
          title: titleName.trim(),
          moods: moodsArray
        })
      });
      const data = await res.json();

      if (!res.ok) throw new Error(data.error || 'Échec renommage');

      let notice = `✓ ${data.renamed} fichier(s) renommé(s)${data.failed ? `, ${data.failed} échec(s)` : ''}`;
      const newPaths = data.results.filter((r: { success: boolean }) => r.success).map((r: { newPath: string }) => r.newPath);

      if (pushToNavidrome && newPaths.length > 0 && moodsArray.length > 0) {
        setPushingNavidrome(true);
        try {
          const pushRes = await fetch(`${API}/navidrome/push`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filePaths: newPaths, moods: moodsArray })
          });
          const pushData = await pushRes.json();
          if (!pushRes.ok) throw new Error(pushData.error || 'Échec push Navidrome');

          const covered = pushData.results.filter((r: { alreadyInLibrary?: boolean }) => r.alreadyInLibrary).length;
          const toMoods = pushData.pushed - covered;
          notice += ` · ⚖️ Navidrome: ${toMoods} vers playlists mood`;
          if (covered > 0) notice += `, ${covered} déjà présent(s) → Covers`;
          if (pushData.failed) notice += `, ${pushData.failed} échec(s)`;
        } catch (err) {
          notice += ` · ⚠️ Navidrome: ${String(err instanceof Error ? err.message : err)}`;
        } finally {
          setPushingNavidrome(false);
        }
      }

      setRenameNotice(notice);
      setSelectedFiles(new Set());
      setTitleName('');

      // Rafraîchit l'état local avec les nouveaux chemins/noms
      const statusRes = await fetch(`${API}/status`);
      const newState = await statusRes.json();
      setState(newState);
      if (Array.isArray(newState.processedGroups)) setProcessedGroups(new Set(newState.processedGroups));
    } catch (err) {
      setRenameNotice(`⚠️ ${String(err instanceof Error ? err.message : err)}`);
    } finally {
      setRenaming(false);
    }
  };

  // Signature stable d'un groupe (méthode + chemins triés) pour marquer les groupes déjà traités
  const groupSignature = (dup: Duplicate) =>
    `${dup.method}:${dup.files.map(f => f.path).sort().join('|')}`;

  const openGroupPanel = (dup: Duplicate) => {
    setWorkingGroup(dup);
    setKeepPaths(new Set([dup.files[0]?.path].filter(Boolean)));
    setGroupAuthor('');
    setGroupTitle('');
    setGroupMoods(new Set());
    setGroupQuarantine(true);
    setGroupRename(false);
    setGroupNavidrome(false);
    setGroupNotice(null);
  };

  const toggleKeep = (filePath: string) => {
    const next = new Set(keepPaths);
    if (next.has(filePath)) next.delete(filePath); else next.add(filePath);
    setKeepPaths(next);
  };

  const toggleGroupMood = (m: string) => {
    const next = new Set(groupMoods);
    if (next.has(m)) next.delete(m); else next.add(m);
    setGroupMoods(next);
  };

  const playFileByPath = (filePath: string) => {
    setPlayingFilePath(filePath);
  };

  // Mode "Surprends-moi" — tinder-like : 10 morceaux au hasard, écoute + décision
  // garder/quarantaine à la volée, un par un.
  const [surpriseQueue, setSurpriseQueue] = useState<File[]>([]);
  const [surpriseIndex, setSurpriseIndex] = useState(0);
  const [showSurprise, setShowSurprise] = useState(false);
  const [surpriseActing, setSurpriseActing] = useState(false);

  const startSurprise = () => {
    const pool = [...state.files];
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const picked = pool.slice(0, 10);
    if (picked.length === 0) return;
    setSurpriseQueue(picked);
    setSurpriseIndex(0);
    setShowSurprise(true);
    setIsPlaying(true);
    setPlayingFilePath(picked[0].path);
  };

  const closeSurprise = () => {
    setShowSurprise(false);
    setSurpriseQueue([]);
    setSurpriseIndex(0);
  };

  const advanceSurprise = () => {
    const nextIndex = surpriseIndex + 1;
    if (nextIndex >= surpriseQueue.length) {
      closeSurprise();
      return;
    }
    setSurpriseIndex(nextIndex);
    setPlayingFilePath(surpriseQueue[nextIndex].path);
    setIsPlaying(true);
  };

  const surpriseDecide = async (decision: 'keep' | 'quarantine') => {
    const current = surpriseQueue[surpriseIndex];
    if (!current || surpriseActing) return;
    setSurpriseActing(true);
    try {
      if (decision === 'quarantine') {
        await quickQuarantine([current.path]);
      }
      advanceSurprise();
    } finally {
      setSurpriseActing(false);
    }
  };

  const generateGroupAuthor = async () => {
    if (!workingGroup) return;
    setGeneratingAuthor(true);
    try {
      const res = await fetch(`${API}/generate-author`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          trackNames: workingGroup.files.map(f => f.name),
          mood: Array.from(groupMoods).join(', ')
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Échec génération');
      setGroupAuthor(data.author);
    } catch (err) {
      setGroupNotice(`⚠️ ${String(err instanceof Error ? err.message : err)}`);
    } finally {
      setGeneratingAuthor(false);
    }
  };

  const generateGroupTitle = async () => {
    if (!workingGroup) return;
    setGeneratingTitle(true);
    try {
      const withLyrics = workingGroup.files.find(f => f.lyrics && f.lyrics.trim());
      if (!withLyrics) {
        throw new Error('Aucune parole transcrite pour ce groupe (l\'étape "Paroles" doit être terminée)');
      }
      const res = await fetch(`${API}/generate-title`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lyrics: withLyrics.lyrics })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Échec génération');
      setGroupTitle(data.title);
    } catch (err) {
      setGroupNotice(`⚠️ ${String(err instanceof Error ? err.message : err)}`);
    } finally {
      setGeneratingTitle(false);
    }
  };

  // Applique le traitement du groupe : quarantaine des écartés → renommage des gardés → push Navidrome
  const applyGroup = async () => {
    if (!workingGroup) return;
    if (keepPaths.size === 0) {
      setGroupNotice('⚠️ Garde au moins un fichier (ou annule)');
      return;
    }
    if (groupRename && !groupAuthor.trim()) {
      setGroupNotice('⚠️ Renseigne un auteur pour renommer (ou décoche "Renommer")');
      return;
    }
    if (groupNavidrome && groupMoods.size === 0) {
      setGroupNotice('⚠️ Choisis au moins un mood pour l\'envoi Navidrome');
      return;
    }

    setGroupProcessing(true);
    setGroupNotice(null);
    const report: string[] = [];

    try {
      const discarded = workingGroup.files.filter(f => !keepPaths.has(f.path));
      let keptPaths = workingGroup.files.filter(f => keepPaths.has(f.path)).map(f => f.path);

      // 1. Quarantaine des fichiers écartés
      if (groupQuarantine && discarded.length > 0) {
        const res = await fetch(`${API}/quarantine`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filePaths: discarded.map(f => f.path) })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Échec quarantaine');
        report.push(`${data.quarantined} écarté(s)`);
      }

      // 2. Renommage + tag des fichiers gardés
      if (groupRename && groupAuthor.trim()) {
        const res = await fetch(`${API}/rename-bulk`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            filePaths: keptPaths,
            author: groupAuthor.trim(),
            title: groupTitle.trim(),
            moods: Array.from(groupMoods)
          })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Échec renommage');
        report.push(`${data.renamed} renommé(s)`);
        // les chemins ont changé — récupère les nouveaux pour le push
        keptPaths = data.results
          .filter((r: { success: boolean }) => r.success)
          .map((r: { newPath: string }) => r.newPath);
      }

      // 3. Envoi vers Navidrome (playlists mood, détection déjà-présent → Covers)
      if (groupNavidrome && keptPaths.length > 0) {
        const res = await fetch(`${API}/navidrome/push`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filePaths: keptPaths, moods: Array.from(groupMoods) })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Échec push Navidrome');
        const covered = data.results.filter((r: { alreadyInLibrary?: boolean }) => r.alreadyInLibrary).length;
        report.push(`Navidrome: ${data.pushed - covered} vers moods${covered ? `, ${covered} → Covers` : ''}`);
      }

      // Marque le groupe traité (persisté côté serveur) et ferme
      await fetch(`${API}/groups/skip`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: workingGroup.method, filePaths: workingGroup.files.map(f => f.path) })
      });
      setProcessedGroups(prev => new Set(prev).add(groupSignature(workingGroup)));
      setWorkingGroup(null);
      setRenameNotice(`✓ Groupe traité — ${report.join(' · ') || 'aucune action'}`);

      const statusRes = await fetch(`${API}/status`);
      const newState = await statusRes.json();
      setState(newState);
      if (Array.isArray(newState.processedGroups)) setProcessedGroups(new Set(newState.processedGroups));
      loadQuarantineCount();
    } catch (err) {
      setGroupNotice(`⚠️ ${String(err instanceof Error ? err.message : err)}`);
    } finally {
      setGroupProcessing(false);
    }
  };

  const skipGroup = async () => {
    if (!workingGroup) return;
    try {
      await fetch(`${API}/groups/skip`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: workingGroup.method, filePaths: workingGroup.files.map(f => f.path) })
      });
    } catch {
      // le groupe restera visible si l'appel échoue — pas bloquant
    }
    setProcessedGroups(prev => new Set(prev).add(groupSignature(workingGroup)));
    setWorkingGroup(null);
  };

  const loadQuarantineCount = async () => {
    try {
      const res = await fetch(`${API}/quarantine`);
      const data = await res.json();
      setQuarantineItems(data.items || []);
    } catch {
      // silencieux — panneau optionnel
    }
  };

  // Suppression rapide (réversible) — premier passage "dégrossir" du tri en entonnoir,
  // indépendant de tout groupe de doublons : n'importe quel fichier, à tout moment.
  const quickQuarantine = async (filePaths: string[]) => {
    if (filePaths.length === 0) return;
    setRenameNotice(null);
    try {
      const res = await fetch(`${API}/quarantine`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePaths })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Échec mise en quarantaine');

      setRenameNotice(`✓ ${data.quarantined} fichier(s) mis en quarantaine`);
      setSelectedFiles(prev => {
        const next = new Set(prev);
        filePaths.forEach(p => next.delete(p));
        return next;
      });

      const statusRes = await fetch(`${API}/status`);
      const newState = await statusRes.json();
      setState(newState);
      if (Array.isArray(newState.processedGroups)) setProcessedGroups(new Set(newState.processedGroups));
      loadQuarantineCount();
    } catch (err) {
      setRenameNotice(`⚠️ ${String(err instanceof Error ? err.message : err)}`);
    }
  };

  // Note un fichier de 0 à 5 étoiles — met à jour l'affichage immédiatement (optimiste)
  // pour que le clic soit instantané, sans attendre la réponse serveur.
  const rateFile = async (filePath: string, rating: number) => {
    setState(prev => ({
      ...prev,
      files: prev.files.map(f => f.path === filePath ? { ...f, rating } : f),
      duplicates: prev.duplicates.map(d => ({
        ...d,
        files: d.files.map(f => f.path === filePath ? { ...f, rating } : f)
      })),
      similarPairs: prev.similarPairs.map(p => ({
        ...p,
        fileA: p.fileA.path === filePath ? { ...p.fileA, rating } : p.fileA,
        fileB: p.fileB.path === filePath ? { ...p.fileB, rating } : p.fileB
      }))
    }));
    if (workingGroup) {
      setWorkingGroup(prev => prev ? {
        ...prev,
        files: prev.files.map(f => f.path === filePath ? { ...f, rating } : f)
      } : prev);
    }

    try {
      await fetch(`${API}/rating`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath, rating })
      });
    } catch {
      // note perdue en cas de coupure réseau — pas bloquant, pas critique
    }
  };

  // BPM/tonalité à la demande (Essentia, ~6-9s la première fois, instantané ensuite via cache)
  const analyzeAudio = async (filePath: string) => {
    setAnalyzingPaths(prev => new Set(prev).add(filePath));
    try {
      const res = await fetch(`${API}/analyze-audio`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Échec analyse');

      const apply = (f: File) => f.path === filePath ? { ...f, bpm: data.bpm, key: data.key, scale: data.scale } : f;
      setState(prev => ({
        ...prev,
        files: prev.files.map(apply),
        duplicates: prev.duplicates.map(d => ({ ...d, files: d.files.map(apply) })),
        similarPairs: prev.similarPairs.map(p => ({
          ...p,
          fileA: apply(p.fileA),
          fileB: apply(p.fileB)
        }))
      }));
      if (workingGroup) {
        setWorkingGroup(prev => prev ? { ...prev, files: prev.files.map(apply) } : prev);
      }
    } catch (err) {
      setGroupNotice(`⚠️ ${String(err instanceof Error ? err.message : err)}`);
    } finally {
      setAnalyzingPaths(prev => {
        const next = new Set(prev);
        next.delete(filePath);
        return next;
      });
    }
  };

  const openWaveformEditor = async (file: File) => {
    setWaveformFile(file);
    setWaveformImage(null);
    setWaveformError(null);
    setTrimStart(0);
    setTrimEnd(0);
    setFadeIn(0);
    setFadeOut(0);
    setWaveformLoading(true);
    try {
      const res = await fetch(`${API}/waveform/${toBase64Url(file.path)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Échec génération du sonogramme');
      setWaveformImage(data.image);
      setWaveformDuration(data.duration);
    } catch (err) {
      setWaveformError(String(err instanceof Error ? err.message : err));
    } finally {
      setWaveformLoading(false);
    }
  };

  const closeWaveformEditor = () => {
    setWaveformFile(null);
    setWaveformImage(null);
    setWaveformError(null);
  };

  const openInfo = (filePath: string) => setInfoFilePath(filePath);
  const closeInfo = () => setInfoFilePath(null);

  // Raccourcis clavier façon Lightroom — désactivés si le focus est sur un champ de
  // saisie. La liste complète est visible via le bouton Aide (ou touche ?).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;

      // Échap ferme le panneau ouvert le plus prioritaire (du plus au moins bloquant)
      if (e.key === 'Escape') {
        if (showHelp) { e.preventDefault(); setShowHelp(false); return; }
        if (showModal) { e.preventDefault(); setShowModal(false); return; }
        if (showProjectPicker) { e.preventDefault(); setShowProjectPicker(false); return; }
        if (waveformFile) { e.preventDefault(); closeWaveformEditor(); return; }
        if (infoFilePath) { e.preventDefault(); closeInfo(); return; }
        if (showSurprise) { e.preventDefault(); closeSurprise(); return; }
        return;
      }

      if (e.key === '?') {
        e.preventDefault();
        setShowHelp(prev => !prev);
        return;
      }

      // Morceau "actif" pour les raccourcis note/info/garder/quarantaine : le tirage
      // surprise prime, puis le fichier du panneau info ouvert, puis la lecture en cours.
      const activeFilePath = (showSurprise && surpriseQueue[surpriseIndex])
        ? surpriseQueue[surpriseIndex].path
        : infoFilePath || playingFilePath;

      if (e.key === ' ') {
        e.preventDefault();
        togglePlayPause();
        return;
      }

      if (/^[0-5]$/.test(e.key)) {
        if (activeFilePath) {
          e.preventDefault();
          rateFile(activeFilePath, Number(e.key));
        }
        return;
      }

      if (e.key.toLowerCase() === 'i') {
        if (activeFilePath) {
          e.preventDefault();
          openInfo(activeFilePath);
        }
        return;
      }

      if (e.key.toLowerCase() === 'g' || e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (showSurprise) surpriseDecide('keep');
        else if (infoFilePath) closeInfo();
        else if (playingFilePath) handleNextTrack();
        return;
      }

      if (e.key.toLowerCase() === 'x' || e.key.toLowerCase() === 'q') {
        e.preventDefault();
        if (showSurprise) surpriseDecide('quarantine');
        else if (infoFilePath) { const p = infoFilePath; closeInfo(); quickQuarantine([p]); }
        else if (playingFilePath) quickQuarantine([playingFilePath]);
        return;
      }

      const audio = audioRef.current;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (audio) audio.currentTime = Math.max(0, audio.currentTime - 10);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        if (audio) audio.currentTime = Math.min(audio.duration || audio.currentTime + 10, audio.currentTime + 10);
      } else if (e.key === 'ArrowUp') {
        if (playingFilePath !== null) { e.preventDefault(); handlePrevTrack(); }
      } else if (e.key === 'ArrowDown') {
        if (playingFilePath !== null) { e.preventDefault(); handleNextTrack(); }
      } else if (e.key === 'PageUp') {
        e.preventDefault();
        fileListRef.current?.scrollBy({ top: -(fileListRef.current.clientHeight * 0.9), behavior: 'smooth' });
      } else if (e.key === 'PageDown') {
        e.preventDefault();
        fileListRef.current?.scrollBy({ top: fileListRef.current.clientHeight * 0.9, behavior: 'smooth' });
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playingFilePath, state.files.length, showSurprise, surpriseQueue, surpriseIndex, infoFilePath, waveformFile, showModal, showProjectPicker, showHelp]);

  const applyAudioEdit = async () => {
    if (!waveformFile) return;
    setWaveformApplying(true);
    setWaveformError(null);
    try {
      const res = await fetch(`${API}/audio-edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: waveformFile.path, trimStart, trimEnd, fadeIn, fadeOut })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Échec du montage audio');

      const apply = (f: File) => f.path === waveformFile.path
        ? { ...f, size: data.size, mtime: data.mtime, fingerprint: undefined, lyrics: undefined, bpm: undefined, key: undefined, scale: undefined }
        : f;
      setState(prev => ({
        ...prev,
        files: prev.files.map(apply),
        duplicates: prev.duplicates.map(d => ({ ...d, files: d.files.map(apply) })),
        similarPairs: prev.similarPairs.map(p => ({ ...p, fileA: apply(p.fileA), fileB: apply(p.fileB) }))
      }));
      if (workingGroup) {
        setWorkingGroup(prev => prev ? { ...prev, files: prev.files.map(apply) } : prev);
      }
      showTopNotice('✓ Montage audio appliqué (annulable)');
      closeWaveformEditor();
    } catch (err) {
      setWaveformError(String(err instanceof Error ? err.message : err));
    } finally {
      setWaveformApplying(false);
    }
  };

  const handleRestoreQuarantine = async (quarantineName: string) => {
    try {
      const res = await fetch(`${API}/quarantine/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quarantineNames: [quarantineName] })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Échec restauration');
      loadQuarantineCount();
    } catch (err) {
      setRenameNotice(`⚠️ ${String(err instanceof Error ? err.message : err)}`);
    }
  };

  // Suppression physique définitive — seule action du système qui n'est PAS
  // réversible. Nécessite un clic "Vider" suivi d'un clic "Confirmer" séparé,
  // jamais un déclenchement en un seul geste.
  const handleEmptyTrash = async () => {
    setEmptyingTrash(true);
    try {
      const res = await fetch(`${API}/quarantine/empty`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Échec suppression');
      setRenameNotice(`🗑️ ${data.deleted} fichier(s) supprimé(s) définitivement${data.failed ? `, ${data.failed} échec(s)` : ''}`);
      setConfirmEmptyTrash(false);
      loadQuarantineCount();
    } catch (err) {
      setRenameNotice(`⚠️ ${String(err instanceof Error ? err.message : err)}`);
    } finally {
      setEmptyingTrash(false);
    }
  };

  const loadBrowsePath = async (targetPath: string) => {
    try {
      const res = await fetch(`${API}/browse?path=${encodeURIComponent(targetPath)}`);
      const data = await res.json();

      if (!res.ok) {
        setBrowseError(data.error || 'Chemin invalide');
        return;
      }

      setBrowseError(null);
      setBrowsePath(data.currentPath);
      setPathInput(data.currentPath);
      setBrowseParent(data.parent);
      setBrowseDirs(data.dirs);
    } catch (err) {
      setBrowseError(String(err));
    }
  };

  const loadShortcuts = async () => {
    try {
      const res = await fetch(`${API}/browse/shortcuts`);
      const data = await res.json();
      setShortcuts(data.shortcuts || []);
    } catch {
      setShortcuts([]);
    }
  };

  const handleScanDirectory = () => {
    setShowModal(true);
    loadBrowsePath(browsePath);
    loadShortcuts();
  };

  const handlePathSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    loadBrowsePath(pathInput);
  };

  const confirmScan = async (dirPath: string) => {
    setShowModal(false);

    try {
      const res = await fetch(`${API}/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dirPath })
      });

      if (res.ok) {
        const data = await res.json();
        setState(data);
      } else {
        setState(prev => ({ ...prev, error: 'Erreur scan répertoire', status: 'error' }));
      }
    } catch (err) {
      setState(prev => ({ ...prev, error: String(err), status: 'error' }));
    }
  };

  const toggleFileSelection = (filePath: string) => {
    const newSelection = new Set(selectedFiles);
    if (newSelection.has(filePath)) {
      newSelection.delete(filePath);
    } else {
      newSelection.add(filePath);
    }
    setSelectedFiles(newSelection);
  };

  const filteredDuplicates = state.duplicates.filter(
    d => d.method === analysisMode && !processedGroups.has(groupSignature(d))
  );

  // Taille/Nom sont calculés en synchrone dès le scan lancé ; Audio/Paroles sont
  // calculés en fond après leur boucle complète — un mode "vide" pendant qu'il
  // tourne encore ne veut pas dire "aucun doublon", juste "pas encore calculé".
  const modeStageReady = (mode: AnalysisMethod): boolean => {
    if (mode === 'size' || mode === 'name') return true;
    if (mode === 'fingerprint') return state.status === 'completed' || state.totalProgress >= 75;
    if (mode === 'lyrics') return state.status === 'completed';
    return true;
  };
  const currentModeReady = modeStageReady(analysisMode);

  const filteredSimilarPairs = state.similarPairs
    .filter(p => p.similarity >= similarMin && p.similarity <= similarMax)
    .sort((a, b) => b.similarity - a.similarity);

  const statusLabel =
    state.status === 'idle' ? 'Prêt' :
    state.status === 'scanning' ? 'Analyse en cours' :
    state.status === 'completed' ? 'Terminé' : 'Erreur';

  return (
    <div className="app">
      {/* TOP BAR */}
      <header className="top-bar">
        <div className="brand">
          <ScaleIcon />
          <span className="brand-name">Nemesis</span>
        </div>

        <div className="progress-section">
          {state.status === 'scanning' ? (
            <>
              <div className="progress-row">
                <span className="progress-label">Progression globale</span>
                <span className="progress-value">{state.totalProgress}%</span>
              </div>
              <div className="progress-bar">
                <div className="progress-fill" style={{ width: `${state.totalProgress}%` }} />
              </div>

              {state.currentFile ? (
                <>
                  <div className="progress-row secondary">
                    <span className="progress-label">
                      {state.currentStage === 'lyrics' ? '🎤 Paroles' : '🌊 Audio (fingerprint)'} · fichier {state.currentFile}
                    </span>
                    <span className="progress-value">{state.fileProgress}%</span>
                  </div>
                  <div className={`progress-bar stage-bar stage-${state.currentStage}`}>
                    <div className="progress-fill" style={{ width: `${state.fileProgress}%` }} />
                  </div>
                </>
              ) : (
                <div className="progress-row secondary">
                  <span className="progress-label">En attente d’analyse</span>
                  <span className="progress-value" />
                </div>
              )}
            </>
          ) : state.files.length > 0 ? (
            <div className="progress-summary">
              <CheckIcon /> {state.files.length} fichier(s) · {state.duplicates.length} groupe(s) de doublons
            </div>
          ) : (
            <div className="progress-summary muted">Aucune analyse en cours</div>
          )}
        </div>

        <div className="project-actions">
          {state.dirPath && (
            <span className="project-path-chip" title={state.dirPath}>
              {projectStatus === 'done' && '✓ '}{state.dirPath}
            </span>
          )}
          <button
            className="top-btn"
            onClick={() => { loadProjects(); setShowProjectPicker(true); }}
            title="Voir/reprendre un projet"
          >
            <FolderIcon size={12} /> Projets
          </button>
          <button
            className="top-btn"
            onClick={handleUndo}
            disabled={undoing || !state.actionCount}
            title={state.actionCount ? `Annuler : ${state.actionCount} action(s) journalisée(s)` : 'Aucune action à annuler'}
          >
            <UndoIcon /> {undoing ? '…' : `Annuler${state.actionCount ? ` (${state.actionCount})` : ''}`}
          </button>
          {state.dirPath && (
            projectStatus === 'done' ? (
              <button className="top-btn" onClick={() => reopenDoneProject(state.dirPath!)}>
                <FolderIcon size={12} /> Rouvrir
              </button>
            ) : (
              <button className="top-btn done-btn" onClick={closeProject} disabled={closingProject}>
                <CheckIcon /> {closingProject ? '…' : 'Terminer'}
              </button>
            )
          )}
          {topNotice && <span className="top-notice">{topNotice}</span>}
          <button className="top-btn help-btn" onClick={() => setShowHelp(true)} title="Raccourcis clavier (?)">
            <HelpIcon size={13} /> Aide
          </button>
        </div>

        <div className={`status-chip status-${state.status}`}>
          <span className="status-dot" />
          {statusLabel}
        </div>
      </header>

      <div className="main-content">
        {/* LEFT PANEL */}
        <aside className="left-panel">
          <section className="panel-section">
            <h2><LayersIcon /> Mode d&apos;analyse</h2>
            <div className="analysis-modes">
              <button
                className={`mode-btn ${analysisMode === 'size' ? 'active' : ''}`}
                onClick={() => setAnalysisMode('size')}
              >
                <RulerIcon />
                <span className="mode-btn-text">
                  <strong>Taille</strong>
                  <em>grossier · instantané</em>
                </span>
              </button>
              <button
                className={`mode-btn ${analysisMode === 'name' ? 'active' : ''}`}
                onClick={() => setAnalysisMode('name')}
              >
                <TextIcon />
                <span className="mode-btn-text">
                  <strong>Nom</strong>
                  <em>fuzzy match</em>
                </span>
              </button>
              <button
                className={`mode-btn ${analysisMode === 'fingerprint' ? 'active' : ''}`}
                onClick={() => setAnalysisMode('fingerprint')}
              >
                <WaveIcon />
                <span className="mode-btn-text">
                  <strong>Audio</strong>
                  <em>fin · fingerprint</em>
                </span>
              </button>
              <button
                className={`mode-btn ${analysisMode === 'lyrics' ? 'active' : ''}`}
                onClick={() => setAnalysisMode('lyrics')}
              >
                <MicIcon />
                <span className="mode-btn-text">
                  <strong>Paroles</strong>
                  <em>t+15s · 15s</em>
                </span>
              </button>
            </div>
          </section>

          <section className="panel-section">
            <h2><SparkleIcon /> Similaires</h2>
            <button className="similar-toggle" onClick={() => setShowSimilar(!showSimilar)}>
              {showSimilar ? 'Masquer' : 'Afficher'} ({filteredSimilarPairs.length})
            </button>
            {showSimilar && (
              <div className="similar-range">
                <div className="similar-range-row">
                  <span>{similarMin}%</span>
                  <span>—</span>
                  <span>{similarMax}%</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={similarMin}
                  onChange={(e) => setSimilarMin(Math.min(Number(e.target.value), similarMax))}
                />
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={similarMax}
                  onChange={(e) => setSimilarMax(Math.max(Number(e.target.value), similarMin))}
                />
              </div>
            )}
          </section>

          <section className="panel-section">
            <h2><TagIcon /> Renommage</h2>
            <div className="rename-options">
              <label>
                Auteur fictif
                <div className="author-input-row">
                  <input
                    type="text"
                    placeholder="The Spectral Artist #42"
                    value={authorName}
                    onChange={(e) => setAuthorName(e.target.value)}
                  />
                  <button
                    className="generate-btn"
                    onClick={handleGenerateAuthor}
                    disabled={generatingAuthor}
                    title="Générer via Ollama local"
                  >
                    {generatingAuthor ? '…' : <SparkleIcon />}
                  </button>
                </div>
              </label>
              <label>
                Titre (paroles)
                <div className="author-input-row">
                  <input
                    type="text"
                    placeholder="3-4 mots depuis paroles"
                    value={titleName}
                    onChange={(e) => setTitleName(e.target.value)}
                  />
                  <button
                    className="generate-btn"
                    onClick={handleGenerateTitle}
                    disabled={generatingTitle}
                    title="Générer depuis les paroles transcrites"
                  >
                    {generatingTitle ? '…' : <MicIcon />}
                  </button>
                </div>
              </label>
              <label>
                Mood(s) — {selectedMoods.size} sélectionné(s)
                <div className="mood-checkboxes">
                  {availableMoods.map((m) => (
                    <button
                      key={m}
                      type="button"
                      className={`mood-chip ${selectedMoods.has(m) ? 'active' : ''}`}
                      style={{
                        background: selectedMoods.has(m) ? moodColor(m) : undefined,
                        borderColor: moodColor(m)
                      } as any}
                      onClick={() => toggleMood(m)}
                    >
                      <span className="mood-dot" style={{ background: moodColor(m) }} />
                      {m}
                    </button>
                  ))}
                </div>
              </label>
              <label className="navidrome-toggle">
                <input
                  type="checkbox"
                  checked={pushToNavidrome}
                  onChange={(e) => setPushToNavidrome(e.target.checked)}
                />
                Envoyer vers Navidrome (playlists mood)
              </label>
              <button
                className="rename-btn"
                onClick={handleBulkRename}
                disabled={renaming || pushingNavidrome || selectedFiles.size === 0}
              >
                {renaming ? 'Renommage…' : pushingNavidrome ? 'Envoi Navidrome…' : `Renommer la sélection (${selectedFiles.size})`}
              </button>
              {renameNotice && <div className="rename-notice">{renameNotice}</div>}
            </div>
          </section>

          <button className="scan-btn" onClick={handleScanDirectory}>
            <FolderIcon />
            Scanner un répertoire
          </button>
        </aside>

        {/* CENTER PANEL */}
        <section className="center-panel">
          <div className="panel-header">
            <h2>Fichiers détectés</h2>
            <div className="panel-header-actions">
              {selectedFiles.size > 0 && (
                <button
                  className="quick-delete-bulk"
                  onClick={() => quickQuarantine(Array.from(selectedFiles))}
                  title="Mettre la sélection en quarantaine"
                >
                  <TrashIcon /> Quarantaine ({selectedFiles.size})
                </button>
              )}
              {state.files.length > 0 && (
                <button className="surprise-btn" onClick={startSurprise} title="Écoute rapide de 10 morceaux au hasard">
                  🎲 Surprends-moi
                </button>
              )}
              <span className="panel-count">{state.files.length}</span>
            </div>
          </div>

          {state.files.length === 0 ? (
            <div className="empty-state">
              <FolderIcon size={28} />
              <p>Aucun fichier scanné</p>
              <span>Sélectionne un répertoire pour démarrer l&apos;analyse</span>
            </div>
          ) : (
            <div className="file-list">
              <div className="file-list-head">
                <span className="col-check" />
                <span className="col-num">#</span>
                <span className="col-name">Nom</span>
                <span className="col-lyrics-state" />
                <span className="col-rating">Note</span>
                <span className="col-size">Taille</span>
                <span className="col-play" />
                <span className="col-waveform" />
                <span className="col-delete" />
              </div>
              <div className="file-list-body" ref={fileListRef}>
                {state.files.map((file, idx) => {
                  const lyricsState = getLyricsState(file);
                  return (
                  <div
                    key={idx}
                    className={`file-row ${idx % 2 === 0 ? 'even' : 'odd'} ${selectedFiles.has(file.path) ? 'selected' : ''}`}
                    onClick={() => toggleFileSelection(file.path)}
                  >
                    <input
                      type="checkbox"
                      checked={selectedFiles.has(file.path)}
                      onChange={() => toggleFileSelection(file.path)}
                      className="file-checkbox"
                      onClick={(e) => e.stopPropagation()}
                    />
                    <span className="file-num">{idx + 1}</span>
                    <span className="file-name" title={file.name}>{file.name}</span>
                    <button
                      className={`col-lyrics-state state-${lyricsState}`}
                      title="Voir les infos du fichier (paroles, bpm, tonalité...)"
                      onClick={(e) => { e.stopPropagation(); openInfo(file.path); }}
                    >
                      {lyricsState === 'lyrics' ? <MicIcon size={12} /> : lyricsState === 'instrumental' ? <MicOffIcon size={12} /> : <HelpIcon size={12} />}
                    </button>
                    <span className="col-rating">
                      <StarRating value={file.rating} onChange={(n) => rateFile(file.path, n)} size={11} />
                    </span>
                    <span className="file-size">{(file.size / 1024 / 1024).toFixed(1)} MB</span>
                    <button
                      className="play-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        setPlayingFilePath(file.path);
                      }}
                    >
                      <PlayIcon />
                    </button>
                    <button
                      className="waveform-btn"
                      title="Sonogramme — trim / fade"
                      onClick={(e) => {
                        e.stopPropagation();
                        openWaveformEditor(file);
                      }}
                    >
                      <WaveformIcon />
                    </button>
                    <button
                      className="quick-delete-btn"
                      title="Quarantaine rapide"
                      onClick={(e) => {
                        e.stopPropagation();
                        quickQuarantine([file.path]);
                      }}
                    >
                      <TrashIcon />
                    </button>
                  </div>
                  );
                })}
              </div>
            </div>
          )}
        </section>

        {/* RIGHT PANEL */}
        <aside className="right-panel">
          <div className="panel-header">
            <h2>{showSimilar ? `Similaires (${similarMin}-${similarMax}%)` : 'Doublons'}</h2>
            <span className="panel-count">
              {showSimilar ? filteredSimilarPairs.length : filteredDuplicates.length}
            </span>
          </div>

          {showSimilar ? (
            filteredSimilarPairs.length === 0 ? (
              <div className="empty-state small">
                <SparkleIcon />
                <p>Aucune paire dans cette plage</p>
              </div>
            ) : (
              <div className="duplicates-list">
                {filteredSimilarPairs.map((pair, idx) => (
                  <div
                    key={idx}
                    className={`duplicate-group clickable method-${pair.method}`}
                    onClick={() => openGroupPanel({ method: pair.method, similarity: pair.similarity, files: [pair.fileA, pair.fileB] })}
                    title="Cliquer pour traiter cette paire"
                  >
                    <div className="dup-header">
                      <span><SparkleIcon /> {pair.method}</span>
                      <span className="similarity">{pair.similarity}%</span>
                    </div>
                    <div className="dup-file">
                      <span className="dup-name" title={pair.fileA.name}>{pair.fileA.name}</span>
                    </div>
                    <div className="dup-file">
                      <span className="dup-name" title={pair.fileB.name}>{pair.fileB.name}</span>
                    </div>
                  </div>
                ))}
              </div>
            )
          ) : filteredDuplicates.length === 0 ? (
            <div className="empty-state small">
              {currentModeReady ? (
                <>
                  <LinkIcon size={22} />
                  <p>Aucun doublon</p>
                </>
              ) : (
                <>
                  <WaveIcon size={22} />
                  <p>Analyse en cours…</p>
                  <span>
                    L&apos;étape {analysisMode === 'fingerprint' ? 'Audio' : 'Paroles'} n&apos;est pas
                    encore terminée ({state.currentFile || '…'}) — les groupes apparaîtront à la fin.
                  </span>
                </>
              )}
            </div>
          ) : (
            <div className="duplicates-list">
              {filteredDuplicates.map((dup, idx) => (
                <div
                  key={idx}
                  className={`duplicate-group clickable method-${dup.method}`}
                  onClick={() => openGroupPanel(dup)}
                  title="Cliquer pour traiter ce groupe"
                >
                  <div className="dup-header">
                    <span><LinkIcon size={12} /> Groupe {idx + 1}</span>
                    {dup.similarity && <span className="similarity">{dup.similarity}%</span>}
                  </div>
                  {dup.files.map((file, i) => (
                    <div key={i} className="dup-file">
                      <span className="dup-name" title={file.name}>{file.name}</span>
                      <span className="dup-method">{dup.method}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}

          {quarantineItems.length > 0 && (
            <div className="quarantine-panel">
              <button className="quarantine-toggle" onClick={() => setShowQuarantine(!showQuarantine)}>
                <TrashIcon /> Corbeille ({quarantineItems.length})
              </button>
              {showQuarantine && (
                <>
                  <div className="quarantine-list">
                    {quarantineItems.map((item) => (
                      <div key={item.quarantineName} className="quarantine-item">
                        <span className="quarantine-name" title={item.originalPath}>{item.quarantineName}</span>
                        <button onClick={() => handleRestoreQuarantine(item.quarantineName)}>
                          Restaurer
                        </button>
                      </div>
                    ))}
                  </div>

                  {!confirmEmptyTrash ? (
                    <button className="empty-trash-btn" onClick={() => setConfirmEmptyTrash(true)}>
                      <TrashIcon /> Vider la corbeille ({quarantineItems.length})
                    </button>
                  ) : (
                    <div className="empty-trash-confirm">
                      <span>
                        ⚠️ Suppression <strong>définitive</strong> de {quarantineItems.length} fichier(s) —
                        aucun retour possible.
                      </span>
                      <div className="empty-trash-confirm-actions">
                        <button onClick={() => setConfirmEmptyTrash(false)} disabled={emptyingTrash}>
                          Annuler
                        </button>
                        <button className="empty-trash-confirm-btn" onClick={handleEmptyTrash} disabled={emptyingTrash}>
                          {emptyingTrash ? 'Suppression…' : 'Confirmer la suppression'}
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </aside>
      </div>

      {/* BOTTOM BAR (PLAYER) */}
      <footer className="bottom-bar">
        <div className="player-controls">
          <button className="control-btn ghost" onClick={handlePrevTrack} disabled={playingFilePath === null}>
            <PrevIcon />
          </button>
          <button className="control-btn primary" onClick={togglePlayPause}>
            {isPlaying ? <PauseIcon /> : <PlayIcon />}
          </button>
          <button className="control-btn ghost" onClick={handleNextTrack} disabled={playingFilePath === null}>
            <NextIcon />
          </button>
        </div>

        <div className="player-track">
          {(() => {
            const playingFile = playingFilePath ? state.files.find(f => f.path === playingFilePath) : null;
            return playingFile ? (
              <>
                <WaveIcon size={14} />
                <span>{playingFile.name}</span>
              </>
            ) : (
              <span className="muted">Aucun fichier en lecture</span>
            );
          })()}
        </div>

        <div className="player-volume">
          <VolumeIcon />
          <input
            type="range"
            className="volume-slider"
            min="0"
            max="100"
            defaultValue="70"
            onChange={(e) => {
              if (audioRef.current) audioRef.current.volume = Number(e.target.value) / 100;
            }}
          />
          <span className="time-display">{formatTime(currentTime)} / {formatTime(duration)}</span>
        </div>
      </footer>

      <audio ref={audioRef} src={playingFilePath ? `${API}/stream/${toBase64Url(playingFilePath)}` : undefined} />

      {state.error && (
        <div className="error-notification">
          <WarnIcon /> {state.error}
        </div>
      )}

      {/* SÉLECTEUR DE PROJET */}
      {showProjectPicker && (
        <div className="modal-overlay" onClick={() => setShowProjectPicker(false)}>
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
                          <button onClick={() => setConfirmDeleteProject(null)} disabled={deletingProject}>
                            Annuler
                          </button>
                          <button
                            className="project-delete-confirm-btn"
                            onClick={() => deleteProject(p.dirPath)}
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
                            onClick={() => p.status === 'done' ? reopenDoneProject(p.dirPath) : resumeProject(p.dirPath)}
                          >
                            {p.status === 'done' ? 'Rouvrir' : 'Reprendre'}
                          </button>
                          <button
                            className="project-delete-btn"
                            onClick={() => setConfirmDeleteProject(p.dirPath)}
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
              <button className="modal-btn-cancel" onClick={() => setShowProjectPicker(false)}>
                Fermer
              </button>
              <button
                className="modal-btn"
                onClick={() => {
                  setShowProjectPicker(false);
                  handleScanDirectory();
                }}
              >
                <FolderIcon size={14} /> Nouveau dossier
              </button>
            </div>
          </div>
        </div>
      )}

      {/* PANNEAU DE TRAVAIL DE GROUPE */}
      {workingGroup && (
        <div className="modal-overlay" onClick={() => setWorkingGroup(null)}>
          <div className="modal-content group-modal" onClick={(e) => e.stopPropagation()}>
            <h2>
              <LinkIcon size={16} /> Traiter le groupe
              <span className={`group-method-badge method-${workingGroup.method}`}>
                {workingGroup.method}{workingGroup.similarity ? ` · ${workingGroup.similarity}%` : ''}
              </span>
            </h2>

            <div className="group-files">
              <div className="group-files-hint">
                Note pour comparer, coche les fichiers à <strong>garder</strong> — les autres partent en corbeille (réversible)
              </div>
              {[...workingGroup.files]
                .sort((a, b) => (b.rating || 0) - (a.rating || 0))
                .map((file) => {
                  const lyricsState = getLyricsState(file);
                  const isAnalyzing = analyzingPaths.has(file.path);
                  return (
                <div key={file.path} className={`group-file-card ${keepPaths.has(file.path) ? 'kept' : 'discarded'}`}>
                  <div className="group-file-row">
                    <input
                      type="checkbox"
                      checked={keepPaths.has(file.path)}
                      onChange={() => toggleKeep(file.path)}
                    />
                    <button className="play-btn" onClick={() => playFileByPath(file.path)} title="Écouter">
                      <PlayIcon />
                    </button>
                    <StarRating value={file.rating} onChange={(n) => rateFile(file.path, n)} size={12} />
                    <span className="group-file-name" title={file.path}>{file.name}</span>
                    <span className="group-file-size">{(file.size / 1024 / 1024).toFixed(1)} MB</span>
                    <span className="group-file-fate">{keepPaths.has(file.path) ? 'gardé' : 'corbeille'}</span>
                    <button
                      className="waveform-btn"
                      title="Sonogramme — trim / fade"
                      onClick={() => openWaveformEditor(file)}
                    >
                      <WaveformIcon />
                    </button>
                    <button
                      className="group-file-trash"
                      title="Mettre ce fichier en quarantaine tout de suite"
                      onClick={() => quickQuarantine([file.path])}
                    >
                      <TrashIcon />
                    </button>
                  </div>
                  <div className="group-file-meta">
                    <span className="meta-item" title="Date de création">
                      📅 {formatDate(file.mtime)}
                    </span>
                    <button className={`meta-item meta-item-btn lyrics-${lyricsState}`} onClick={() => openInfo(file.path)} title="Voir les infos complètes">
                      {lyricsState === 'lyrics' ? <MicIcon size={11} /> : lyricsState === 'instrumental' ? <MicOffIcon size={11} /> : <HelpIcon size={11} />}
                      {lyricsState === 'lyrics' ? 'Paroles' : lyricsState === 'instrumental' ? 'Instrumental' : 'Paroles inconnues'}
                    </button>
                    {file.bpm ? (
                      <span className="meta-item">🎵 {file.bpm} BPM · {file.key}{file.scale === 'minor' ? 'm' : ''}</span>
                    ) : (
                      <button className="meta-analyze-btn" onClick={() => analyzeAudio(file.path)} disabled={isAnalyzing}>
                        {isAnalyzing ? '…analyse' : '🎵 Analyser BPM/tonalité'}
                      </button>
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
                  onChange={(e) => setGroupQuarantine(e.target.checked)}
                />
                Mettre les non-gardés en corbeille
              </label>

              <label className="group-check">
                <input
                  type="checkbox"
                  checked={groupRename}
                  onChange={(e) => setGroupRename(e.target.checked)}
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
                      onChange={(e) => setGroupAuthor(e.target.value)}
                    />
                    <button className="generate-btn" onClick={generateGroupAuthor} disabled={generatingAuthor} title="Générer via Ollama">
                      {generatingAuthor ? '…' : <SparkleIcon />}
                    </button>
                  </div>
                  <div className="author-input-row">
                    <input
                      type="text"
                      placeholder="Titre (3-4 mots depuis paroles)"
                      value={groupTitle}
                      onChange={(e) => setGroupTitle(e.target.value)}
                    />
                    <button className="generate-btn" onClick={generateGroupTitle} disabled={generatingTitle} title="Générer depuis les paroles">
                      {generatingTitle ? '…' : <MicIcon />}
                    </button>
                  </div>
                </div>
              )}

              <label className="group-check">
                <input
                  type="checkbox"
                  checked={groupNavidrome}
                  onChange={(e) => setGroupNavidrome(e.target.checked)}
                />
                Envoyer les gardés vers Navidrome
              </label>

              {(groupNavidrome || groupRename) && (
                <div className="mood-checkboxes">
                  {availableMoods.map((m) => (
                    <button
                      key={m}
                      type="button"
                      className={`mood-chip ${groupMoods.has(m) ? 'active' : ''}`}
                      style={{
                        background: groupMoods.has(m) ? moodColor(m) : undefined,
                        borderColor: moodColor(m)
                      } as any}
                      onClick={() => toggleGroupMood(m)}
                    >
                      <span className="mood-dot" style={{ background: moodColor(m) }} />
                      {m}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {groupNotice && <div className="group-notice">{groupNotice}</div>}

            <div className="modal-actions">
              <button className="modal-btn-cancel" onClick={() => setWorkingGroup(null)} disabled={groupProcessing}>
                Annuler
              </button>
              <button className="modal-btn-cancel" onClick={skipGroup} disabled={groupProcessing}>
                Ignorer ce groupe
              </button>
              <button className="modal-btn" onClick={applyGroup} disabled={groupProcessing}>
                {groupProcessing ? 'Traitement…' : 'Appliquer'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal-content browser-modal" onClick={(e) => e.stopPropagation()}>
            <h2><FolderIcon size={18} /> Sélectionner un répertoire</h2>

            <form className="browse-path-form" onSubmit={handlePathSubmit}>
              <input
                className="browse-path-input"
                value={pathInput}
                onChange={(e) => setPathInput(e.target.value)}
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
                          onClick={() => loadBrowsePath(sc.path)}
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
                  <button className="browse-item browse-up" onClick={() => loadBrowsePath(browseParent)}>
                    <FolderIcon size={14} /> ..
                  </button>
                )}
                {browseDirs.map((dir) => (
                  <button
                    key={dir}
                    className="browse-item"
                    onClick={() => loadBrowsePath(`${browsePath}/${dir}`.replace(/\/+/g, '/'))}
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
              <button className="modal-btn-cancel" onClick={() => setShowModal(false)}>
                Annuler
              </button>
              <button className="modal-btn" onClick={() => confirmScan(browsePath)}>
                Scanner ce dossier
              </button>
            </div>
          </div>
        </div>
      )}

      {showSurprise && surpriseQueue[surpriseIndex] && (() => {
        const track = surpriseQueue[surpriseIndex];
        const lyricsState = getLyricsState(track);
        return (
          <div className="modal-overlay">
            <div className="surprise-modal">
              <div className="surprise-header">
                <span>🎲 Surprends-moi</span>
                <span className="surprise-progress">{surpriseIndex + 1} / {surpriseQueue.length}</span>
                <button className="surprise-close" onClick={closeSurprise} title="Fermer">✕</button>
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
                  <button className="play-btn" onClick={togglePlayPause} title={isPlaying ? 'Pause' : 'Lecture'}>
                    {isPlaying ? <PauseIcon /> : <PlayIcon />}
                  </button>
                  <StarRating value={track.rating} onChange={(n) => rateFile(track.path, n)} size={16} />
                </div>
              </div>

              <div className="surprise-actions">
                <button
                  className="surprise-btn-quarantine"
                  onClick={() => surpriseDecide('quarantine')}
                  disabled={surpriseActing}
                >
                  <TrashIcon /> Quarantaine
                </button>
                <button
                  className="surprise-btn-keep"
                  onClick={() => surpriseDecide('keep')}
                  disabled={surpriseActing}
                >
                  <CheckIcon /> Garder
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {waveformFile && (() => {
        const newDuration = Math.max(0, waveformDuration - trimStart - trimEnd);
        const startPct = waveformDuration > 0 ? (trimStart / waveformDuration) * 100 : 0;
        const endPct = waveformDuration > 0 ? (trimEnd / waveformDuration) * 100 : 0;
        const fadeInPct = waveformDuration > 0 ? (fadeIn / waveformDuration) * 100 : 0;
        const fadeOutPct = waveformDuration > 0 ? (fadeOut / waveformDuration) * 100 : 0;
        const isCurrentPlaying = playingFilePath === waveformFile.path;
        return (
          <div className="modal-overlay" onClick={closeWaveformEditor}>
            <div className="waveform-modal" onClick={(e) => e.stopPropagation()}>
              <div className="waveform-header">
                <span title={waveformFile.path}><WaveformIcon size={14} /> {waveformFile.name}</span>
                <button className="surprise-close" onClick={closeWaveformEditor} title="Fermer">✕</button>
              </div>

              {waveformLoading ? (
                <div className="waveform-loading">Génération du sonogramme…</div>
              ) : waveformError ? (
                <div className="waveform-error">⚠️ {waveformError}</div>
              ) : waveformImage ? (
                <>
                  <div className="waveform-canvas">
                    <img src={waveformImage} alt="Sonogramme" draggable={false} />
                    {startPct > 0 && <div className="waveform-cut waveform-cut-start" style={{ width: `${startPct}%` }} />}
                    {endPct > 0 && <div className="waveform-cut waveform-cut-end" style={{ width: `${endPct}%` }} />}
                    {fadeIn > 0 && <div className="waveform-fade waveform-fade-in" style={{ left: `${startPct}%`, width: `${fadeInPct}%` }} />}
                    {fadeOut > 0 && <div className="waveform-fade waveform-fade-out" style={{ right: `${endPct}%`, width: `${fadeOutPct}%` }} />}
                  </div>

                  <div className="waveform-play-row">
                    <button
                      className="play-btn"
                      title={isCurrentPlaying && isPlaying ? 'Pause' : 'Écouter'}
                      onClick={() => isCurrentPlaying ? togglePlayPause() : playFileByPath(waveformFile.path)}
                    >
                      {isCurrentPlaying && isPlaying ? <PauseIcon /> : <PlayIcon />}
                    </button>
                    <span className="waveform-duration">
                      {formatTime(newDuration)} <span className="waveform-duration-orig">/ original {formatTime(waveformDuration)}</span>
                    </span>
                  </div>

                  <div className="waveform-controls">
                    <label>
                      Couper au début (s)
                      <input
                        type="number" min={0} step={0.5}
                        max={Math.max(0, waveformDuration - trimEnd - 0.5)}
                        value={trimStart}
                        onChange={(e) => setTrimStart(Math.max(0, Number(e.target.value) || 0))}
                      />
                    </label>
                    <label>
                      Couper à la fin (s)
                      <input
                        type="number" min={0} step={0.5}
                        max={Math.max(0, waveformDuration - trimStart - 0.5)}
                        value={trimEnd}
                        onChange={(e) => setTrimEnd(Math.max(0, Number(e.target.value) || 0))}
                      />
                    </label>
                    <label>
                      Fade in (s)
                      <input
                        type="number" min={0} step={0.5}
                        max={newDuration}
                        value={fadeIn}
                        onChange={(e) => setFadeIn(Math.max(0, Number(e.target.value) || 0))}
                      />
                    </label>
                    <label>
                      Fade out (s)
                      <input
                        type="number" min={0} step={0.5}
                        max={newDuration}
                        value={fadeOut}
                        onChange={(e) => setFadeOut(Math.max(0, Number(e.target.value) || 0))}
                      />
                    </label>
                  </div>
                </>
              ) : null}

              <div className="waveform-actions">
                <button className="modal-btn-cancel" onClick={closeWaveformEditor}>Annuler</button>
                <button
                  className="modal-btn"
                  onClick={applyAudioEdit}
                  disabled={waveformApplying || !waveformImage || (trimStart === 0 && trimEnd === 0 && fadeIn === 0 && fadeOut === 0)}
                >
                  {waveformApplying ? 'Application…' : 'Appliquer (réversible)'}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {infoFilePath && (() => {
        const file = findFileByPath(infoFilePath);
        if (!file) { closeInfo(); return null; }
        const lyricsState = getLyricsState(file);
        const isAnalyzing = analyzingPaths.has(file.path);
        return (
          <div className="modal-overlay" onClick={closeInfo}>
            <div className="info-modal" onClick={(e) => e.stopPropagation()}>
              <div className="info-header">
                <span title={file.path}><HelpIcon size={14} /> {file.name}</span>
                <div className="info-header-actions">
                  <button className="play-btn" onClick={() => playFileByPath(file.path)} title="Écouter">
                    <PlayIcon />
                  </button>
                  <button className="waveform-btn" onClick={() => { closeInfo(); openWaveformEditor(file); }} title="Sonogramme — trim / fade">
                    <WaveformIcon />
                  </button>
                  <button className="surprise-close" onClick={closeInfo} title="Fermer">✕</button>
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
                    <StarRating value={file.rating} onChange={(n) => rateFile(file.path, n)} size={14} />
                  </span>
                </div>
                <div className="info-row">
                  <span className="info-label">BPM / Tonalité</span>
                  <span className="info-value">
                    {file.bpm ? (
                      `${file.bpm} BPM · ${file.key}${file.scale === 'minor' ? 'm' : ''}`
                    ) : (
                      <button className="meta-analyze-btn" onClick={() => analyzeAudio(file.path)} disabled={isAnalyzing}>
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
                </div>
              </div>

              <div className="surprise-actions">
                <button
                  className="surprise-btn-quarantine"
                  onClick={() => { closeInfo(); quickQuarantine([file.path]); }}
                  title="Mettre en quarantaine"
                >
                  <TrashIcon /> Quarantaine
                </button>
                <button
                  className="surprise-btn-keep"
                  onClick={closeInfo}
                  title="Garder — fermer sans action"
                >
                  <CheckIcon /> Garder
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {showHelp && (
        <div className="modal-overlay" onClick={() => setShowHelp(false)}>
          <div className="help-modal" onClick={(e) => e.stopPropagation()}>
            <div className="waveform-header">
              <span><HelpIcon size={14} /> Raccourcis clavier</span>
              <button className="surprise-close" onClick={() => setShowHelp(false)} title="Fermer">✕</button>
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
      )}
    </div>
  );
}

/* --- Icônes SVG monochromes (héritent currentColor) --- */

function ScaleIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v18M5 21h14M5 7l-3 6a3 3 0 0 0 6 0l-3-6ZM19 7l-3 6a3 3 0 0 0 6 0l-3-6ZM5 7h14" />
      <path d="M12 3l7 4M12 3 5 7" />
    </svg>
  );
}

function LayersIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m12 2 9 5-9 5-9-5 9-5Z" /><path d="m3 12 9 5 9-5" /><path d="m3 17 9 5 9-5" />
    </svg>
  );
}

function RulerIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21.3 8.7 15.3 2.7a1 1 0 0 0-1.4 0L2.7 13.9a1 1 0 0 0 0 1.4l6 6a1 1 0 0 0 1.4 0L21.3 10.1a1 1 0 0 0 0-1.4Z" />
      <path d="m14.5 8.5 1 1M11.5 11.5l1 1M8.5 14.5l1 1" />
    </svg>
  );
}

function TextIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 7V4h16v3M9 20h6M12 4v16" />
    </svg>
  );
}

function WaveIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12h2l2-7 3 15 3-11 2 5h2M18 12h4" />
    </svg>
  );
}

function MicIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
      <path d="M19 10v1a7 7 0 0 1-14 0v-1M12 18v4M8 22h8" />
    </svg>
  );
}

function MicOffIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 1l22 22M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V5a3 3 0 0 0-5.94-.6" />
      <path d="M19 10v1a7 7 0 0 1-1.11 3.79M5 10v1a7 7 0 0 0 7 7c.68 0 1.33-.09 1.95-.26M12 18v4M8 22h8" />
    </svg>
  );
}

function HelpIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01" />
    </svg>
  );
}

function TagIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2H3v9l10.29 10.3a1 1 0 0 0 1.42 0l7.29-7.3a1 1 0 0 0 0-1.4L12 2Z" />
      <circle cx="7.5" cy="7.5" r="1.5" />
    </svg>
  );
}

function SparkleIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2l1.6 5.4L19 9l-5.4 1.6L12 16l-1.6-5.4L5 9l5.4-1.6L12 2Z" />
      <path d="M19 15l.7 2.3L22 18l-2.3.7L19 21l-.7-2.3L16 18l2.3-.7L19 15Z" opacity="0.6" />
    </svg>
  );
}

function FolderIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
      <path d="M8 5v14l11-7L8 5Z" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
      <path d="M7 5h3v14H7zM14 5h3v14h-3z" />
    </svg>
  );
}

function WaveformIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12h2M6 8v8M10 5v14M14 8v8M18 10v4M22 12h-2" />
    </svg>
  );
}

function PrevIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <path d="M6 6h2v12H6zM20 6v12L9 12l11-6Z" />
    </svg>
  );
}

function NextIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <path d="M16 6h2v12h-2zM4 6v12l11-6L4 6Z" />
    </svg>
  );
}

function VolumeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 5 6 9H2v6h4l5 4V5ZM19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
    </svg>
  );
}

function LinkIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6h16Z" />
    </svg>
  );
}

function UndoIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function WarnIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
      <path d="M12 9v4M12 17h.01" />
    </svg>
  );
}

export default App;
