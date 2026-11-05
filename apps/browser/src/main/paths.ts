import { app } from 'electron';
import path from 'node:path';

declare const __APP_VERSION__: string;
declare const __API_BASE__: string;

export const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0';

/** Test runs and power users can point the browser at another profile directory. */
export function configureUserData(): void {
  const dir = process.env.NOAI_USER_DATA;
  if (dir) app.setPath('userData', path.resolve(dir));
  else app.setPath('userData', path.join(app.getPath('appData'), 'No-AI Browser'));
  app.setPath('sessionData', path.join(app.getPath('userData'), 'Session'));
}

export const paths = {
  get root() {
    return app.getAppPath();
  },
  get renderer() {
    return path.join(app.getAppPath(), 'dist', 'renderer');
  },
  get uiPreload() {
    return path.join(app.getAppPath(), 'dist', 'preload', 'ui.js');
  },
  get webPreload() {
    return path.join(app.getAppPath(), 'dist', 'preload', 'web.js');
  },
  get userData() {
    return app.getPath('userData');
  },
};

export function apiBase(): string {
  return (process.env.NOAI_API_BASE || (typeof __API_BASE__ === 'string' ? __API_BASE__ : '')).replace(/\/+$/, '');
}

export const isTest = () => process.env.NOAI_TEST === '1';
