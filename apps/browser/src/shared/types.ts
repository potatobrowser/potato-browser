import type { Platform } from '@potato/shared';

export type FlagMode = 'hide' | 'label' | 'ignore';
export type Theme = 'system' | 'light' | 'dark';
export type StartupMode = 'restore' | 'newtab' | 'homepage';
export type SearchEngineId =
  | 'duckduckgo'
  | 'google'
  | 'google-web'
  | 'bing'
  | 'brave'
  | 'startpage'
  | 'ecosia'
  | 'kagi';

export interface Settings {
  version: 1;
  startup: StartupMode;
  homepage: string;
  searchEngine: SearchEngineId;
  searchSuggestions: boolean;
  showBookmarksBar: boolean;
  theme: Theme;
  downloadsDir: string;
  askWhereToSave: boolean;
  shield: {
    enabled: boolean;
    /** Hostnames (registrable or full) where AI features are shown. */
    disabledSites: string[];
    /** Rule ids the user turned off globally. */
    disabledRules: string[];
  };
  flags: {
    mode: FlagMode;
    /** Distinct flags needed before a post counts as AI-generated. */
    threshold: number;
    showButtons: boolean;
    disabledPlatforms: Platform[];
  };
  privacy: {
    globalPrivacyControl: boolean;
    blockAiChatbots: boolean;
  };
  adblock: {
    enabled: boolean;
    /** Hostnames (registrable or full) where ads are allowed. */
    disabledSites: string[];
    trackers: boolean;
    cookieNotices: boolean;
    annoyances: boolean;
    /** The user's own filters, in EasyList / uBlock Origin syntax. */
    customFilters: string;
    autoUpdate: boolean;
  };
  passwords: {
    /** Ask to save passwords after signing in. */
    offerToSave: boolean;
    /** Offer saved passwords in login fields. */
    autofill: boolean;
    /** Origins where saving is never offered. */
    neverSave: string[];
  };
  installId: string;
  firstRunDone: boolean;
}

export type SettingsPatch = {
  [K in keyof Settings]?: Settings[K] extends object ? Partial<Settings[K]> : Settings[K];
};

export interface ShieldTabState {
  host: string;
  /** The site has dedicated rules in the catalog. */
  supported: boolean;
  /** Hiding is active for this site. */
  enabled: boolean;
  hiddenCount: number;
  features: string[];
}

export interface AdblockTabState {
  /** Blocking is active for this page's site. */
  enabled: boolean;
  /** Requests blocked on this page. */
  blocked: number;
  /** Most blocked hosts, most first. */
  hosts: { host: string; count: number }[];
}

export interface FlagTabState {
  platform: Platform | null;
  hidden: number;
  labeled: number;
}

export type Security = 'secure' | 'insecure' | 'internal' | 'file' | 'none';

export interface TabState {
  id: number;
  title: string;
  /** Full URL; '' for the new tab page. */
  url: string;
  favicon: string | null;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  audible: boolean;
  muted: boolean;
  crashed: boolean;
  security: Security;
  zoom: number;
  bookmarked: boolean;
  shield: ShieldTabState;
  adblock: AdblockTabState;
  flags: FlagTabState;
}

export interface BookmarkNode {
  id: number;
  parentId: number | null;
  type: 'folder' | 'url';
  title: string;
  url: string | null;
  position: number;
  createdAt: number;
  children?: BookmarkNode[];
  favicon?: string | null;
}

export interface PermissionPrompt {
  id: number;
  tabId: number;
  origin: string;
  /** Human readable, e.g. "use your camera and microphone". */
  description: string;
  kind: string;
}

export interface FindState {
  text: string;
  active: number;
  matches: number;
}

export interface DownloadItemState {
  id: string;
  url: string;
  filename: string;
  path: string;
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted';
  paused: boolean;
  received: number;
  total: number;
  startedAt: number;
  endedAt: number | null;
  mime: string;
}

export interface WindowState {
  windowId: number;
  isPrivate: boolean;
  tabs: TabState[];
  activeTabId: number;
  bookmarksBar: BookmarkNode[] | null;
  permissionPrompts: PermissionPrompt[];
  find: FindState | null;
  fullscreen: boolean;
  downloads: { active: number; recent: DownloadItemState[] };
  theme: Theme;
  shieldGloballyEnabled: boolean;
  adblockGloballyEnabled: boolean;
  updateAvailable: string | null;
  passwordPrompt: PasswordPrompt | null;
}

