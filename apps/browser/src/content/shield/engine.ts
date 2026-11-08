import { RULES } from './rules';
import { ruleMatchesHost, ruleMatchesPath } from './match';
import type { HideTarget, Matcher, PlaceholderRewrite, ShieldFeature, ShieldRule } from './types';
import { isSafeExtraCss, isSafeSelector } from './validate';

export const HIDDEN_ATTR = 'data-potato-hidden';
const PLACEHOLDER_ATTR = 'data-potato-placeholder';

export interface ShieldReport {
  count: number;
  features: string[];
  delta: number;
}

export interface ShieldHost {
  insertCSS(css: string): string;
  removeCSS(key: string): void;
  report(r: ShieldReport): void;
}

/** `catalog`: the rules in use (downloaded updates included); the app's own by default. */
export function rulesFor(host: string, pathname = '/', catalog: ShieldRule[] = RULES): ShieldRule[] {
  return catalog.filter((r) => ruleMatchesHost(r, host) && ruleMatchesPath(r, pathname));
}

const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

const compiled = new WeakMap<object, { texts: Set<string>; patterns: RegExp[] }>();
function compile(m: { texts?: string[]; patterns?: string[] }) {
  let c = compiled.get(m);
  if (!c) {
    c = {
      texts: new Set((m.texts ?? []).map(norm)),
      patterns: (m.patterns ?? []).map((p) => new RegExp(p, 'i')),
    };
    compiled.set(m, c);
  }
  return c;
}

export function matcherHits(m: Matcher, el: Element): boolean {
  if (m.notInside && el.parentElement?.closest(m.notInside)) return false;
  if (m.any) return true;
  const raw = m.attr ? el.getAttribute(m.attr) : el.textContent;
  // Cheap bound before norm(): broad candidates (div, span) would otherwise normalize whole pages.
  if (raw == null || (m.maxLength && raw.length > m.maxLength * 10 + 200)) return false;
  const value = norm(raw);
  if (!value || (m.maxLength && value.length > m.maxLength)) return false;
  const c = compile(m);
  if (c.texts.has(value)) return true;
  return c.patterns.some((re) => re.test(value));
}

function containsAny(el: Element, selector: string): boolean {
  try {
    return !!el.querySelector(selector);
  } catch {
    return false;
  }
}

export function resolveTarget(el: Element, hide: HideTarget | undefined): Element | null {
  if (!hide) return el;
  if (hide.closest) {
    const c = el.closest(hide.closest);
    if (c) return c;
  }
  if (hide.upTo) {
    let cur: Element | null = el;
    while (cur?.parentElement && !cur.parentElement.matches(hide.upTo)) cur = cur.parentElement;
    if (cur?.parentElement) return cur;
  }
  if (hide.climbFree) {
    let cur: Element = el;
    while (cur.parentElement) {
      const parent: Element = cur.parentElement;
      if (hide.stopAt && parent.matches(hide.stopAt)) break;
      if (containsAny(parent, hide.climbFree)) break;
      cur = parent;
    }
    if (cur !== el || !hide.levels) return cur;
  }
  if (hide.levels) {
    let cur: Element | null = el;
    for (let i = 0; i < hide.levels && cur?.parentElement && cur.parentElement !== document.body; i++) cur = cur.parentElement;
    return cur;
  }
  return el;
}

function safeQueryAll(root: ParentNode, selector: string): Element[] {
  try {
    return Array.from(root.querySelectorAll(selector));
  } catch {
    return [];
  }
}

/** One stylesheet rule per selector, so one bad selector cannot disable the others. */
export function buildStylesheet(features: ShieldFeature[]): string {
  const lines = features.flatMap((f) => [
    ...(f.css ?? []).filter(isSafeSelector).map((sel) => `${sel} { display: none !important; }`),
    ...(f.extraCss ?? []).filter(isSafeExtraCss),
  ]);
  lines.push(`[${HIDDEN_ATTR}] { display: none !important; }`);
  return lines.join('\n');
}

/** Runs in every frame: applies the site's rules and keeps applying them as the page changes. */
export class ShieldEngine {
  private rules: ShieldRule[];
  private enabled = false;
  private disabled = new Set<string>();
  private cssKey: string | null = null;
  private cssText = '';
  private observer: MutationObserver | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastScan = 0;
  private lastCount = 0;
  private lastReport = '';
  private listening = false;

  private catalog: ShieldRule[] | undefined;

  constructor(
    private readonly host: ShieldHost,
    private readonly hostname: string,
    private readonly pathname: string,
    catalog?: ShieldRule[],
  ) {
    this.catalog = catalog;
    this.rules = rulesFor(hostname, pathname, catalog);
  }

  get active(): boolean {
    return this.rules.length > 0;
  }

  /** New rules for the page (a downloaded update); applied by the next apply(). */
  setCatalog(catalog: ShieldRule[]): void {
    if (catalog === this.catalog || JSON.stringify(catalog) === JSON.stringify(this.catalog)) return;
    const wasActive = this.active;
    this.catalog = catalog;
    this.rules = rulesFor(this.hostname, this.pathname, catalog);
    if (wasActive && !this.active) {
      this.removeCss();
      this.stopObserver();
      this.restorePlaceholders();
      this.lastCount = 0;
      this.send({ count: 0, features: [], delta: 0 });
    }
  }

