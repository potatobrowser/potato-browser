import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { TestBrowser } from './support/browser';

const CSV = path.resolve(__dirname, '../fixtures/passwords');

let b: TestBrowser;
test.afterEach(async () => b?.close());

const logins = () => b.app.evaluate(() => (globalThis as any).__potato.ctx.passwords.store.list());
const passwordOf = (id: number) => b.app.evaluate(({}, i) => (globalThis as any).__potato.ctx.passwords.store.password(i), id);
const seed = (origin: string, username: string, password: string) =>
  b.app.evaluate(({}, l) => (globalThis as any).__potato.ctx.passwords.store.add(l), { origin, username, password });
const popupVisible = () =>
  b.app.evaluate(() => {
    const { ctx } = (globalThis as any).__potato;
    return !!ctx.passwords.popups.get(ctx.windows.focused())?.visible;
  });

async function popupPage(): Promise<Page> {
  await expect.poll(() => b.app.windows().some((p) => p.url().startsWith('potato://autofill/'))).toBe(true);
  const page = b.app.windows().find((p) => p.url().startsWith('potato://autofill/'))!;
  await page.waitForLoadState('domcontentloaded');
  // Clicks in the first half second after the dropdown appears are ignored (clickjacking).
  await page.waitForTimeout(600);
  return page;
}

test('offers to save a password after signing in, and saves it encrypted', async () => {
  b = await TestBrowser.launch();
  const ui = await b.uiPage();
  const page = await b.goto('https://pw.test/login.html', ui);
  await page.fill('#username', 'alice@pw.test');
  await page.fill('#password', 'Spud-123!');
  await page.click('#submit');
  await expect(ui.getByTestId('password-prompt')).toBeVisible();
  await expect(ui.getByTestId('password-prompt')).toContainText('Save password for pw.test?');
  await expect(ui.getByTestId('password-prompt-username')).toHaveValue('alice@pw.test');
  await ui.getByTestId('password-save').click();
  await expect(ui.getByTestId('password-prompt')).toHaveCount(0);

  await expect.poll(logins).toHaveLength(1);
  const [saved] = await logins();
  expect(saved).toMatchObject({ origin: 'https://pw.test', username: 'alice@pw.test' });
  expect(await passwordOf(saved.id)).toBe('Spud-123!');
  // Only ciphertext reaches the profile database.
  const raw = await b.app.evaluate(() => {
    const rows = (globalThis as any).__potato.ctx.db.db.prepare('SELECT password FROM logins').all();
    return rows.map((r: any) => Buffer.from(r.password).toString('latin1')).join();
  });
  expect(raw.startsWith('v10')).toBe(true);
  expect(raw).not.toContain('Spud-123!');
});

test('fills a saved login from the dropdown, by click and by keyboard', async () => {
  b = await TestBrowser.launch();
  await seed('https://pw.test', 'alice@pw.test', 'Spud-123!');
  await seed('https://accounts.pw.test', 'bob', 'Mash-456');
  const ui = await b.uiPage();
  const page = await b.goto('https://pw.test/login.html', ui);
  await page.click('#username');
  await expect.poll(popupVisible).toBe(true);
  const popup = await popupPage();
  // The exact match first, then the login from another subdomain of the site, with its host.
  await expect(popup.getByTestId('autofill-item')).toHaveCount(2);
  await expect(popup.getByTestId('autofill-item').first()).toContainText('alice@pw.test');
  await expect(popup.getByTestId('autofill-item').nth(1)).toContainText('accounts.pw.test');
  await popup.getByTestId('autofill-item').first().click();
  await expect(page.locator('#password')).toHaveValue('Spud-123!');
  await expect(page.locator('#username')).toHaveValue('alice@pw.test');
  // The page saw the values arrive like typing.
  await expect(page.locator('#state')).toContainText('"password":"Spud-123!"');
  await expect.poll(popupVisible).toBe(false);

  // Keyboard: arrow down, arrow down, Enter picks the second login without submitting the form.
  await page.fill('#username', '');
  await page.fill('#password', '');
  await page.click('#password');
  await page.click('#username');
  await expect.poll(popupVisible).toBe(true);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(popup.locator('[aria-selected=true]')).toContainText('bob');
  await page.waitForTimeout(600);
  await page.keyboard.press('Enter');
  await expect(page.locator('#username')).toHaveValue('bob');
  await expect(page.locator('#password')).toHaveValue('Mash-456');
  expect(page.url()).toBe('https://pw.test/login.html');

  // Typing narrows the list to matching usernames.
  await page.fill('#username', '');
  await page.click('#password');
  await page.click('#username');
  await page.keyboard.type('al');
  await expect(popup.getByTestId('autofill-item')).toHaveCount(1);
  await page.keyboard.type('x');
  await expect.poll(popupVisible).toBe(false);

  // Signing in with the saved password asks nothing and counts the use.
  await page.fill('#username', 'alice@pw.test');
  await page.fill('#password', 'Spud-123!');
  await page.click('#submit');
  await b.tabPage('https://pw.test/welcome');
  await page.waitForTimeout(2500);
  await expect(ui.getByTestId('password-prompt')).toHaveCount(0);
  expect((await logins()).find((l: any) => l.username === 'alice@pw.test').timesUsed).toBeGreaterThan(0);
});

