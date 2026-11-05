import { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { HistoryEntry } from '../../shared/types';
import { prettyUrl } from '../../shared/urls';
import { call } from '../shared/api';
import { Card, dayLabel, Favicon, timeLabel } from '../shared/components';
import { Clock, Close, Search } from '../shared/icons';
import '../shared/pages.css';

const PAGE = 150;

function History() {
  const [q, setQ] = useState('');
  const [items, setItems] = useState<HistoryEntry[]>([]);
  const [more, setMore] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const load = useCallback(async (text: string) => {
    const rows = await call<HistoryEntry[]>('history.query', text, PAGE);
    setItems(rows);
    setMore(rows.length === PAGE);
    setSelected(new Set());
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void load(q), 120);
    return () => clearTimeout(t);
  }, [q, load]);

  const groups = useMemo(() => {
    const out: { day: string; rows: HistoryEntry[] }[] = [];
    for (const it of items) {
      const day = dayLabel(it.visitTime);
      const last = out[out.length - 1];
      if (last?.day === day) last.rows.push(it);
      else out.push({ day, rows: [it] });
    }
    return out;
  }, [items]);

  const remove = async (ids: number[]) => {
    await call('history.delete', ids);
    await load(q);
  };

  return (
    <div className="page">
      <div className="page-head">
        <h1>
          <Clock size={24} /> History
        </h1>
        <div style={{ display: 'flex', gap: 8 }}>
          {selected.size > 0 && (
            <button className="btn danger" data-testid="history-delete-selected" onClick={() => void remove([...selected])}>
              Delete {selected.size} selected
            </button>
          )}
          <a className="btn" href="noai://settings/#privacy">
            Clear browsing data
          </a>
        </div>
      </div>
      <div className="search" style={{ marginBottom: 16 }}>
        <Search />
        <input data-testid="history-search" placeholder="Search history" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      </div>
      <Card>
        {items.length === 0 ? (
          <div className="empty" data-testid="history-empty">
            {q ? 'No matching pages.' : 'Pages you visit appear here. Private windows are never recorded.'}
          </div>
        ) : (
          groups.map((g) => (
            <div key={g.day}>
              <div className="day">{g.day}</div>
              <ul className="list">
                {g.rows.map((it) => (
                  <li key={it.id} className="list-item" data-testid="history-item">
                    <input
                      type="checkbox"
                      aria-label="Select"
                      checked={selected.has(it.id)}
                      onChange={(e) => {
                        const next = new Set(selected);
                        if (e.target.checked) next.add(it.id);
                        else next.delete(it.id);
                        setSelected(next);
                      }}
                    />
                    <span className="muted mono" style={{ width: 52 }}>
                      {timeLabel(it.visitTime)}
                    </span>
                    <Favicon src={it.favicon} />
                    <a className="grow truncate" href={it.url} title={it.url} style={{ color: 'inherit', textDecoration: 'none' }}>
                      {it.title || it.url} <span className="muted"> {prettyUrl(it.url).host}</span>
                    </a>
                    <button className="icon-btn" aria-label="Remove from history" title="Remove from history" onClick={() => void remove([it.id])}>
                      <Close size={13} />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
        {more && (
          <div style={{ padding: 16, textAlign: 'center' }}>
            <button
              className="btn"
              onClick={async () => {
                const before = items[items.length - 1]?.visitTime ?? Date.now();
                const rows = await call<HistoryEntry[]>('history.query', q, PAGE, before);
                setItems([...items, ...rows]);
                setMore(rows.length === PAGE);
              }}
            >
              Show more
            </button>
          </div>
        )}
      </Card>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<History />);
