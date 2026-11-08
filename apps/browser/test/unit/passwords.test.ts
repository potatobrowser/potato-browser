import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { parseCsv, passwordCsv, readPasswordCsv, CsvError } from '../../src/main/passwords/csv';
import { matchKind, normalizeOrigin, pickPasswords, siteOfOrigin } from '../../src/main/passwords/match';
import { LoginStore, type Cipher } from '../../src/main/passwords/store';

describe('csv', () => {
  it('parses quotes, doubled quotes, line breaks in fields, CRLF and a BOM', () => {
    const text = '﻿a,b,c\r\n"x, y","say ""hi""","line1\nline2"\r\n,,\n"",z,\n';
    expect(parseCsv(text)).toEqual([
      ['a', 'b', 'c'],
      ['x, y', 'say "hi"', 'line1\nline2'],
      ['', '', ''],
      ['', 'z', ''],
    ]);
  });

  it('round-trips through the export format', () => {
    const logins = [
      { origin: 'https://a.test', username: 'ann', password: 'p,"q"\n', note: '  spaced  ' },
      { origin: 'http://b.test:8080', username: '', password: '=SUM(1)', note: '' },
    ];
    const back = readPasswordCsv(passwordCsv(logins));
    expect(back.source).toBe('Chrome');
    expect(back.logins).toEqual(logins);
  });

  it('reads a Chrome export and skips app and empty entries', () => {
    const r = readPasswordCsv(
      [
        'name,url,username,password,note',
        'example.com,https://example.com/login?next=/,alice,pw1,',
        'app,android://AbC@com.example.app/,bob,pw2,',
        'nopass,https://nopass.test/,carol,,',
        'example.com,https://example.com/other,alice,pw3,',
      ].join('\n'),
    );
    expect(r.source).toBe('Chrome');
    expect(r.logins).toEqual([{ origin: 'https://example.com', username: 'alice', password: 'pw1', note: '' }]);
    expect(r.skipped).toEqual({ noPassword: 1, noWebsite: 1, archived: 0, duplicates: 1 });
  });

  it('reads Safari, Firefox and 1Password exports', () => {
    const safari = readPasswordCsv('Title,URL,Username,Password,Notes,OTPAuth\nShop (alice),https://shop.test/,alice@x.test,s3cret,"door code 1234",otpauth://totp/x\n');
    expect(safari.source).toBe('Safari');
    expect(safari.logins).toEqual([{ origin: 'https://shop.test', username: 'alice@x.test', password: 's3cret', note: 'door code 1234' }]);

    const firefox = readPasswordCsv(
      '"url","username","password","httpRealm","formActionOrigin","guid","timeCreated","timeLastUsed","timePasswordChanged"\n' +
        '"https://mail.test","bob","fx-pw","","https://mail.test","{abc}","1700000000000","1700000000000","1700000000000"\n' +
        '"http://router.local:8080","admin","admin","Router","","{def}","1","1","1"\n',
    );
    expect(firefox.source).toBe('Firefox');
    expect(firefox.logins.map((l) => [l.origin, l.username])).toEqual([
      ['https://mail.test', 'bob'],
      ['http://router.local:8080', 'admin'],
    ]);

    const onePassword = readPasswordCsv(
      'Title,Url,Username,Password,OTPAuth,Favorite,Archived,Tags,Notes\n' +
        'Bank,bank.test,carol,b4nk,,false,false,finance,"Security question: potato"\n' +
        'Old,https://old.test,carol,old,,false,true,,\n' +
        'Wifi,,,,,false,false,,"no login"\n',
    );
    expect(onePassword.source).toBe('1Password');
    expect(onePassword.logins).toEqual([{ origin: 'https://bank.test', username: 'carol', password: 'b4nk', note: 'Security question: potato' }]);
    expect(onePassword.skipped).toMatchObject({ archived: 1, noPassword: 1 });
  });

  it('reads bare hosts with ports', () => {
    const r = readPasswordCsv('url,username,password\nlocalhost:3000,dev,pw\nrouter.local:8080/admin,admin,pw2\n');
    expect(r.logins.map((l) => l.origin)).toEqual(['https://localhost:3000', 'https://router.local:8080']);
  });

  it('takes the first web address from cells with several, and other header names', () => {
    const r = readPasswordCsv('folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n,,login,X,,,0,"androidapp://x,https://x.test/a",dan,pw,\n');
    expect(r.source).toBe('Bitwarden');
    expect(r.logins).toEqual([{ origin: 'https://x.test', username: 'dan', password: 'pw', note: '' }]);
  });

  it('rejects files without url and password columns', () => {
    expect(() => readPasswordCsv('a,b\n1,2\n')).toThrow(CsvError);
    expect(() => readPasswordCsv('')).toThrow(CsvError);
  });
});

