/**
 * Converts ABP / uBlock Origin network filters into WebKit content rule lists (the JSON that
 * WKContentRuleListStore compiles). Runs at build time in Node and on the device in
 * JavaScriptCore (list updates, the user's own filters), so it uses no Node or DOM APIs.
 *
 * WebKit rejects a whole list when one url-filter is outside its regex subset, so every pattern
 * goes through `isWebKitRegex`, which mirrors WebCore's URLFilterParser.
 */

export interface WebKitTrigger {
  'url-filter': string;
  'url-filter-is-case-sensitive'?: boolean;
  'resource-type'?: string[];
  'load-type'?: string[];
  'load-context'?: string[];
  'if-domain'?: string[];
  'unless-domain'?: string[];
  'if-top-url'?: string[];
  'unless-top-url'?: string[];
}

export type WebKitAction = { type: 'block' } | { type: 'ignore-previous-rules' };

export interface WebKitRule {
  trigger: WebKitTrigger;
  action: WebKitAction;
}

/** `!#if` tokens for Potato Browser on iOS (WebKit, mobile, Ghostery's engine for cosmetics). */
export const IOS_ENV: Record<string, boolean> = {
  env_safari: true,
  env_mobile: true,
  ext_ghostery: true,
  cap_html_filtering: false,
  cap_user_stylesheet: false,
  cap_ipaddress: false,
};

export const MAX_RULES = 150_000;

// ---- preprocessor ------------------------------------------------------------------------------

/** Evaluates a `!#if` expression: tokens, `!`, `&&`, `||` and parentheses. Unknown tokens are false. */
export function evaluateCondition(expr: string, env: Record<string, boolean>): boolean {
  const tokens = expr.match(/\(|\)|!|&&|\|\||[A-Za-z0-9_]+/g) ?? [];
  let i = 0;
  const primary = (): boolean => {
    const t = tokens[i++];
    if (t === '!') return !primary();
    if (t === '(') {
      const v = or();
      i++; // ')'
      return v;
    }
    return t ? env[t] === true : false;
  };
  const and = (): boolean => {
    let v = primary();
    while (tokens[i] === '&&') {
      i++;
      const r = primary();
      v = v && r;
    }
    return v;
  };
  const or = (): boolean => {
    let v = and();
    while (tokens[i] === '||') {
      i++;
      const r = and();
      v = v || r;
    }
    return v;
  };
  return or();
}

/** The lines of a list that apply in `env` (`!#if` / `!#else` / `!#endif` resolved). */
export function preprocess(text: string, env: Record<string, boolean>): string[] {
  const out: string[] = [];
  const stack: { active: boolean; parent: boolean }[] = [];
  let active = true;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('!#if ')) {
      stack.push({ active, parent: active });
      active = active && evaluateCondition(line.slice(5), env);
      continue;
    }
    if (line === '!#else') {
      const top = stack[stack.length - 1];
      if (top) active = top.parent && !active;
      continue;
    }
    if (line === '!#endif') {
      const top = stack.pop();
      active = top ? top.active : true;
      continue;
    }
    if (active) out.push(line);
  }
  return out;
}

// ---- filter parsing ----------------------------------------------------------------------------

export type ContentType =
  | 'script'
  | 'image'
  | 'stylesheet'
  | 'font'
  | 'media'
  | 'object'
  | 'xhr'
  | 'websocket'
  | 'ping'
  | 'subdocument'
  | 'other'
  | 'document'
  | 'popup'
  | 'webrtc';

const TYPE_ALIASES: Record<string, ContentType> = {
  script: 'script',
  image: 'image',
  stylesheet: 'stylesheet',
  css: 'stylesheet',
  font: 'font',
  media: 'media',
  object: 'object',
  'object-subrequest': 'object',
  xmlhttprequest: 'xhr',
  xhr: 'xhr',
  websocket: 'websocket',
  ping: 'ping',
  beacon: 'ping',
  subdocument: 'subdocument',
  frame: 'subdocument',
  other: 'other',
  document: 'document',
  doc: 'document',
  popup: 'popup',
  webrtc: 'webrtc',
};

const ALL_TYPES = Object.values(TYPE_ALIASES).filter((t, i, a) => a.indexOf(t) === i);

