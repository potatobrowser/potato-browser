import { app, shell, type DownloadItem, type WebContents } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DownloadItemState } from '../shared/types';
import { ctx } from './context';

interface Live {
  item: DownloadItem | null;
  state: DownloadItemState;
  isPrivate: boolean;
}

/** Picks a free file name in `dir`: "report.pdf" -> "report (1).pdf". */
export function uniquePath(dir: string, filename: string, taken: Set<string> = new Set()): string {
  const safe = filename.replace(/[/\\:\x00-\x1f]/g, '_').replace(/^\.+/, '_').trim() || 'download';
  const ext = path.extname(safe);
  const stem = safe.slice(0, safe.length - ext.length);
  for (let i = 0; i < 10_000; i++) {
    const name = i === 0 ? safe : `${stem} (${i})${ext}`;
    const full = path.join(dir, name);
    if (!fs.existsSync(full) && !taken.has(full)) return full;
  }
  return path.join(dir, `${stem}-${Date.now()}${ext}`);
}

export class DownloadManager {
  private live = new Map<string, Live>();
  private listeners = new Set<() => void>();

  handle(item: DownloadItem, _wc: WebContents | undefined, isPrivate: boolean): void {
    const settings = ctx.settings.get();
    const id = crypto.randomUUID();
    const dir = settings.downloadsDir;
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {}
    const reserved = new Set([...this.live.values()].filter((l) => l.state.state === 'progressing').map((l) => l.state.path));
    if (settings.askWhereToSave && process.env.POTATO_TEST !== '1') {
      item.setSaveDialogOptions({ defaultPath: path.join(dir, item.getFilename()) });
    } else {
      item.setSavePath(uniquePath(dir, item.getFilename(), reserved));
    }
    const state: DownloadItemState = {
      id,
      url: item.getURL(),
      filename: path.basename(item.getSavePath() || item.getFilename()),
      path: item.getSavePath(),
      state: 'progressing',
      paused: false,
      received: 0,
      total: item.getTotalBytes(),
      startedAt: Date.now(),
      endedAt: null,
      mime: item.getMimeType(),
    };
    const live: Live = { item, state, isPrivate };
    this.live.set(id, live);
    let lastPersist = 0;

    item.on('updated', (_e, s) => {
      state.received = item.getReceivedBytes();
      state.total = item.getTotalBytes();
      state.paused = item.isPaused();
      state.state = s === 'interrupted' ? 'interrupted' : 'progressing';
      if (item.getSavePath()) {
        state.path = item.getSavePath();
        state.filename = path.basename(state.path);
      }
      if (!isPrivate && Date.now() - lastPersist > 1000) {
        lastPersist = Date.now();
        ctx.db.saveDownload(state);
      }
      this.changed();
    });
    item.once('done', (_e, s) => {
      state.state = s;
      state.received = item.getReceivedBytes();
      state.total = item.getTotalBytes() || state.received;
      state.endedAt = Date.now();
      state.path = item.getSavePath() || state.path;
      state.filename = path.basename(state.path) || state.filename;
      live.item = null;
      if (!isPrivate) ctx.db.saveDownload(state);
      if (s === 'completed' && process.platform === 'darwin' && state.path) app.dock?.downloadFinished(state.path);
      this.changed();
    });
    if (!isPrivate) ctx.db.saveDownload(state);
    this.changed();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    ctx.windows?.broadcast();
    for (const fn of this.listeners) fn();
  }

  /** Recent downloads of this browsing context for the toolbar popover. */
  summary(isPrivate: boolean): { active: number; recent: DownloadItemState[] } {
    const recent = [...this.live.values()]
      .filter((l) => l.isPrivate === isPrivate)
      .map((l) => ({ ...l.state }))
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, 6);
    return { active: recent.filter((d) => d.state === 'progressing').length, recent };
  }

  list(): DownloadItemState[] {
    const persisted = ctx.db.listDownloads();
    const byId = new Map(persisted.map((d) => [d.id, d]));
    for (const l of this.live.values()) if (!l.isPrivate) byId.set(l.state.id, { ...l.state });
    return [...byId.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  private find(id: string): DownloadItemState | null {
    return this.live.get(id)?.state ?? ctx.db.listDownloads().find((d) => d.id === id) ?? null;
  }

  open(id: string): void {
    const d = this.find(id);
    if (d?.state === 'completed' && d.path && fs.existsSync(d.path)) void shell.openPath(d.path);
  }

  show(id: string): void {
    const d = this.find(id);
    if (d?.path && fs.existsSync(d.path)) shell.showItemInFolder(d.path);
    else void shell.openPath(ctx.settings.get().downloadsDir);
  }

  cancel(id: string): void {
    this.live.get(id)?.item?.cancel();
  }

  pause(id: string): void {
    const item = this.live.get(id)?.item;
    if (!item) return;
    if (item.isPaused()) item.resume();
    else item.pause();
  }

  remove(id: string): void {
    const l = this.live.get(id);
    if (l?.item) l.item.cancel();
    this.live.delete(id);
    ctx.db.removeDownload(id);
    this.changed();
  }

  clear(): void {
    for (const [id, l] of this.live) if (l.state.state !== 'progressing' && !l.isPrivate) this.live.delete(id);
    ctx.db.clearDownloads(0);
    this.changed();
  }

  exists(id: string): boolean {
    const d = this.find(id);
    return !!d?.path && fs.existsSync(d.path);
  }

  forgetPrivate(): void {
    for (const [id, l] of this.live) if (l.isPrivate && l.state.state !== 'progressing') this.live.delete(id);
  }
}
