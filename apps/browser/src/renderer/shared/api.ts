import type { SuggestResult, WindowState } from '../../shared/types';

export interface ChromeApi {
  send(cmd: { type: string; [k: string]: unknown }): void;
  suggest(text: string): Promise<SuggestResult>;
  report(feature: string, problem: string): Promise<boolean>;
  onState(cb: (s: WindowState) => void): () => void;
  onEvent(cb: (e: { type: string; [k: string]: unknown }) => void): () => void;
}

export interface InternalApi {
  call<T = unknown>(method: string, ...args: unknown[]): Promise<T>;
  onEvent(cb: (e: { type: string }) => void): () => void;
}

declare global {
  interface Window {
    chromeApi: ChromeApi;
    potato: InternalApi;
  }
}

export const chrome = () => window.chromeApi;

/** Calls the main process from internal pages. */
export function call<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
  return window.potato.call<T>(method, ...args);
}

export function onInternalEvent(cb: (e: { type: string }) => void): () => void {
  return window.potato?.onEvent(cb) ?? (() => {});
}

export function formatBytes(n: number): string {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}
