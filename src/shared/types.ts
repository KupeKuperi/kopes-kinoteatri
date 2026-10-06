// Data contracts shared by the main process (engine + data readers) and the renderer.

export interface BinaryInfo {
  path: string;
  version: string | null;
  source: 'override' | 'path' | 'known-location';
}

export type EngineState = 'starting' | 'ready' | 'busy' | 'stopped' | 'error' | 'missing';

export interface EngineStatus {
  state: EngineState;
  binary: BinaryInfo | null;
  /** Human-readable name of the operation the engine is running. */
  activity: string | null;
  /** Spinner text the TUI is currently showing, e.g. `Loading streams...`. */
  tuiStatus: string | null;
  mode: 'streaming' | 'tv' | null;
  provider: string | null;
  error: string | null;
}

export interface EnvironmentInfo {
  configDir: string;
  dataDir: string;
  downloadDir: string;
  ytDlp: string | null;
  ffmpeg: string | null;
  players: { vlc: string | null; mpv: string | null; iina: string | null };
}

// ── Search / browse ─────────────────────────────────────────────────────────

export interface ResultItem {
  /** Position in the TUI's result list (what the engine navigates to). */
  index: number;
  title: string;
  year?: string;
  /** Display type, e.g. `Movie`, `Series`. */
  type?: string;
  rating?: string;
  provider?: string;
  /** Present for history entries, e.g. `S04E08`. */
  episodeTag?: string;
  subjectId?: string;
  cover?: string;
  /** Release notes worth showing on the poster, e.g. `CAM` (recorded in a cinema). */
  badges?: string[];
  /** IMDb rating, when the title could be matched to IMDb. */
  imdb?: ImdbRating;
}

export interface ImdbRating {
  id: string;
  rating: number;
  votes: number;
}

export interface ResultsView {
  /** Identity of an engine list; pass it back when opening an item so the right list is used. */
  key?: string;
  /** `imdb` lists come from IMDb, not from the engine; opening one searches the active source. */
  source: 'search' | 'browse' | 'imdb';
  /** Query text or browse category label. */
  label: string;
  provider: string | null;
  total: number;
  items: ResultItem[];
  /** Message the TUI showed instead of results, e.g. `No results for …`. */
  message?: string;
  /** Set when the typed query found nothing and `label` is the looser query that did. */
  requested?: string;
}

/** A title suggested while typing in the search box. */
export interface Suggestion {
  title: string;
  year?: string;
  kind?: string;
  cover?: string;
  subjectId?: string;
  /** Where it came from: titles moviebox-tui has seen before, or a live search. */
  source: 'known' | 'live';
}

export interface BrowseCategory {
  index: number;
  group: string;
  label: string;
}

// ── Details ────────────────────────────────────────────────────────────────

export interface Episode {
  season: number;
  episode: number;
  title?: string;
}

export interface Season {
  season: number;
  episodes: Episode[];
}

export interface AudioTrack {
  subjectId: string;
  label: string;
}

export interface DetailsInfo {
  subjectId: string;
  provider: string;
  title: string;
  /** `movie` | `series` as stored by the TUI. */
  kind: string;
  year?: string;
  description?: string;
  rating?: string;
  duration?: string;
  cover?: string;
  tags: string[];
  seasons: Season[];
  audio: AudioTrack[];
  tagline?: string;
  director?: string;
  cast?: string;
  /** Source's summary of available formats, e.g. `BluRay | 2160p 4K UHD DV HDR10 | x265`. */
  formats?: string;
  /** Spoken languages the source lists, e.g. `Hindi | English`. */
  languages?: string;
  imdb?: ImdbRating;
}

export type PaneName = 'Audio' | 'Seasons' | 'Episodes' | 'Streams';

export type StreamsStatus = 'idle' | 'loading' | 'ready' | 'empty' | 'choose-audio';

export interface StreamOption {
  index: number;
  /** Resolution as read from the release name when present (the engine labels some 1080p releases "4K"). */
  resolution: string;
  /** Audio languages of this release, when the source lists them. */
  audio?: string;
  size?: string;
  sizeBytes?: number;
  tags?: string;
  source?: string;
  release?: string;
  codec?: string;
  season?: number;
  episode?: number;
}

export interface Caption {
  language: string;
}

/** The engine asks which subtitles to load before it plays or downloads a MovieBox title. */
export interface SubtitleChoice {
  purpose: 'play' | 'download';
  /** Title being played or downloaded. */
  title: string;
  /** Option labels; the first is always "No subtitles". */
  options: string[];
}

