/**
 * AI Shield rule format.
 *
 * A rule covers one site (or product) and lists its AI features. Each feature is hidden by
 *  - `css`: selectors hidden with a user-origin `display:none !important` stylesheet injected at
 *    document start (user !important beats any page style, so nothing flashes), and/or
 *  - `match`: JS heuristics for things without stable selectors (visible text, aria-labels).
 *    Matches mark an ancestor with `data-noai-hidden`, which the same stylesheet hides, so turning
 *    the shield off for a site is a single stylesheet removal.
 * Rules may also rewrite AI search placeholders and block requests that only serve AI answers
 * (the latter is applied by the main process).
 */
export interface ShieldRule {
  id: string;
  /** Display name, e.g. "Google Search". */
  site: string;
  /**
   * Host patterns. `google.*` matches any Google ccTLD (google.de, google.co.uk), a leading
   * `*.` matches subdomains, `www.` is always optional, and `*` matches every site.
   */
  hosts: string[];
  /** Optional path regex sources; the rule only applies when one matches location.pathname. */
  paths?: string[];
  features: ShieldFeature[];
}

export interface ShieldFeature {
  /** Stable id, unique within the rule ("ai-overview"). */
  id: string;
  /** Display name, e.g. "AI Overviews". */
  name: string;
  css?: string[];
  /** Raw CSS rules for layout fixes (e.g. space left by a docked AI panel). */
  extraCss?: string[];
  match?: Matcher[];
  placeholders?: PlaceholderRewrite[];
  /** Requests that only produce AI output; blocked while the shield is on for the site. */
  block?: string[];
}

export interface Matcher {
  /** Candidate elements to test, e.g. "h1, h2, [role=heading]". Keep it narrow for speed. */
  candidates: string;
  /** Compare this attribute instead of the element's text (e.g. "aria-label"). */
  attr?: string;
  /** Exact strings (trimmed, case-insensitive, whitespace collapsed). */
  texts?: string[];
  /** Regex sources tested case-insensitively. */
  patterns?: string[];
  /** The candidate selector alone identifies the AI element (no text test). */
  any?: boolean;
  /** Only accept candidates whose text is at most this long (avoids matching whole articles). */
  maxLength?: number;
  /** Skip candidates inside elements matching this selector (e.g. "a" for search result titles). */
  notInside?: string;
  /** What to hide once a candidate matches. Defaults to the candidate itself. */
  hide?: HideTarget;
}

/** Strategies are tried in order: closest, upTo, climbFree, levels; the first hit wins. */
export interface HideTarget {
  /** Hide `candidate.closest(selector)`. */
  closest?: string;
  /** Climb until the parent matches this selector, then hide that child (e.g. "#rso"). */
  upTo?: string;
  /**
   * Climb while the parent contains nothing matching this selector (e.g. other search results or
   * the search box) and does not match `stopAt`.
   */
  climbFree?: string;
  stopAt?: string;
  /** Climb this many levels. */
  levels?: number;
}

export interface PlaceholderRewrite {
  selector: string;
  /** Regex sources (case-insensitive) matched against the current placeholder. */
  patterns: string[];
  replacement: string;
}
