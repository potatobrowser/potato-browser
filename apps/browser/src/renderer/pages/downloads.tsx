import { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { DownloadItemState } from '../../shared/types';
import { call, formatBytes, onInternalEvent } from '../shared/api';
import { Card } from '../shared/components';
import { Close, Download, File } from '../shared/icons';
import '../shared/pages.css';

type Item = DownloadItemState & { exists: boolean };

function status(d: Item): string {
  if (d.state === 'progressing') {
    const pct = d.total ? ` (${Math.round((d.received / d.total) * 100)}%)` : '';
    return `${d.paused ? 'Paused' : 'Downloading'} · ${formatBytes(d.received)}${d.total ? ` of ${formatBytes(d.total)}` : ''}${pct}`;
  }
  if (d.state === 'completed') return d.exists ? formatBytes(d.total || d.received) : 'Deleted';
  if (d.state === 'cancelled') return 'Cancelled';
  return 'Failed';
}

function Downloads() {
  const [items, setItems] = useState<Item[]>([]);
  const load = useCallback(() => void call<Item[]>('downloads.list').then(setItems), []);
  useEffect(() => {
    load();
    return onInternalEvent((e) => e.type === 'downloads' && load());
  }, [load]);

  return (
    <div className="page">
      <div className="page-head">
        <h1>
          <Download size={24} /> Downloads
        </h1>
        {items.some((d) => d.state !== 'progressing') && (
          <button className="btn" onClick={async () => { await call('downloads.clear'); load(); }}>
            Clear list
          </button>
        )}
      </div>
      <Card>
        {items.length === 0 ? (
          <div className="empty">Files you download land here, fresh from the field.</div>
        ) : (
          <ul className="list" data-testid="downloads-list">
            {items.map((d) => (
              <li key={d.id} className="list-item" data-testid="download-row" data-state={d.state}>
                <span className="fav">
                  <File size={18} />
                </span>
                <div className="grow">
                  <div className="truncate" style={{ fontWeight: 600, textDecoration: d.state === 'completed' && d.exists ? 'none' : d.state === 'progressing' ? 'none' : 'line-through' }} data-testid="download-name">
                    {d.filename}
                  </div>
                  <div className="muted truncate" style={{ fontSize: 13 }}>
                    {status(d)} · <span title={d.url}>{new URL(d.url).host || d.url}</span>
                  </div>
                </div>
                {d.state === 'progressing' ? (
                  <>
                    <button className="btn small" onClick={() => void call('downloads.pause', d.id).then(load)}>
                      {d.paused ? 'Resume' : 'Pause'}
                    </button>
                    <button className="btn small" onClick={() => void call('downloads.cancel', d.id).then(load)}>
                      Cancel
                    </button>
                  </>
                ) : d.state === 'completed' && d.exists ? (
                  <>
                    <button className="btn small" onClick={() => void call('downloads.open', d.id)}>
                      Open
                    </button>
                    <button className="btn small" onClick={() => void call('downloads.show', d.id)}>
                      Show in Finder
                    </button>
                  </>
                ) : null}
                <button className="icon-btn" aria-label="Remove from list" onClick={() => void call('downloads.remove', d.id).then(load)}>
                  <Close size={13} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Downloads />);
