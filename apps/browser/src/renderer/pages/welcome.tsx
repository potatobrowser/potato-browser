import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { ImportSource, SearchEngineId } from '../../shared/types';
import { call, onInternalEvent } from '../shared/api';
import { useSettings } from '../shared/components';
import { FlagModePicker } from '../shared/flagmodes';
import { AdBlock, ArrowRight, BrandMark, Check, Flag, Globe, NoAi, Shield } from '../shared/icons';
import { AccessSteps, useImporter } from '../shared/importer';
import '../shared/pages.css';
import './welcome.css';

const ENGINES: { id: SearchEngineId; name: string; text: string }[] = [
  { id: 'duckduckgo', name: 'DuckDuckGo', text: 'The no-AI version. Plain results, like a plain baked potato.' },
  { id: 'google', name: 'Google', text: 'AI Overviews and AI Mode get peeled off by the AI Shield.' },
];

const FEATURES = [
  { icon: <Shield size={18} />, title: 'AI Shield', text: 'Peels the AI off major sites' },
  { icon: <AdBlock size={18} />, title: 'Ad blocker', text: 'Mashes ads and trackers' },
  { icon: <NoAi size={18} />, title: 'No AI in the engine', text: 'Nothing artificial under the skin' },
  { icon: <Flag size={18} />, title: 'Community flags', text: 'Many eyes, all anonymous' },
];

const SHOWN_SOURCES = 4;

const count = (n: number, noun: string) => `${n.toLocaleString()} ${noun}${n === 1 ? '' : 's'}`;

