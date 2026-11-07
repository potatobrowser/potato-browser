import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ShieldStats, TopSite } from '../../shared/types';
import { getSearchEngine, prettyUrl, resolveInput } from '../../shared/urls';
import { call } from '../shared/api';
import { Favicon, useSettings } from '../shared/components';
import { BrandMark, Search } from '../shared/icons';
import '../shared/pages.css';
import './newtab.css';

function NewTab() {
  const [settings] = useSettings();
  const [sites, setSites] = useState<TopSite[]>([]);
  const [stats, setStats] = useState<ShieldStats | null>(null);
  const [q, setQ] = useState('');

  useEffect(() => {
    void call<TopSite[]>('topSites').then(setSites);
    void call<ShieldStats>('shield.stats').then(setStats);
  }, []);

  const engine = settings ? getSearchEngine(settings.searchEngine) : null;

  return (
    <main className="ntp">
      <div className="ntp-brand">
        <BrandMark size={44} />
      </div>
      <form
        className="ntp-search search"
        onSubmit={(e) => {
          e.preventDefault();
          if (!settings) return;
          const url = resolveInput(q, settings.searchEngine);
          if (url) location.href = url;
        }}
      >
        <Search size={18} />
        <input
          data-testid="ntp-search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={engine ? `Search ${engine.name.replace(/ \(.*\)$/, '')} or type a URL` : 'Search or type a URL'}
          autoComplete="off"
          spellCheck={false}
        />
      </form>
      {sites.length > 0 && (
        <ul className="tiles" data-testid="top-sites">
          {sites.map((s) => (
            <li key={s.url}>
              <a href={s.url} className="tile" title={s.title}>
                <span className="tile-icon">
                  <Favicon src={s.favicon} />
                </span>
                <span className="tile-title truncate">{s.title || prettyUrl(s.url).host}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
      <footer className="ntp-foot" data-testid="ntp-stats">
        {stats && (stats.hiddenTotal > 0 || stats.blockedTotal > 0) ? (
          <span>
            Today: <strong>{stats.blockedToday.toLocaleString()}</strong> ads and trackers mashed ·{' '}
            <strong>{stats.hiddenToday.toLocaleString()}</strong> AI features peeled off
          </span>
        ) : (
          <span>Ads get mashed and AI features get peeled off the sites you visit. The web, the way people grew it.</span>
        )}
      </footer>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<NewTab />);
