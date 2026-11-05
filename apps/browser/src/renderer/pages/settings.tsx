import { PLATFORM_LABELS, PLATFORMS, type Platform } from '@noai/shared';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AppInfo, FlagMode, ImportResult, ImportSource, SearchEngineId, Settings, ShieldRuleSummary, StartupMode, Theme } from '../../shared/types';
import { SEARCH_ENGINES } from '../../shared/urls';
import { call } from '../shared/api';
import { Card, Row, Toggle, useSettings } from '../shared/components';
import { BrandMark } from '../shared/icons';
import '../shared/pages.css';
import './settings.css';

const SECTIONS = [
  ['general', 'General'],
  ['shield', 'AI Shield'],
  ['flags', 'AI flags'],
  ['privacy', 'Privacy'],
  ['import', 'Import'],
  ['downloads', 'Downloads'],
  ['about', 'About'],
] as const;

type Update = (patch: Parameters<ReturnType<typeof useSettings>[1]>[0]) => Promise<void>;

function General({ s, update }: { s: Settings; update: Update }) {
  const [isDefault, setDefault] = useState<boolean | null>(null);
  const engine = SEARCH_ENGINES.find((e) => e.id === s.searchEngine);
  useEffect(() => void call<boolean>('app.isDefaultBrowser').then(setDefault), []);
  return (
    <Card title="General" id="general">
      <Row title="Default browser" hint={isDefault ? 'No-AI Browser opens your links.' : 'Open links from other apps in No-AI Browser.'}>
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
          <input className="input wide" defaultValue={s.homepage} onBlur={(e) => void update({ homepage: e.target.value.trim() || 'noai://newtab/' })} />
        </Row>
      )}
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
  useEffect(() => void call<ShieldRuleSummary[]>('shield.rules').then(setRules), []);
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
      hint="Hides the AI features of the websites you visit: AI summaries, chat assistants, AI writing buttons and AI search modes. Use the shield button in the toolbar to show them on a single site."
    >
      <Row title="Hide AI features on websites" testId="shield-global">
        <Toggle label="Hide AI features on websites" testId="shield-global-toggle" checked={s.shield.enabled} onChange={(v) => void update({ shield: { enabled: v } })} />
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
          <span className="muted small">None. AI is hidden everywhere we know how.</span>
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

function FlagsSection({ s, update }: { s: Settings; update: Update }) {
  const [mine, setMine] = useState(0);
  useEffect(() => void call<{ mine: number }>('flags.stats').then((r) => setMine(r.mine)), []);
  const modes: { id: FlagMode; title: string; hint: string }[] = [
    { id: 'hide', title: 'Hide', hint: 'Collapse flagged posts behind a small notice you can open.' },
    { id: 'label', title: 'Label', hint: 'Show flagged posts with an "AI" label and outline.' },
    { id: 'ignore', title: 'Ignore', hint: 'Show everything as is. Flag buttons still work.' },
  ];
  const disabled = new Set(s.flags.disabledPlatforms);
  return (
    <Card
      title="AI flags"
      id="flags"
      hint="People flag posts they believe are AI-generated. Flags are anonymous: no account, and the browser only sends short hash prefixes when it checks posts, so the service never learns what you read."
    >
      <div className="row column">
        <div className="row-label">
          <span>Posts flagged as AI-generated</span>
        </div>
        <div className="mode-grid" role="radiogroup" aria-label="Flagged posts" data-testid="flag-mode">
          {modes.map((m) => (
            <button
              key={m.id}
              role="radio"
              aria-checked={s.flags.mode === m.id}
              data-testid={`flag-mode-${m.id}`}
              className={`mode${s.flags.mode === m.id ? ' on' : ''}`}
              onClick={() => void update({ flags: { mode: m.id } })}
            >
              <strong>{m.title}</strong>
              <small>{m.hint}</small>
            </button>
          ))}
        </div>
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
      <Row title="Show flag buttons on posts" hint={`You have flagged ${mine} ${mine === 1 ? 'post' : 'posts'}.`}>
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
                <span className="muted">{p.kind.replace('+', ' and ')}</span>
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
  const [sources, setSources] = useState<ImportSource[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, ImportResult>>({});
  const [what, setWhat] = useState<Record<string, { bookmarks: boolean; history: boolean }>>({});
  const detect = () => void call<ImportSource[]>('import.detect').then(setSources);
  useEffect(detect, []);
  return (
    <Card title="Import from another browser" id="import" hint="Bring your bookmarks and history. Passwords and cookies stay where they are.">
      {sources === null ? (
        <div className="empty">Looking for browsers...</div>
      ) : sources.length === 0 ? (
        <div className="empty">No other browsers found on this Mac.</div>
      ) : (
        <ul className="list" data-testid="import-sources">
          {sources.map((src) => {
            const w = what[src.id] ?? { bookmarks: src.hasBookmarks, history: src.hasHistory };
            const r = results[src.id];
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
                  {src.blocked && !r ? (
                    <p className="warn-text">
                      {src.blocked}{' '}
                      <button className="link-btn" onClick={() => void call('app.openFullDiskAccess')}>
                        Open System Settings
                      </button>
                    </p>
                  ) : null}
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
                  disabled={busy !== null || (!w.bookmarks && !w.history)}
                  onClick={async () => {
                    setBusy(src.id);
                    try {
                      const res = await call<ImportResult>('import.run', src.id, w);
                      setResults((prev) => ({ ...prev, [src.id]: res }));
                    } finally {
                      setBusy(null);
                    }
                  }}
                >
                  {busy === src.id ? 'Importing...' : 'Import'}
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

function About() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [update, setUpdate] = useState<string>('');
  useEffect(() => void call<AppInfo>('app.info').then(setInfo), []);
  if (!info) return null;
  return (
    <Card title="About No-AI Browser" id="about">
      <div className="about-head">
        <BrandMark size={52} color="var(--ink)" />
        <div>
          <h3>No-AI Browser</h3>
          <p className="muted" data-testid="about-version">
            Version {info.version} · Chromium {info.chromium}
          </p>
        </div>
        <button
          className="btn"
          onClick={async () => {
            setUpdate('Checking...');
            const r = await call<{ available: string | null; current: string; latest: unknown }>('app.checkUpdates');
            setUpdate(r.available ? `Version ${r.available} is available.` : r.latest ? 'You are up to date.' : 'Could not check for updates.');
          }}
        >
          Check for updates
        </button>
      </div>
      {update && (
        <p className="about-update">
          {update}{' '}
          {update.includes('available') ? (
            <button className="link-btn" onClick={() => void call('app.openDownloadPage')}>
              Download
            </button>
          ) : null}
        </p>
      )}
      <div className="row column">
        <div className="row-label">
          <span>No AI in the engine</span>
          <small>
            This browser is built on Chromium {info.chromium.split('.')[0]} without Chrome's AI layer: no Gemini Nano, no on-device model downloads, no AI
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
      <Row title="Anonymous flag id" hint="A random id used only to count your flags once. It is stored on the server as a keyed hash.">
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
          <BrandMark size={22} color="var(--ink)" /> Settings
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
        <FlagsSection s={s} update={update} />
        <PrivacySection s={s} update={update} />
        <ImportSection />
        <DownloadsSection s={s} update={update} />
        <About />
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<SettingsPage />);
