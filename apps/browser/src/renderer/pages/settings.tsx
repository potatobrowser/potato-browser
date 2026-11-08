import { PLATFORM_LABELS, PLATFORMS, type Platform } from '@potato/shared';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { TAB_SLEEP_MINUTES } from '../../shared/constants';
import type { AdblockStatus, AppInfo, SearchEngineId, Settings, ShieldRulesStatus, ShieldRuleSummary, StartupMode, Theme, UpdateStatus } from '../../shared/types';
import { SEARCH_ENGINES } from '../../shared/urls';
import { call, onInternalEvent } from '../shared/api';
import { Card, Row, Toggle, useSettings } from '../shared/components';
import { FlagModePicker } from '../shared/flagmodes';
import { AccessSteps, useImporter, type What } from '../shared/importer';
import { BrandMark } from '../shared/icons';
import '../shared/pages.css';
import './settings.css';

const SECTIONS = [
  ['general', 'General'],
  ['shield', 'AI Shield'],
  ['adblock', 'Ad blocker'],
  ['flags', 'AI flags'],
  ['passwords', 'Passwords'],
  ['privacy', 'Privacy'],
  ['import', 'Import'],
  ['downloads', 'Downloads'],
  ['about', 'About'],
] as const;

type Update = (patch: Parameters<ReturnType<typeof useSettings>[1]>[0]) => Promise<void>;

const sleepLabel = (min: number) => (min === 0 ? 'Never' : min < 60 ? `After ${min} minutes` : `After ${min / 60} ${min === 60 ? 'hour' : 'hours'}`);