/** Live state of the TUI's details screen, read back from the terminal. */
export interface DetailsState {
  title: string;
  meta: string;
  panes: PaneName[];
  focus: PaneName | null;
  audioLabels: string[];
  selectedAudio: number | null;
  streamsStatus: StreamsStatus;
  streamsMessage?: string;
  favorite: boolean;
}

export interface DetailsView {
  /** Index in the result list this view was opened from. */
  index: number;
  info: DetailsInfo | null;
  state: DetailsState;
  streams: StreamOption[];
  /** Season/episode the stream list belongs to (series only). */
  current: { season: number; episode: number } | null;
  captions: Caption[];
}

export type DownloadScope = 'stream' | 'episode' | 'season';

// ── Library (files written by the TUI) ─────────────────────────────────────

export interface HistoryEntry {
  key: string;
  provider: string;
  subjectId: string;
  title: string;
  cover?: string;
  kind: 'movie' | 'series' | 'unknown';
  year?: string;
  season?: number;
  episode?: number;
  timestamp: number;
  durationSeconds?: number;
  progressSeconds?: number;
  completed: boolean;
  release?: string;
}

export interface FavoriteEntry {
  key: string;
  provider: string;
  subjectId: string;
  title: string;
  cover?: string;
  kind: 'movie' | 'series' | 'unknown';
  year?: string;
  addedAt?: number;
}

export interface LibrarySnapshot {
  continueWatching: HistoryEntry[];
  history: HistoryEntry[];
  favorites: FavoriteEntry[];
}

// ── Downloads ──────────────────────────────────────────────────────────────

export interface ActiveDownload {
  /** The file being downloaded (from the TUI's "Download started" notice), else the panel's title. */
  label: string;
  percent: number | null;
  status: string;
  /** Done: the TUI keeps the panel up for a few seconds after a download completes. */
  finished: boolean;
}

export interface DownloadFile {
  name: string;
  /** Unfinished downloads: the path the finished file will have. */
  path: string;
  size: number;
  modified: number;
  /** Not finished (stopped or failed): the pieces stay so downloading it again continues. */
  partial: boolean;
  /** Number of pieces an unfinished download left behind. */
  pieces?: number;
  /** Languages of the subtitle files saved beside it ("en", …). */
  subtitles?: string[];
}

// ── Live TV ────────────────────────────────────────────────────────────────

export interface TvPlaylist {
  source: string;
  name?: string;
  enabled: boolean;
  channelCount?: number;
}

export interface TvChannel {
  index: number;
  name: string;
  group?: string;
  logo?: string;
  playlist?: string;
}

export interface TvView {
  playlists: TvPlaylist[];
  channels: TvChannel[];
  message?: string;
}

// ── Settings (config.json owned by the TUI) ────────────────────────────────

export type PlayerName = 'vlc' | 'mpv' | 'iina' | 'android';

export interface TuiSettings {
  defaultPlayer: PlayerName;
  vlcPath: string | null;
  mpvPath: string | null;
  iinaPath: string | null;
  downloadDir: string | null;
  autoUpdate: boolean;
  streamingEnabled: boolean;
  tvEnabled: boolean;
  providers: Record<string, boolean>;
}

export interface GuiSettings {
  /** Explicit path to moviebox-tui; empty = auto-detect. */
  binaryPath: string;
  /**
   * Subtitles to load when the engine offers some: a language ("English"), 'off' for none, or
   * 'ask' to choose every time. A language the title doesn't have also asks.
   */
  subtitles: string;
}

export interface SettingsBundle {
  tui: TuiSettings | null;
  gui: GuiSettings;
}

// ── Events pushed from main to renderer ────────────────────────────────────

export interface Toast {
  id: number;
  kind: 'success' | 'info' | 'error' | 'warning';
  title: string;
  message: string;
}

export type EngineEvent =
  | { type: 'status'; payload: EngineStatus }
  | { type: 'toast'; payload: Toast }
  | { type: 'downloads'; payload: ActiveDownload[] }
  | { type: 'library'; payload: LibrarySnapshot }
  | { type: 'details'; payload: DetailsView }
  | { type: 'results'; payload: ResultsView }
  | { type: 'subtitles'; payload: SubtitleChoice | null }
  /** Progress of installing the engine (a step to show), or null when it's done. */
  | { type: 'setup'; payload: string | null }
  | { type: 'console-data'; payload: string };
