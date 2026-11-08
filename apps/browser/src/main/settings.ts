import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { isPlatform } from '@potato/shared';
import { TAB_SLEEP_MINUTES } from '../shared/constants';
import type { FlagMode, SearchEngineId, Settings, SettingsPatch, StartupMode, Theme } from '../shared/types';
import { migrateLegacyUrl, SEARCH_ENGINES } from '../shared/urls';
import { JsonFile } from './store';

export function defaultSettings(): Settings {
  return {
    version: 1,
    startup: 'restore',
    homepage: 'potato://newtab/',
    searchEngine: 'duckduckgo',
    searchSuggestions: true,
    showBookmarksBar: true,
    theme: 'system',
    downloadsDir: path.join(os.homedir(), 'Downloads'),
    askWhereToSave: false,
    shield: { enabled: true, disabledSites: [], disabledRules: [] },
    flags: { mode: 'label', threshold: 3, showButtons: true, disabledPlatforms: [] },
    privacy: { globalPrivacyControl: true, blockAiChatbots: false },
    adblock: { enabled: true, disabledSites: [], trackers: true, cookieNotices: false, annoyances: false, customFilters: '', autoUpdate: true },
    passwords: { offerToSave: true, autofill: true, neverSave: [] },
    // As Edge's sleeping tabs: tabs of a work session stay loaded, tabs left alone longer are the ones that pile up.
    tabs: { sleepAfter: 120 },
    installId: crypto.randomBytes(16).toString('hex'),
    firstRunDone: false,
  };
}

const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
const str = (v: unknown, fallback: string) => (typeof v === 'string' && v ? v : fallback);
const strList = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** Merges stored (possibly partial or malformed) settings onto defaults, field by field. */
export function sanitizeSettings(raw: unknown): Settings {
  const d = defaultSettings();
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const engines = SEARCH_ENGINES.map((e) => e.id);
  const threshold = Number(r.flags?.threshold);
  const sleepAfter = typeof r.tabs?.sleepAfter === 'number' ? r.tabs.sleepAfter : NaN;
  return {
    version: 1,
    startup: oneOf<StartupMode>(r.startup, ['restore', 'newtab', 'homepage'], d.startup),
    homepage: migrateLegacyUrl(str(r.homepage, d.homepage)),
    searchEngine: oneOf<SearchEngineId>(r.searchEngine, engines, d.searchEngine),
    searchSuggestions: bool(r.searchSuggestions, d.searchSuggestions),
    showBookmarksBar: bool(r.showBookmarksBar, d.showBookmarksBar),
    theme: oneOf<Theme>(r.theme, ['system', 'light', 'dark'], d.theme),
    downloadsDir: str(r.downloadsDir, d.downloadsDir),
    askWhereToSave: bool(r.askWhereToSave, d.askWhereToSave),
    shield: {
      enabled: bool(r.shield?.enabled, true),
      disabledSites: [...new Set(strList(r.shield?.disabledSites).map((s) => s.toLowerCase()))],
      disabledRules: [...new Set(strList(r.shield?.disabledRules))],
    },
    flags: {
      mode: oneOf<FlagMode>(r.flags?.mode, ['hide', 'label', 'ignore'], d.flags.mode),
      threshold: Number.isInteger(threshold) && threshold >= 1 && threshold <= 100 ? threshold : d.flags.threshold,
      showButtons: bool(r.flags?.showButtons, true),
      disabledPlatforms: strList(r.flags?.disabledPlatforms).filter(isPlatform),
    },
    privacy: {
      globalPrivacyControl: bool(r.privacy?.globalPrivacyControl, d.privacy.globalPrivacyControl),
      blockAiChatbots: bool(r.privacy?.blockAiChatbots, d.privacy.blockAiChatbots),
    },
    adblock: {
      enabled: bool(r.adblock?.enabled, d.adblock.enabled),
      disabledSites: [...new Set(strList(r.adblock?.disabledSites).map((s) => s.toLowerCase()))],
      trackers: bool(r.adblock?.trackers, d.adblock.trackers),
      cookieNotices: bool(r.adblock?.cookieNotices, d.adblock.cookieNotices),
      annoyances: bool(r.adblock?.annoyances, d.adblock.annoyances),
      customFilters: typeof r.adblock?.customFilters === 'string' ? r.adblock.customFilters.slice(0, 200_000) : '',
      autoUpdate: bool(r.adblock?.autoUpdate, d.adblock.autoUpdate),
    },
    passwords: {
      offerToSave: bool(r.passwords?.offerToSave, d.passwords.offerToSave),
      autofill: bool(r.passwords?.autofill, d.passwords.autofill),
      neverSave: [...new Set(strList(r.passwords?.neverSave).filter((o) => /^https?:\/\/[^/]+$/.test(o)))].slice(0, 5000),
    },
    tabs: {
      sleepAfter: (TAB_SLEEP_MINUTES as readonly number[]).includes(sleepAfter) ? sleepAfter : d.tabs.sleepAfter,
    },
    installId: typeof r.installId === 'string' && /^[0-9a-f]{32}$/.test(r.installId) ? r.installId : d.installId,
    firstRunDone: bool(r.firstRunDone, false),
  };
}

export class SettingsStore extends EventEmitter<{ changed: [Settings, Settings] }> {
  private file: JsonFile<Settings>;
  private value: Settings;

  constructor(dir: string) {
    super();
    this.file = new JsonFile<Settings>(path.join(dir, 'settings.json'), 100);
    this.value = sanitizeSettings(this.file.read());
    this.file.write(this.value);
  }

  get(): Settings {
    return this.value;
  }

  update(patch: SettingsPatch): Settings {
    const prev = this.value;
    const merged: Record<string, unknown> = { ...prev };
    for (const [k, v] of Object.entries(patch)) {
      const cur = (prev as unknown as Record<string, unknown>)[k];
      merged[k] = v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' ? { ...cur, ...v } : v;
    }
    // installId is never changed through patches.
    merged.installId = prev.installId;
    this.value = sanitizeSettings(merged);
    this.file.write(this.value);
    this.emit('changed', this.value, prev);
    return this.value;
  }

  flush(): void {
    this.file.flush();
  }
}
