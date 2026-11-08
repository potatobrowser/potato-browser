import { expect, test } from '@playwright/test';
import { TestBrowser } from './support/browser';

let b: TestBrowser;
test.afterEach(async () => b?.close());

const FORBIDDEN = [
  'LanguageModel',
  'Summarizer',
  'Writer',
  'Rewriter',
  'Proofreader',
  'Translator',
  'LanguageDetector',
  'Classifier',
  'ai',
  'SpeechRecognition',
  'webkitSpeechRecognition',
];

test('no built-in AI APIs exist in pages, iframes or workers', async () => {
  b = await TestBrowser.launch();
  const page = await b.goto('https://site.test/engine');
  const report = await page.evaluate((names) => (window as any).engineReport(names), FORBIDDEN);
  for (const scope of ['main', 'frame', 'worker'] as const) {
    for (const name of FORBIDDEN) expect(report[scope][name], `${scope}.${name}`).toBe('undefined');
  }
  expect(report.ml).toBe(false);
  // The page cannot reach Node or Electron either.
  expect(report.electron).toBe('undefined/undefined');
});

test('identifies as a plain Chromium browser', async () => {
  b = await TestBrowser.launch();
  const page = await b.goto('https://site.test/');
  const ua = await page.evaluate(() => navigator.userAgent);
  expect(ua).toMatch(/Chrome\/\d+\.0\.0\.0 Safari\/537\.36$/);
  expect(ua).not.toMatch(/Electron|Potato/i);
  const brands = await page.evaluate(() => (navigator as any).userAgentData?.brands.map((x: any) => x.brand).join(','));
  expect(brands).not.toMatch(/Electron/);
});

// The sign-in request header is set in webRequest, which the fixture proxy bypasses; the unit test covers it.
test('Google sign-in pages are not patched to pose as another browser', async () => {
  b = await TestBrowser.launch();
  const signIn = await b.goto('https://accounts.google.com/');
  const nav = await signIn.evaluate(() => ({
    ua: navigator.userAgent,
    native: Object.getOwnPropertyDescriptor(Navigator.prototype, 'userAgent')!.get!.toString().includes('[native code]'),
    brands: (navigator as any).userAgentData?.brands.map((x: any) => x.brand).join(','),
  }));
  expect(nav.ua).not.toMatch(/Firefox/);
  expect(nav.native).toBe(true);
  expect(nav.brands).toMatch(/Chromium/);
});

test('the About page reports the engine and what is switched off', async () => {
  b = await TestBrowser.launch();
  await b.cmd('showAbout');
  const about = await b.tabPage('potato://settings/');
  await expect(about.getByTestId('about-version')).toContainText(/Version \d+\.\d+\.\d+ · Chromium \d+/);
  const report = about.getByTestId('engine-report');
  for (const f of ['AIPromptAPI', 'AISummarizationAPI', 'TranslationAPI', 'LanguageDetectionAPI', 'AIWriterAPI', 'AIRewriterAPI']) {
    await expect(report).toContainText(f);
  }
});

test('internal pages expose their API only to themselves', async () => {
  b = await TestBrowser.launch();
  const web = await b.goto('https://site.test/');
  expect(await web.evaluate(() => typeof (window as any).potato)).toBe('undefined');
  await b.cmd('showHistory');
  const history = await b.tabPage('potato://history/');
  expect(await history.evaluate(() => typeof (window as any).potato?.call)).toBe('function');
});

test('every AI Shield selector is valid CSS in this Chromium', async () => {
  const { RULES } = await import('../../src/content/shield/rules');
  const selectors = RULES.flatMap((r) =>
    r.features.flatMap((f) => [...(f.css ?? []), ...(f.match ?? []).map((m) => m.candidates), ...(f.placeholders ?? []).map((p) => p.selector)]),
  );
  b = await TestBrowser.launch();
  const page = await b.goto('https://site.test/');
  const invalid = await page.evaluate((list) => {
    const bad: string[] = [];
    for (const s of list) {
      try {
        document.querySelector(s);
      } catch {
        bad.push(s);
      }
    }
    return bad;
  }, selectors);
  expect(selectors.length).toBeGreaterThan(150);
  expect(invalid).toEqual([]);
});