export interface ParsedFilter {
  raw: string;
  exception: boolean;
  pattern: string;
  types: Set<ContentType> | null;
  party: 'first' | 'third' | null;
  domains: string[];
  notDomains: string[];
  to: string[];
  /** Request domains a block does not apply to (`denyallow=`). */
  denyallow: string[];
  matchCase: boolean;
  important: boolean;
  /** `redirect=`: blocked like any filter (WKWebView has no redirects for apps). */
  redirect: string | null;
  /** `csp=`: not expressible (WKWebView has no header changes for apps). */
  csp: string | null;
  /** elemhide, generichide, specifichide: exceptions that only concern cosmetics. */
  cosmeticOnly: boolean;
  badfilter: boolean;
}

/** Cosmetic filters, scriptlets and HTML filters: handled by the cosmetic engine, not here. */
export function isCosmeticLine(line: string): boolean {
  return /#[@?$%]?#|#@?\$\??#|#@?%#|\$@?\$/.test(line) && !/^\/.*\/(\$.*)?$/.test(line);
}

function splitOptions(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '\\' && s[i + 1] === ',') {
      cur += ',';
      i++;
    } else if (c === ',') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out.map((o) => o.trim()).filter(Boolean);
}

/** Index of the `$` that starts the options, or -1. */
function optionsIndex(line: string): number {
  if (line.startsWith('/')) {
    // A regex pattern may contain `$`; the options come after its closing slash.
    const end = line.lastIndexOf('/$');
    if (end > 0) return end + 1;
    return line.endsWith('/') ? -1 : line.lastIndexOf('$');
  }
  return line.lastIndexOf('$');
}

const UNSUPPORTED_OPTIONS = new Set([
  'redirect-rule',
  'removeparam',
  'queryprune',
  'header',
  'permissions',
  'method',
  'replace',
  'urlskip',
  'uritransform',
  'urltransform',
  'ipaddress',
  'genericblock',
  'empty',
  'mp4',
  'inline-script',
  'inline-font',
  'popunder',
  'cname',
  'sitekey',
  'rewrite',
  'reason',
  'requestheader',
  'responseheader',
]);

/** Parses one network filter line; null when it is not one or uses options WebKit cannot express. */
export function parseNetworkFilter(rawLine: string): ParsedFilter | null {
  let line = rawLine.trim();
  if (!line || line.startsWith('!') || line.startsWith('[') || isCosmeticLine(line)) return null;
  const f: ParsedFilter = {
    raw: line,
    exception: false,
    pattern: '',
    types: null,
    party: null,
    domains: [],
    notDomains: [],
    to: [],
    denyallow: [],
    matchCase: false,
    important: false,
    redirect: null,
    csp: null,
    cosmeticOnly: false,
    badfilter: false,
  };
  if (line.startsWith('@@')) {
    f.exception = true;
    line = line.slice(2);
  }
  const idx = optionsIndex(line);
  let opts: string[] = [];
  if (idx >= 0) {
    opts = splitOptions(line.slice(idx + 1));
    line = line.slice(0, idx);
  }
  f.pattern = line;
  const types = new Set<ContentType>();
  const notTypes = new Set<ContentType>();
  for (const opt of opts) {
    const eq = opt.indexOf('=');
    const name = (eq >= 0 ? opt.slice(0, eq) : opt).toLowerCase();
    const value = eq >= 0 ? opt.slice(eq + 1) : '';
    const negated = name.startsWith('~');
    const bare = negated ? name.slice(1) : name;
    if (bare in TYPE_ALIASES && !value) {
      (negated ? notTypes : types).add(TYPE_ALIASES[bare]!);
      continue;
    }
    switch (bare) {
      case 'all':
        if (negated) return null;
        ALL_TYPES.forEach((t) => types.add(t));
        continue;
      case 'third-party':
      case '3p':
        f.party = negated ? 'first' : 'third';
        continue;
      case 'first-party':
      case '1p':
        f.party = negated ? 'third' : 'first';
        continue;
      case 'strict1p':
        f.party = 'first';
        continue;
      case 'strict3p':
        f.party = 'third';
        continue;
      case 'domain':
      case 'from': {
        if (negated || !value || value.startsWith('/')) return null;
        for (const d of value.split('|')) {
          const domain = d.trim().toLowerCase();
          if (!domain) continue;
          if (domain.startsWith('~')) f.notDomains.push(domain.slice(1));
          else f.domains.push(domain);
        }
        continue;
      }
      case 'to': {
        if (negated || !value) return null;
        for (const d of value.split('|')) {
          const domain = d.trim().toLowerCase();
          if (!domain || domain.startsWith('~') || domain.startsWith('/')) return null;
          f.to.push(domain);
        }
        continue;
      }
      case 'denyallow': {
        if (negated || !value) return null;
        for (const d of value.split('|')) {
          const domain = d.trim().toLowerCase();
          if (!domain || domain.startsWith('~') || domain.includes('*') || domain.startsWith('/')) return null;
          f.denyallow.push(domain);
        }
        continue;
      }
      case 'match-case':
        f.matchCase = !negated;
        continue;
      case 'important':
        f.important = true;
        continue;
      case 'redirect':
        if (!value) return null;
        f.redirect = value.replace(/:\d+$/, '');
        continue;
      case 'csp':
        f.csp = value;
        continue;
      case 'elemhide':
      case 'ehide':
      case 'generichide':
      case 'ghide':
      case 'specifichide':
      case 'shide':
        f.cosmeticOnly = true;
        continue;
      case 'badfilter':
        f.badfilter = true;
        continue;
      case '_':
      case 'stealth':
        continue;
      default:
        if (/^_+$/.test(bare)) continue;
        if (UNSUPPORTED_OPTIONS.has(bare)) return null;
        return null;
    }
  }
  if (types.size || notTypes.size) {
    const base = types.size ? types : new Set(ALL_TYPES.filter((t) => t !== 'document' && t !== 'popup'));
    for (const t of notTypes) base.delete(t);
    f.types = base;
  }
  return f;
}

