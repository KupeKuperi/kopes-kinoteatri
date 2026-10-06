import { create } from 'zustand';
import type { TitleRef } from '@shared/api';
import type {
  ActiveDownload,
  BrowseCategory,
  DetailsView,
  DownloadScope,
  EngineEvent,
  EngineStatus,
  EnvironmentInfo,
  FavoriteEntry,
  HistoryEntry,
  LibrarySnapshot,
  ResultItem,
  ResultsView,
  SubtitleChoice,
  Toast,
} from '@shared/types';
import { errorMessage, mb } from './api';

export type Section = 'home' | 'results' | 'details' | 'library' | 'downloads' | 'tv' | 'settings';
export interface Route {
  name: Section;
  tab?: string;
}

interface Pending {
  title: string;
  cover?: string;
  year?: string;
  type?: string;
}

interface State {
  stack: Route[];
  status: EngineStatus | null;
  env: EnvironmentInfo | null;
  /** Step of the engine install in progress ("Downloading…"), or null. */
  setupStep: string | null;
  library: LibrarySnapshot;
  downloads: ActiveDownload[];
  toasts: Toast[];
  categories: BrowseCategory[];
  /** False until the active source's Discover lists were asked for (some sources have none). */
  categoriesLoaded: boolean;
  /** Why the source's Discover lists couldn't be read (null when they loaded or are loading). */
  categoriesError: string | null;
  reloadCategories(): Promise<void>;
  providers: string[];
  consoleOpen: boolean;
  shortcutsOpen: boolean;
  /** Recent search queries (this app's own memory, newest first). */
  recent: string[];

  results: ResultsView | null;
  resultsLoading: string | null;
  resultsError: string | null;
  /** What the Results page asked for last: its title, kind and retry stay when loading fails. */
  resultsRequest: ResultsRequest | null;

  /** The engine is asking which subtitles to load (the dialog answers it). */
  subtitleChoice: SubtitleChoice | null;
  /** The subtitle setting: a language, 'off' or 'ask'. */
  subtitles: string;

  details: DetailsView | null;
  detailsLoading: Pending | null;
  detailsBusy: string | null;
  detailsError: string | null;
  /** Set when a title opened by name isn't on the active source: offer the other sources. */
  detailsNotFound: { ref: TitleRef & { cover?: string }; source: string | null } | null;

  go(route: Route): void;
  back(): void;
  toast(kind: Toast['kind'], title: string, message?: string): void;
  dismissToast(id: number): void;
  setConsole(open: boolean): void;
  setShortcuts(open: boolean): void;

  init(): () => void;
  refreshStatus(): Promise<void>;
  search(query: string): Promise<void>;
  browse(category: BrowseCategory): Promise<void>;
  openImdbList(kind: string): Promise<void>;
  /** `stay`: keep the current page (the caller opens something on the new source right away). */
  setProvider(name: string, opts?: { stay?: boolean }): Promise<boolean>;
  openResult(item: ResultItem): Promise<void>;
  openTitle(ref: TitleRef & { cover?: string }): Promise<void>;
  openFavorite(f: FavoriteEntry): Promise<void>;
  /** Switches to `source` and opens the title that wasn't found on the previous one. */
  retryTitleOn(source: string): Promise<void>;
  /** Re-reads the list of sources (after settings changed which are enabled). */
  reloadSources(): Promise<void>;
  /** Opens a title from a result list that is already on the engine's screen (live suggestions). */
  openFromView(view: ResultsView, item: ResultItem): Promise<void>;
  detailsAction(label: string, fn: () => Promise<DetailsView>): Promise<void>;
  selectAudio(i: number): Promise<void>;
  selectSeason(s: number): Promise<void>;
  selectEpisode(s: number, e: number): Promise<void>;
  play(streamIndex: number): Promise<void>;
  download(scope: DownloadScope, target: number): Promise<void>;
  toggleFavorite(): Promise<void>;
  resume(entry: HistoryEntry): Promise<void>;
  /** Answers the subtitle question: option index, or -1 to cancel the play or download. */
  chooseSubtitle(index: number): Promise<void>;
  setSubtitles(preference: string): Promise<void>;
}

