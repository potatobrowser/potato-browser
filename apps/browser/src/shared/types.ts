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
  updateAvailable: string | null;
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
  shield: { enabled: boolean; disabledRules: string[] };
  flags: { enabled: boolean; mode: FlagMode; threshold: number; showButtons: boolean; disabledPlatforms: Platform[] };
}

export interface FlagStatus {
  /** Distinct flags from everyone, including the user's own. */
  n: number;
  /** The user flagged it. */
  mine: boolean;
}