/** The filter text without `badfilter`, for matching `$badfilter` lines to their targets. */
export function badfilterKey(raw: string): string {
  return raw
    .replace(/([$,])badfilter(?=,|$)/, '$1')
    .replace(/,+$/, '')
    .replace(/,,+/g, ',')
    .replace(/\$,/, '$')
    .replace(/\$$/, '');
}

// ---- patterns ----------------------------------------------------------------------------------

/** ABP separator `^`: anything but a letter, digit, `_ - . %`. */
const SEP = '[^a-zA-Z0-9_.%-]';
const HOST_ANCHOR = '^[^:]+://+([^/]+\\.)?';

/**
 * Mirrors WebCore's URLFilterParser: ASCII only, no alternation, no `{n,m}`, no built-in classes
 * except `.`, no back references or lookarounds, `^` only first and `$` only last.
 */
export function isWebKitRegex(p: string): boolean {
  if (!p || !/^[\x20-\x7e]*$/.test(p)) return false;
  let depth = 0;
  let canQuantify = false;
  let lastWasQuantifier = false;
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === '\\') {
      const n = p[i + 1];
      if (n === undefined || /[0-9dDwWsSbBuxcpPk]/.test(n)) return false;
      i++;
      canQuantify = true;
      lastWasQuantifier = false;
      continue;
    }
    if (c === '[') {
      let j = i + 1;
      if (p[j] === '^') j++;
      if (p[j] === ']') return false;
      let closed = false;
      for (; j < p.length; j++) {
        const d = p[j]!;
        if (d === '\\') {
          const n = p[j + 1];
          if (n === undefined || /[0-9dDwWsSbBuxcpPk]/.test(n)) return false;
          j++;
          continue;
        }
        if (d === '[') return false;
        if (d === ']') {
          closed = true;
          break;
        }
      }
      if (!closed) return false;
      i = j;
      canQuantify = true;
      lastWasQuantifier = false;
      continue;
    }
    if (c === '(') {
      if (p[i + 1] === '?') {
        if (p[i + 2] !== ':') return false;
        i += 2;
      }
      depth++;
      canQuantify = false;
      lastWasQuantifier = false;
      continue;
    }
    if (c === ')') {
      if (--depth < 0) return false;
      canQuantify = true;
      lastWasQuantifier = false;
      continue;
    }
    if (c === '*' || c === '+' || c === '?') {
      if (lastWasQuantifier && c === '?') {
        lastWasQuantifier = false;
        canQuantify = false;
        continue;
      }
      if (!canQuantify) return false;
      canQuantify = false;
      lastWasQuantifier = true;
      continue;
    }
    if (c === '|' || c === '{' || c === '}') return false;
    if (c === '^') {
      if (i !== 0) return false;
      canQuantify = false;
      lastWasQuantifier = false;
      continue;
    }
    if (c === '$') {
      if (i !== p.length - 1) return false;
      continue;
    }
    canQuantify = true;
    lastWasQuantifier = false;
  }
  return depth === 0;
}