  private features(): { rule: ShieldRule; feature: ShieldFeature }[] {
    return this.rules.flatMap((rule) =>
      rule.features
        .filter((f) => !this.disabled.has(`${rule.id}:${f.id}`) && !this.disabled.has(rule.id))
        .map((feature) => ({ rule, feature })),
    );
  }

  apply(config: { enabled: boolean; disabledRules: string[] }): void {
    if (!this.active) return;
    this.enabled = config.enabled;
    this.disabled = new Set(config.disabledRules);
    if (!this.enabled) {
      this.removeCss();
      this.stopObserver();
      this.restorePlaceholders();
      this.lastCount = 0;
      this.send({ count: 0, features: [], delta: 0 });
      return;
    }
    const css = buildStylesheet(this.features().map((x) => x.feature));
    if (css !== this.cssText) {
      this.removeCss();
      this.cssText = css;
      this.cssKey = this.host.insertCSS(css);
    }
    this.startObserver();
    this.schedule(0);
  }

  private removeCss(): void {
    if (this.cssKey) this.host.removeCSS(this.cssKey);
    this.cssKey = null;
    this.cssText = '';
  }

  private startObserver(): void {
    if (this.observer) return;
    const target = document.documentElement ?? document;
    this.observer = new MutationObserver(() => this.schedule(120));
    this.observer.observe(target, { childList: true, subtree: true, characterData: true });
    if (!this.listening) {
      this.listening = true;
      document.addEventListener('DOMContentLoaded', () => this.schedule(0), { once: true });
      window.addEventListener('load', () => this.schedule(0), { once: true });
    }
  }

  private stopObserver(): void {
    this.observer?.disconnect();
    this.observer = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(delay: number): void {
    if (this.timer || !this.enabled) return;
    const since = Date.now() - this.lastScan;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.enabled) this.scan();
    }, Math.max(delay, since < 250 ? 250 - since : 0));
  }

  private rewritePlaceholders(rules: PlaceholderRewrite[]): void {
    for (const r of rules) {
      const c = compile({ patterns: r.patterns });
      for (const el of safeQueryAll(document, r.selector)) {
        for (const attr of ['placeholder', 'aria-label']) {
          const value = el.getAttribute(attr);
          if (!value || value === r.replacement || !c.patterns.some((re) => re.test(value))) continue;
          if (!el.hasAttribute(`${PLACEHOLDER_ATTR}-${attr}`)) el.setAttribute(`${PLACEHOLDER_ATTR}-${attr}`, value);
          el.setAttribute(attr, r.replacement);
        }
      }
    }
  }

  private restorePlaceholders(): void {
    for (const attr of ['placeholder', 'aria-label']) {
      for (const el of safeQueryAll(document, `[${PLACEHOLDER_ATTR}-${attr}]`)) {
        el.setAttribute(attr, el.getAttribute(`${PLACEHOLDER_ATTR}-${attr}`) ?? '');
        el.removeAttribute(`${PLACEHOLDER_ATTR}-${attr}`);
      }
    }
  }

  /** Applies heuristics and counts what is hidden. Exposed for tests. */
  scan(): ShieldReport {
    this.lastScan = Date.now();
    const hits: { el: Element; name: string }[] = [];
    for (const { rule, feature } of this.features()) {
      for (const sel of feature.css ?? []) {
        for (const el of safeQueryAll(document, sel)) hits.push({ el, name: feature.name });
      }
      const mark = `${rule.id}:${feature.id}`;
      for (const m of feature.match ?? []) {
        for (const el of safeQueryAll(document, m.candidates)) {
          if (el.closest(`[${HIDDEN_ATTR}]`)) continue;
          if (!matcherHits(m, el)) continue;
          const target = resolveTarget(el, m.hide);
          if (!target || target === document.body || target === document.documentElement) continue;
          if (!target.hasAttribute(HIDDEN_ATTR)) target.setAttribute(HIDDEN_ATTR, mark);
        }
      }
      // Elements marked by earlier scans still count.
      if (feature.match?.length) {
        for (const el of safeQueryAll(document, `[${HIDDEN_ATTR}="${mark}"]`)) hits.push({ el, name: feature.name });
      }
      if (feature.placeholders) this.rewritePlaceholders(feature.placeholders);
    }
    // Count outermost hidden elements only, so nested matches are not counted twice.
    const unique = [...new Map(hits.map((h) => [h.el, h])).values()];
    const set = new Set(unique.map((h) => h.el));
    const outer = unique.filter((h) => {
      for (let p = h.el.parentElement; p; p = p.parentElement) if (set.has(p)) return false;
      return true;
    });
    const report: ShieldReport = {
      count: outer.length,
      features: [...new Set(outer.map((h) => h.name))],
      delta: Math.max(0, outer.length - this.lastCount),
    };
    this.lastCount = outer.length;
    this.send(report);
    return report;
  }

  private send(r: ShieldReport): void {
    const key = `${r.count}|${r.features.join(',')}`;
    if (key === this.lastReport) return;
    this.lastReport = key;
    this.host.report(r);
  }
}
