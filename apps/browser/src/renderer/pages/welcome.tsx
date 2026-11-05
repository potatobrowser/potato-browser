import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { FlagMode, ImportResult, ImportSource } from '../../shared/types';
import { call } from '../shared/api';
import { useSettings } from '../shared/components';
import { BrandMark, Flag, Shield } from '../shared/icons';
import '../shared/pages.css';
import './welcome.css';

function Welcome() {
  const [settings, update] = useSettings();
  const [sources, setSources] = useState<ImportSource[]>([]);
  const [imported, setImported] = useState<Record<string, ImportResult | 'busy'>>({});
  const [isDefault, setDefault] = useState(false);

  useEffect(() => {
    void call<ImportSource[]>('import.detect').then((s) => setSources(s.filter((x) => !x.blocked).slice(0, 4)));
    void call<boolean>('app.isDefaultBrowser').then(setDefault);
  }, []);

  const finish = async () => {
    await call('app.finishWelcome');
    location.href = 'noai://newtab/';
  };

  const modes: { id: FlagMode; label: string; text: string }[] = [
    { id: 'hide', label: 'Hide them', text: 'Flagged posts fold away behind a small notice.' },
    { id: 'label', label: 'Label them', text: 'Flagged posts stay, marked with an AI label.' },
    { id: 'ignore', label: 'Leave them', text: 'Nothing changes. You can still flag posts.' },
  ];

  return (
    <main className="welcome">
      <header>
        <BrandMark size={64} color="var(--ink)" />
        <h1>The web, without the AI.</h1>
        <p className="lede">No-AI Browser is a fast Chromium browser that keeps machine-made features and content out of your way. Three things are already on:</p>
      </header>

      <section className="points">
        <article>
          <span className="pt-icon">
            <Shield size={20} />
          </span>
          <h2>AI Shield</h2>
          <p>AI Overviews, chat assistants, "Help me write" buttons and AI search modes are hidden on major sites. Switch it off per site from the shield in the toolbar.</p>
        </article>
        <article>
          <span className="pt-icon">
            <BrandMark size={20} color="currentColor" />
          </span>
          <h2>No AI in the engine</h2>
          <p>No built-in language models, no on-device AI downloads, no AI web APIs. Pages can't summon a model through your browser.</p>
        </article>
        <article>
          <span className="pt-icon">
            <Flag size={20} />
          </span>
          <h2>Community flags</h2>
          <p>Flag posts you think are AI-generated on Reddit, X, Instagram, Facebook and more. Anonymous, no account.</p>
        </article>
      </section>

      <section className="step">
        <h2>When people flag a post as AI-generated</h2>
        <div className="choices" role="radiogroup">
          {modes.map((m) => (
            <button
              key={m.id}
              role="radio"
              aria-checked={settings?.flags.mode === m.id}
              data-testid={`welcome-mode-${m.id}`}
              className={`choice${settings?.flags.mode === m.id ? ' on' : ''}`}
              onClick={() => void update({ flags: { mode: m.id } })}
            >
              <strong>{m.label}</strong>
              <small>{m.text}</small>
            </button>
          ))}
        </div>
      </section>

      {sources.length > 0 && (
        <section className="step">
          <h2>Bring your bookmarks and history</h2>
          <ul className="sources">
            {sources.map((s) => {
              const r = imported[s.id];
              return (
                <li key={s.id}>
                  <span>
                    <strong>{s.browser}</strong> {s.profile !== 'Default' && <span className="muted">· {s.profile}</span>}
                  </span>
                  {r && r !== 'busy' ? (
                    <span className="pill ok">
                      {r.errors.length ? 'Partly imported' : `${r.bookmarks} bookmarks, ${r.history} pages`}
                    </span>
                  ) : (
                    <button
                      className="btn"
                      disabled={r === 'busy'}
                      onClick={async () => {
                        setImported((p) => ({ ...p, [s.id]: 'busy' }));
                        const res = await call<ImportResult>('import.run', s.id, { bookmarks: true, history: true });
                        setImported((p) => ({ ...p, [s.id]: res }));
                      }}
                    >
                      {r === 'busy' ? 'Importing...' : 'Import'}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <footer className="actions">
        {!isDefault && (
          <button
            className="btn"
            onClick={async () => {
              await call('app.setDefaultBrowser');
              setTimeout(() => void call<boolean>('app.isDefaultBrowser').then(setDefault), 1500);
            }}
          >
            Make default browser
          </button>
        )}
        <button className="btn primary big" data-testid="welcome-start" onClick={() => void finish()}>
          Start browsing
        </button>
      </footer>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<Welcome />);
