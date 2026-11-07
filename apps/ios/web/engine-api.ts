/**
 * The ad blocker's cosmetic engine in the app's JavaScriptCore context (not a web page): the
 * same Ghostery engine as on the Mac, one per list group. It answers a page's hiding rules and
 * scriptlets, the generic rules for ids and classes, whether a resource URL is blocked (for the
 * counts), and builds engines and rule lists from downloaded lists.
 */
import { FiltersEngine, Request } from '@ghostery/adblocker';
import { parse as parseHost } from 'tldts-experimental';
import { dropTrustedScriptlets, trustedScriptletNames } from '../../browser/src/main/adblock/trust';
import { IOS_ENV } from './contentblocker';
import { buildRuleLists, type GroupLists } from './rulelists';

/** As on the Mac (apps/browser/src/main/adblock/compile.ts ENGINE_OPTIONS); a test keeps them equal. */
export const ENGINE_OPTIONS = {
  loadPreprocessors: true,
  loadExtendedSelectors: true,
  loadCSPFilters: true,
  enableHtmlFiltering: false,
  enableMutationObserver: true,
} as const;

const engines = new Map<string, FiltersEngine>();
const env = () => new Map(Object.entries(IOS_ENV)) as Parameters<FiltersEngine['updateEnv']>[0];

function target(url: string) {
  const p = parseHost(url);
  return { url, hostname: p.hostname ?? '', domain: p.domain ?? '' };
}

function selected(ids: string[]): FiltersEngine[] {
  return ids.map((id) => engines.get(id)).filter((e): e is FiltersEngine => !!e);
}

export interface CosmeticsStart {
  styles: string;
  scripts: string[];
  extended: unknown[];
}

export function createEngineApi() {
  return api;
}

const api = {
  load(id: string, bytes: Uint8Array): number {
    const engine = FiltersEngine.deserialize(bytes);
    engine.updateEnv(env());
    engines.set(id, engine);
    const f = engine.getFilters();
    return f.networkFilters.length + f.cosmeticFilters.length;
  },

  unload(id: string): void {
    engines.delete(id);
  },

  loaded(): string[] {
    return [...engines.keys()];
  },

  /** Hostname rules, base generic rules, scriptlets and procedural selectors for a document. */
  cosmetics(ids: string[], url: string): CosmeticsStart | null {
    const t = target(url);
    if (!t.hostname) return null;
    const styles: string[] = [];
    const scripts: string[] = [];
    const extended: unknown[] = [];
    for (const engine of selected(ids)) {
      const r = engine.getCosmeticsFilters({
        ...t,
        getBaseRules: true,
        getInjectionRules: true,
        getExtendedRules: true,
        getRulesFromHostname: true,
        getRulesFromDOM: false,
      });
      if (r.active === false) continue;
      if (r.styles) styles.push(r.styles);
      scripts.push(...r.scripts);
      extended.push(...r.extended);
    }
    // Each scriptlet in its own block: uBlock's helpers are function declarations (see the Mac app).
    return { styles: styles.join('\n'), scripts: [...new Set(scripts)].map((s) => `try{${s}}catch(e){}`), extended };
  },

  /** Generic hiding rules for ids, classes and links seen in a frame. */
  domRules(ids: string[], url: string, dom: { classes?: string[]; ids?: string[]; hrefs?: string[] }): string {
    const t = target(url);
    if (!t.hostname) return '';
    const out: string[] = [];
    for (const engine of selected(ids)) {
      const r = engine.getCosmeticsFilters({
        ...t,
        classes: (dom.classes ?? []).slice(0, 5000),
        ids: (dom.ids ?? []).slice(0, 5000),
        hrefs: (dom.hrefs ?? []).slice(0, 5000),
        getBaseRules: false,
        getInjectionRules: false,
        getExtendedRules: false,
        getRulesFromHostname: false,
        getRulesFromDOM: true,
      });
      if (r.active !== false && r.styles) out.push(r.styles);
    }
    return out.join('\n');
  },

  /** Hostnames of the resources the filters block (each once per blocked resource). */
  blocked(ids: string[], sourceUrl: string, items: { url: string; type: string }[]): string[] {
    const list = selected(ids);
    const hosts: string[] = [];
    for (const item of items.slice(0, 500)) {
      let request: Request;
      try {
        request = Request.fromRawDetails({ url: item.url, sourceUrl, type: item.type as Parameters<typeof Request.fromRawDetails>[0]['type'] });
      } catch {
        continue;
      }
      let blocked = false;
      for (const engine of list) {
        const m = engine.match(request);
        if (m.exception) {
          blocked = false;
          break;
        }
        if (m.match || m.redirect) blocked = true;
      }
      if (blocked) hosts.push(request.hostname);
    }
    return hosts;
  },

  /**
   * Compiles lists into an engine, as the Mac app's compileEngine does: trusted scriptlets only
   * from uBlock's own lists and the user's filters.
   */
  compile(lists: { id: string; text: string }[], resourcesJson: string, custom = ''): Uint8Array {
    const trusted = trustedScriptletNames(resourcesJson);
    const texts = lists.map((l) => (l.id.startsWith('ublock-') ? l.text : dropTrustedScriptlets(l.text, trusted)));
    const engine = FiltersEngine.parse([...texts, custom].join('\n'), ENGINE_OPTIONS);
    engine.updateResources(resourcesJson, 'device');
    return engine.serialize();
  },

  /** WebKit rule lists (JSON text) per group, plus `custom` for the user's own filters. */
  ruleLists(groups: GroupLists[], custom = ''): Record<string, { json: string; rules: number }> {
    const built = buildRuleLists(groups, custom);
    const out: Record<string, { json: string; rules: number }> = {};
    for (const [id, b] of Object.entries(built)) out[id] = { json: JSON.stringify(b.rules), rules: b.rules.length };
    return out;
  },
};