/** "Save password?" for the active tab, after a sign-in that looked successful. */
export interface PasswordPrompt {
  id: number;
  host: string;
  username: string;
  /** A password for this username is saved already and differs. */
  update: boolean;
}

/** A saved login without its secrets. */
export interface LoginInfo {
  id: number;
  origin: string;
  host: string;
  username: string;
  createdAt: number;
  updatedAt: number;
  lastUsed: number;
  timesUsed: number;
  hasNote: boolean;
}

export interface PasswordsOverview {
  /** The macOS Keychain key can be used; without it nothing is saved or filled. */
  available: boolean;
  logins: LoginInfo[];
  /** Showing, copying or exporting passwords asks for Touch ID or the Mac's password first. */
  asksAuth: boolean;
}

export interface PasswordImportResult {
  /** Set when the file could not be read; nothing was imported. */
  error: string | null;
  source: string | null;
  added: number;
  /** Already saved with the same password. */
  same: number;
  /** Already saved with a different password, which was kept. */
  kept: number;
  skipped: { noPassword: number; noWebsite: number; archived: number; duplicates: number };
  /** Name of the imported file, which can be moved to the Trash afterwards. */
  file: string | null;
}

/** One entry of the autofill dropdown. */
export interface AutofillItem {
  username: string;
  /** The saved login's host when it is from another subdomain of the site. */
  host: string | null;
}

export interface AutofillView {
  items: AutofillItem[];
  highlighted: number;
}

export type SuggestionKind = 'url' | 'search' | 'history' | 'bookmark' | 'suggest';

export interface Suggestion {
  kind: SuggestionKind;
  title: string;
  url: string;
  /** Text to put in the omnibox when this suggestion is highlighted. */
  fill: string;
}

export interface SuggestResult {
  input: string;
  suggestions: Suggestion[];
  /** Inline autocompletion (host completion) for the typed text, or null. */
  inline: string | null;
}

export interface HistoryEntry {
  id: number;
  url: string;
  title: string;
  visitTime: number;
  favicon: string | null;
}

export interface TopSite {
  url: string;
  title: string;
  favicon: string | null;
}

export interface ImportSource {
  id: string;
  browser: string;
  profile: string;
  path: string;
  kind: 'chromium' | 'firefox' | 'safari';
  hasBookmarks: boolean;
  hasHistory: boolean;
  /** Set when the data exists but macOS blocks access (Safari needs Full Disk Access). */
  blocked: string | null;
}

export interface ImportResult {
  sourceId: string;
  bookmarks: number;
  history: number;
  errors: string[];
}

export interface AppInfo {
  name: string;
  version: string;
  chromium: string;
  electron: string;
  node: string;
  v8: string;
  engine: EngineReport;
  installIdShort: string;
  apiBase: string;
}

export interface EngineReport {
  disabledFeatures: string[];
  disabledBlinkFeatures: string[];
}

export interface ShieldRuleSummary {
  id: string;
  site: string;
  features: { id: string; name: string }[];
  hosts: string[];
}

export interface ShieldStats {
  hiddenTotal: number;
  hiddenToday: number;
  blockedTotal: number;
  blockedToday: number;
}

export interface AdblockListInfo {
  id: string;
  name: string;
  group: string;
  homepage: string;
  /** When this copy of the list was fetched (ISO date). */
  fetchedAt: string;
}

export interface AdblockStatus {
  ready: boolean;
  compiling: boolean;
  updating: boolean;
  /** Network and cosmetic filters in the running engine. */
  filters: number;
  lists: AdblockListInfo[];
  lastCheck: number | null;
  lastError: string | null;
  /** Problem with the user's own filters, if any line was rejected. */
  customErrors: string[];
}

export interface ClearDataOptions {
  since: number;
  history: boolean;
  cookies: boolean;
  cache: boolean;
  downloads: boolean;
}

/** Config the web preload asks for at document start. */
export interface PageConfig {
  isPrivate: boolean;
  /** Only under the e2e suite: open shadow roots so tests can reach injected buttons. */
  testHooks: boolean;
  shield: { enabled: boolean; disabledRules: string[] };
  adblock: { enabled: boolean };
  flags: { enabled: boolean; mode: FlagMode; threshold: number; showButtons: boolean; disabledPlatforms: Platform[] };
  passwords: { autofill: boolean; save: boolean };
}

export interface FlagStatus {
  /** Distinct flags from everyone, including the user's own. */
  n: number;
  /** The user flagged it. */
  mine: boolean;
}
