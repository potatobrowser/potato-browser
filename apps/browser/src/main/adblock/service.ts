import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { app, net, utilityProcess, webContents, type OnBeforeRequestListenerDetails, type OnHeadersReceivedListenerDetails, type WebFrameMain } from 'electron';
import { Request as FilterRequest, type FiltersEngine } from '@ghostery/adblocker';
import { parse as parseHost } from 'tldts-experimental';
import type { AdblockStatus, AdblockTabState, Settings } from '../../shared/types';
import { hostMatches, siteKey } from '../../shared/urls';
import { ctx } from '../context';
import { notifyInternalPages } from '../notify';
import { apiBase, APP_VERSION, isTest, paths } from '../paths';
import { CATALOG, customFilterErrors, DEFAULT_GROUPS, groupsFor, isPlausibleList, listsForGroups, loadEngine, specKey, type CompileJob, type EngineSpec } from './compile';

interface BundledManifest {
  fetchedAt: string;
  lists: Record<string, { rev: string; sha256: string }>;
}

interface UserState {
  lists: Record<string, { rev: string; sha256: string; fetchedAt: string }>;
  lastCheck: number | null;
  lastError: string | null;
  /** UTC day of the last scheduled check, the one that counts the install as used that day. */
  countedDay?: string;
}

interface PageCounts {
  blocked: number;
  hosts: Map<string, number>;
  /** Registrable domain of the page, so the previous page's last beacons are not counted here. */
  domain: string;
}

export interface Cosmetics {
  styles: string;
  scripts: string[];
  extended: unknown[];
}

const REV = /^[0-9a-f]{64}$/;
// Stand-ins are served only under this per-launch path, so pages cannot probe for the browser.
const RESOURCE_TOKEN = crypto.randomBytes(12).toString('hex');
const RESOURCE_BASE = `potato-res://r/${RESOURCE_TOKEN}/`;
const utcDay = (t: number | null) => (t ? new Date(t).toISOString().slice(0, 10) : '');
const isWeb = (url: string) => url.startsWith('https:') || url.startsWith('http:');