test('passwords stay with their site: other sites, frames and page scripts get nothing', async () => {
  b = await TestBrowser.launch();
  await seed('https://pw.test', 'alice@pw.test', 'Spud-123!');
  const ui = await b.uiPage();

  // A partner page embedding the bank's sign-in: its own form gets nothing, the bank's frame does.
  const partner = await b.goto('https://frame.test/', ui);
  await partner.click('#own-user');
  await partner.waitForTimeout(800);
  expect(await popupVisible()).toBe(false);
  const frame = partner.frameLocator('#login');
  await frame.locator('#username').click();
  await expect.poll(popupVisible).toBe(true);
  // The dropdown sits under the field inside the frame (60px margin, 4px border).
  const bounds = await b.app.evaluate(() => {
    const { ctx } = (globalThis as any).__potato;
    const win = ctx.windows.focused();
    const view = ctx.passwords.popups.get(win).view;
    return { popup: view.getBounds(), tab: win.activeTab.view.getBounds() };
  });
  // Playwright's box for elements in frames leaves out the iframe border, so add it up here.
  const iframe = (await partner.locator('#login').boundingBox())!;
  const inner = await frame.locator('#username').evaluate((el) => el.getBoundingClientRect().toJSON());
  const field = { x: iframe.x + 4 + inner.x, y: iframe.y + 4 + inner.y };
  expect(Math.abs(bounds.popup.x + 8 - (bounds.tab.x + field.x))).toBeLessThan(2);
  expect(Math.abs(bounds.popup.y + 8 - (bounds.tab.y + field.y + inner.height + 2))).toBeLessThan(2);
  const popup = await popupPage();
  await popup.getByTestId('autofill-item').first().click();
  await expect(frame.locator('#password')).toHaveValue('Spud-123!');
  await expect(partner.locator('#own-pass')).toHaveValue('');

  // Script on the bank's own page cannot pick a login for the user. focus() does not open the
  // dropdown; once the user opens it, a pick right after it appeared or moved is ignored (a page
  // can move a field so the dropdown lands under the pointer).
  const sneaky = await b.goto('https://pw.test/attack.html', ui);
  const pickNow = () =>
    b.app.evaluate(() => {
      const { ctx } = (globalThis as any).__potato;
      ctx.passwords.popupCommand(ctx.windows.focused(), { type: 'autofill.pick', index: 0 });
    });
  await sneaky.click('body');
  await sneaky.waitForTimeout(300);
  await sneaky.evaluate(() => document.getElementById('password')!.focus());
  await sneaky.waitForTimeout(800);
  expect(await popupVisible()).toBe(false);
  await sneaky.click('#username');
  await expect.poll(popupVisible).toBe(true);
  await pickNow();
  await sneaky.waitForTimeout(400);
  await expect(sneaky.locator('#password')).toHaveValue('');
  await sneaky.waitForTimeout(600);
  await sneaky.evaluate(() => {
    document.getElementById('username')!.style.marginTop = '40px';
    window.dispatchEvent(new Event('scroll'));
  });
  await sneaky.waitForTimeout(200);
  await pickNow();
  await sneaky.waitForTimeout(400);
  await expect(sneaky.locator('#password')).toHaveValue('');
  await sneaky.evaluate(() => (window as any).tryToSteal());
  await expect(sneaky.locator('#stolen')).toHaveText('nothing');

  // Only the passwords page reads saved passwords; other internal pages get at most the count.
  await b.cmd('newTab');
  const ntp = await b.tabPage('potato://newtab/');
  const tryCall = (m: string) => ntp.evaluate((method) => (window as any).potato.call(method).then(() => 'ok', () => 'denied'), m);
  expect(await tryCall('passwords.list')).toBe('denied');
  expect(await tryCall('passwords.count')).toBe('denied');

  // http pages never get passwords saved on https.
  const plain = await b.goto('http://pw.test/login.html', ui);
  await plain.click('#username');
  await plain.waitForTimeout(800);
  expect(await popupVisible()).toBe(false);
});

