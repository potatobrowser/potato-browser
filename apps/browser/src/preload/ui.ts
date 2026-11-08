import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { SuggestResult, WindowState } from '../shared/types';

/** Bridge for the browser chrome (tab strip, toolbar, popovers). */
const api = {
  send(cmd: { type: string; [k: string]: unknown }): void {
    ipcRenderer.send('ui:command', cmd);
  },
  suggest(text: string): Promise<SuggestResult> {
    return ipcRenderer.invoke('ui:suggest', text);
  },
  /** Reports the active tab's page to potatobrowser.com; resolves to whether it arrived. */
  report(feature: string, problem: string): Promise<boolean> {
    return ipcRenderer.invoke('ui:report', feature, problem);
  },
  onState(cb: (s: WindowState) => void): () => void {
    const l = (_e: IpcRendererEvent, s: WindowState) => cb(s);
    ipcRenderer.on('ui:state', l);
    return () => ipcRenderer.off('ui:state', l);
  },
  onEvent(cb: (e: { type: string; [k: string]: unknown }) => void): () => void {
    const l = (_e: IpcRendererEvent, ev: { type: string }) => cb(ev);
    ipcRenderer.on('ui:event', l);
    return () => ipcRenderer.off('ui:event', l);
  },
};

contextBridge.exposeInMainWorld('chromeApi', api);

export type ChromeApi = typeof api;
