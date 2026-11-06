import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APP_DIR = path.resolve(__dirname, '../../..');

export interface LaunchOptions {
  settings?: Record<string, unknown>;
  /** Reuse a profile directory (to test persistence across restarts). */
  userData?: string;
  /** Fake home directory for profile import. */
  importHome?: string;
  firstRun?: boolean;
  env?: Record<string, string>;
}

export function defaultSettings(dir: string): Record<string, unknown> {
  return {
    firstRunDone: true,
    startup: 'newtab',
    searchSuggestions: false,
    downloadsDir: path.join(dir, 'Downloads'),
    flags: { mode: 'label', threshold: 3, showButtons: true, disabledPlatforms: [] },
  };
}

export class TestBrowser {
  constructor(
    readonly app: ElectronApplication,
    readonly userData: string,
  ) {}

  static async launch(opts: LaunchOptions = {}): Promise<TestBrowser> {
    const userData = opts.userData ?? fs.mkdtempSync(path.join(os.tmpdir(), 'noai-e2e-'));
    const settingsFile = path.join(userData, 'settings.json');
    if (!opts.userData || opts.settings) {
      const existing = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) : defaultSettings(userData);
      const merged = { ...existing, ...(opts.settings ?? {}) };
      if (opts.firstRun) merged.firstRunDone = false;
      fs.writeFileSync(settingsFile, JSON.stringify(merged));
    }
    // NOAI_E2E_EXECUTABLE runs the suite against a packaged build instead of the dev bundle.
    const packaged = process.env.NOAI_E2E_EXECUTABLE;
    const app = await electron.launch({
      ...(packaged ? { executablePath: packaged, args: [] } : { args: [APP_DIR] }),
      cwd: APP_DIR,
      env: {
        ...process.env,
        NOAI_TEST: '1',
        NOAI_USER_DATA: userData,
        NOAI_FIXTURE_PROXY: process.env.NOAI_E2E_FIXTURES ?? '',
        NOAI_FIXTURE_HOSTS: '*,-nonexistent.invalid',
        NOAI_API_BASE: process.env.NOAI_E2E_API ?? 'http://127.0.0.1:9',
        ...(opts.firstRun ? {} : { NOAI_SKIP_WELCOME: '1' }),
        ...(opts.importHome ? { NOAI_IMPORT_HOME: opts.importHome } : {}),
        ...(opts.env ?? {}),
      },
    });
    const b = new TestBrowser(app, userData);
    await b.uiPage();
    return b;
  }

  /** The chrome UI page of the focused (or given) window. */
  async uiPage(windowId?: number): Promise<Page> {
    const id = windowId ?? (await this.app.evaluate(() => (globalThis as any).__noai?.ctx.windows.focused()?.id ?? 1));
    await expect.poll(() => this.app.windows().some((p) => p.url().startsWith(`noai://ui/?window=${id}`)), { timeout: 20_000 }).toBe(true);
    const page = this.app.windows().find((p) => p.url().startsWith(`noai://ui/?window=${id}`))!;
    await page.waitForSelector('[data-testid=omnibox-input]');
    return page;
  }

  /** Runs a menu/shortcut command in the main process. */
  async cmd(name: string, ...args: unknown[]): Promise<void> {
    await this.app.evaluate(({}, [n, a]) => (globalThis as any).__noai.commands[n as string](...(a as unknown[])), [name, args] as const);
  }

  async activeTabUrl(): Promise<string> {
    return this.app.evaluate(() => (globalThis as any).__noai.ctx.windows.focused()?.activeTab?.url ?? '');
  }

  async tabUrls(): Promise<string[]> {
    return this.app.evaluate(() => (globalThis as any).__noai.ctx.windows.focused()?.tabs.map((t: any) => t.url) ?? []);
  }

  /** Navigates the active tab (as if typed in the omnibox) and returns its Page once loaded. */
  async goto(url: string, ui?: Page): Promise<Page> {
    const page = ui ?? (await this.uiPage());
    const input = page.getByTestId('omnibox-input');
    await input.click();
    await input.fill(url);
    await input.press('Enter');
    return this.tabPage(url);
  }

  /** The Page of a tab whose URL starts with (or contains) `match`. */
  async tabPage(match: string | RegExp): Promise<Page> {
    const test = (u: string) => (typeof match === 'string' ? u.startsWith(match) || u.includes(match) : match.test(u));
    await expect.poll(() => this.app.windows().some((p) => !p.url().startsWith('noai://ui') && test(p.url())), { timeout: 20_000 }).toBe(true);
    const page = this.app.windows().find((p) => !p.url().startsWith('noai://ui') && test(p.url()))!;
    await page.waitForLoadState('domcontentloaded');
    return page;
  }

  async settings(): Promise<any> {
    return this.app.evaluate(() => (globalThis as any).__noai.ctx.settings.get());
  }

  async updateSettings(patch: Record<string, unknown>): Promise<void> {
    await this.app.evaluate(({}, p) => (globalThis as any).__noai.ctx.settings.update(p), patch);
  }

  async windowState(): Promise<any> {
    return this.app.evaluate(() => (globalThis as any).__noai.ctx.windows.focused()?.state());
  }

  async close(): Promise<void> {
    await this.app.close().catch(() => {});
  }
}

export async function apiLookup(prefixes: string[]): Promise<{ h: string; n: number }[]> {
  const res = await fetch(`${process.env.NOAI_E2E_API}/api/v1/lookup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prefixes }),
  });
  return ((await res.json()) as { items: { h: string; n: number }[] }).items;
}

let clientSeq = 0;
/** Flags a content key as some other anonymous user. */
export async function flagAsOthers(key: string, count: number): Promise<void> {
  const { hashContentKey, parseContentKey } = await import('@noai/shared');
  const h = await hashContentKey(key);
  const platform = parseContentKey(key)!.platform;
  for (let i = 0; i < count; i++) {
    const client = (Date.now().toString(16) + (clientSeq++).toString(16).padStart(8, '0') + Math.random().toString(16).slice(2)).slice(0, 32).padEnd(32, '0');
    const res = await fetch(`${process.env.NOAI_E2E_API}/api/v1/flags`, {
      method: 'POST',
      // Each simulated person flags from a different network (votes count once per network).
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': `10.${process.pid % 200}.${clientSeq % 250}.9` },
      body: JSON.stringify({ h, platform, client }),
    });
    if (!res.ok) throw new Error(`seeding flag failed: ${res.status} ${await res.text()}`);
  }
}

export async function flagCount(key: string): Promise<number> {
  const { hashContentKey, hashPrefix } = await import('@noai/shared');
  const h = await hashContentKey(key);
  const items = await apiLookup([hashPrefix(h)]);
  return items.find((i) => i.h === h)?.n ?? 0;
}
