import type { FlagMode } from '../../shared/types';
import { Flag } from './icons';
import './flagmodes.css';

export const FLAG_MODES: { id: FlagMode; title: string; text: string }[] = [
  { id: 'hide', title: 'Hide them', text: 'Folded away behind a notice. One click shows them.' },
  { id: 'label', title: 'Label them', text: 'Shown with an amber outline and an AI tag.' },
  { id: 'ignore', title: 'Leave them', text: 'Shown as usual. You can still flag posts.' },
];

function Pill({ flagged }: { flagged?: boolean }) {
  return (
    <span className={`mp-pill${flagged ? ' flagged' : ''}`}>
      <Flag size={9} strokeWidth={1.8} />
      {flagged ? 'AI · 4' : 'AI?'}
    </span>
  );
}

function Post({ flagged, labeled }: { flagged?: boolean; labeled?: boolean }) {
  return (
    <div className={`mp${labeled ? ' labeled' : ''}`}>
      <div className="mp-head">
        <span className="mp-av" />
        <span className="mp-name" />
        <Pill flagged={flagged} />
      </div>
      <span className="mp-line" />
      <span className="mp-line short" />
    </div>
  );
}

/** A miniature feed showing what a flagged post looks like in each mode (mirrors the in-page UI). */
export function FlagModePreview({ mode }: { mode: FlagMode }) {
  return (
    <div className="fm-preview" aria-hidden="true">
      <Post />
      {mode === 'hide' ? (
        <div className="mp-hidden">
          <Flag size={10} strokeWidth={1.8} />
          <span>Hidden: flagged as AI by 4 people.</span>
          <u>Show</u>
        </div>
      ) : (
        <Post flagged={mode === 'label'} labeled={mode === 'label'} />
      )}
    </div>
  );
}

export function FlagModePicker({ value, onChange, testIdPrefix }: { value: FlagMode | undefined; onChange(m: FlagMode): void; testIdPrefix: string }) {
  return (
    <div className="fm-grid" role="radiogroup" aria-label="Posts flagged as AI-generated" data-testid={`${testIdPrefix}s`}>
      {FLAG_MODES.map((m) => (
        <button
          key={m.id}
          type="button"
          role="radio"
          aria-checked={value === m.id}
          data-testid={`${testIdPrefix}-${m.id}`}
          className={`fm-card${value === m.id ? ' on' : ''}`}
          onClick={() => onChange(m.id)}
        >
          <FlagModePreview mode={m.id} />
          <span className="fm-label">
            <span className="radio" />
            <strong>{m.title}</strong>
          </span>
          <small>{m.text}</small>
        </button>
      ))}
    </div>
  );
}
