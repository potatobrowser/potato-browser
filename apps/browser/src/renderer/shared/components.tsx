import { useEffect, useState, type ReactNode } from 'react';
import type { Settings, SettingsPatch } from '../../shared/types';
import { call, onInternalEvent } from './api';
import { Globe } from './icons';

export function Toggle({ checked, onChange, label, testId }: { checked: boolean; onChange(v: boolean): void; label: string; testId?: string }) {
  return (
    <input
      type="checkbox"
      role="switch"
      aria-label={label}
      data-testid={testId}
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
    />
  );
}

export function Row({ title, hint, children, testId }: { title: ReactNode; hint?: ReactNode; children?: ReactNode; testId?: string }) {
  return (
    <div className="row" data-testid={testId}>
      <div className="row-label">
        <span>{title}</span>
        {hint ? <small>{hint}</small> : null}
      </div>
      {children}
    </div>
  );
}

export function Card({ title, hint, children, id }: { title?: ReactNode; hint?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section className="card" id={id}>
      {title ? (
        <div className="card-head">
          <h2>{title}</h2>
          {hint ? <p>{hint}</p> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function Favicon({ src }: { src: string | null | undefined }) {
  return <span className="fav">{src ? <img src={src} alt="" /> : <Globe size={16} />}</span>;
}

/** Settings with live updates from other windows/pages. */
export function useSettings(): [Settings | null, (patch: SettingsPatch) => Promise<void>] {
  const [settings, setSettings] = useState<Settings | null>(null);
  useEffect(() => {
    const load = () => void call<Settings>('settings.get').then(setSettings);
    load();
    return onInternalEvent((e) => e.type === 'settings' && load());
  }, []);
  const update = async (patch: SettingsPatch) => {
    setSettings(await call<Settings>('settings.set', patch));
  };
  return [settings, update];
}

export function dayLabel(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(today) - start(d)) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

export function timeLabel(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
