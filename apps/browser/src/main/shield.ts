import fs from 'node:fs';
import path from 'node:path';
import { net, type WebContents } from 'electron';
import type { ShieldRulesEnvelope } from '@potato/shared';
import { RULES } from '../content/shield/rules';
import { ruleMatchesHost, ruleMatchesPath } from '../content/shield/match';
import type { ShieldRule } from '../content/shield/types';
import type { PageConfig, ShieldRuleSummary, ShieldRulesStatus } from '../shared/types';
import { hostMatches, siteKey } from '../shared/urls';
import { ctx } from './context';
import { apiBase, isTest, paths } from './paths';
import { openRules } from './shield-verify';

declare const __SHIELD_RULES_VERSION__: number;
declare const __SHIELD_RULES_HASH__: string;

/** The catalog this build ships (its git version and hash come from scripts/build.mjs). */
const BUNDLED = {
  rules: RULES,
  version: typeof __SHIELD_RULES_VERSION__ === 'number' ? __SHIELD_RULES_VERSION__ : 0,
  hash: typeof __SHIELD_RULES_HASH__ === 'string' ? __SHIELD_RULES_HASH__ : '',
};

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** Main-process side of the AI Shield: the rules in use, per-site state, page config and counts. */
export class ShieldService {
  private catalog: ShieldRule[] = BUNDLED.rules;
  private version = BUNDLED.version;
  private hash = BUNDLED.hash;
  private source: ShieldRulesStatus['source'] = 'app';
  private lastCheck: number | null = null;
  private fetching: Promise<void> | null = null;

  private get file(): string {
    return path.join(paths.userData, 'Shield', 'rules.json');
  }

