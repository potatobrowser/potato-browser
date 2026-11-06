import { useCallback, useEffect, useRef, useState } from 'react';
import type { ImportResult, ImportSource } from '../../shared/types';
import { call, onInternalEvent } from './api';

export type What = { bookmarks: boolean; history: boolean };
/** 'access': waiting for the user to allow Full Disk Access in System Settings. */
export type ImportState = 'busy' | 'access' | ImportResult;

const PENDING_KEY = 'noai.pendingImport';

function readPending(): { id: string; what: What } | null {
  try {
    const v = JSON.parse(localStorage.getItem(PENDING_KEY) ?? 'null');
    return v && typeof v.id === 'string' ? v : null;
  } catch {
    return null;
  }
}

function writePending(v: { id: string; what: What } | null): void {
  try {
    if (v) localStorage.setItem(PENDING_KEY, JSON.stringify(v));
    else localStorage.removeItem(PENDING_KEY);
  } catch {}
}

/**
 * Import sources with the macOS permission flow: importing a protected source (Safari) opens
 * System Settings on Full Disk Access, and the import resumes by itself once access works,
 * including after a relaunch.
 */
export function useImporter() {
  const [sources, setSources] = useState<ImportSource[] | null>(null);
  const [states, setStates] = useState<Record<string, ImportState>>({});
  const waiting = useRef(new Map<string, What>());

  const set = (id: string, s: ImportState) => setStates((p) => ({ ...p, [id]: s }));

  const runNow = useCallback(async (id: string, what: What) => {
    set(id, 'busy');
    try {
      set(id, await call<ImportResult>('import.run', id, what));
    } catch (err) {
      set(id, { sourceId: id, bookmarks: 0, history: 0, errors: [String((err as Error)?.message ?? err)] });
    }
  }, []);

  const detect = useCallback(async () => {
    const list = await call<ImportSource[]>('import.detect');
    setSources(list);
    for (const s of list) {
      const what = waiting.current.get(s.id);
      if (!what) continue;
      if (s.blocked) {
        set(s.id, 'access');
        continue;
      }
      waiting.current.delete(s.id);
      writePending(null);
      void runNow(s.id, what);
    }
    return list;
  }, [runNow]);

  useEffect(() => {
    const pending = readPending();
    if (pending) waiting.current.set(pending.id, pending.what);
    void detect().then((list) => {
      if (pending && !list.some((s) => s.id === pending.id)) writePending(null);
    });
    return onInternalEvent((e) => {
      if (e.type === 'app-active' && waiting.current.size) void detect();
    });
  }, [detect]);

  const run = (src: ImportSource, what: What = { bookmarks: src.hasBookmarks, history: src.hasHistory }) => {
    if (!src.blocked) return runNow(src.id, what);
    waiting.current.set(src.id, what);
    writePending({ id: src.id, what });
    set(src.id, 'access');
    void call('app.openFullDiskAccess');
  };

  const cancel = (id: string) => {
    waiting.current.delete(id);
    writePending(null);
    setStates((p) => {
      const { [id]: _drop, ...rest } = p;
      return rest;
    });
  };

  return { sources, states, run, cancel, recheck: detect };
}

/** Inline steps shown while macOS needs Full Disk Access for a source. */
export function AccessSteps({ browser, onRecheck, onCancel }: { browser: string; onRecheck(): void; onCancel(): void }) {
  return (
    <div className="access" role="status" data-testid="import-access">
      <p className="access-title">System Settings opened on Full Disk Access</p>
      <ol>
        <li>
          Switch on <strong>No-AI Browser</strong>. Not in the list? Click <strong>+</strong> and pick it in Applications.
        </li>
        <li>Come back here. The {browser} import starts on its own.</li>
      </ol>
      <div className="access-actions">
        <button className="btn small" onClick={() => void call('app.openFullDiskAccess')}>
          Open System Settings
        </button>
        <button className="btn small" onClick={onRecheck} data-testid="import-recheck">
          Check again
        </button>
        <button className="link-btn" onClick={() => void call('app.relaunch')} title="macOS sometimes applies the permission only after a restart">
          Still blocked? Quit and reopen
        </button>
        <button className="link-btn muted" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
