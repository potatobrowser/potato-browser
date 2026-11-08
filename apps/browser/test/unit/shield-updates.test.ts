import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildStylesheet } from '../../src/content/shield/engine';
import { RULES } from '../../src/content/shield/rules';
import { isSafeExtraCss, isSafeSelector, validateRules } from '../../src/content/shield/validate';
import { openRules, publicKeys } from '../../src/main/shield-verify';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

function signed(rules: unknown, opts: { version?: number; format?: number } = {}) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url').toString('base64');
  const json = JSON.stringify(rules);
  const payload = JSON.stringify({ format: opts.format ?? 1, version: opts.version ?? 2_000_000_000, hash: crypto.createHash('sha256').update(json).digest('hex'), rules });
  return { envelope: { payload, signature: crypto.sign(null, Buffer.from(payload), privateKey).toString('base64') }, keys: publicKeys([raw]) };
}

describe('downloaded AI Shield rules', () => {
  it('accept the whole shipped catalog unchanged', () => {
    expect(validateRules(clone(RULES))).toEqual(clone(RULES));
  });

  it('carry the version in rules.lock.json that was bumped for exactly these rules', () => {
    const lock = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../src/content/shield/rules.lock.json'), 'utf8'));
    const hash = crypto.createHash('sha256').update(JSON.stringify(RULES)).digest('hex');
    // Changed rules.ts? Run: node apps/browser/scripts/shield-rules.mjs --bump
    expect(lock.hash, 'rules.ts changed without node apps/browser/scripts/shield-rules.mjs --bump').toBe(hash);
    expect(Number.isSafeInteger(lock.version)).toBe(true);
  });

  it('refuse selectors and raw CSS that could escape their rule or load anything', () => {
    expect(isSafeSelector('[data-attnms]')).toBe(true);
    expect(isSafeSelector('a[href*="udm=50"]:not(:has(img))')).toBe(true);
    for (const bad of ['a{} body', 'a; b', '@import x', 'a\\7d', '', 'x'.repeat(700), '.one /*', '*/ .two']) expect(isSafeSelector(bad), bad).toBe(false);
    expect(isSafeSelector('a[href^="https://duck.ai"]')).toBe(true);
    expect(isSafeExtraCss('body.rufus-docked-left { padding-left: 0 !important; margin-left: 0 !important; }')).toBe(true);
    for (const bad of [
      'a { background: url(https://evil.example/x) }',
      'a { background-image: image-set("x.png" 1x) }',
      'input[value^="a"] { content: "x" }',
      'a { color: red } b { color: blue }',
      '@media screen { a { color: red } }',
      'a { color: red /* } b { */ }',
    ]) {
      expect(isSafeExtraCss(bad), bad).toBe(false);
    }
    const sheet = buildStylesheet([{ id: 'x', name: 'X', css: ['#ok', 'a{} body { background: url(//evil) }', '.one /*', '*/ .two', '#also-ok'], extraCss: ['a { background: url(//evil) }'] }]);
    expect(sheet).toContain('#ok { display: none !important; }');
    expect(sheet).toContain('#also-ok { display: none !important; }');
    expect(sheet).not.toContain('evil');
    expect(sheet).not.toContain('/*');
  });

  it('refuse malformed rules as a whole', () => {
    const base = clone(RULES);
    const cases: ((r: any[]) => void)[] = [
      (r) => (r[0].id = 'Bad Id'),
      (r) => r.push(clone(r[0])),
      (r) => (r[0].hosts = ['evil.com/path']),
      (r) => (r[0].features = []),
      (r) => (r[0].features[0].match = [{ candidates: 'div', texts: [] }]),
      (r) => (r[0].features[0].match = [{ candidates: 'div', patterns: ['(unclosed'] }]),
      (r) => (r[0].features[0].block = ['google']),
      (r) => (r[0].features[0].placeholders = [{ selector: 'input', patterns: ['x'], replacement: 'y'.repeat(200) }]),
    ];
    for (const mutate of cases) {
      const r = clone(base);
      mutate(r);
      expect(validateRules(r), mutate.toString()).toBeNull();
    }
    expect(validateRules([])).toBeNull();
    expect(validateRules('nope')).toBeNull();
  });

  it('open only with a valid signature from a trusted key', () => {
    const extra = [...clone(RULES), { id: 'new-site', site: 'New', hosts: ['new.example'], features: [{ id: 'chat', name: 'Chat', css: ['#ai'] }] }];
    const { envelope, keys } = signed(extra);
    const opened = openRules(envelope, keys);
    expect(opened?.version).toBe(2_000_000_000);
    expect(opened?.rules.at(-1)?.id).toBe('new-site');
    // Another key, a changed byte, or the release keys alone: refused.
    expect(openRules(envelope, signed(extra).keys)).toBeNull();
    expect(openRules({ ...envelope, payload: envelope.payload.replace('"Chat"', '"Chats"') }, keys)).toBeNull();
    expect(openRules(envelope)).toBeNull();
    expect(openRules({ payload: envelope.payload, signature: 'AAAA' }, keys)).toBeNull();
    expect(openRules(null, keys)).toBeNull();
  });

  it('refuse a future format and signed rules that fail validation', () => {
    expect(openRules(signed(clone(RULES), { format: 2 }).envelope, signed(clone(RULES), { format: 2 }).keys)).toBeNull();
    const bad = clone(RULES) as any[];
    bad[0].features[0].css = ['a{} b'];
    const s = signed(bad);
    expect(openRules(s.envelope, s.keys)).toBeNull();
  });
});
