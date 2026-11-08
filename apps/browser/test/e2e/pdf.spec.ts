import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { TestBrowser } from './support/browser';

let b: TestBrowser;
test.afterEach(async () => b?.close());

const PDF = 'https://site.test/files/spud-report.pdf';

/** What the active tab shows: Chromium's PDF viewer frame and, inside it, the PDF plugin. */
function viewer(): Promise<{ viewer: boolean; plugin: boolean }> {
  return b.app.evaluate(async () => {
    const wc = (globalThis as any).__potato.ctx.windows.focused()?.activeTab?.wc;
    const ext = wc?.mainFrame.frames.find((f: any) => f.origin === 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai');
    const plugin = ext?.frames[0];
    const embed = plugin ? await plugin.executeJavaScript(`!!document.querySelector('embed[type="application/x-google-chrome-pdf"]')`).catch(() => false) : false;
    return { viewer: !!ext, plugin: embed };
  });
}

/** Runs a script in the viewer's own document (its toolbar lives in shadow roots). */
function inViewer(js: string): Promise<unknown> {
  return b.app.evaluate(async ({}, js) => {
    const wc = (globalThis as any).__potato.ctx.windows.focused().activeTab.wc;
    const ext = wc.mainFrame.frames.find((f: any) => f.origin === 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai');
    return ext.executeJavaScript(js);
  }, js);
}

const downloads = () => b.app.evaluate(() => (globalThis as any).__potato.ctx.downloads.list().map((d: any) => d.filename));
const downloaded = (name: string) => path.join(b.userData, 'Downloads', name);

test('a PDF link opens in the tab, in the built-in viewer', async () => {
  b = await TestBrowser.launch();
  const ui = await b.uiPage();
  const page = await b.goto('https://site.test/', ui);
  await page.click('#pdf');
  await expect.poll(() => b.activeTabUrl()).toBe(PDF);
  await expect.poll(viewer).toEqual({ viewer: true, plugin: true });
  // The title is the PDF's own, so the viewer read the file.
  await expect(ui.getByTestId('tab-title')).toHaveText('Spud Report');
  await expect(ui.getByTestId('omnibox')).toContainText('site.test/files/spud-report.pdf');
  expect((await b.windowState()).tabs[0]).toMatchObject({ security: 'secure', canGoBack: true });
  expect(await downloads()).toEqual([]);
  expect(fs.existsSync(path.join(b.userData, 'Downloads'))).toBe(false);

  // Find in page searches the PDF's text, on both pages.
  await b.cmd('find');
  await ui.getByTestId('find-input').fill('tuber');
  await expect(ui.getByTestId('find-count')).toHaveText('1/3');
  await ui.getByTestId('find-input').press('Escape');

  // The viewer has its own zoom; the browser's would only show a number and change the site's zoom.
  await b.cmd('zoomIn');
  await expect(ui.getByTestId('omnibox')).not.toContainText('%');
  expect(await b.app.evaluate(() => (globalThis as any).__potato.ctx.db.getSiteSetting('site.test', 'zoom'))).toBeNull();

  // The viewer's download button saves the file, and so does Save Page As.
  await inViewer(`document.querySelector('pdf-viewer').shadowRoot.querySelector('viewer-toolbar').shadowRoot
    .querySelector('viewer-download-controls').shadowRoot.querySelector('#save').click()`);
  await expect.poll(() => fs.existsSync(downloaded('spud-report.pdf')) && fs.statSync(downloaded('spud-report.pdf')).size).toBe(
    fs.statSync(path.resolve(__dirname, '../fixtures/sites/site.test/files/spud-report.pdf')).size,
  );
  await b.cmd('savePage');
  await expect.poll(() => fs.existsSync(downloaded('spud-report (1).pdf'))).toBe(true);
  expect(await b.activeTabUrl()).toBe(PDF);
});

test('a PDF sent as an attachment downloads', async () => {
  b = await TestBrowser.launch();
  const ui = await b.uiPage();
  const page = await b.goto('https://site.test/', ui);
  await page.click('#pdf-attachment');
  await expect.poll(() => fs.existsSync(downloaded('spud-report.pdf'))).toBe(true);
  await expect(ui.getByTestId('downloads-button')).toBeVisible();
  expect(await b.activeTabUrl()).toBe('https://site.test/');
  await expect(ui.getByTestId('tab-title')).toHaveText('Site Test Home');
});

test('PDFs open in private windows and in embedded frames, and come back with the session', async () => {
  b = await TestBrowser.launch({ settings: { startup: 'restore' } });
  const ui = await b.uiPage();
  // Pages can embed PDFs too.
  const embedding = await b.goto('https://site.test/pdf-embed', ui);
  await expect(embedding.locator('#viewer')).toContainText('pdfViewerEnabled=true');
  await expect
    .poll(() => b.app.evaluate(() => (globalThis as any).__potato.ctx.windows.focused().activeTab.wc.mainFrame.framesInSubtree.filter((f: any) => f.origin.startsWith('chrome-extension://')).length))
    .toBe(2);
  await b.goto(PDF, ui);
  await expect.poll(viewer).toEqual({ viewer: true, plugin: true });

  await b.cmd('newPrivateWindow');
  const pui = await b.uiPage();
  await b.goto(PDF, pui);
  await expect.poll(viewer).toEqual({ viewer: true, plugin: true });
  await expect(pui.getByTestId('tab-title')).toHaveText('Spud Report');
  await b.cmd('closeWindow');

  const userData = b.userData;
  await b.close();
  b = await TestBrowser.launch({ userData });
  const ui2 = await b.uiPage();
  await expect.poll(() => b.activeTabUrl()).toBe(PDF);
  await expect.poll(viewer).toEqual({ viewer: true, plugin: true });
  await expect(ui2.getByTestId('tab-title')).toHaveText('Spud Report');
});
