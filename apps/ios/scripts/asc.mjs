// App Store Connect chores for TestFlight, with the API key from apps/ios/.env:
//   node scripts/asc.mjs testers          internal group "Team" with every App Store Connect user
//   node scripts/asc.mjs wait <build>     waits until Apple has processed that build number
import { sign } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BUNDLE_ID = 'com.potatobrowser.app';
const root = path.resolve(import.meta.dirname, '..');
const env = { ...readEnv(path.join(root, '.env')), ...process.env };
const keyPath = env.ASC_KEY_PATH ?? path.join(os.homedir(), '.appstoreconnect/private_keys', `AuthKey_${env.ASC_KEY_ID}.p8`);

function readEnv(file) {
  if (!fs.existsSync(file)) return {};
  return Object.fromEntries(
    fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => /^\w+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
  );
}

const b64 = (x) => Buffer.from(x).toString('base64url');
function token() {
  const now = Math.floor(Date.now() / 1000);
  const input = `${b64(JSON.stringify({ alg: 'ES256', kid: env.ASC_KEY_ID, typ: 'JWT' }))}.${b64(JSON.stringify({ iss: env.ASC_ISSUER_ID, iat: now, exp: now + 900, aud: 'appstoreconnect-v1' }))}`;
  return `${input}.${b64(sign('sha256', Buffer.from(input), { key: fs.readFileSync(keyPath, 'utf8'), dsaEncoding: 'ieee-p1363' }))}`;
}

async function api(method, p, body) {
  const res = await fetch(`https://api.appstoreconnect.apple.com${p}`, {
    method,
    headers: { authorization: `Bearer ${token()}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${p}: ${res.status} ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}

async function app() {
  const r = await api('GET', `/v1/apps?filter[bundleId]=${BUNDLE_ID}&limit=1`);
  if (!r.data[0]) throw new Error(`no App Store Connect app for ${BUNDLE_ID}`);
  return r.data[0];
}

async function testers() {
  const a = await app();
  let [group] = (await api('GET', `/v1/betaGroups?filter[app]=${a.id}&filter[isInternalGroup]=true&limit=1`)).data;
  if (!group) {
    group = (
      await api('POST', '/v1/betaGroups', {
        data: { type: 'betaGroups', attributes: { name: 'Team', isInternalGroup: true, hasAccessToAllBuilds: true }, relationships: { app: { data: { type: 'apps', id: a.id } } } },
      })
    ).data;
    console.log(`created internal group ${group.attributes.name}`);
  }
  const have = new Set((await api('GET', `/v1/betaGroups/${group.id}/betaTesters?limit=200`)).data.map((t) => String(t.attributes.email).toLowerCase()));
  let added = 0;
  for (const u of (await api('GET', '/v1/users?limit=200')).data) {
    const email = String(u.attributes.username ?? '');
    if (!email.includes('@') || have.has(email.toLowerCase())) continue;
    await api('POST', '/v1/betaTesters', {
      data: { type: 'betaTesters', attributes: { email, firstName: u.attributes.firstName, lastName: u.attributes.lastName }, relationships: { betaGroups: { data: [{ type: 'betaGroups', id: group.id }] } } },
    });
    added++;
  }
  console.log(`internal TestFlight group "${group.attributes.name}" ready, ${have.size + added} tester(s)${added ? `, ${added} added` : ''}`);
}

async function wait(build) {
  const a = await app();
  const deadline = Date.now() + 90 * 60_000;
  for (;;) {
    const r = await api('GET', `/v1/builds?filter[app]=${a.id}&filter[version]=${build}&limit=1`);
    const b = r.data[0];
    const state = b?.attributes.processingState ?? 'NOT_FOUND_YET';
    console.log(`${new Date().toISOString().slice(11, 19)} build ${build}: ${state}`);
    if (state === 'VALID') return;
    if (state === 'INVALID' || state === 'FAILED') throw new Error(`build ${build} is ${state}`);
    if (Date.now() > deadline) throw new Error('timed out waiting for processing');
    await new Promise((r) => setTimeout(r, 60_000));
  }
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'testers') await testers();
else if (cmd === 'wait') await wait(arg);
else {
  console.error('usage: node scripts/asc.mjs testers | wait <build>');
  process.exit(1);
}
