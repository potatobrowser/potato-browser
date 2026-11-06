import { PLATFORM_LABELS } from '@potato/shared';
import type { DownloadItemState, TabState } from '../../shared/types';
import { chrome, formatBytes } from '../shared/api';
import { Download, File, Flag, Shield } from '../shared/icons';

export function ShieldPanel({ tab, globallyEnabled }: { tab: TabState | null; globallyEnabled: boolean }) {
  const s = tab?.shield;
  const web = !!s?.host;
  const f = tab?.flags;
  return (
    <div className="panel shield-panel" data-testid="shield-panel" role="dialog" aria-label="AI Shield">
      <div className="panel-head">
        <span className={`panel-icon${s?.enabled ? ' on' : ''}`}>
          <Shield size={18} filled={!!s?.enabled} />
        </span>
        <div>
          <div className="panel-title">AI Shield</div>
          <div className="panel-sub">{web ? s!.host : 'Not available on this page'}</div>
        </div>
      </div>
      {web ? (
        <>
          <label className="switch-row">
            <span>
              <strong>Hide AI on this site</strong>
              <small>{s!.enabled ? 'AI features are peeled off.' : 'AI features are shown on this site.'}</small>
            </span>
            <input
              type="checkbox"
              role="switch"
              data-testid="shield-site-toggle"
              checked={s!.enabled}
              disabled={!globallyEnabled}
              onChange={(e) => chrome().send({ type: 'shield.setSite', enabled: e.target.checked })}
            />
          </label>
          {!globallyEnabled && <p className="panel-note">The AI Shield is turned off for all sites in Settings.</p>}
          <div className="panel-section" data-testid="shield-summary">
            {s!.enabled && s!.hiddenCount > 0 ? (
              <>
                <p>
                  <strong data-testid="shield-count">{s!.hiddenCount}</strong> AI {s!.hiddenCount === 1 ? 'bit' : 'bits'} peeled off this page
                </p>
                <ul className="feature-list">
                  {s!.features.map((name) => (
                    <li key={name}>{name}</li>
                  ))}
                </ul>
              </>
            ) : s!.supported ? (
              <p>{s!.enabled ? 'Nothing artificial on this page right now.' : 'Known AI features of this site are visible.'}</p>
            ) : (
              <p>No known AI features on this site. Fresh from the field.</p>
            )}
          </div>
          {f?.platform ? (
            <div className="panel-section">
              <p className="flag-line">
                <Flag size={14} /> {PLATFORM_LABELS[f.platform]}: {f.hidden} flagged {f.hidden === 1 ? 'post' : 'posts'} buried, {f.labeled} labeled
              </p>
            </div>
          ) : null}
        </>
      ) : (
        <p className="panel-section">Open a website to see what's growing on it and peel off its AI features.</p>
      )}
      <div className="panel-foot">
        <button className="link" onClick={() => chrome().send({ type: 'shield.openSettings' })}>
          AI Shield settings
        </button>
        <button className="link" onClick={() => chrome().send({ type: 'flags.openSettings' })}>
          Flag settings
        </button>
      </div>
    </div>
  );
}

function downloadLine(d: DownloadItemState): string {
  if (d.state === 'completed') return formatBytes(d.total || d.received);
  if (d.state === 'cancelled') return 'Cancelled';
  if (d.state === 'interrupted') return 'Failed';
  if (d.total) return `${formatBytes(d.received)} of ${formatBytes(d.total)}`;
  return formatBytes(d.received);
}

export function DownloadsPanel({ items }: { items: DownloadItemState[] }) {
  return (
    <div className="panel downloads-panel" data-testid="downloads-panel" role="dialog" aria-label="Downloads">
      <div className="panel-title pad">Recent downloads</div>
      <ul className="dl-list">
        {items.map((d) => (
          <li key={d.id} className={`dl-item ${d.state}`}>
            <span className="dl-icon">
              <File />
            </span>
            <span className="dl-main">
              <button
                className="dl-name"
                disabled={d.state !== 'completed'}
                onClick={() => chrome().send({ type: 'downloads.open', id: d.id })}
                title={d.filename}
              >
                {d.filename}
              </button>
              {d.state === 'progressing' && d.total > 0 ? (
                <progress max={d.total} value={d.received} />
              ) : null}
              <small>{downloadLine(d)}</small>
            </span>
            {d.state === 'progressing' ? (
              <button className="link" onClick={() => chrome().send({ type: 'downloads.cancel', id: d.id })}>
                Cancel
              </button>
            ) : d.state === 'completed' ? (
              <button className="link" title="Show in Finder" onClick={() => chrome().send({ type: 'downloads.show', id: d.id })}>
                Show
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      <div className="panel-foot">
        <button className="link" onClick={() => chrome().send({ type: 'downloads.showAll' })}>
          <Download size={14} /> Show all downloads
        </button>
      </div>
    </div>
  );
}