/** Rewrites a `/regex/` filter into WebKit's subset, or null. */
export function convertRegexFilter(src: string): string | null {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (c === '\\') {
      const n = src[i + 1];
      if (n === 'd') out += '[0-9]';
      else if (n === 'w') out += '[a-zA-Z0-9_]';
      else if (n === undefined) return null;
      else out += c + n;
      i++;
      continue;
    }
    out += c;
  }
  // Inside classes, \d and \w became nested classes: not allowed.
  return isWebKitRegex(out) ? out : null;
}

/** Converts an ABP pattern to url-filter regexes (two when a trailing `^` may also be the end). */
export function patternToRegexes(pattern: string): string[] | null {
  if (pattern.length > 2 && pattern.startsWith('/') && pattern.endsWith('/')) {
    const re = convertRegexFilter(pattern.slice(1, -1));
    return re ? [re] : null;
  }
  if (!/^[\x20-\x7e]*$/.test(pattern)) return null;
  let p = pattern;
  let prefix = '';
  if (p.startsWith('||')) {
    prefix = HOST_ANCHOR;
    p = p.slice(2);
  } else if (p.startsWith('|')) {
    prefix = '^';
    p = p.slice(1);
  }
  let suffix = '';
  if (p.endsWith('|')) {
    suffix = '$';
    p = p.slice(0, -1);
  }
  // `||host^`: a host is always followed by `/` or `:` in a request URL.
  const hostOnly = prefix === HOST_ANCHOR && /^[a-z0-9.-]+\^$/i.test(p);
  let body = '';
  for (const c of p) {
    if (c === '*') body += '.*';
    else if (c === '^') body += SEP;
    else if (/[a-zA-Z0-9_\-%/:=&,;@!~'"<> ]/.test(c)) body += c;
    else body += '\\' + c;
  }
  if (!prefix) body = body.replace(/^(\.\*)+/, '');
  if (!suffix) body = body.replace(/(\.\*)+$/, '');
  let re = prefix + body + suffix;
  if (!re || re === '^') re = '.*';
  const out = [re];
  if (!hostOnly && !suffix && re.endsWith(SEP)) out.push(re.slice(0, -SEP.length) + '$');
  return out.every(isWebKitRegex) ? out : null;
}

// ---- domains -----------------------------------------------------------------------------------

/** Public suffixes an entity (`google.*`) expands to: the common ones, not all of them. */
export const ENTITY_SUFFIXES = [
  'com', 'net', 'org', 'de', 'fr', 'it', 'es', 'nl', 'be', 'ch', 'at', 'pl', 'cz', 'hu', 'ro', 'gr',
  'se', 'no', 'dk', 'fi', 'ie', 'pt', 'sk', 'ru', 'ua', 'tr', 'com.tr', 'co.uk', 'ca', 'com.au', 'co.nz',
  'co.jp', 'jp', 'co.kr', 'co.in', 'in', 'com.br', 'com.mx', 'com.ar', 'cl', 'co', 'com.co', 'co.za',
  'com.sg', 'com.hk', 'com.tw', 'co.id', 'com.my', 'com.ph', 'co.th', 'com.vn', 'co.il', 'ae', 'com.sa',
  'com.eg', 'com.pk', 'com.ng', 'bg', 'hr', 'si', 'rs', 'lt', 'lv', 'ee', 'lu', 'is',
];

/** `example.com` -> `*example.com` (subdomains too); `google.*` -> one entry per suffix. */
export function webkitDomains(domains: string[]): string[] {
  const out = new Set<string>();
  for (const raw of domains) {
    const d = raw.replace(/^\*\./, '');
    if (!d || !/^[a-z0-9.*-]+$/.test(d)) continue;
    if (d.endsWith('.*')) {
      const base = d.slice(0, -2);
      if (base.includes('*')) continue;
      for (const s of ENTITY_SUFFIXES) out.add(`*${base}.${s}`);
    } else if (!d.includes('*')) out.add(`*${d}`);
  }
  return [...out];
}

// ---- conversion --------------------------------------------------------------------------------

const RESOURCE_TYPES: Partial<Record<ContentType, string>> = {
  script: 'script',
  image: 'image',
  stylesheet: 'style-sheet',
  font: 'font',
  media: 'media',
  object: 'other',
  xhr: 'fetch',
  websocket: 'websocket',
  ping: 'ping',
  other: 'other',
};

export interface Converted {
  blocks: WebKitRule[];
  exceptions: WebKitRule[];
  important: WebKitRule[];
  allowPages: WebKitRule[];
}

export function emptyConverted(): Converted {
  return { blocks: [], exceptions: [], important: [], allowPages: [] };
}

interface TriggerVariant {
  types: string[] | undefined;
  context?: string[];
}

/** The resource-type / load-context combinations a filter needs (iframes need their own rule). */
function typeVariants(types: Set<ContentType> | null): TriggerVariant[] | null {
  if (!types) return [{ types: undefined }];
  const mapped = new Set<string>();
  for (const t of types) {
    const r = RESOURCE_TYPES[t];
    if (r) mapped.add(r);
  }
  const variants: TriggerVariant[] = [];
  if (mapped.size) variants.push({ types: [...mapped] });
  if (types.has('subdocument')) variants.push({ types: ['document'], context: ['child-frame'] });
  return variants.length ? variants : null;
}

function baseTriggers(f: ParsedFilter): WebKitTrigger[] | null {
  let patterns: string[] | null;
  if (f.to.length) {
    if (f.pattern && f.pattern !== '*') return null;
    patterns = [];
    for (const d of f.to) {
      if (d.endsWith('.*') || d.includes('*')) return null;
      const r = patternToRegexes(`||${d}^`);
      if (!r) return null;
      patterns.push(...r);
    }
  } else patterns = patternToRegexes(f.pattern || '*');
  if (!patterns) return null;
  return patterns.map((p) => {
    const t: WebKitTrigger = { 'url-filter': p };
    if (f.matchCase) t['url-filter-is-case-sensitive'] = true;
    if (f.party) t['load-type'] = [f.party === 'first' ? 'first-party' : 'third-party'];
    return t;
  });
}

/** Adds the filter's rules to `out`. Returns false when it cannot be expressed. */
export function convertFilter(f: ParsedFilter, out: Converted): boolean {
  if (f.badfilter || (f.cosmeticOnly && !f.exception)) return false;
  if (f.cosmeticOnly) return true; // cosmetic exceptions live in the cosmetic engine
  const ifDomains = webkitDomains(f.domains);
  const unlessDomains = webkitDomains(f.notDomains);
  if (f.domains.length && !ifDomains.length) return false;

  // Page allowlist: `@@||site^$document` turns everything off on matching pages.
  if (f.exception && f.types?.has('document') && !f.csp) {
    if (f.domains.length || f.notDomains.length) return false;
    const tops = patternToRegexes(f.pattern || '*');
    if (!tops) return false;
    out.allowPages.push({
      trigger: { 'url-filter': '.*', 'if-top-url': tops },
      action: { type: 'ignore-previous-rules' },
    });
    return true;
  }

  const bases = baseTriggers(f);
  if (!bases) return false;
  const denied: string[] = [];
  for (const d of f.denyallow) {
    const r = patternToRegexes(`||${d}^`);
    if (!r) return false;
    denied.push(...r);
  }
  const withDomains = (t: WebKitTrigger): WebKitTrigger[] => {
    if (ifDomains.length) return [{ ...t, 'if-domain': ifDomains }];
    if (unlessDomains.length) return [{ ...t, 'unless-domain': unlessDomains }];
    return [t];
  };

  // `$csp` needs modify-headers, which WKWebView ignores outside Safari extensions.
  if (f.csp !== null) return false;

  const types = f.types ? new Set(f.types) : null;
  types?.delete('document');
  types?.delete('popup');
  types?.delete('webrtc');
  const variants = typeVariants(types);
  if (!variants) return false;
  for (const b of bases) {
    for (const v of variants) {
      const t: WebKitTrigger = { ...b };
      if (v.types) t['resource-type'] = v.types;
      if (v.context) t['load-context'] = v.context;
      for (const trigger of withDomains(t)) {
        // WKWebView ignores `redirect` actions outside Safari extensions, so a filter with a
        // stand-in (`redirect=`) blocks the request like any other.
        if (f.exception) out.exceptions.push({ trigger, action: { type: 'ignore-previous-rules' } });
        else (f.important ? out.important : out.blocks).push({ trigger, action: { type: 'block' } });
        // `denyallow=`: the allowed request domains are exceptions of this block only.
        if (!f.exception) {
          for (const p of denied) out.exceptions.push({ trigger: { ...trigger, 'url-filter': p }, action: { type: 'ignore-previous-rules' } });
        }
        // `domain=a.com|~b.a.com`: the negated subdomains get an exception right after.
        if (!f.exception && ifDomains.length && unlessDomains.length) {
          out.exceptions.push({ trigger: { ...t, 'if-domain': unlessDomains }, action: { type: 'ignore-previous-rules' } });
        }
      }
    }
  }
  return true;
}

export interface ConvertStats {
  filters: number;
  converted: number;
  skipped: number;
  badfiltered: number;
}

/** Network filters of `lists` (raw text), converted; `badfilters` are collected across lists. */
export function convertLists(
  lists: string[],
  opts: { env?: Record<string, boolean>; badfilters?: Set<string> } = {},
): { converted: Converted; stats: ConvertStats } {
  const env = opts.env ?? IOS_ENV;
  const parsed: ParsedFilter[] = [];
  const bad = opts.badfilters ?? new Set<string>();
  for (const text of lists) {
    for (const line of preprocess(text, env)) {
      const f = parseNetworkFilter(line);
      if (!f) continue;
      if (f.badfilter) bad.add(badfilterKey(f.raw));
      else parsed.push(f);
    }
  }
  const converted = emptyConverted();
  const stats: ConvertStats = { filters: parsed.length, converted: 0, skipped: 0, badfiltered: 0 };
  const seen = new Set<string>();
  for (const f of parsed) {
    if (bad.has(f.raw)) {
      stats.badfiltered++;
      continue;
    }
    if (seen.has(f.raw)) continue;
    seen.add(f.raw);
    if (convertFilter(f, converted)) stats.converted++;
    else stats.skipped++;
  }
  return { converted, stats };
}

/** All `$badfilter` targets in `lists`. */
export function collectBadfilters(lists: string[], env: Record<string, boolean> = IOS_ENV): Set<string> {
  const bad = new Set<string>();
  for (const text of lists) {
    for (const line of preprocess(text, env)) {
      if (!line.includes('badfilter')) continue;
      const f = parseNetworkFilter(line);
      if (f?.badfilter) bad.add(badfilterKey(f.raw));
    }
  }
  return bad;
}

/** Main-frame documents are never blocked (the Mac app does not block whole pages either). */
const ALLOW_TOP_DOCUMENT: WebKitRule = {
  trigger: { 'url-filter': '.*', 'resource-type': ['document'], 'load-context': ['top-frame'] },
  action: { type: 'ignore-previous-rules' },
};

/**
 * One rule list in WebKit's evaluation order: blocks, exceptions, important blocks, the
 * top-document allow, then whole-page allows. `extraExceptions` are exceptions from other lists
 * that also apply here.
 */
export function assemble(c: Converted, extraExceptions: WebKitRule[] = []): WebKitRule[] {
  const rules = [
    ...c.blocks,
    ...c.exceptions,
    ...extraExceptions,
    ...c.important,
    ALLOW_TOP_DOCUMENT,
    ...c.allowPages,
  ];
  if (rules.length > MAX_RULES) throw new Error(`${rules.length} rules, WebKit allows ${MAX_RULES}`);
  return rules;
}