test('no prompt after a failed sign-in; prompts after single page app and two-step sign-ins', async () => {
  b = await TestBrowser.launch();
  const ui = await b.uiPage();

  const fail = await b.goto('https://pw.test/fail.html', ui);
  await fail.fill('#username', 'carol');
  await fail.fill('#password', 'wrong');
  await fail.click('#submit');
  await fail.waitForTimeout(3500);
  await expect(ui.getByTestId('password-prompt')).toHaveCount(0);

  // Single page app: no navigation, the sign-in form goes away. Showing the password is no sign-in.
  const spa = await b.goto('https://pw.test/spa.html', ui);
  await spa.fill('#username', 'dora');
  await spa.fill('#password', 'Chips-789');
  await spa.click('#eye');
  await spa.waitForTimeout(1500);
  await expect(ui.getByTestId('password-prompt')).toHaveCount(0);
  await spa.click('#submit');
  await expect(ui.getByTestId('password-prompt')).toBeVisible();
  await expect(ui.getByTestId('password-prompt-username')).toHaveValue('dora');
  await ui.getByTestId('password-dismiss').click();
  await expect(ui.getByTestId('password-prompt')).toHaveCount(0);

  // A single page app that hides the form while it checks, then shows it again with an error.
  const spaFail = await b.goto('https://pw.test/spa-fail.html', ui);
  await spaFail.fill('#username', 'dora');
  await spaFail.fill('#password', 'typo');
  await spaFail.click('#submit');
  await expect(spaFail.locator('#error')).toBeVisible();
  await spaFail.waitForTimeout(3000);
  await expect(ui.getByTestId('password-prompt')).toHaveCount(0);
  // A slow check: the prompt may show while the form is away, and goes when the form comes back.
  const slowFail = await b.goto('https://pw.test/spa-fail.html?wait=3500', ui);
  await slowFail.fill('#username', 'dora');
  await slowFail.fill('#password', 'typo2');
  await slowFail.click('#submit');
  await expect(ui.getByTestId('password-prompt')).toBeVisible();
  await expect(slowFail.locator('#error')).toBeVisible();
  await expect(ui.getByTestId('password-prompt')).toHaveCount(0);

  // Email on one page, password on the next.
  const step1 = await b.goto('https://pw.test/step1.html', ui);
  await step1.fill('#username', 'erin@pw.test');
  await step1.click('#next');
  const step2 = await b.tabPage('https://pw.test/step2');
  await step2.fill('#password', 'Hash-Brown-1');
  await step2.click('#submit');
  await expect(ui.getByTestId('password-prompt-username')).toHaveValue('erin@pw.test');
  // The username can be corrected before saving.
  await ui.getByTestId('password-prompt-username').fill('erin');
  await ui.getByTestId('password-save').click();
  await expect.poll(async () => (await logins()).map((l: any) => l.username)).toEqual(['erin']);
});

test('offers to update a changed password, remembers "never", and private windows save nothing', async () => {
  b = await TestBrowser.launch();
  await seed('https://pw.test', 'alice@pw.test', 'old-pass');
  const ui = await b.uiPage();

  const change = await b.goto('https://pw.test/change.html', ui);
  await change.fill('#current', 'old-pass');
  await change.fill('#new', 'new-pass');
  await change.fill('#confirm', 'new-pass');
  await change.click('#submit');
  await expect(ui.getByTestId('password-prompt')).toContainText('Update the saved password for alice@pw.test on pw.test?');
  await ui.getByTestId('password-save').click();
  await expect.poll(async () => passwordOf((await logins())[0].id)).toBe('new-pass');

  const login = await b.goto('https://pw.test/login.html', ui);
  await login.fill('#username', 'frank@pw.test');
  await login.fill('#password', 'Fries-1');
  await login.click('#submit');
  await ui.getByTestId('password-never').click();
  await expect.poll(async () => (await b.settings()).passwords.neverSave).toEqual(['https://pw.test']);
  const again = await b.goto('https://pw.test/login.html', ui);
  await again.fill('#username', 'frank@pw.test');
  await again.fill('#password', 'Fries-1');
  await again.click('#submit');
  await b.tabPage('https://pw.test/welcome');
  await again.waitForTimeout(3000);
  await expect(ui.getByTestId('password-prompt')).toHaveCount(0);
  await b.updateSettings({ passwords: { neverSave: [] } });

  await b.cmd('newPrivateWindow');
  const pui = await b.uiPage();
  const priv = await b.goto('https://pw.test/login.html', pui);
  // Private windows still fill saved logins.
  await priv.click('#username');
  await expect.poll(popupVisible).toBe(true);
  await priv.fill('#username', 'gina@pw.test');
  await priv.fill('#password', 'Tater-2');
  await priv.click('#submit');
  await b.tabPage('https://pw.test/welcome');
  await priv.waitForTimeout(3000);
  await expect(pui.getByTestId('password-prompt')).toHaveCount(0);
  expect((await logins()).map((l: any) => l.username)).toEqual(['alice@pw.test']);
});