  /** A rule update downloaded earlier wins over the app's rules when it is newer. */
  init(): void {
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8')) as ShieldRulesEnvelope & { checkedAt?: number };
      this.lastCheck = typeof saved.checkedAt === 'number' ? saved.checkedAt : null;
      const opened = openRules(saved);
      if (opened && opened.version > BUNDLED.version && opened.hash !== BUNDLED.hash) this.use(opened, 'update');
    } catch {}
  }

  private use(r: { rules: ShieldRule[]; version: number; hash: string }, source: ShieldRulesStatus['source']): void {
    this.catalog = r.rules;
    this.version = r.version;
    this.hash = r.hash;
    this.source = source;
  }

  status(): ShieldRulesStatus {
    return { source: this.source, version: this.version, rules: this.catalog.length, lastCheck: this.lastCheck };
  }

  /**
   * From the daily check: downloads the rules when the site has newer ones, checks their
   * signature (the server alone cannot change them) and swaps them in for every open page.
   */
  update(latest: { version?: unknown; hash?: unknown } | undefined): Promise<void> {
    this.lastCheck = Date.now();
    const version = latest?.version;
    if (typeof version !== 'number' || typeof latest?.hash !== 'string' || latest.hash === this.hash || version <= this.version) return Promise.resolve();
    this.fetching ??= this.download().finally(() => (this.fetching = null));
    return this.fetching;
  }

  private async download(): Promise<void> {
    const res = await net.fetch(`${apiBase()}/api/v1/shield/rules`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30_000), credentials: 'omit' });
    if (!res.ok) throw new Error(`the rules service answered ${res.status}`);
    const envelope = (await res.json()) as ShieldRulesEnvelope;
    const opened = openRules(envelope);
    if (!opened) throw new Error('the rule update is not signed or not valid');
    if (opened.version <= this.version) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify({ payload: envelope.payload, signature: envelope.signature, checkedAt: this.lastCheck }));
    fs.renameSync(`${this.file}.tmp`, this.file);
    this.use(opened, 'update');
    this.broadcast();
  }

  /** Rules that apply to a host, excluding the catch-all widget rule. */
  private siteRules(host: string): ShieldRule[] {
    return this.catalog.filter((r) => !r.hosts.includes('*') && ruleMatchesHost(r, host));
  }

  isSupported(url: string): boolean {
    return this.siteRules(hostOf(url)).length > 0;
  }

  /**
   * Network side of the shield: requests that only produce AI output are cancelled, and Google's
   * AI Mode (udm=50) is sent back to regular results. Returns a redirect URL, 'cancel' or null.
   */
  filterRequest(url: string, topUrl: string, isMainFrame: boolean): string | 'cancel' | null {
    if (!/^https?:/.test(topUrl) || !this.isEnabledFor(topUrl)) return null;
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return null;
    }
    if (isMainFrame) {
      if (/^(www\.)?google\.[a-z.]+$/.test(u.hostname) && !this.isRuleDisabled('google-search', 'ai-mode')) {
        if (u.pathname === '/ai' || u.pathname === '/aimode') return `${u.origin}/`;
        if (u.pathname === '/search' && u.searchParams.get('udm') === '50') {
          u.searchParams.delete('udm');
          u.searchParams.delete('aep');
          u.searchParams.delete('ntc');
          return u.toString();
        }
      }
      return null;
    }
    const top = new URL(topUrl);
    const target = u.hostname + u.pathname;
    for (const rule of this.catalog) {
      if (!ruleMatchesHost(rule, top.hostname) || (rule.paths && !ruleMatchesPath(rule, top.pathname))) continue;
      for (const f of rule.features) {
        if (!f.block?.length || this.isRuleDisabled(rule.id, f.id)) continue;
        if (f.block.some((b) => target.includes(b))) return 'cancel';
      }
    }
    return null;
  }

  private isRuleDisabled(ruleId: string, featureId: string): boolean {
    const d = ctx.settings.get().shield.disabledRules;
    return d.includes(ruleId) || d.includes(`${ruleId}:${featureId}`);
  }

  isSiteDisabled(url: string): boolean {
    const host = hostOf(url);
    if (!host) return false;
    return ctx.settings.get().shield.disabledSites.some((s) => hostMatches(host, s));
  }

  isEnabledFor(url: string): boolean {
    return ctx.settings.get().shield.enabled && !this.isSiteDisabled(url);
  }

  /** Turns hiding on/off for the site of `url` and updates every open page of that site live. */
  setSiteEnabled(url: string, enabled: boolean): void {
    const host = hostOf(url);
    if (!host) return;
    const key = siteKey(url);
    const s = ctx.settings.get().shield;
    // Remove any entry covering this host (it may have been added for a parent domain).
    let sites = s.disabledSites.filter((d) => !hostMatches(host, d));
    if (!enabled) sites = [...sites, key];
    ctx.settings.update({ shield: { disabledSites: sites } });
  }

  /** Pushes the current state to every frame of every tab (after any settings change). */
  broadcast(): void {
    for (const tab of ctx.windows.allTabs()) {
      // Asleep tabs read the settings when they wake.
      const wc = tab.wc;
      if (!wc) continue;
      for (const frame of wc.mainFrame.framesInSubtree) {
        try {
          frame.send('page:config', this.pageConfig(wc, tab.url, tab.win.isPrivate, frame.url));
        } catch {}
      }
    }
    ctx.windows.broadcast();
  }

  /** `frameUrl`: the frame asking, whose host picks the rules it gets. */
  pageConfig(_wc: WebContents | null, topUrl: string, isPrivate: boolean, frameUrl = topUrl): PageConfig {
    const s = ctx.settings.get();
    const web = /^https?:/.test(topUrl);
    const frameHost = hostOf(frameUrl);
    return {
      isPrivate,
      testHooks: isTest(),
      shield: {
        enabled: web && this.isEnabledFor(topUrl),
        disabledRules: s.shield.disabledRules,
        rules: frameHost ? this.catalog.filter((r) => ruleMatchesHost(r, frameHost)) : [],
      },
      adblock: { enabled: web && ctx.adblock.isEnabledFor(topUrl) },
      flags: {
        enabled: web && (s.flags.mode !== 'ignore' || s.flags.showButtons),
        mode: s.flags.mode,
        threshold: s.flags.threshold,
        showButtons: s.flags.showButtons,
        disabledPlatforms: s.flags.disabledPlatforms,
      },
      passwords: ctx.passwords.pageConfig(isPrivate),
    };
  }

  summaries(): ShieldRuleSummary[] {
    return this.catalog.map((r) => ({ id: r.id, site: r.site, hosts: r.hosts, features: r.features.map((f) => ({ id: f.id, name: f.name })) }));
  }

  recordHidden(delta: number, isPrivate: boolean): void {
    if (!isPrivate && delta > 0) ctx.db.addShieldHidden(delta);
  }
}