describe('matching', () => {
  it('normalizes origins', () => {
    expect(normalizeOrigin('https://Example.COM:443/login?x=1')).toBe('https://example.com');
    expect(normalizeOrigin('example.com/login')).toBe('https://example.com');
    expect(normalizeOrigin('http://a.test:8080/')).toBe('http://a.test:8080');
    expect(normalizeOrigin('localhost:3000')).toBe('https://localhost:3000');
    expect(normalizeOrigin('example.com:8443/login')).toBe('https://example.com:8443');
    expect(normalizeOrigin('mailto:a@b.test')).toBeNull();
    expect(normalizeOrigin('about:blank')).toBeNull();
    expect(normalizeOrigin('android://x@com.app/')).toBeNull();
    expect(normalizeOrigin('javascript:alert(1)')).toBeNull();
    expect(normalizeOrigin('')).toBeNull();
  });

  it('matches the same origin, http upgraded to https, and the same site', () => {
    expect(matchKind('https://example.com', 'https://example.com')).toBe('exact');
    expect(matchKind('http://example.com', 'https://example.com')).toBe('exact');
    expect(matchKind('https://login.example.com', 'https://www.example.com')).toBe('site');
    expect(matchKind('https://login.example.co.uk', 'https://example.co.uk')).toBe('site');
  });

  it('never offers a password to another site, a downgraded page or a neighbour on a shared host', () => {
    expect(matchKind('https://example.com', 'http://example.com')).toBeNull();
    expect(matchKind('https://example.com', 'https://example.org')).toBeNull();
    expect(matchKind('https://example.com', 'https://notexample.com')).toBeNull();
    expect(matchKind('https://alice.github.io', 'https://mallory.github.io')).toBeNull();
    expect(matchKind('https://a.blogspot.com', 'https://b.blogspot.com')).toBeNull();
    expect(matchKind('https://example.com', 'https://example.com:8443')).toBeNull();
    expect(matchKind('http://192.168.1.1', 'http://192.168.1.2')).toBeNull();
    expect(matchKind('http://192.168.1.1', 'https://192.168.1.1')).toBe('exact');
    expect(matchKind('https://example.com', 'null')).toBeNull();
    expect(siteOfOrigin('https://alice.github.io')).toBe('alice.github.io');
  });

  it('picks the new password of login, sign-up and change forms', () => {
    const f = (...v: string[]) => v.map((value) => ({ value, autocomplete: '' }));
    expect(pickPasswords(f('a'))).toEqual({ password: 'a', current: null });
    expect(pickPasswords(f('a', 'a'))).toEqual({ password: 'a', current: null });
    // A password and a PIN look the same as a current and a new password: no guess.
    expect(pickPasswords(f('pw', 'pin'))).toBeNull();
    expect(pickPasswords(f('old', 'new', 'new'))).toEqual({ password: 'new', current: 'old' });
    expect(pickPasswords(f('a', 'b', 'c'))).toBeNull();
    expect(pickPasswords(f('', ''))).toBeNull();
    expect(
      pickPasswords([
        { value: 'new', autocomplete: 'new-password' },
        { value: 'old', autocomplete: 'current-password' },
      ]),
    ).toEqual({ password: 'new', current: 'old' });
  });
});

/** AES like safeStorage, with a fixed key: the store only sees opaque bytes. */
function testCipher(): Cipher & { calls: number } {
  const key = crypto.randomBytes(32);
  const c = {
    calls: 0,
    async encrypt(plain: string) {
      c.calls++;
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },
    async decrypt(data: Buffer) {
      c.calls++;
      const d = crypto.createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
      d.setAuthTag(data.subarray(12, 28));
      return { text: Buffer.concat([d.update(data.subarray(28)), d.final()]).toString('utf8') };
    },
  };
  return c;
}

describe('login store', () => {
  it('keeps passwords and notes encrypted and finds logins by site', async () => {
    const db = new DatabaseSync(':memory:');
    const cipher = testCipher();
    const store = new LoginStore(db, cipher);
    const id = await store.add({ origin: 'https://login.example.com', username: 'alice', password: 'hunter2', note: 'pin 0000' });
    await store.add({ origin: 'https://other.test', username: 'bob', password: 'pw' });
    const raw = JSON.stringify(db.prepare('SELECT * FROM logins').all(), (_k, v) => (v instanceof Uint8Array ? Buffer.from(v).toString('latin1') : v));
    expect(raw).not.toContain('hunter2');
    expect(raw).not.toContain('pin 0000');
    expect(raw).toContain('alice');

    expect(store.forSite('example.com').map((l) => l.username)).toEqual(['alice']);
    expect(await store.password(id)).toBe('hunter2');
    expect(await store.note(id)).toBe('pin 0000');
    expect(store.get(id)).toMatchObject({ host: 'login.example.com', hasNote: true, timesUsed: 0 });

    await expect(store.add({ origin: 'https://login.example.com', username: 'alice', password: 'x' })).rejects.toThrow('already saved');
    await store.update(id, { password: 'new', note: '' });
    expect(await store.password(id)).toBe('new');
    expect(store.get(id)!.hasNote).toBe(false);
    store.markUsed(id);
    expect(store.get(id)!.timesUsed).toBe(1);
    store.remove(id);
    expect(store.count()).toBe(1);
  });

  it('imports new logins and never overwrites saved ones', async () => {
    const store = new LoginStore(new DatabaseSync(':memory:'), testCipher());
    await store.add({ origin: 'https://a.test', username: 'ann', password: 'mine' });
    await store.add({ origin: 'https://b.test', username: 'ben', password: 'same' });
    const res = await store.import([
      { origin: 'https://a.test', username: 'ann', password: 'theirs', note: '' },
      { origin: 'https://b.test', username: 'ben', password: 'same', note: '' },
      { origin: 'https://c.test', username: 'cat', password: 'new', note: 'n' },
    ]);
    expect(res).toEqual({ added: 1, same: 1, kept: 1 });
    expect(await store.password(store.find('https://a.test', 'ann')!.id)).toBe('mine');
    expect(await store.note(store.find('https://c.test', 'cat')!.id)).toBe('n');
  });
});