test('imports Chrome, Safari, Firefox and 1Password exports, then shows, edits, deletes and exports', async () => {
  b = await TestBrowser.launch();
  await b.cmd('importPasswords');
  const page = await b.tabPage('potato://passwords/');
  await expect(page.getByTestId('passwords-empty')).toBeVisible();
  const result = page.getByTestId('passwords-import-result');
  // Native file dialogs are answered in the main process; trashing just deletes the copy.
  await b.app.evaluate(({ shell }) => {
    const fs = process.getBuiltinModule('node:fs');
    shell.trashItem = async (f: string) => fs.rmSync(f);
  });
  const importFile = async (name: string) => {
    const copy = path.join(b.userData, name);
    fs.copyFileSync(path.join(CSV, name), copy);
    await b.app.evaluate(({ dialog }, f) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [f] })) as any;
    }, copy);
    await page.getByTestId('passwords-import').click();
    return copy;
  };

  const chromeCopy = await importFile('chrome.csv');
  await expect(result).toHaveText('Imported 2 passwords from Chrome. 2 rows have no website or password and were left out.');
  await page.getByTestId('passwords-import-trash').getByRole('button', { name: 'Move to Trash' }).click();
  await expect(page.getByTestId('passwords-import-trash')).toContainText('is in the Trash');
  expect(fs.existsSync(chromeCopy)).toBe(false);

  await importFile('safari.csv');
  await expect(result).toHaveText('Imported 1 password from Safari. 1 was already saved.');
  await importFile('firefox.csv');
  await expect(result).toHaveText('Imported 1 password from Firefox. 1 login was already saved with a different password; the saved one stays.');
  await importFile('1password.csv');
  await expect(result).toHaveText('Imported 1 password from 1Password. 1 row has no website or password and was left out. 1 archived item was left out.');
  await importFile('not-passwords.csv');
  await expect(result).toContainText('does not look like a password export');

  const rows = page.getByTestId('login-row');
  await expect(rows).toHaveCount(5);
  expect(await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-host')))).toEqual(['bank.test', 'bank.test', 'forum.test', 'mail.test', 'shop.test']);
  const mail = page.locator('[data-host="mail.test"]');
  await mail.getByTestId('login-reveal').click();
  await expect(mail.getByTestId('login-password')).toHaveText('Ch,pass"2');
  await expect(mail).toContainText('two, lines');

  // The imported logins fill on their sites.
  const ui = await b.uiPage();
  await b.cmd('newTab');
  const shop = await b.goto('https://shop.test/', ui);
  await shop.click('#u');
  await expect.poll(popupVisible).toBe(true);
  await (await popupPage()).getByTestId('autofill-item').first().click();
  await expect(shop.locator('#p')).toHaveValue('Sa-pass-1');
  await b.cmd('showPasswords');

  await page.getByTestId('passwords-search').fill('bank');
  await expect(rows).toHaveCount(2);
  const erin = page.locator('[data-testid=login-row]', { hasText: 'erin' });
  await erin.getByTestId('login-edit').click();
  await expect(erin.getByTestId('edit-password')).toHaveValue('1P-pass-1');
  await erin.getByTestId('edit-username').fill('erin@bank.test');
  await erin.getByTestId('edit-password').fill('Edited-1');
  await erin.getByTestId('edit-save').click();
  await expect(erin.getByTestId('login-username')).toHaveText('erin@bank.test');
  await expect(erin.getByTestId('login-password')).toHaveText('Edited-1');

  page.once('dialog', (d) => void d.accept());
  await erin.getByTestId('login-delete').click();
  await expect(rows).toHaveCount(1);
  await page.getByTestId('passwords-search').fill('');

  const out = path.join(b.userData, 'export.csv');
  await b.app.evaluate(({ dialog }, f) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: f })) as any;
  }, out);
  await page.getByTestId('passwords-export').click();
  await expect.poll(() => fs.existsSync(out)).toBe(true);
  expect(fs.statSync(out).mode & 0o777).toBe(0o600);
  const text = fs.readFileSync(out, 'utf8');
  expect(text.split('\r\n')[0]).toBe('name,url,username,password,note');
  expect(text).toContain('mail.test,https://mail.test/,alice,"Ch,pass""2","two, lines\nnote"');
  expect(text).not.toContain('erin');

  await b.cmd('showSettings');
  const settings = await b.tabPage('potato://settings/');
  await expect(settings.locator('#passwords')).toContainText('4 saved.');

  // Saved passwords survive a restart: the Keychain key is the same.
  const userData = b.userData;
  await b.close();
  b = await TestBrowser.launch({ userData });
  const saved = await logins();
  expect(saved).toHaveLength(4);
  expect(await passwordOf(saved.find((l: any) => l.host === 'forum.test').id)).toBe('Fx-pass-1');
});