function domainOf(url: string): string {
  const p = parseHost(url);
  return p.domain ?? p.hostname ?? '';
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * The built-in ad and tracker blocker: one compiled filter engine shared by every session.
 * The default engine ships with the app; other list choices, the user's own filters and daily
 * list updates are compiled in a utility process and swapped in without a restart.
 */
export class AdblockService {
  private engine: FiltersEngine | null = null;
  private loadedKey = '';
  private filterCount = 0;
  private manifest: BundledManifest | null = null;
  private state: UserState = { lists: {}, lastCheck: null, lastError: null };
  private compiling: Promise<void> | null = null;
  private recompile = false;
  private updating: Promise<void> | null = null;
  private customErrors: string[] = [];
  private pages = new Map<number, PageCounts>();
  private dirty = new Set<number>();
  private dirtyTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingStats = 0;
  private timers: ReturnType<typeof setInterval>[] = [];

  private get bundledDir(): string {
    return path.join(paths.root, 'dist', 'filters');
  }

  private get userDir(): string {
    return path.join(paths.userData, 'Filters');
  }

  private get settings(): Settings['adblock'] {
    return ctx.settings.get().adblock;
  }

  /** Loads an engine synchronously, so the first page of the session is already filtered. */
  init(): void {
    try {
      this.manifest = JSON.parse(fs.readFileSync(path.join(this.bundledDir, 'manifest.json'), 'utf8')) as BundledManifest;
    } catch (err) {
      console.error('adblock: no bundled filters', err);
    }
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(this.userDir, 'state.json'), 'utf8')) as Partial<UserState>;
      this.state = { lists: raw.lists ?? {}, lastCheck: raw.lastCheck ?? null, lastError: raw.lastError ?? null, countedDay: raw.countedDay };
    } catch {}
    this.customErrors = customFilterErrors(this.settings.customFilters);

    const wantKey = specKey(this.spec());
    const cached = this.cachedKey();
    if (cached && cached === wantKey && this.load(path.join(this.userDir, 'engine.bin'), cached)) return;
    if (wantKey === this.bundledKey() && this.load(path.join(this.bundledDir, 'engine.bin'), wantKey)) return;
    // Something close to the wanted engine now, the exact one in a moment.
    if (!(cached && this.load(path.join(this.userDir, 'engine.bin'), cached))) this.load(path.join(this.bundledDir, 'engine.bin'), this.bundledKey());
    app.whenReady().then(() => this.rebuild());
  }

  /** The daily check asks for list updates while these are on, and for AI Shield rules. */
  private wantsLists(): boolean {
    return this.settings.enabled && this.settings.autoUpdate;
  }

  private wantsCheck(): boolean {
    return this.wantsLists() || ctx.settings.get().shield.autoUpdate;
  }

  start(): void {
    this.timers.push(setInterval(() => this.flushStats(), 15_000));
    if (isTest() && process.env.POTATO_ADBLOCK_UPDATES !== '1') return;
    // Once per calendar day (UTC), so the check also tells how many installs ran that day.
    const due = () => this.wantsCheck() && this.state.countedDay !== utcDay(Date.now());
    const first = (isTest() && Number(process.env.POTATO_UPDATE_CHECK_DELAY_MS)) || 90_000;
    setTimeout(() => due() && void this.checkForUpdates(true).catch(() => {}), first);
    this.timers.push(setInterval(() => due() && void this.checkForUpdates(true).catch(() => {}), 3_600_000));
  }

  stop(): void {
    this.timers.forEach(clearInterval);
    this.flushStats();
  }

  private load(file: string, key: string): boolean {
    try {
      const started = Date.now();
      this.engine = loadEngine(file);
      this.loadedKey = key;
      try {
        this.filterCount = JSON.parse(fs.readFileSync(`${file}.json`, 'utf8')).filters ?? 0;
      } catch {
        this.filterCount = 0;
      }
      if (!isTest()) console.log(`adblock: engine loaded in ${Date.now() - started} ms`);
      return true;
    } catch (err) {
      console.error('adblock: cannot load engine', file, err);
      return false;
    }
  }

  private cachedKey(): string | null {
    try {
      const k = JSON.parse(fs.readFileSync(path.join(this.userDir, 'engine.json'), 'utf8')).key;
      return typeof k === 'string' && fs.existsSync(path.join(this.userDir, 'engine.bin')) ? k : null;
    } catch {
      return null;
    }
  }

  /** Where each list comes from: the newest of the copy in the app and a downloaded update. */
  private source(id: string): { rev: string; fetchedAt: string; file: string } {
    const bundled = { rev: this.manifest?.lists[id]?.rev ?? '', fetchedAt: this.manifest?.fetchedAt ?? '', file: path.join(this.bundledDir, 'lists', `${id}.txt.gz`) };
    const user = this.state.lists[id];
    const userFile = path.join(this.userDir, 'lists', `${id}.txt`);
    if (user && Date.parse(user.fetchedAt) > Date.parse(bundled.fetchedAt || '0') && fs.existsSync(userFile)) {
      return { rev: user.rev, fetchedAt: user.fetchedAt, file: userFile };
    }
    return bundled;
  }

  private spec(): EngineSpec {
    const s = this.settings;
    return {
      lists: listsForGroups(groupsFor(s)).map((id) => [id, this.source(id).rev]),
      resources: this.source(CATALOG.resources).rev,
      custom: s.customFilters,
    };
  }

  private bundledKey(): string {
    const m = this.manifest;
    if (!m) return '';
    return specKey({ lists: listsForGroups(DEFAULT_GROUPS).map((id) => [id, m.lists[id]?.rev ?? '']), resources: m.lists[CATALOG.resources]?.rev ?? '', custom: '' });
  }

  /** The loaded engine matches the settings and lists (nothing left to compile). */
  isCurrent(): boolean {
    return !!this.engine && !this.compiling && this.loadedKey === specKey(this.spec());
  }

  /** Recompiles when the wanted engine (lists, revisions, own filters) differs from the loaded one. */
  rebuild(): Promise<void> {
    if (this.compiling) {
      this.recompile = true;
      return this.compiling;
    }
    this.compiling = this.compile()
      .catch((err) => console.error('adblock: compile failed', err))
      .finally(() => {
        this.compiling = null;
        if (this.recompile) {
          this.recompile = false;
          void this.rebuild();
        }
        this.changed();
      });
    this.changed();
    return this.compiling;
  }

  private async compile(): Promise<void> {
    const spec = this.spec();
    const key = specKey(spec);
    if (key === this.loadedKey) return;
    if (key === this.bundledKey()) {
      this.load(path.join(this.bundledDir, 'engine.bin'), key);
      return;
    }
    fs.mkdirSync(this.userDir, { recursive: true });
    const out = path.join(this.userDir, 'engine.bin');
    const job: CompileJob = {
      lists: spec.lists.map(([id]) => this.source(id).file),
      resources: this.source(CATALOG.resources).file,
      custom: spec.custom,
      out: `${out}.next`,
    };
    await runCompiler(job);
    const meta = path.join(this.userDir, 'engine.json');
    // The key goes last: until it is written, the new engine.bin is not trusted at startup.
    fs.rmSync(meta, { force: true });
    fs.renameSync(`${job.out}.json`, `${out}.json`);
    fs.renameSync(job.out, out);
    fs.writeFileSync(meta, JSON.stringify({ key }));
    this.load(out, key);
  }

  private changed(): void {
    if (!ctx.windows) return;
    ctx.windows.broadcast();
    notifyInternalPages({ type: 'adblock' });
  }

  onSettingsChanged(next: Settings, prev: Settings): void {
    const a = next.adblock;
    const b = prev.adblock;
    if (a.customFilters !== b.customFilters) this.customErrors = customFilterErrors(a.customFilters);
    const groupsChanged = groupsFor(a).join() !== groupsFor(b).join();
    if (groupsChanged || a.customFilters !== b.customFilters) void this.rebuild();
    // Newly chosen lists may be older than the ones in use: refresh them now.
    if (groupsChanged && a.enabled && a.autoUpdate && !(isTest() && process.env.POTATO_ADBLOCK_UPDATES !== '1')) {
      void this.checkForUpdates().catch(() => {});
    }
  }

  // ---- per-site state ------------------------------------------------------------------------

  isSiteDisabled(url: string): boolean {
    const host = hostOf(url);
    return !!host && this.settings.disabledSites.some((s) => hostMatches(host, s));
  }

  isEnabledFor(url: string): boolean {
    return this.settings.enabled && isWeb(url) && !this.isSiteDisabled(url);
  }

  setSiteEnabled(url: string, enabled: boolean): void {
    const host = hostOf(url);
    if (!host) return;
    let sites = this.settings.disabledSites.filter((d) => !hostMatches(host, d));
    if (!enabled) sites = [...sites, siteKey(url)];
    ctx.settings.update({ adblock: { disabledSites: sites } });
  }

  // ---- network -------------------------------------------------------------------------------

  /** Verdict for a subresource request: cancel, a neutered stand-in (redirect) or null. */
  filterRequest(details: OnBeforeRequestListenerDetails, isPrivate: boolean): { cancel: true } | { redirectURL: string } | null {
    const engine = this.engine;
    if (!engine || !this.settings.enabled || details.resourceType === 'mainFrame') return null;
    const url = details.url;
    if (!isWeb(url) && !url.startsWith('wss:') && !url.startsWith('ws:')) return null;
    const { frameUrl, topUrl } = frameUrls(details.frame);
    // Right after leaving an internal page the tab may still report it (potato://newtab/) while
    // the new page's first requests arrive: the referrer names the page then.
    const tabUrl = details.webContents?.getURL() ?? '';
    const site = topUrl || (isWeb(tabUrl) ? tabUrl : '') || details.referrer || '';
    // Internal pages, files and error pages are never filtered; nor are requests with no page to
    // judge them by (a service worker without referrer), which the per-site switch could not reach.
    if (!site || !isWeb(site) || this.isSiteDisabled(site)) return null;
    const request = FilterRequest.fromRawDetails({
      url,
      sourceUrl: isWeb(frameUrl) ? frameUrl : site,
      type: (details.resourceType || 'other') as Parameters<typeof FilterRequest.fromRawDetails>[0]['type'],
      requestId: String(details.id),
      tabId: details.webContentsId ?? -1,
    });
    const { match, redirect } = engine.match(request);
    if (!match && !redirect) return null;
    this.count(details.webContentsId, request.hostname, isPrivate, site);
    return redirect ? { redirectURL: `${RESOURCE_BASE}${encodeURIComponent(redirect.filename)}` } : { cancel: true };
  }

  /** Serves a redirect stand-in (`potato-res://r/<token>/<name>`) from uBlock Origin's resources. */
  serveResource(req: Request): Response {
    const [, token, raw = ''] = new URL(req.url).pathname.split('/');
    if (token !== RESOURCE_TOKEN) return new Response('', { status: 404 });
    const name = decodeURIComponent(raw);
    let res: { contentType: string; dataUrl: string } | undefined;
    try {
      res = this.engine?.resources.getResource(name);
    } catch {}
    const m = res && /^data:([^,]*?)(;base64)?,(.*)$/s.exec(res.dataUrl);
    if (!res || !m) return new Response('', { status: 404 });
    const body = m[2] ? Buffer.from(m[3]!, 'base64') : Buffer.from(decodeURIComponent(m[3]!));
    return new Response(body, {
      headers: { 'content-type': res.contentType, 'access-control-allow-origin': '*', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
    });
  }

  /** `$csp` filters: extra Content-Security-Policy for documents of matching sites. */
  cspFor(details: OnHeadersReceivedListenerDetails): string | undefined {
    const engine = this.engine;
    if (!engine || !this.settings.enabled) return undefined;
    if (details.resourceType !== 'mainFrame' && details.resourceType !== 'subFrame') return undefined;
    const { topUrl } = frameUrls(details.frame);
    const site = details.resourceType === 'mainFrame' ? details.url : topUrl || details.url;
    if (!isWeb(details.url) || this.isSiteDisabled(site)) return undefined;
    return engine.getCSPDirectives(FilterRequest.fromRawDetails({ url: details.url, sourceUrl: site, type: details.resourceType }));
  }

  // ---- cosmetics -----------------------------------------------------------------------------

  /** Styles, scriptlets and procedural selectors for a frame at document start. */
  cosmeticsFor(frame: WebFrameMain): Cosmetics | null {
    const target = this.cosmeticTarget(frame);
    if (!target) return null;
    const r = this.engine!.getCosmeticsFilters({
      ...target,
      getBaseRules: true,
      getInjectionRules: true,
      getExtendedRules: true,
      getRulesFromHostname: true,
      getRulesFromDOM: false,
    });
    if (r.active === false) return null;
    // Each scriptlet in its own block, as Ghostery injects them: their helpers (uBlock's
    // proxyApplyFn) are function declarations, and at top level every scriptlet would replace the
    // previous one's global copy, sending its Function.prototype.toString hook into a loop.
    const scripts = [...new Set(r.scripts)].map((s) => `try{${s}}catch(e){}`);
    return { styles: r.styles, scripts, extended: r.extended };
  }

  /** Generic hiding rules for ids, classes and links that appeared in the frame. */
  cosmeticsForDom(frame: WebFrameMain, dom: { classes: string[]; ids: string[]; hrefs: string[] }): string {
    const target = this.cosmeticTarget(frame);
    if (!target) return '';
    const r = this.engine!.getCosmeticsFilters({
      ...target,
      ...dom,
      getBaseRules: false,
      getInjectionRules: false,
      getExtendedRules: false,
      getRulesFromHostname: false,
      getRulesFromDOM: true,
    });
    return r.active === false ? '' : r.styles;
  }

  private cosmeticTarget(frame: WebFrameMain) {
    if (!this.engine || !this.settings.enabled) return null;
    const url = frame.url;
    const top = frame.top?.url ?? url;
    if (!isWeb(url) || !isWeb(top) || this.isSiteDisabled(top)) return null;
    const p = parseHost(url);
    const ancestors: { hostname: string; domain: string }[] = [];
    for (let f = frame.parent; f; f = f.parent) {
      const a = parseHost(f.url);
      if (a.hostname) ancestors.push({ hostname: a.hostname, domain: a.domain ?? '' });
    }
    return { url, hostname: p.hostname ?? '', domain: p.domain ?? '', ancestors };
  }

  // ---- counts --------------------------------------------------------------------------------

  private count(wcId: number | undefined, host: string, isPrivate: boolean, site: string): void {
    if (!isPrivate) this.pendingStats++;
    if (wcId === undefined) return;
    let page = this.pages.get(wcId);
    if (!page) this.pages.set(wcId, (page = { blocked: 0, hosts: new Map(), domain: '' }));
    if (page.domain && site && domainOf(site) !== page.domain) return;
    page.blocked++;
    const h = host.replace(/^www\./, '');
    if (h && (page.hosts.has(h) || page.hosts.size < 200)) page.hosts.set(h, (page.hosts.get(h) ?? 0) + 1);
    this.dirty.add(wcId);
    // Blocked requests come in bursts; the toolbar is refreshed a few times a second at most.
    this.dirtyTimer ??= setTimeout(() => {
      this.dirtyTimer = null;
      const wins = new Set<{ update(): void }>();
      for (const id of this.dirty) {
        const wc = webContents.fromId(id);
        const tab = wc ? ctx.windows.tabFor(wc) : null;
        if (tab) wins.add(tab.win);
      }
      this.dirty.clear();
      wins.forEach((w) => w.update());
    }, 250);
  }

  /** The tab is gone or its renderer crashed. */
  resetPage(wcId: number): void {
    this.pages.delete(wcId);
  }

  /**
   * A new document committed in the tab. Counting starts here, not when the navigation starts:
   * a navigation that never commits (a download link) leaves the page on screen and its count.
   */
  pageCommitted(wcId: number, url: string): void {
    this.pages.set(wcId, { blocked: 0, hosts: new Map(), domain: domainOf(url) });
  }

  tabState(wcId: number, url: string): AdblockTabState {
    const page = this.pages.get(wcId);
    const hosts = page ? [...page.hosts].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([host, count]) => ({ host, count })) : [];
    return { enabled: this.isEnabledFor(url), blocked: page?.blocked ?? 0, hosts };
  }

  flushStats(): void {
    if (!this.pendingStats) return;
    try {
      ctx.db.addAdsBlocked(this.pendingStats);
      this.pendingStats = 0;
    } catch {}
  }

  // ---- updates -------------------------------------------------------------------------------

  /**
   * The daily check: downloads lists whose revision changed (through potatobrowser.com) and
   * recompiles, and hands the AI Shield its rule version. It names the lists, the app and its
   * version, nothing about the user.
   */
  /** `daily`: the scheduled check, which also counts the install as used today; "Update now" is not. */
  checkForUpdates(daily = false): Promise<void> {
    this.updating ??= this.update(daily).finally(() => {
      this.updating = null;
      this.changed();
    });
    this.changed();
    return this.updating;
  }

  private async update(daily: boolean): Promise<void> {
    // Lists only: scriptlet code (uBlock's resources) changes with signed app releases, never
    // through a download. Trusted scriptlets, whose arguments can carry code, only run from
    // uBlock's own lists (see dropTrustedScriptlets), as in uBlock Origin.
    const ids = this.wantsLists() ? this.spec().lists.map(([id]) => id) : [];
    try {
      const res = await net.fetch(`${apiBase()}/api/v1/filters?lists=${ids.join(',')}&app=mac&v=${APP_VERSION}${daily ? '&daily=1' : ''}`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(30_000),
        credentials: 'omit',
      });
      if (!res.ok) throw new Error(`the filter service answered ${res.status}`);
      if (daily) this.state.countedDay = utcDay(Date.now());
      const body = (await res.json()) as { lists?: Record<string, unknown>; shield?: { version?: unknown; hash?: unknown } };
      const latest = body.lists ?? {};
      if (ctx.settings.get().shield.autoUpdate) {
        await ctx.shield.update(body.shield).catch((err) => console.warn('shield rules update failed:', err instanceof Error ? err.message : err));
      }
      let changed = 0;
      const failed: string[] = [];
      // One list failing must not hold back the others.
      for (const id of ids) {
        const rev = latest[id];
        if (typeof rev !== 'string' || !REV.test(rev) || rev === this.source(id).rev) continue;
        const name = CATALOG.lists[id]?.name ?? id;
        try {
          const r = await net.fetch(`${apiBase()}/api/v1/filters/${id}/${rev}`, { signal: AbortSignal.timeout(120_000) });
          if (!r.ok) throw new Error(`${r.status}`);
          const text = await r.text();
          if (!isPlausibleList(id, text)) throw new Error('damaged');
          fs.mkdirSync(path.join(this.userDir, 'lists'), { recursive: true });
          const file = path.join(this.userDir, 'lists', `${id}.txt`);
          fs.writeFileSync(`${file}.tmp`, text);
          fs.renameSync(`${file}.tmp`, file);
          this.state.lists[id] = { rev, sha256: crypto.createHash('sha256').update(text).digest('hex'), fetchedAt: new Date().toISOString() };
          changed++;
        } catch {
          failed.push(name);
        }
      }
      this.state.lastCheck = Date.now();
      this.state.lastError = failed.length ? `could not download ${failed.join(', ')}` : null;
      if (changed) await this.rebuild();
    } catch (err) {
      this.state.lastCheck = Date.now();
      this.state.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      this.saveState();
    }
  }

  private saveState(): void {
    try {
      fs.mkdirSync(this.userDir, { recursive: true });
      fs.writeFileSync(path.join(this.userDir, 'state.json'), JSON.stringify(this.state));
    } catch {}
  }

  status(): AdblockStatus {
    const groups = groupsFor(this.settings);
    return {
      ready: !!this.engine,
      compiling: !!this.compiling,
      updating: !!this.updating,
      filters: this.filterCount,
      lists: [...listsForGroups(groups), CATALOG.resources].map((id) => ({
        id,
        name: CATALOG.lists[id]?.name ?? id,
        group: CATALOG.groups.find((g) => g.lists.includes(id))?.id ?? 'resources',
        homepage: CATALOG.lists[id]?.homepage ?? '',
        fetchedAt: this.source(id).fetchedAt,
      })),
      lastCheck: this.state.lastCheck,
      lastError: this.state.lastError,
      customErrors: this.customErrors,
    };
  }
}

function frameUrls(frame: WebFrameMain | null | undefined): { frameUrl: string; topUrl: string } {
  try {
    if (frame) return { frameUrl: frame.url, topUrl: frame.top?.url ?? '' };
  } catch {}
  return { frameUrl: '', topUrl: '' };
}

function runCompiler(job: CompileJob): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = utilityProcess.fork(path.join(paths.root, 'dist', 'main', 'filters-compiler.js'), [], { serviceName: 'Potato Browser Filters' });
    let done = false;
    // A stuck compile must not hold up every later rebuild.
    const timer = setTimeout(() => {
      done = true;
      child.kill();
      reject(new Error('filter compiler timed out'));
    }, 120_000);
    child.once('message', (m: { ok: boolean; error?: string }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      if (m.ok) resolve();
      else reject(new Error(m.error));
    });
    child.once('exit', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(new Error(`filter compiler exited with ${code}`));
    });
    child.postMessage(job);
  });
}
