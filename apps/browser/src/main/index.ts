import { app, dialog, nativeTheme } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AdblockService } from './adblock/service';
import { commands, openInternal } from './commands';
import { ctx } from './context';
import { ProfileDb } from './db';
import { DownloadManager } from './downloads';
import { applyEngineSwitches, chromeUserAgent } from './engine';
import { FlagsService } from './flags';
import { PasswordService } from './passwords/service';
import { registerIpc } from './ipc';
import { notifyInternalPages } from './notify';
import { buildAppMenu, refreshMenuChecks } from './menus';
import { configureUserData, isTest, paths } from './paths';
import { PermissionManager } from './permissions';
import { registerSchemes } from './protocol';
import { SettingsStore } from './settings';
import { ShieldService } from './shield';
import { UpdateChecker } from './updates';
import { WindowManager } from './windows';

// ---- before ready: identity, engine switches, schemes -----------------------------------------
app.setName('Potato Browser');
configureUserData();
applyEngineSwitches();
app.userAgentFallback = chromeUserAgent();
registerSchemes();
// Tests must never touch the real Keychain (or wait on its permission dialog). Only with a
// throwaway profile: the mock key would leave a real profile's passwords unreadable.
if (isTest() && process.env.POTATO_USER_DATA) app.commandLine.appendSwitch('use-mock-keychain');

let ready = false;
const pendingUrls: string[] = [];

function openExternalUrl(url: string): void {
  if (!ready) {
    pendingUrls.push(url);
    return;
  }
  ctx.windows.openUrl(url);
}

// macOS hands us links when we are the default browser.
app.on('open-url', (event, url) => {
  event.preventDefault();
  if (/^(https?|file):/i.test(url)) openExternalUrl(url);
});
app.on('open-file', (event, file) => {
  event.preventDefault();
  openExternalUrl(pathToFileURL(file).href);
});

if (!isTest() && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const urls = argv.filter((a) => /^(https?|file):/i.test(a));
    if (urls.length) urls.forEach(openExternalUrl);
    else if (ready) (ctx.windows.focused() ?? ctx.windows.createWindow()).focus();
  });
}

app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (event) => event.preventDefault());
});

app.on('certificate-error', (event, wc, url, _error, cert, callback, isMainFrame) => {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {}
  if (host && ctx.windows?.isCertificateAllowed(wc.session, host, cert.fingerprint)) {
    event.preventDefault();
    callback(true);
    return;
  }
  // Only the page itself: a subresource error is not what the warning page shows the user.
  if (host && isMainFrame) ctx.windows?.noteCertificateError(wc, host, cert.fingerprint);
  callback(false);
});

// Electron would otherwise send the first matching identity to any site that asks, unasked.
app.on('select-client-certificate', (event, _wc, url, list, callback) => {
  event.preventDefault();
  if (!list.length) return callback();
  let host = url;
  try {
    host = new URL(url).host;
  } catch {}
  const shown = list.slice(0, 5);
  void dialog
    .showMessageBox({
      type: 'question',
      message: `${host} asks for a certificate to identify you`,
      detail: 'Choose one to send, or Cancel to send none.',
      buttons: [...shown.map((c) => c.subjectName || c.issuerName || 'Certificate'), 'Cancel'],
      cancelId: shown.length,
      defaultId: shown.length,
    })
    .then(({ response }) => callback(shown[response]))
    .catch(() => callback());
});

app.whenReady().then(() => {
  ctx.settings = new SettingsStore(paths.userData);
  ctx.db = new ProfileDb(path.join(paths.userData, 'Profile.sqlite'));
  ctx.downloads = new DownloadManager();
  ctx.permissions = new PermissionManager();
  ctx.shield = new ShieldService();
  ctx.adblock = new AdblockService();
  ctx.adblock.init();
  ctx.flags = new FlagsService();
  ctx.passwords = new PasswordService();
  ctx.updates = new UpdateChecker();
  ctx.windows = new WindowManager();

  nativeTheme.themeSource = ctx.settings.get().theme;
  registerIpc();
  buildAppMenu();

  ctx.settings.on('changed', (next, prev) => {
    if (next.theme !== prev.theme) nativeTheme.themeSource = next.theme;
    if (JSON.stringify(next.flags) !== JSON.stringify(prev.flags)) ctx.flags.clearCache();
    ctx.adblock.onSettingsChanged(next, prev);
    refreshMenuChecks();
    ctx.shield.broadcast();
    notifyInternalPages({ type: 'settings' });
  });
  ctx.downloads.onChange(() => notifyInternalPages({ type: 'downloads' }));
  // Internal pages re-check permissions (Full Disk Access, default browser) when the user returns.
  app.on('did-become-active', () => notifyInternalPages({ type: 'app-active' }));

  const firstRun = !ctx.settings.get().firstRunDone && process.env.POTATO_SKIP_WELCOME !== '1';
  ready = true;
  ctx.windows.restoreOrOpen(firstRun, pendingUrls.splice(0));
  ctx.updates.start();
  ctx.adblock.start();

  if (isTest()) {
    // Lets Playwright drive the same code paths as menus and shortcuts.
    (globalThis as Record<string, unknown>).__potato = { ctx, commands, openInternal };
  }
});

app.on('activate', () => {
  if (ready && ctx.windows.windows.length === 0) ctx.windows.createWindow();
});

app.on('before-quit', () => {
  if (!ready) return;
  ctx.windows.persistSessionNow();
  ctx.windows.quitting = true;
  ctx.settings.flush();
  ctx.adblock.stop();
});

app.on('window-all-closed', () => {
  // macOS keeps the app running without windows, like every other browser.
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  if (!ready) return;
  ctx.updates.stop();
  try {
    ctx.db.close();
  } catch {}
});