export interface ResultsRequest {
  label: string;
  kind: ResultsView['source'];
  retry: () => Promise<void>;
}

let toastSeq = 100000;

let focusBeforeDialog: HTMLElement | null = null;

/** Puts focus back where it was before the subtitle dialog (once the page is no longer inert). */
function restoreFocus() {
  const el = focusBeforeDialog;
  focusBeforeDialog = null;
  setTimeout(() => {
    if (el && el !== document.body && el.isConnected && !(el as HTMLButtonElement).disabled) el.focus({ preventScroll: true });
    else document.querySelector<HTMLElement>('main [data-nav]')?.focus({ preventScroll: true });
  }, 30);
}

// Request counters: only the newest request of each kind may update the page.
let resultsReq = 0;
let detailsReq = 0;

async function loadResults(request: ResultsRequest, fetch: () => Promise<ResultsView>): Promise<void> {
  const req = ++resultsReq;
  const label = request.label;
  useStore.setState({ resultsLoading: label, resultsError: null, results: null, resultsRequest: request });
  try {
    const results = await fetch();
    if (req === resultsReq) useStore.setState({ results });
  } catch (e) {
    if (req === resultsReq) useStore.setState({ resultsError: errorMessage(e) });
  } finally {
    if (req === resultsReq) useStore.setState({ resultsLoading: null });
  }
}

async function loadDetails(
  pending: { title: string; cover?: string; year?: string; type?: string },
  fetch: () => Promise<{ details: DetailsView | null; notFound?: State['detailsNotFound'] }>,
): Promise<void> {
  const req = ++detailsReq;
  useStore.setState({ details: null, detailsError: null, detailsNotFound: null, detailsLoading: pending });
  try {
    const { details, notFound } = await fetch();
    if (req !== detailsReq) return;
    if (details) useStore.setState({ details });
    else
      useStore.setState({
        detailsNotFound: notFound ?? null,
        detailsError: `“${pending.title}” isn't on ${notFound?.source ?? 'this source'}.`,
      });
  } catch (e) {
    if (req === detailsReq) useStore.setState({ detailsError: errorMessage(e) });
  } finally {
    if (req === detailsReq) useStore.setState({ detailsLoading: null });
  }
}

// Recent searches are a per-window convenience; storage can be unavailable, so never depend on it.
const RECENT_KEY = 'mb.recentSearches';
function loadRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
function saveRecent(list: string[]) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* not persisted this time */
  }
}
const EMPTY_LIBRARY: LibrarySnapshot = { continueWatching: [], history: [], favorites: [] };

