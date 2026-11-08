/**
 * Stylesheets from the content world. iOS has no public API for user stylesheets, so hiding
 * rules go into constructed sheets adopted by the document: page CSP (`style-src`) does not
 * apply to them and page scripts cannot remove them with DOM calls. A `<style>` element is the
 * fallback where adoption fails (XML documents).
 */
/**
 * Adopted sheets are author CSS, unlike the Mac app's user stylesheets: a site's own
 * `display: ... !important` with a more specific selector would beat a hiding rule. Three
 * id tests that never match lift every hiding rule above any realistic site selector.
 */
const LIFT = ':not(#potato-x1):not(#potato-x2):not(#potato-x3)';

function lift(sheet: CSSStyleSheet): void {
  for (const rule of Array.from(sheet.cssRules)) {
    if (!(rule instanceof CSSStyleRule) || rule.style.getPropertyValue('display') !== 'none' || rule.style.getPropertyPriority('display') !== 'important') continue;
    try {
      rule.selectorText = `:is(${rule.selectorText})${LIFT}`;
    } catch {}
  }
}

export class Styles {
  private sheets = new Map<string, CSSStyleSheet | HTMLStyleElement>();
  private n = 0;
  private readonly adopt =
    typeof CSSStyleSheet === 'function' && 'replaceSync' in CSSStyleSheet.prototype && 'adoptedStyleSheets' in Document.prototype;

  /** `strong`: hiding rules that must win against the site's own `!important` (the AI Shield). */
  insert(css: string, strong = false): string {
    const key = `s${++this.n}`;
    if (this.adopt) {
      try {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(css);
        if (strong) lift(sheet);
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
        this.sheets.set(key, sheet);
        return key;
      } catch {}
    }
    const el = document.createElement('style');
    el.textContent = css;
    (document.head ?? document.documentElement)?.appendChild(el);
    this.sheets.set(key, el);
    return key;
  }

  remove(key: string): void {
    const s = this.sheets.get(key);
    if (!s) return;
    this.sheets.delete(key);
    if (s instanceof CSSStyleSheet) {
      try {
        document.adoptedStyleSheets = document.adoptedStyleSheets.filter((x) => x !== s);
      } catch {}
    } else s.remove();
  }

  /** Puts back sheets a page dropped (by assigning adoptedStyleSheets or replacing the head). */
  restore(): void {
    const adopted = this.adopt ? document.adoptedStyleSheets : [];
    const missing: CSSStyleSheet[] = [];
    for (const s of this.sheets.values()) {
      if (s instanceof CSSStyleSheet) {
        if (!adopted.includes(s)) missing.push(s);
      } else if (!s.isConnected) (document.head ?? document.documentElement)?.appendChild(s);
    }
    if (missing.length) {
      try {
        document.adoptedStyleSheets = [...adopted, ...missing];
      } catch {}
    }
  }
}