function Step({ n, title, hint, aside, children }: { n: number; title: string; hint: string; aside?: ReactNode; children?: ReactNode }) {
  return (
    <section className="step" aria-labelledby={`step-${n}`}>
      <div className="step-head">
        <span className="step-num">{n}</span>
        <div className="step-text">
          <h2 id={`step-${n}`}>{title}</h2>
          <p>{hint}</p>
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

function ImportList() {
  const { sources, states, run, cancel, recheck } = useImporter();
  const [defaultName, setDefaultName] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  useEffect(() => void call<string | null>('app.defaultBrowserName').then(setDefaultName), []);

  if (sources === null) return <div className="empty small">Digging for other browsers...</div>;
  if (sources.length === 0) return <div className="empty small">No other browsers on this Mac. A fresh field!</div>;

  const isDefault = (s: ImportSource) => !!defaultName && s.browser === defaultName;
  // The browser people use today comes first.
  const sorted = [...sources].sort((a, b) => Number(isDefault(b)) - Number(isDefault(a)));
  const shown = showAll ? sorted : sorted.slice(0, SHOWN_SOURCES);

  return (
    <>
      <ul className="sources" data-testid="welcome-sources">
        {shown.map((s) => {
          const st = states[s.id];
          const done = st && st !== 'busy' && st !== 'access' ? st : null;
          return (
            <li key={s.id} data-testid="welcome-source" data-source-id={s.id}>
              <div className="src-row">
                <span className="src-icon">
                  <Globe size={16} />
                </span>
                <div className="src-name">
                  <strong>{s.browser}</strong>
                  {s.profile !== 'Default' && <span className="muted"> · {s.profile}</span>}
                  {isDefault(s) && <span className="tag">Current default</span>}
                  {s.blocked && !done && st !== 'access' && <small className="muted">macOS asks for access first</small>}
                  {done?.errors.length ? <small className="warn">{done.errors.join(' ')}</small> : null}
                </div>
                {done && !done.errors.length ? (
                  <span className="pill ok" data-testid="welcome-import-result">
                    <Check size={12} strokeWidth={2} />
                    {count(done.bookmarks, 'bookmark')}, {count(done.history, 'page')}
                  </span>
                ) : (
                  <button className="btn" data-testid="welcome-import" disabled={st === 'busy' || st === 'access'} onClick={() => void run(s)}>
                    {st === 'busy' ? 'Harvesting...' : st === 'access' ? 'Waiting for access' : done ? 'Try again' : 'Import'}
                  </button>
                )}
              </div>
              {st === 'access' && <AccessSteps browser={s.browser} onRecheck={() => void recheck()} onCancel={() => cancel(s.id)} />}
            </li>
          );
        })}
      </ul>
      {sorted.length > SHOWN_SOURCES && !showAll && (
        <button className="link-btn more" onClick={() => setShowAll(true)}>
          Show {sorted.length - SHOWN_SOURCES} more
        </button>
      )}
    </>
  );
}

function DefaultBrowserButton() {
  const [isDefault, setDefault] = useState<boolean | null>(null);
  const [asked, setAsked] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const check = () => call<boolean>('app.isDefaultBrowser').then((v) => {
    setDefault(v);
    if (v && timer.current) clearInterval(timer.current);
    return v;
  });

  useEffect(() => {
    void check();
    const off = onInternalEvent((e) => e.type === 'app-active' && void check());
    return () => {
      off();
      if (timer.current) clearInterval(timer.current);
    };
  }, []);

  if (isDefault) {
    return (
      <span className="pill ok big-pill" data-testid="welcome-default-done">
        <Check size={13} strokeWidth={2} /> Default browser
      </span>
    );
  }
  return (
    <button
      className="btn"
      data-testid="welcome-default"
      onClick={async () => {
        await call('app.setDefaultBrowser');
        setAsked(true);
        // macOS confirms in its own dialog; watch for the answer for a minute.
        if (timer.current) clearInterval(timer.current);
        let left = 60;
        timer.current = setInterval(() => {
          if (--left <= 0 && timer.current) clearInterval(timer.current);
          void check();
        }, 1000);
      }}
    >
      {asked ? 'Confirm in the macOS dialog' : 'Make default'}
    </button>
  );
}

function Welcome() {
  const [settings, update] = useSettings();

  const finish = async () => {
    await call('app.finishWelcome');
    location.href = 'potato://newtab/';
  };

  return (
    <>
      <main className="welcome">
        <header className="hero">
          <BrandMark size={56} />
          <h1>No artificial ingredients.</h1>
          <p className="lede">A fast Chromium browser that keeps AI features, AI content and ads off your plate. Just the web, the way people grew it.</p>
        </header>

        <p className="eyebrow" id="already-on">
          <Check size={13} strokeWidth={2.2} /> Already baked in
        </p>
        <ul className="features" aria-labelledby="already-on">
          {FEATURES.map((f) => (
            <li key={f.title}>
              <span className="ft-icon">{f.icon}</span>
              <span className="ft-text">
                <strong>{f.title}</strong>
                <span>{f.text}</span>
              </span>
            </li>
          ))}
        </ul>

        <Step n={1} title="Search engine" hint="Where the address bar goes digging when you search.">
          <div className="engines" role="radiogroup" aria-label="Search engine">
            {ENGINES.map((e) => (
              <button
                key={e.id}
                type="button"
                role="radio"
                aria-checked={settings?.searchEngine === e.id}
                data-testid={`welcome-engine-${e.id}`}
                className={`engine${settings?.searchEngine === e.id ? ' on' : ''}`}
                onClick={() => void update({ searchEngine: e.id })}
              >
                <span className="radio" />
                <span className="engine-text">
                  <strong>{e.name}</strong>
                  <small>{e.text}</small>
                </span>
              </button>
            ))}
          </div>
        </Step>

        <Step n={2} title="Posts flagged as AI" hint="Fellow spuds flag AI-generated posts on Reddit, X, YouTube and more. Choose what happens to them.">
          <FlagModePicker value={settings?.flags.mode} onChange={(mode) => void update({ flags: { mode } })} testIdPrefix="welcome-mode" />
        </Step>

        <Step n={3} title="Bookmarks, history and passwords" hint="Replant them from the browser you use now.">
          <ImportList />
          <p className="password-import">
            Passwords come over as a file: export them from your browser or password manager, then{' '}
            <a href="potato://passwords/#import" target="_blank" data-testid="welcome-passwords">
              import the file here
            </a>
            .
          </p>
        </Step>

        <Step n={4} title="Default browser" hint="Send links from Mail, Slack and other apps straight to the potato." aside={<DefaultBrowserButton />} />
      </main>

      <footer className="finish">
        <div className="finish-inner">
          <span className="muted">Nothing here is set in stone. Or soil. Change it anytime in Settings.</span>
          <button className="btn primary big" data-testid="welcome-start" onClick={() => void finish()}>
            Start browsing <ArrowRight size={16} strokeWidth={1.8} />
          </button>
        </div>
      </footer>
    </>
  );
}

createRoot(document.getElementById('root')!).render(<Welcome />);
