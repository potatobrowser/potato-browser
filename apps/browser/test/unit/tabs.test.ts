import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseSession, persistable, toDisk, trimHistory, type TabHistory } from '../../src/main/sessionfile';
import { sanitizeSettings } from '../../src/main/settings';
import { minuteMs, sleepBlocker, type SleepInfo } from '../../src/main/sleep';

vi.mock('electron', () => ({ app: {} }));

const entry = (url: string, title = '') => ({ url, title });

describe('session file', () => {
  it('reads the format before 0.8, where tabs are only addresses', () => {
    const s = parseSession({
      windows: [
        { bounds: { x: 1, y: 2, width: 900, height: 700 }, tabs: ['https://a.test/', 7, 'noai://settings/', ''], active: 2 },
        { tabs: [], active: 0 },
        { tabs: 'nope' },
      ],
    });
    expect(s.restore).toBeUndefined();
    expect(s.windows).toHaveLength(1);
    expect(s.windows[0]!.bounds).toEqual({ x: 1, y: 2, width: 900, height: 700 });
    expect(s.windows[0]!.tabs).toEqual([
      { entries: [entry('https://a.test/')], index: 0 },
      { entries: [entry('potato://settings/')], index: 0 },
    ]);
    // The active tab is still the settings page, after the malformed tab before it was dropped.
    expect(s.windows[0]!.active).toBe(1);
  });

  it('writes addresses where older versions read them and history beside them', () => {
    const tabs: TabHistory[] = [
      { entries: [entry('https://a.test/1', 'One'), entry('https://a.test/2', 'Two')], index: 1 },
      { entries: [entry('potato://settings/', 'Settings')], index: 0 },
    ];
    const disk = toDisk({ windows: [{ active: 1, tabs }], restore: true });
    expect(disk.windows[0]!.tabs).toEqual(['https://a.test/2', 'potato://settings/']);
    expect(disk.restore).toBe(true);
    expect(parseSession(JSON.parse(JSON.stringify(disk)))).toEqual({ windows: [{ active: 1, tabs }], restore: true });
  });

  it('ignores a history that is malformed or belongs to another address', () => {
    const s = parseSession({
      windows: [
        {
          tabs: ['https://a.test/', 'https://b.test/', 'https://c.test/'],
          active: 0,
          history: [
            { index: 0, entries: [entry('https://elsewhere.test/', 'X')] },
            { index: 3, entries: [entry('https://b.test/')] },
            { index: 0, entries: [{ title: 'no url' }] },
          ],
        },
      ],
    });
    expect(s.windows[0]!.tabs.map((t) => t.entries)).toEqual([[entry('https://a.test/')], [entry('https://b.test/')], [entry('https://c.test/')]]);
  });

  it('caps windows at 100 tabs and survives garbage', () => {
    const tabs = Array.from({ length: 150 }, (_, i) => `https://a.test/${i}`);
    expect(parseSession({ windows: [{ tabs, active: 140 }] }).windows[0]).toMatchObject({ active: 99 });
    expect(parseSession({ windows: [{ tabs, active: 140 }] }).windows[0]!.tabs).toHaveLength(100);
    for (const raw of [null, 'x', 42, { windows: 'x' }, { windows: [null, 5] }]) expect(parseSession(raw)).toEqual({ windows: [] });
  });

  it('keeps entries around the current one, without page state or pages that cannot load again', () => {
    const entries = Array.from({ length: 40 }, (_, i) => ({ url: `https://a.test/${i}`, title: `T${i}`, pageState: 'AAAA' }));
    const h = trimHistory({ entries, index: 30 })!;
    expect(h.entries[0]!.url).toBe('https://a.test/10');
    expect(h.entries.at(-1)!.url).toBe('https://a.test/35');
    expect(h.entries[h.index]!.url).toBe('https://a.test/30');
    expect(h.entries.some((e) => 'pageState' in e)).toBe(false);

    const mixed = trimHistory({
      entries: [entry('data:text/html,hi'), entry('https://a.test/'), entry('blob:https://a.test/x'), entry('potato://action/retry'), entry('https://a.test/now')],
      index: 4,
    })!;
    expect(mixed).toEqual({ entries: [entry('https://a.test/'), entry('https://a.test/now')], index: 1 });
    expect(trimHistory({ entries: [entry('https://a.test/'), entry('data:text/plain,x')], index: 1 })).toBeNull();
    expect(trimHistory(null)).toBeNull();
  });

  it('knows which addresses load again on the next launch', () => {
    for (const u of ['https://a.test/', 'http://a.test/x', 'file:///tmp/a.html', 'potato://settings/', 'view-source:https://a.test/', 'about:blank']) {
      expect(persistable(u), u).toBe(true);
    }
    for (const u of ['', 'data:text/html,x', 'blob:https://a.test/1', 'chrome-error://chromewebdata/', 'javascript:1', 'potato://action/retry', `https://a.test/${'x'.repeat(9000)}`]) {
      expect(persistable(u), u).toBe(false);
    }
  });
});

