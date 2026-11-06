import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { decodeCommentToolsKey } from '../../src/content/flags/adapters/linkedin';
import { decodeCommentId } from '../../src/content/flags/adapters/facebook';
import { errorPageHtml } from '../../src/main/errorpage';
import { fromWebkitTime } from '../../src/main/importers/common';
import { parseProfilesIni } from '../../src/main/importers/firefox';
import { parseXmlPlist } from '../../src/main/importers/safari';
import { sanitizeSettings } from '../../src/main/settings';

vi.mock('electron', () => ({ app: {}, shell: {} }));

describe('importer parsers', () => {
  it('reads Firefox profiles.ini', () => {
    const ini = '[General]\nStartWithLastProfile=1\n\n[Profile1]\nName=work\nIsRelative=0\nPath=/abs/work\n\n[Profile0]\nName=default-release\nIsRelative=1\nPath=Profiles/x.default-release\n\n[Install123]\nDefault=Profiles/x\n';
    expect(parseProfilesIni(ini, '/root')).toEqual([
      { name: 'work', path: '/abs/work' },
      { name: 'default-release', path: path.join('/root', 'Profiles/x.default-release') },
    ]);
  });

  it('parses XML property lists', () => {
    const xml = `<?xml version="1.0"?><!DOCTYPE plist><plist version="1.0"><dict>
      <key>Title</key><string>Tom &amp; Jerry &#x263A;</string><key>N</key><integer>42</integer><key>R</key><real>1.5</real>
      <key>T</key><true/><key>F</key><false/><key>E</key><string/><key>D</key><data>AAAA</data>
      <key>List</key><array><dict><key>a</key><string>b</string></dict><array/></array></dict></plist>`;
    expect(parseXmlPlist(xml)).toEqual({ Title: 'Tom & Jerry ☺', N: 42, R: 1.5, T: true, F: false, E: '', D: null, List: [{ a: 'b' }, []] });
  });

  it('converts WebKit timestamps', () => {
    const ms = Date.UTC(2026, 0, 1);
    expect(fromWebkitTime(String(BigInt(ms + 11_644_473_600_000) * 1000n))).toBe(ms);
    expect(fromWebkitTime(null)).toBe(0);
    expect(fromWebkitTime('0')).toBe(0);
  });
});

describe('platform id decoders', () => {
  it('decodes LinkedIn commentTools keys (research test vectors)', () => {
    expect(decodeCommentToolsKey('EgsIhsDR7MbT+OrPAQ-replaceableCommentTools')).toBe('ugcPost:7488062648685834243');
    expect(decodeCommentToolsKey('EgsIgoDIsJ7StI3QAQ-replaceableCommentTools')).toBe('ugcPost:7497764716677758977');
    expect(decodeCommentToolsKey('CgsIgMC6+KjStI3QAQ-replaceableCommentTools')).toBe('activity:7497764718095323136');
    expect(decodeCommentToolsKey('garbage')).toBeNull();
  });

  it('decodes Facebook comment ids', () => {
    expect(decodeCommentId('Y29tbWVudDoxMjA2OTAzNjAxNDgzOTYwXzc3OTIzNDI4MTE0NjkzNQ%3D%3D')).toEqual({
      post: '1206903601483960',
      comment: '779234281146935',
    });
    expect(decodeCommentId('779234281146935')).toEqual({ comment: '779234281146935' });
    expect(decodeCommentId('%%%')).toBeNull();
  });
});

describe('settings and error pages', () => {
  it('falls back to defaults for anything invalid', () => {
    const s = sanitizeSettings({
      startup: 'nonsense',
      searchEngine: 'altavista',
      flags: { mode: 'hide', threshold: 0, disabledPlatforms: ['reddit', 'myspace'] },
      shield: { disabledSites: ['Google.com', 'google.com', 5] },
      installId: 'not-hex',
    });
    expect(s.startup).toBe('restore');
    expect(s.searchEngine).toBe('duckduckgo');
    expect(s.flags).toMatchObject({ mode: 'hide', threshold: 3, disabledPlatforms: ['reddit'] });
    expect(s.shield.disabledSites).toEqual(['google.com']);
    expect(s.installId).toMatch(/^[0-9a-f]{32}$/);
    expect(sanitizeSettings(null).shield.enabled).toBe(true);
  });

  it('escapes hostile URLs on error pages', () => {
    const html = errorPageHtml('https://x.test/"><script>alert(1)</script>', -105, 'ERR_NAME_NOT_RESOLVED');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('potato://action/retry');
  });
});

describe('downloads', () => {
  it('picks a free file name', async () => {
    const { uniquePath } = await import('../../src/main/downloads');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'potato-dl-'));
    fs.writeFileSync(path.join(dir, 'a.pdf'), '');
    fs.writeFileSync(path.join(dir, 'a (1).pdf'), '');
    expect(uniquePath(dir, 'a.pdf')).toBe(path.join(dir, 'a (2).pdf'));
    const hostile = uniquePath(dir, '../../etc/passwd');
    expect(path.dirname(hostile)).toBe(dir);
    expect(path.basename(hostile)).not.toContain('/');
    expect(uniquePath(dir, '')).toBe(path.join(dir, 'download'));
  });
});