function General({ s, update }: { s: Settings; update: Update }) {
  const [isDefault, setDefault] = useState<boolean | null>(null);
  const engine = SEARCH_ENGINES.find((e) => e.id === s.searchEngine);
  useEffect(() => void call<boolean>('app.isDefaultBrowser').then(setDefault), []);
  return (
    <Card title="General" id="general">
      <Row title="Default browser" hint={isDefault ? 'The potato opens your links.' : 'Send links from other apps straight to the potato.'}>
        {isDefault ? (
          <span className="pill ok">Default</span>
        ) : (
          <button
            className="btn"
            onClick={async () => {
              await call('app.setDefaultBrowser');
              setTimeout(() => void call<boolean>('app.isDefaultBrowser').then(setDefault), 1500);
            }}
          >
            Make default
          </button>
        )}
      </Row>
      <Row title="On startup">
        <select value={s.startup} onChange={(e) => void update({ startup: e.target.value as StartupMode })} data-testid="startup-select">
          <option value="restore">Continue where you left off</option>
          <option value="newtab">Open a new tab</option>
          <option value="homepage">Open the home page</option>
        </select>
      </Row>
      {s.startup === 'homepage' && (
        <Row title="Home page">
          <input className="input wide" defaultValue={s.homepage} onBlur={(e) => void update({ homepage: e.target.value.trim() || 'potato://newtab/' })} />
        </Row>
      )}
      <Row
        title="Put unused tabs to sleep"
        hint="Tabs you leave alone take a nap and give their memory back. A click wakes them up. Tabs playing sound, sharing your camera or holding unsaved changes stay awake."
      >
        <select value={s.tabs.sleepAfter} data-testid="sleep-select" onChange={(e) => void update({ tabs: { sleepAfter: Number(e.target.value) } })}>
          {TAB_SLEEP_MINUTES.map((m) => (
            <option key={m} value={m}>
              {sleepLabel(m)}
            </option>
          ))}
        </select>
      </Row>
      <Row title="Search engine" hint={engine?.note}>
        <select value={s.searchEngine} data-testid="engine-select" onChange={(e) => void update({ searchEngine: e.target.value as SearchEngineId })}>
          {SEARCH_ENGINES.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
      </Row>
      <Row title="Search suggestions" hint="Ask your search engine for suggestions while you type in the address bar.">
        <Toggle label="Search suggestions" checked={s.searchSuggestions} onChange={(v) => void update({ searchSuggestions: v })} />
      </Row>
      <Row title="Appearance">
        <div className="seg" role="group" aria-label="Theme">
          {(['system', 'light', 'dark'] as Theme[]).map((t) => (
            <button key={t} aria-pressed={s.theme === t} onClick={() => void update({ theme: t })}>
              {t[0]!.toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
      </Row>
      <Row title="Show bookmarks bar">
        <Toggle label="Show bookmarks bar" checked={s.showBookmarksBar} onChange={(v) => void update({ showBookmarksBar: v })} />
      </Row>
    </Card>
  );
}

function ShieldSection({ s, update }: { s: Settings; update: Update }) {
  const [rules, setRules] = useState<ShieldRuleSummary[]>([]);
  const [status, setStatus] = useState<ShieldRulesStatus | null>(null);
  useEffect(() => {
    const load = () => {
      void call<ShieldRuleSummary[]>('shield.rules').then(setRules);
      void call<ShieldRulesStatus>('shield.status').then(setStatus);
    };
    load();
    return onInternalEvent((e) => e.type === 'adblock' && load());
  }, []);
  const disabled = new Set(s.shield.disabledRules);
  const toggleFeature = (id: string, on: boolean) => {
    const next = new Set(disabled);
    if (on) next.delete(id);
    else next.add(id);
    void update({ shield: { disabledRules: [...next] } });
  };
  return (
    <Card
      title="AI Shield"
      id="shield"
      hint="Peels the AI features off the websites you visit: AI summaries, chat assistants, AI writing buttons and AI search modes. The shield button in the toolbar brings them back on a single site."
    >
      <Row title="Hide AI features on websites" testId="shield-global">
        <Toggle label="Hide AI features on websites" testId="shield-global-toggle" checked={s.shield.enabled} onChange={(v) => void update({ shield: { enabled: v } })} />
      </Row>
      <Row
        title="Update the rules daily"
        testId="shield-rules"
        hint={
          status
            ? `${status.source === 'update' ? 'Rules updated' : 'Rules from this version'}, ${new Date(status.version * 1000).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })}. Sites change their AI features often; fixes arrive the same day, signed by us.`
            : null
        }
      >
        <Toggle label="Update the AI Shield rules daily" testId="shield-auto-update" checked={s.shield.autoUpdate} onChange={(v) => void update({ shield: { autoUpdate: v } })} />
      </Row>
      <div className="row column">
        <div className="row-label">
          <span>Sites where AI features are shown</span>
          <small>Added when you switch the shield off for a site.</small>
        </div>
        {s.shield.disabledSites.length ? (
          <ul className="chips" data-testid="shield-exceptions">
            {s.shield.disabledSites.map((site) => (
              <li key={site}>
                {site}
                <button
                  className="chip-x"
                  aria-label={`Hide AI on ${site} again`}
                  onClick={() => void update({ shield: { disabledSites: s.shield.disabledSites.filter((d) => d !== site) } })}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <span className="muted small">None. Every AI feature we know of is peeled off, everywhere.</span>
        )}
      </div>
      <details className="rules">
        <summary>
          Covered sites <span className="muted">({rules.filter((r) => !r.hosts.includes('*')).length} sites)</span>
        </summary>
        <ul className="rule-list">
          {rules.map((r) => (
            <li key={r.id}>
              <strong>{r.site}</strong>
              <div className="rule-features">
                {r.features.map((f) => {
                  const fid = `${r.id}:${f.id}`;
                  return (
                    <label key={fid} className="check">
                      <input type="checkbox" checked={!disabled.has(fid) && !disabled.has(r.id)} onChange={(e) => toggleFeature(fid, e.target.checked)} />
                      {f.name}
                    </label>
                  );
                })}
              </div>
            </li>
          ))}
        </ul>
      </details>
    </Card>
  );
}

function ago(iso: string | number | null): string {
  const t = typeof iso === 'number' ? iso : iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return 'never';
  const min = Math.round((Date.now() - t) / 60_000);
  if (min < 2) return 'just now';
  if (min < 90) return `${min} minutes ago`;
  const h = Math.round(min / 60);
  if (h < 36) return `${h} hours ago`;
  return `${Math.round(h / 24)} days ago`;
}

function AdblockSection({ s, update }: { s: Settings; update: Update }) {
  const [status, setStatus] = useState<AdblockStatus | null>(null);
  const [draft, setDraft] = useState(s.adblock.customFilters);
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    const load = () => void call<AdblockStatus>('adblock.status').then(setStatus);
    load();
    return onInternalEvent((e) => e.type === 'adblock' && load());
  }, []);
  useEffect(() => setDraft(s.adblock.customFilters), [s.adblock.customFilters]);
  const a = s.adblock;
  const newest = status?.lists.reduce((m, l) => (l.fetchedAt > m ? l.fetchedAt : m), '') ?? '';
  const busy = checking || status?.updating || status?.compiling;
  return (
    <Card
      title="Ad blocker"
      id="adblock"
      hint="Mashes ads and trackers before they load: banners, video ads, pop-ups, tracking pixels and the scripts behind them. It uses the EasyList, EasyPrivacy and uBlock Origin filter lists. The ad blocker button in the toolbar lets ads through on a single site."
    >
      <Row title="Block ads" testId="adblock-global">
        <Toggle label="Block ads" testId="adblock-global-toggle" checked={a.enabled} onChange={(v) => void update({ adblock: { enabled: v } })} />
      </Row>
      <Row title="Block trackers" hint="Analytics, tracking pixels and fingerprinting scripts that follow you from site to site.">
        <Toggle label="Block trackers" testId="adblock-trackers" checked={a.trackers} onChange={(v) => void update({ adblock: { trackers: v } })} />
      </Row>
      <Row title="Hide cookie notices" hint="Removes most cookie consent banners. Sites then usually act as if you made no choice.">
        <Toggle label="Hide cookie notices" testId="adblock-cookies" checked={a.cookieNotices} onChange={(v) => void update({ adblock: { cookieNotices: v } })} />
      </Row>
      <Row title="Hide annoyances" hint="Newsletter pop-ups, open-in-app banners, chat bubbles and similar clutter.">
        <Toggle label="Hide annoyances" testId="adblock-annoyances" checked={a.annoyances} onChange={(v) => void update({ adblock: { annoyances: v } })} />
      </Row>
      <div className="row column">
        <div className="row-label">
          <span>Sites where ads are allowed</span>
          <small>Added when you switch the ad blocker off for a site.</small>
        </div>
        {a.disabledSites.length ? (
          <ul className="chips" data-testid="adblock-exceptions">
            {a.disabledSites.map((site) => (
              <li key={site}>
                {site}
                <button
                  className="chip-x"
                  aria-label={`Block ads on ${site} again`}
                  onClick={() => void update({ adblock: { disabledSites: a.disabledSites.filter((d) => d !== site) } })}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <span className="muted small">None. Ads get mashed everywhere.</span>
        )}
      </div>
      <Row
        title="Filter lists"
        testId="adblock-lists-row"
        hint={
          status ? (
            <span data-testid="adblock-status">
              {status.compiling
                ? 'Preparing the new filters...'
                : `${status.filters.toLocaleString()} filters, updated ${ago(newest)}.`}
              {status.lastError ? <span className="warn-text"> Last update failed: {status.lastError}</span> : null}
            </span>
          ) : (
            'Loading...'
          )
        }
      >
        <button
          className="btn"
          data-testid="adblock-update"
          disabled={!!busy}
          onClick={async () => {
            setChecking(true);
            setStatus(await call<AdblockStatus>('adblock.update'));
            setChecking(false);
          }}
        >
          {busy ? 'Updating...' : 'Update now'}
        </button>
      </Row>
      <Row title="Update filter lists automatically" hint="Once a day, through potatobrowser.com. The request names the lists and nothing about you.">
        <Toggle label="Update filter lists automatically" checked={a.autoUpdate} onChange={(v) => void update({ adblock: { autoUpdate: v } })} />
      </Row>
      <details className="rules" data-testid="adblock-custom">
        <summary>Your own filters</summary>
        <div className="custom-filters">
          <p className="muted small-text">
            One filter per line, in uBlock Origin or Adblock Plus syntax. For example <span className="mono">example.com##.newsletter-popup</span> hides
            an element, <span className="mono">||ads.example.com^</span> blocks a server.
          </p>
          <textarea
            className="filters-input mono"
            data-testid="adblock-custom-input"
            spellCheck={false}
            rows={6}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="example.com##.newsletter-popup"
          />
          <div className="custom-actions">
            <button className="btn" data-testid="adblock-custom-save" disabled={draft === a.customFilters} onClick={() => void update({ adblock: { customFilters: draft } })}>
              Save filters
            </button>
            {status?.customErrors.length ? (
              <span className="warn-text" data-testid="adblock-custom-errors">
                Not understood: {status.customErrors.join(', ')}
              </span>
            ) : null}
          </div>
        </div>
      </details>
      <details className="rules">
        <summary>
          Lists in use <span className="muted">({status?.lists.length ?? 0})</span>
        </summary>
        <ul className="list-sources">
          {status?.lists.map((l) => (
            <li key={l.id}>
              <a href={l.homepage} target="_blank" rel="noreferrer">
                {l.name}
              </a>
              <span className="muted">fetched {ago(l.fetchedAt)}</span>
            </li>
          ))}
        </ul>
      </details>
    </Card>
  );
}

function FlagsSection({ s, update }: { s: Settings; update: Update }) {
  const [mine, setMine] = useState(0);
  useEffect(() => void call<{ mine: number }>('flags.stats').then((r) => setMine(r.mine)), []);
  const disabled = new Set(s.flags.disabledPlatforms);
  return (
    <Card
      title="AI flags"
      id="flags"
      hint="People flag posts they think are AI-generated. Flags are anonymous: no account, and when the browser checks posts it sends only short hash prefixes that thousands of other posts share (hashed like the browns), never the posts or the page."
    >
      <div className="row column">
        <div className="row-label">
          <span>Posts flagged as AI-generated</span>
        </div>
        <FlagModePicker value={s.flags.mode} onChange={(mode) => void update({ flags: { mode } })} testIdPrefix="flag-mode" />
      </div>
      <Row title="Flags needed" hint="How many people must flag a post before it counts as AI-generated. Your own flag always counts.">
        <select value={s.flags.threshold} data-testid="flag-threshold" onChange={(e) => void update({ flags: { threshold: Number(e.target.value) } })}>
          {[1, 2, 3, 5, 10, 25].map((n) => (
            <option key={n} value={n}>
              {n} {n === 1 ? 'person' : 'people'}
            </option>
          ))}
        </select>
      </Row>
      <Row title="Show flag buttons on posts" hint={mine ? `You have flagged ${mine} ${mine === 1 ? 'post' : 'posts'}. Sharp eyes.` : 'No flags from you yet. Keep your eyes peeled.'}>
        <Toggle label="Show flag buttons" checked={s.flags.showButtons} onChange={(v) => void update({ flags: { showButtons: v } })} />
      </Row>
      <div className="row column">
        <div className="row-label">
          <span>Platforms</span>
        </div>
        <div className="platforms">
          {PLATFORMS.map((p: Platform) => (
            <label key={p} className="check">
              <input
                type="checkbox"
                checked={!disabled.has(p)}
                onChange={(e) => {
                  const next = new Set(disabled);
                  if (e.target.checked) next.delete(p);
                  else next.add(p);
                  void update({ flags: { disabledPlatforms: [...next] } });
                }}
              />
              {PLATFORM_LABELS[p]}
            </label>
          ))}
        </div>
      </div>
    </Card>
  );
}

function PasswordsSection({ s, update }: { s: Settings; update: Update }) {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    const load = () => void call<number>('passwords.count').then(setCount);
    load();
    return onInternalEvent((e) => e.type === 'passwords' && load());
  }, []);
  const p = s.passwords;
  return (
    <Card title="Passwords" id="passwords" hint="Saved passwords are encrypted with a key kept in your macOS Keychain, and never leave this Mac.">
      <Row title="Saved passwords" hint={count === null ? null : count ? `${count.toLocaleString()} saved. Show, edit, import or export them.` : 'None yet. Import them from another browser or password manager.'}>
        <a className="btn" href="potato://passwords/" data-testid="settings-manage-passwords">
          Manage passwords
        </a>
      </Row>
      <Row title="Offer to save passwords" hint="After you sign in to a site. Never in private windows.">
        <Toggle label="Offer to save passwords" checked={p.offerToSave} onChange={(v) => void update({ passwords: { offerToSave: v } })} />
      </Row>
      <Row title="Fill passwords on websites" hint="Saved logins show up under sign-in fields. Nothing is filled until you pick one.">
        <Toggle label="Fill passwords on websites" checked={p.autofill} onChange={(v) => void update({ passwords: { autofill: v } })} />
      </Row>
    </Card>
  );
}

function PrivacySection({ s, update }: { s: Settings; update: Update }) {
  const [range, setRange] = useState('3600000');
  const [what, setWhat] = useState({ history: true, cookies: false, cache: true, downloads: false });
  const [done, setDone] = useState(false);
  const [perms, setPerms] = useState<{ origin: string; kind: string; decision: string }[]>([]);
  const loadPerms = () => void call<typeof perms>('permissions.list').then(setPerms);
  useEffect(loadPerms, []);
  return (
    <Card title="Privacy" id="privacy">
      <Row title="Send Global Privacy Control" hint="Tells websites not to sell or share your data.">
        <Toggle label="Global Privacy Control" checked={s.privacy.globalPrivacyControl} onChange={(v) => void update({ privacy: { globalPrivacyControl: v } })} />
      </Row>
      <Row title="Block AI chatbot sites" hint="ChatGPT, Gemini, Claude, Copilot, Perplexity and others. You can still open them once from the block page.">
        <Toggle label="Block AI chatbot sites" testId="block-chatbots" checked={s.privacy.blockAiChatbots} onChange={(v) => void update({ privacy: { blockAiChatbots: v } })} />
      </Row>
      <Row
        title="Send crash reports"
        hint="When the browser crashes, send a report to potatobrowser.com so it gets fixed. It holds the version, what crashed and a memory snapshot that can include bits of the page you were on. Kept 90 days, never shared."
      >
        <Toggle label="Send crash reports" testId="crash-reports" checked={s.privacy.crashReports} onChange={(v) => void update({ privacy: { crashReports: v } })} />
      </Row>
      <div className="row column">
        <div className="row-label">
          <span>Clear browsing data</span>
          <small>Cookies and cached files are cleared for all time.</small>
        </div>
        <div className="clear-grid">
          <select value={range} onChange={(e) => setRange(e.target.value)} aria-label="Time range">
            <option value="3600000">Last hour</option>
            <option value="86400000">Last 24 hours</option>
            <option value="604800000">Last 7 days</option>
            <option value="0">All time</option>
          </select>
          {(['history', 'downloads', 'cookies', 'cache'] as const).map((k) => (
            <label className="check" key={k}>
              <input type="checkbox" checked={what[k]} onChange={(e) => setWhat({ ...what, [k]: e.target.checked })} />
              {{ history: 'History', downloads: 'Download list', cookies: 'Cookies and site data', cache: 'Cached files' }[k]}
            </label>
          ))}
          <button
            className="btn"
            data-testid="clear-data"
            onClick={async () => {
              const since = range === '0' ? 0 : Date.now() - Number(range);
              await call('app.clearData', { since, ...what });
              setDone(true);
              setTimeout(() => setDone(false), 2500);
            }}
          >
            {done ? 'Cleared' : 'Clear data'}
          </button>
        </div>
      </div>
      <div className="row column">
        <div className="row-label">
          <span>Site permissions</span>
        </div>
        {perms.length ? (
          <ul className="perm-list">
            {perms.map((p) => (
              <li key={p.origin + p.kind}>
                <span className="truncate">{p.origin.replace(/^https?:\/\//, '')}</span>
                <span className="muted">
                  {p.kind.startsWith('openExternal:') ? `open ${p.kind.slice(13)} links` : p.kind === 'openExternal' ? 'open links in other apps' : p.kind.replace('+', ' and ')}
                </span>
                <span className={`pill ${p.decision === 'allow' ? 'ok' : 'warn'}`}>{p.decision === 'allow' ? 'Allowed' : 'Blocked'}</span>
                <button
                  className="btn small"
                  onClick={async () => {
                    await call('permissions.reset', p.origin, p.kind);
                    loadPerms();
                  }}
                >
                  Reset
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <span className="muted small">No site has asked for permissions yet.</span>
        )}
      </div>
    </Card>
  );
}

function ImportSection() {
  const { sources, states, run, cancel, recheck } = useImporter();
  const [what, setWhat] = useState<Record<string, What>>({});
  const busy = Object.values(states).includes('busy');
  return (
    <Card
      title="Import from another browser"
      id="import"
      hint={
        <>
          Replant your bookmarks and history here. Passwords come over as a file: <a href="potato://passwords/#import">import passwords</a>.
        </>
      }
    >
      {sources === null ? (
        <div className="empty">Digging for browsers...</div>
      ) : sources.length === 0 ? (
        <div className="empty">No other browsers on this Mac. A fresh field!</div>
      ) : (
        <ul className="list" data-testid="import-sources">
          {sources.map((src) => {
            const w = what[src.id] ?? { bookmarks: src.hasBookmarks, history: src.hasHistory };
            const st = states[src.id];
            const r = st && st !== 'busy' && st !== 'access' ? st : null;
            return (
              <li key={src.id} className="list-item import-item" data-testid="import-source" data-source-id={src.id}>
                <div className="grow">
                  <strong>{src.browser}</strong> {src.profile !== 'Default' ? <span className="muted">· {src.profile}</span> : null}
                  <div className="import-opts">
                    <label className="check">
                      <input type="checkbox" disabled={!src.hasBookmarks} checked={w.bookmarks && src.hasBookmarks} onChange={(e) => setWhat({ ...what, [src.id]: { ...w, bookmarks: e.target.checked } })} />
                      Bookmarks
                    </label>
                    <label className="check">
                      <input type="checkbox" disabled={!src.hasHistory} checked={w.history && src.hasHistory} onChange={(e) => setWhat({ ...what, [src.id]: { ...w, history: e.target.checked } })} />
                      History
                    </label>
                  </div>
                  {src.blocked && !st ? <p className="muted small-text">macOS protects {src.browser} data. Import opens System Settings so you can allow access.</p> : null}
                  {st === 'access' ? <AccessSteps browser={src.browser} onRecheck={() => void recheck()} onCancel={() => cancel(src.id)} /> : null}
                  {r ? (
                    <p className={r.errors.length ? 'warn-text' : 'ok-text'} data-testid="import-result">
                      {r.errors.length
                        ? r.errors.join(' ')
                        : `Imported ${r.bookmarks.toLocaleString()} bookmarks and ${r.history.toLocaleString()} history entries.`}
                    </p>
                  ) : null}
                </div>
                <button
                  className="btn primary"
                  data-testid="import-run"
                  disabled={busy || st === 'access' || (!w.bookmarks && !w.history)}
                  onClick={() => void run(src, w)}
                >
                  {st === 'busy' ? 'Harvesting...' : 'Import'}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function DownloadsSection({ s, update }: { s: Settings; update: Update }) {
  return (
    <Card title="Downloads" id="downloads">
      <Row title="Save files to" hint={<span className="mono">{s.downloadsDir}</span>}>
        <button
          className="btn"
          onClick={async () => {
            const dir = await call<string | null>('app.chooseDownloadsDir');
            if (dir) await update({ downloadsDir: dir });
          }}
        >
          Change...
        </button>
      </Row>
      <Row title="Ask where to save each file">
        <Toggle label="Ask where to save" checked={s.askWhereToSave} onChange={(v) => void update({ askWhereToSave: v })} />
      </Row>
    </Card>
  );
}

function useUpdateStatus(): UpdateStatus | null {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  useEffect(() => {
    const load = () => void call<UpdateStatus>('app.updateStatus').then(setStatus);
    load();
    return onInternalEvent((e) => e.type === 'update' && load());
  }, []);
  return status;
}

function UpdateNote({ u }: { u: UpdateStatus }) {
  const download = (
    <button className="link-btn" data-testid="update-download" onClick={() => void call('app.openDownloadPage')}>
      Download
    </button>
  );
  switch (u.phase) {
    case 'checking':
      return <>Checking the cellar...</>;
    case 'none':
      return <>You are up to date. Fresh as a new potato.</>;
    case 'downloading':
      return <>Digging up version {u.version}... {u.percent}%</>;
    case 'ready':
      return <>Version {u.version} is ready. Restart to finish updating; your windows and tabs come back.</>;
    case 'available':
      return (
        <>
          Version {u.version} is fresh out of the ground.{' '}
          {u.manual === 'location'
            ? 'Move Potato Browser to the Applications folder and it updates itself. '
            : u.manual === 'build'
              ? 'This build does not update itself. '
              : 'It could not be installed here. '}
          {download}
        </>
      );
    case 'error':
      return u.version ? (
        <>Version {u.version} could not be installed yet. Trying again soon. {download}</>
      ) : (
        <>Could not check for updates. Try again in a bit.</>
      );
    default:
      return null;
  }
}

function About() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const update = useUpdateStatus();
  useEffect(() => void call<AppInfo>('app.info').then(setInfo), []);
  if (!info) return null;
  const busy = update?.phase === 'checking' || update?.phase === 'downloading';
  return (
    <Card title="About Potato Browser" id="about">
      <div className="about-head">
        <BrandMark size={52} />
        <div>
          <h3>Potato Browser</h3>
          <p className="muted" data-testid="about-version">
            Version {info.version} · Chromium {info.chromium}
          </p>
        </div>
        {update?.phase === 'ready' ? (
          <button className="btn primary" data-testid="update-check" onClick={() => void call('app.installUpdate')}>
            Restart to update
          </button>
        ) : (
          <button className="btn" data-testid="update-check" disabled={busy} onClick={() => void call('app.checkUpdates')}>
            Check for updates
          </button>
        )}
      </div>
      {update && update.phase !== 'idle' && (
        <p className="about-update" data-testid="update-status" aria-live="polite">
          <UpdateNote u={update} />
        </p>
      )}
      <div className="row column">
        <div className="row-label">
          <span>No AI in the engine</span>
          <small>
            This spud grows on Chromium {info.chromium.split('.')[0]} without Chrome's AI layer: no Gemini Nano, no on-device model downloads, no AI
            writing or tab features. These built-in AI web APIs are switched off for every page and worker:
          </small>
        </div>
        <ul className="chips static" data-testid="engine-report">
          {info.engine.disabledBlinkFeatures.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      </div>
      <Row title="Engine" hint={`Electron ${info.electron} · V8 ${info.v8} · Node ${info.node}`} />
      <Row title="Source code" hint="Open source under the MIT license. Every release is built in public from this repository.">
        <button className="link-btn" onClick={() => void call('app.openSourcePage')} data-testid="about-source">
          github.com/potatobrowser
        </button>
      </Row>
      <Row title="Anonymous flag id" hint="A random id used only to count your flags once. The server stores it as a keyed hash, scrambled beyond recognition.">
        <span className="mono muted">{info.installIdShort}...</span>
      </Row>
    </Card>
  );
}

function SettingsPage() {
  const [s, update] = useSettings();
  const [active, setActive] = useState(location.hash.slice(1) || 'general');

  useEffect(() => {
    const go = () => {
      const id = location.hash.slice(1) || 'general';
      setActive(id);
      document.getElementById(id)?.scrollIntoView({ block: 'start' });
    };
    const t = setTimeout(go, 50);
    window.addEventListener('hashchange', go);
    return () => {
      clearTimeout(t);
      window.removeEventListener('hashchange', go);
    };
  }, [s === null]);

  if (!s) return null;
  return (
    <div className="settings">
      <nav className="side" aria-label="Settings sections">
        <div className="side-brand">
          <BrandMark size={22} /> Settings
        </div>
        {SECTIONS.map(([id, label]) => (
          <a key={id} href={`#${id}`} className={active === id ? 'on' : ''}>
            {label}
          </a>
        ))}
      </nav>
      <main className="settings-main">
        <General s={s} update={update} />
        <ShieldSection s={s} update={update} />
        <AdblockSection s={s} update={update} />
        <FlagsSection s={s} update={update} />
        <PasswordsSection s={s} update={update} />
        <PrivacySection s={s} update={update} />
        <ImportSection />
        <DownloadsSection s={s} update={update} />
        <About />
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<SettingsPage />);