describe('tab sleeping', () => {
  const now = 10_000_000;
  const after = 15 * 60_000;
  const idle: SleepInfo = {
    loaded: true,
    active: false,
    lastActive: now - after - 1,
    reloadable: true,
    loading: false,
    audible: false,
    lastAudible: 0,
    capturing: false,
    permissionPrompt: false,
    fullscreen: false,
    devTools: false,
    passwords: false,
    notifications: false,
    opener: false,
    refusedSleepAt: 0,
  };

  it('puts a background tab left alone long enough to sleep', () => {
    expect(sleepBlocker(idle, now, after)).toBeNull();
  });

  it.each<[string, Partial<SleepInfo>]>([
    ['not loaded', { loaded: false }],
    ['active', { active: true }],
    ['recently used', { lastActive: now - after + 1000 }],
    ['not reloadable', { reloadable: false }],
    ['loading', { loading: true }],
    ['audio', { audible: true }],
    ['audio', { lastAudible: now - 4 * 60_000 }],
    ['capturing', { capturing: true }],
    ['permission prompt', { permissionPrompt: true }],
    ['fullscreen', { fullscreen: true }],
    ['devtools', { devTools: true }],
    ['passwords', { passwords: true }],
    ['notifications', { notifications: true }],
    ['opener', { opener: true }],
    ['unsaved changes', { refusedSleepAt: now - after + 1000 }],
  ])('stays awake: %s', (reason, patch) => {
    expect(sleepBlocker({ ...idle, ...patch }, now, after)).toBe(reason);
  });

  it('tries again a full period after a page refused to unload', () => {
    expect(sleepBlocker({ ...idle, refusedSleepAt: now - after - 1 }, now, after)).toBeNull();
  });

  it('lets a tab sleep a while after its sound stopped', () => {
    expect(sleepBlocker({ ...idle, lastAudible: now - 6 * 60_000 }, now, after)).toBeNull();
  });

  afterEach(() => {
    delete process.env.POTATO_TEST;
    delete process.env.POTATO_TEST_MINUTE_MS;
  });

  it('shortens minutes only in test runs', () => {
    process.env.POTATO_TEST_MINUTE_MS = '100';
    expect(minuteMs()).toBe(60_000);
    process.env.POTATO_TEST = '1';
    expect(minuteMs()).toBe(100);
  });

  it('offers a fixed set of choices, two hours by default', () => {
    expect(sanitizeSettings({}).tabs.sleepAfter).toBe(120);
    for (const v of [0, 15, 60, 360]) expect(sanitizeSettings({ tabs: { sleepAfter: v } }).tabs.sleepAfter).toBe(v);
    for (const v of [null, 7, '60', -1]) expect(sanitizeSettings({ tabs: { sleepAfter: v } }).tabs.sleepAfter).toBe(120);
  });
});
