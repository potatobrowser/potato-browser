import type { WebContents } from 'electron';
import { RULES, rulesForHost, siteRulesForHost } from '../content/shield/rules';
import { ruleMatchesPath } from '../content/shield/match';
import type { PageConfig, ShieldRuleSummary } from '../shared/types';
import { hostMatches, siteKey } from '../shared/urls';
import { ctx } from './context';
import { isTest } from './paths';

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** Main-process side of the AI Shield: per-site state, page config and hidden-feature counts. */
export class ShieldService {
  isSupported(url: string): boolean {
    return siteRulesForHost(hostOf(url)).length > 0;
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
    for (const rule of rulesForHost(top.hostname)) {
      if (!ruleMatchesPath(rule, top.pathname) && rule.paths) continue;
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
      if (tab.isDestroyed) continue;
      const config = this.pageConfig(tab.wc, tab.url, tab.win.isPrivate);
      for (const frame of tab.wc.mainFrame.framesInSubtree) {
        try {
          frame.send('page:config', config);
        } catch {}
      }
    }
    ctx.windows.broadcast();
  }

  pageConfig(_wc: WebContents | null, topUrl: string, isPrivate: boolean): PageConfig {
    const s = ctx.settings.get();
    const web = /^https?:/.test(topUrl);
    return {
      isPrivate,
      testHooks: isTest(),
      shield: { enabled: web && this.isEnabledFor(topUrl), disabledRules: s.shield.disabledRules },
      adblock: { enabled: web && ctx.adblock.isEnabledFor(topUrl) },
      flags: {
        enabled: web && (s.flags.mode !== 'ignore' || s.flags.showButtons),
        mode: s.flags.mode,
        threshold: s.flags.threshold,
        showButtons: s.flags.showButtons,
        disabledPlatforms: s.flags.disabledPlatforms,
      },
    };
  }

  summaries(): ShieldRuleSummary[] {
    return RULES.map((r) => ({ id: r.id, site: r.site, hosts: r.hosts, features: r.features.map((f) => ({ id: f.id, name: f.name })) }));
  }

  recordHidden(delta: number, isPrivate: boolean): void {
    if (!isPrivate && delta > 0) ctx.db.addShieldHidden(delta);
  }
}