export const useStore = create<State>((set, get) => ({
  stack: [{ name: 'home' }],
  status: null,
  env: null,
  library: EMPTY_LIBRARY,
  downloads: [],
  toasts: [],
  categories: [],
  categoriesLoaded: false,
  categoriesError: null,
  providers: [],
  consoleOpen: false,
  shortcutsOpen: false,
  recent: loadRecent(),
  results: null,
  resultsLoading: null,
  resultsError: null,
  resultsRequest: null,
  details: null,
  detailsLoading: null,
  detailsBusy: null,
  detailsError: null,
  detailsNotFound: null,
  subtitleChoice: null,
  subtitles: 'English',
  setupStep: null,

  go(route) {
    const stack = get().stack;
    const top = stack.at(-1);
    if (top?.name === route.name && top.tab === route.tab) return;
    // Sidebar sections reset the trail; results and details stack on top of where you were.
    let next: Route[];
    if (route.name === 'results') next = [...stack.filter((r) => r.name !== 'results' && r.name !== 'details'), route];
    else if (route.name === 'details') next = [...stack.filter((r) => r.name !== 'details'), route];
    else next = route.name === 'home' ? [{ name: 'home' }] : [{ name: 'home' }, route];
    set({ stack: next });
  },
  back() {
    const stack = get().stack;
    if (stack.length > 1) set({ stack: stack.slice(0, -1) });
  },
  toast(kind, title, message = '') {
    const t: Toast = { id: ++toastSeq, kind, title, message };
    set({ toasts: [...get().toasts.slice(-4), t] });
    setTimeout(() => get().dismissToast(t.id), kind === 'error' ? 8000 : 5000);
  },
  dismissToast(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },
  setConsole: (consoleOpen) => set({ consoleOpen }),
  setShortcuts: (shortcutsOpen) => set({ shortcutsOpen }),

  init() {
    const off = mb.on((e: EngineEvent) => {
      switch (e.type) {
        case 'status': {
          set({ status: e.payload });
          // Categories and sources come from the engine; fetch them the first time it is idle.
          if (e.payload.state === 'ready' && (!get().categoriesLoaded || !get().providers.length)) void loadEngineData();
          break;
        }
        case 'toast': {
          const t = e.payload;
          set({ toasts: [...get().toasts.slice(-4), t] });
          setTimeout(() => get().dismissToast(t.id), t.kind === 'error' ? 8000 : 5000);
          break;
        }
        case 'downloads':
          set({ downloads: e.payload });
          break;
        case 'library':
          set({ library: e.payload });
          break;
        case 'setup':
          set({ setupStep: e.payload });
          break;
        case 'details':
          if (get().details?.state.title === e.payload.state.title) set({ details: e.payload });
          break;
        case 'subtitles':
          // Remember where focus was: the dialog makes the page inert, which drops it.
          if (e.payload && !get().subtitleChoice) focusBeforeDialog = document.activeElement as HTMLElement | null;
          set({ subtitleChoice: e.payload });
          if (!e.payload) restoreFocus();
          break;
        case 'results':
          if (get().results?.label === e.payload.label) set({ results: e.payload });
          break;
      }
    });
    let loading = false;
    const loadEngineData = async () => {
      if (loading) return;
      loading = true;
      // Each on its own: a source without Discover lists must not stop the source list loading.
      if (!get().categoriesLoaded) await get().reloadCategories();
      try {
        if (!get().providers.length) set({ providers: await mb.providers() });
      } catch {
        /* retried on the next ready status */
      }
      loading = false;
    };
    void get().refreshStatus().then(() => {
      if (get().status?.state === 'ready') void loadEngineData();
    });
    void mb.library().then((library) => set({ library }));
    void mb.settings().then((b) => set({ subtitles: b.gui.subtitles }), () => undefined);
    return off;
  },

  async refreshStatus() {
    const { status, env } = await mb.status();
    set({ status, env });
  },

  async search(query) {
    const q = query.trim();
    if (!q) return;
    const recent = [q, ...get().recent.filter((r) => r.toLowerCase() !== q.toLowerCase())].slice(0, 12);
    set({ recent });
    saveRecent(recent);
    get().go({ name: 'results' });
    await loadResults({ label: q, kind: 'search', retry: () => get().search(q) }, () => mb.search(q));
  },

  async browse(category) {
    get().go({ name: 'results' });
    await loadResults({ label: category.label, kind: 'browse', retry: () => get().browse(category) }, () => mb.browse(category.index));
  },

  async setProvider(name, opts) {
    try {
      await mb.setProvider(name);
    } catch (e) {
      get().toast('error', 'Could not switch source', errorMessage(e));
      return false;
    }
    // IMDb lists don't depend on the source and stay. A search runs again on the new source; other
    // lists and the open title belong to the old one, so their pages step back instead of going blank.
    const before = get().results;
    set({ results: before?.source === 'imdb' ? before : null, details: null, categories: [], categoriesLoaded: false });
    if (!opts?.stay && get().stack.at(-1)?.name === 'details') get().back();
    if (!opts?.stay && before?.source === 'browse' && get().stack.at(-1)?.name === 'results') get().back();
    await get().refreshStatus();
    get().toast('info', `Searching ${name}`, 'New searches use this source.');
    if (before?.source === 'search' && get().stack.at(-1)?.name === 'results') void get().search(before.requested ?? before.label);
    // The new source's own Discover lists (MovieBox and Addons have them; others don't).
    await get().reloadCategories();
    return true;
  },

  async reloadCategories() {
    set({ categoriesLoaded: false, categoriesError: null });
    try {
      set({ categories: await mb.browseCategories() });
    } catch (e) {
      set({ categories: [], categoriesError: errorMessage(e) });
    } finally {
      set({ categoriesLoaded: true });
    }
  },

  async openImdbList(kind) {
    get().go({ name: 'results' });
    const label = { movies: 'Top Rated Movies', series: 'Top Rated Series', 'new-movies': 'Best New Movies', 'new-series': 'Best New Series' }[kind] ?? 'IMDb';
    await loadResults({ label, kind: 'imdb', retry: () => get().openImdbList(kind) }, () => mb.imdbList(kind));
  },

  async openResult(item) {
    get().go({ name: 'details' });
    // The key says which list item.index belongs to (live search may have changed the engine's list).
    const key = get().results?.key;
    await loadDetails({ title: item.title, cover: item.cover, year: item.year, type: item.type }, async () => ({ details: await mb.open(item.index, key) }));
  },

  async openTitle(ref) {
    get().go({ name: 'details' });
    // The results page underneath stays as it was (e.g. the IMDb list you came from).
    await loadDetails({ title: ref.title, cover: ref.cover, year: ref.year }, async () => {
      const { details } = await mb.openTitle(ref);
      return { details, notFound: details ? undefined : { ref, source: get().status?.provider ?? null } };
    });
  },

  async retryTitleOn(source) {
    const miss = get().detailsNotFound;
    if (!miss) return;
    if (await get().setProvider(source, { stay: true })) await get().openTitle(miss.ref);
  },

  async reloadSources() {
    try {
      set({ providers: await mb.providers() });
    } catch {
      /* keeps the old list */
    }
  },

  async openFromView(view, item) {
    set({ results: view, resultsError: null, resultsLoading: null });
    get().go({ name: 'results' });
    await get().openResult(item);
  },

  openFavorite(f) {
    return get().openTitle({ title: f.title, year: f.year, subjectId: f.subjectId, cover: f.cover });
  },

  async detailsAction(label, fn) {
    set({ detailsBusy: label });
    const title = get().details?.state.title;
    try {
      const details = await fn();
      // Ignore the answer if another title was opened meanwhile.
      if (get().details?.state.title === title) set({ details });
    } catch (e) {
      get().toast('error', label.replace(/…$/, ' failed'), errorMessage(e));
    } finally {
      set({ detailsBusy: null });
    }
  },

  selectAudio: (i) => get().detailsAction('Switching audio…', () => mb.selectAudio(i)),
  selectSeason: (s) => get().detailsAction(`Loading season ${s}…`, () => mb.selectSeason(s)),
  selectEpisode: (s, e) => get().detailsAction(`Loading episode ${e}…`, () => mb.selectEpisode(s, e)),
  play: (i) => get().detailsAction('Starting player…', () => mb.play(i)),

  async chooseSubtitle(index) {
    set({ subtitleChoice: null });
    restoreFocus();
    try {
      await mb.chooseSubtitle(index);
    } catch (e) {
      get().toast('error', 'Could not continue', errorMessage(e));
    }
  },

  async setSubtitles(preference) {
    const previous = get().subtitles;
    set({ subtitles: preference });
    try {
      await mb.saveSettings({ gui: { subtitles: preference } });
    } catch (e) {
      set({ subtitles: previous });
      get().toast('error', 'Could not save the subtitle setting', errorMessage(e));
    }
  },
  download: (scope, target) => get().detailsAction('Starting download…', () => mb.download(scope, target)),
  toggleFavorite: () => get().detailsAction('Updating favorites…', () => mb.toggleFavorite()),

  async resume(entry) {
    try {
      get().toast('info', `Resuming ${entry.title}`, 'The player opens in a moment.');
      await mb.resume(entry);
    } catch (e) {
      get().toast('error', 'Could not resume', errorMessage(e));
    }
  },
}));

export const useRoute = () => useStore((s) => s.stack[s.stack.length - 1]);
