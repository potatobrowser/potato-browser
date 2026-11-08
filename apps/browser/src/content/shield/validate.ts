import type { HideTarget, Matcher, PlaceholderRewrite, ShieldFeature, ShieldRule } from './types';

/*
 * Checks downloaded AI Shield rules field by field before they are used. They are signed, so this
 * guards against our own mistakes more than against attackers: nothing can break out of the
 * `display: none` rules, raw CSS cannot load anything, and regexes stay small.
 */

const LIMITS = { rules: 500, features: 60, selectors: 300, text: 200, selector: 600, list: 200, pattern: 300 };

/** A selector that cannot end its rule and start another, open an at-rule or comment out its neighbours. */
export function isSafeSelector(s: unknown): s is string {
  return typeof s === 'string' && s.length > 0 && s.length <= LIMITS.selector && !/[{};@\\]|\/\*|\*\//.test(s);
}

/** Raw CSS from a rule: one plain `selector { declarations }`, loading nothing. */
export function isSafeExtraCss(s: unknown): s is string {
  if (typeof s !== 'string' || s.length > 1000) return false;
  const m = /^([^{}]+)\{([^{}]*)\}$/.exec(s.trim());
  return !!m && isSafeSelector(m[1]!.trim()) && !/[@\\]|\/\*|\*\/|url\s*\(|image-set|image\s*\(|expression|attr\s*\(|content\s*:/i.test(m[2]!);
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const strs = (v: unknown, max: number, each = LIMITS.text): v is string[] => Array.isArray(v) && v.length <= max && v.every((x) => str(x, each));
const id = (v: unknown): v is string => typeof v === 'string' && /^[a-z0-9][a-z0-9-]{0,47}$/.test(v);

function regexOk(p: string, flags = ''): boolean {
  if (p.length > LIMITS.pattern) return false;
  try {
    new RegExp(p, flags);
    return true;
  } catch {
    return false;
  }
}

function hide(v: unknown): HideTarget | undefined | null {
  if (v === undefined) return undefined;
  if (!isObj(v)) return null;
  const out: HideTarget = {};
  for (const k of ['closest', 'upTo', 'climbFree', 'stopAt'] as const) {
    if (v[k] === undefined) continue;
    if (!isSafeSelector(v[k])) return null;
    out[k] = v[k];
  }
  if (v.levels !== undefined) {
    if (!Number.isInteger(v.levels) || (v.levels as number) < 1 || (v.levels as number) > 12) return null;
    out.levels = v.levels as number;
  }
  return out;
}

function matcher(v: unknown): Matcher | null {
  if (!isObj(v) || !isSafeSelector(v.candidates)) return null;
  const m: Matcher = { candidates: v.candidates };
  if (v.attr !== undefined) {
    if (!(typeof v.attr === 'string' && /^[a-z][a-z0-9-]{0,40}$/.test(v.attr))) return null;
    m.attr = v.attr;
  }
  if (v.texts !== undefined) {
    if (!strs(v.texts, LIMITS.list)) return null;
    m.texts = v.texts;
  }
  if (v.patterns !== undefined) {
    if (!strs(v.patterns, 20, LIMITS.pattern) || !v.patterns.every((p) => regexOk(p, 'i'))) return null;
    m.patterns = v.patterns;
  }
  if (v.any !== undefined) {
    if (typeof v.any !== 'boolean') return null;
    m.any = v.any;
  }
  if (v.maxLength !== undefined) {
    if (!Number.isInteger(v.maxLength) || (v.maxLength as number) < 1 || (v.maxLength as number) > 10_000) return null;
    m.maxLength = v.maxLength as number;
  }
  if (v.notInside !== undefined) {
    if (!isSafeSelector(v.notInside)) return null;
    m.notInside = v.notInside;
  }
  const h = hide(v.hide);
  if (h === null) return null;
  if (h) m.hide = h;
  if (!m.any && !m.texts?.length && !m.patterns?.length) return null;
  return m;
}

function placeholder(v: unknown): PlaceholderRewrite | null {
  if (!isObj(v) || !isSafeSelector(v.selector) || !strs(v.patterns, 20, LIMITS.pattern) || !v.patterns.every((p) => regexOk(p, 'i'))) return null;
  if (!(typeof v.replacement === 'string' && v.replacement.length <= 80)) return null;
  return { selector: v.selector, patterns: v.patterns, replacement: v.replacement };
}

function feature(v: unknown): ShieldFeature | null {
  if (!isObj(v) || !id(v.id) || !str(v.name, 120)) return null;
  const f: ShieldFeature = { id: v.id, name: v.name };
  if (v.css !== undefined) {
    if (!Array.isArray(v.css) || v.css.length > LIMITS.selectors || !v.css.every(isSafeSelector)) return null;
    f.css = v.css;
  }
  if (v.extraCss !== undefined) {
    if (!Array.isArray(v.extraCss) || v.extraCss.length > 20 || !v.extraCss.every(isSafeExtraCss)) return null;
    f.extraCss = v.extraCss;
  }
  if (v.match !== undefined) {
    if (!Array.isArray(v.match) || v.match.length > 20) return null;
    const ms = v.match.map(matcher);
    if (ms.some((m) => !m)) return null;
    f.match = ms as Matcher[];
  }
  if (v.placeholders !== undefined) {
    if (!Array.isArray(v.placeholders) || v.placeholders.length > 20) return null;
    const ps = v.placeholders.map(placeholder);
    if (ps.some((p) => !p)) return null;
    f.placeholders = ps as PlaceholderRewrite[];
  }
  if (v.block !== undefined) {
    // Substrings of host + path; a bare host fragment would block whole sites.
    if (!strs(v.block, 40, 200) || !v.block.every((b) => b.includes('/') && b.length >= 4)) return null;
    f.block = v.block;
  }
  return f;
}

/** The rules, or null when anything in them is off (then the app keeps the rules it has). */
export function validateRules(v: unknown): ShieldRule[] | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > LIMITS.rules) return null;
  const out: ShieldRule[] = [];
  const ids = new Set<string>();
  for (const r of v) {
    if (!isObj(r) || !id(r.id) || ids.has(r.id) || !str(r.site, 120)) return null;
    ids.add(r.id);
    if (!strs(r.hosts, 50, 120) || !r.hosts.every((h) => h === '*' || /^(\*\.)?[a-z0-9.-]+(\.\*)?$/.test(h))) return null;
    if (r.paths !== undefined && (!strs(r.paths, 20, LIMITS.pattern) || !r.paths.every((p) => regexOk(p)))) return null;
    if (!Array.isArray(r.features) || r.features.length === 0 || r.features.length > LIMITS.features) return null;
    const fs = r.features.map(feature);
    if (fs.some((f) => !f)) return null;
    out.push({ id: r.id, site: r.site, hosts: r.hosts, ...(r.paths ? { paths: r.paths as string[] } : {}), features: fs as ShieldFeature[] });
  }
  return out;
}
