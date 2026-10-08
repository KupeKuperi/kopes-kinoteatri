// The API the preload script exposes to the renderer as `window.mb`.
import type {
  AddonInfo,
  BrowseCategory,
  DetailsView,
  DownloadFile,
  DownloadScope,
  EngineEvent,
  EngineStatus,
  EnvironmentInfo,
  FavoriteEntry,
  GuiSettings,
  HistoryEntry,
  PhoneInfo,
  ImdbRating,
  LibrarySnapshot,
  ResultsView,
  SettingsBundle,
  Suggestion,
  TuiSettings,
  TvView,
} from './types';

export interface TitleRef {
  title: string;
  year?: string;
  subjectId?: string;
  /** When opened from an IMDb list: shown while the source looks the title up. */
  imdb?: ImdbRating;
}

export interface MbApi {
  platform: string;
  /** Set in a phone's browser: where posters are served (the desktop window uses `mbimg://`). */
  imageBase?: string;
  status(): Promise<{ status: EngineStatus; env: EnvironmentInfo }>;
  restartEngine(): Promise<void>;
  consoleSnapshot(): Promise<string>;
  consoleInput(data: string): void;
  /** Installs moviebox-tui (official release) and starts it. */
  installEngine(): Promise<{ status: EngineStatus; env: EnvironmentInfo }>;
  /** Installs VLC or yt-dlp with winget; returns what is installed now. */
  /** `manual`: there was no package manager, so the tool's download page opened instead. */
  installTool(tool: 'vlc' | 'yt-dlp'): Promise<{ env: EnvironmentInfo; manual?: string }>;
  /** Answers the engine's subtitle question: option index, or -1 to cancel. */
  chooseSubtitle(index: number): Promise<void>;

  search(query: string): Promise<ResultsView>;
  /** Instant title suggestions (typo-tolerant) from titles already seen. */
  suggest(query: string): Promise<Suggestion[]>;
  /** Live search while typing; resolves null if a newer request replaced it. */
  suggestLive(query: string): Promise<ResultsView | null>;
  browseCategories(): Promise<BrowseCategory[]>;
  /** IMDb-ranked list: `movies`, `series`, `new-movies` or `new-series`. */
  imdbList(kind: string): Promise<ResultsView>;
  /** IMDb ratings for titles as a source lists them (null where no match). */
  imdbRatings(refs: Array<{ title: string; year?: string; type?: string }>): Promise<Array<ImdbRating | null>>;
  browse(index: number): Promise<ResultsView>;
  providers(): Promise<string[]>;
  setProvider(name: string): Promise<string | null>;

  /** Opens item `index` of the list identified by `key` (ResultsView.key). */
  open(index: number, key?: string): Promise<DetailsView>;
  openTitle(ref: TitleRef): Promise<{ results: ResultsView; details: DetailsView | null }>;
  peekDetails(): Promise<DetailsView | null>;
  selectAudio(index: number): Promise<DetailsView>;
  selectSeason(season: number): Promise<DetailsView>;
  selectEpisode(season: number, episode: number): Promise<DetailsView>;
  play(streamIndex: number): Promise<DetailsView>;
  download(scope: DownloadScope, target: number): Promise<DetailsView>;
  toggleFavorite(): Promise<DetailsView>;
  cancelDownloads(): Promise<void>;

  library(): Promise<LibrarySnapshot>;
  resume(entry: HistoryEntry): Promise<void>;
  removeFromHistory(entry: HistoryEntry): Promise<void>;
  openFavorite(entry: FavoriteEntry): Promise<{ results: ResultsView; details: DetailsView | null }>;

  downloads(): Promise<{ dir: string; files: DownloadFile[] }>;
  /** Deletes the pieces an unfinished download left (path as listed); returns how many files went. */
  deleteUnfinished(p: string): Promise<number>;
  openPath(p: string): Promise<void>;
  revealPath(p: string): Promise<void>;
  pickFolder(current?: string): Promise<string | null>;
  pickFile(current?: string): Promise<string | null>;

  tv(force?: boolean): Promise<TvView>;
  tvAddPlaylist(source: string): Promise<TvView>;
  tvRemovePlaylist(source: string): Promise<TvView>;
  tvPlay(name: string, group?: string): Promise<void>;
  tvLeave(): Promise<void>;

  /** Stremio add-ons (the Addons source). Changing them restarts the engine. */
  addons(): Promise<AddonInfo[]>;
  /** `slow`: seconds the add-on took to list streams, when that is more than the engine waits. */
  addAddon(url: string): Promise<{ addons: AddonInfo[]; added: AddonInfo; slow?: number }>;
  removeAddon(url: string): Promise<AddonInfo[]>;
  setAddonEnabled(url: string, enabled: boolean): Promise<AddonInfo[]>;

  /** Phone access (Settings on the computer). */
  phone(): Promise<PhoneInfo>;
  setPhone(patch: { enabled?: boolean; newKey?: boolean }): Promise<PhoneInfo>;
  /** From a phone: plays stream `streamIndex` of the open title there (`device` = that phone). */
  phonePlay(device: string, streamIndex: number, title: string): Promise<DetailsView>;
  phoneResume(device: string, entry: HistoryEntry): Promise<void>;
  phoneTv(device: string, name: string, group?: string): Promise<void>;
  /** The phone's player is still open (also while paused). */
  phoneProgress(session: string, position: number, paused: boolean): Promise<void>;
  /** The phone closed its player. */
  phoneStop(session: string): Promise<void>;

  settings(): Promise<SettingsBundle>;
  saveSettings(patch: { tui?: Partial<TuiSettings>; gui?: Partial<GuiSettings> }): Promise<SettingsBundle>;
  /** Subtitle files automatic subtitles keep in the app's folder. */
  subtitleCache(): Promise<{ files: number; bytes: number }>;
  /** Deletes them; returns what is left. */
  clearSubtitleCache(): Promise<{ files: number; bytes: number }>;

  /** Subscribes to engine events; returns an unsubscribe function. */
  on(listener: (event: EngineEvent) => void): () => void;
}
