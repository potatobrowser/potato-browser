// App Store Connect chores for TestFlight and the App Store, with the API key from apps/ios/.env:
//   node scripts/asc.mjs testers               internal group "Team" with every App Store Connect user
//   node scripts/asc.mjs wait <build>          waits until Apple has processed that build number
//   node scripts/asc.mjs beta-info             TestFlight test information and the review contact
//   node scripts/asc.mjs public-beta [build]   external group with a public link; submits the build
//                                              (default: the newest valid one) for Beta App Review
//   node scripts/asc.mjs store-info            App Store texts of the version being prepared
// Texts come from store/*.txt; the review contact and feedback address from .env:
// ASC_CONTACT_FIRST, ASC_CONTACT_LAST, ASC_CONTACT_EMAIL, ASC_CONTACT_PHONE, ASC_FEEDBACK_EMAIL.
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

const SITE = 'https://potatobrowser.com';
const text = (name) => fs.readFileSync(path.join(root, 'store', name), 'utf8').trim();
const marketingVersion = () => /MARKETING_VERSION: "([\d.]+)"/.exec(fs.readFileSync(path.join(root, 'project.yml'), 'utf8'))[1];
/** Only the attributes that have a value, so unset .env entries leave App Store Connect as it is. */
const defined = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== ''));

async function upsert(listPath, type, id, attributes, create) {
  const [existing] = (await api('GET', listPath)).data.filter((d) => !attributes.locale || d.attributes.locale === attributes.locale);
  if (existing) {
    const { locale, ...rest } = attributes;
    await api('PATCH', `/v1/${type}/${existing.id}`, { data: { type, id: existing.id, attributes: rest } });
    return existing.id;
  }
  return (await api('POST', `/v1/${type}`, { data: { type, attributes, relationships: create } })).data.id;
}

async function betaInfo() {
  const a = await app();
  await upsert(`/v1/apps/${a.id}/betaAppLocalizations`, 'betaAppLocalizations', a.id, defined({
    locale: 'en-US',
    description: text('beta-description.txt'),
    feedbackEmail: env.ASC_FEEDBACK_EMAIL,
    marketingUrl: SITE,
    privacyPolicyUrl: `${SITE}/privacy`,
  }), { app: { data: { type: 'apps', id: a.id } } });
  await api('PATCH', `/v1/betaAppReviewDetails/${a.id}`, {
    data: {
      type: 'betaAppReviewDetails',
      id: a.id,
      attributes: defined({
        contactFirstName: env.ASC_CONTACT_FIRST,
        contactLastName: env.ASC_CONTACT_LAST,
        contactEmail: env.ASC_CONTACT_EMAIL,
        contactPhone: env.ASC_CONTACT_PHONE,
        demoAccountRequired: false,
        notes: text('review-notes.txt'),
      }),
    },
  });
  const missing = ['ASC_CONTACT_FIRST', 'ASC_CONTACT_LAST', 'ASC_CONTACT_EMAIL', 'ASC_CONTACT_PHONE', 'ASC_FEEDBACK_EMAIL'].filter((k) => !env[k]);
  console.log(`TestFlight test information set${missing.length ? `; still missing for Beta App Review: ${missing.join(', ')}` : ''}`);
}

async function publicBeta(buildNumber) {
  const a = await app();
  const builds = (await api('GET', `/v1/builds?filter[app]=${a.id}&filter[processingState]=VALID&sort=-uploadedDate&limit=20`)).data;
  const build = buildNumber ? builds.find((b) => b.attributes.version === String(buildNumber)) : builds[0];
  if (!build) throw new Error(`no processed build ${buildNumber ?? ''}`);
  let [group] = (await api('GET', `/v1/betaGroups?filter[app]=${a.id}&filter[isInternalGroup]=false&filter[name]=Public%20beta`)).data;
  if (!group) {
    group = (
      await api('POST', '/v1/betaGroups', {
        data: { type: 'betaGroups', attributes: { name: 'Public beta', publicLinkEnabled: true, publicLinkLimitEnabled: false, feedbackEnabled: true }, relationships: { app: { data: { type: 'apps', id: a.id } } } },
      })
    ).data;
    console.log('created the external group "Public beta" with a public link');
  }
  await upsert(`/v1/builds/${build.id}/betaBuildLocalizations`, 'betaBuildLocalizations', build.id, { locale: 'en-US', whatsNew: text('whats-new.txt') }, { build: { data: { type: 'builds', id: build.id } } });
  await api('POST', `/v1/betaGroups/${group.id}/relationships/builds`, { data: [{ type: 'builds', id: build.id }] });
  const pending = (await api('GET', `/v1/betaAppReviewSubmissions?filter[build]=${build.id}`)).data[0];
  if (!pending) {
    await api('POST', '/v1/betaAppReviewSubmissions', { data: { type: 'betaAppReviewSubmissions', relationships: { build: { data: { type: 'builds', id: build.id } } } } });
    console.log(`build ${build.attributes.version} submitted for Beta App Review`);
  } else console.log(`build ${build.attributes.version}: Beta App Review ${pending.attributes.betaReviewState}`);
  const g = (await api('GET', `/v1/betaGroups/${group.id}`)).data.attributes;
  console.log(`public link (works once the build is approved): ${g.publicLink ?? 'not created yet'}`);
}

async function storeInfo() {
  const a = await app();
  const [version] = (await api('GET', `/v1/apps/${a.id}/appStoreVersions?filter[appStoreState]=PREPARE_FOR_SUBMISSION,DEVELOPER_REJECTED,REJECTED&limit=1`)).data;
  if (!version) throw new Error('no App Store version is being prepared');
  // The App Store version must carry the version number of the build it ships.
  await api('PATCH', `/v1/appStoreVersions/${version.id}`, {
    data: { type: 'appStoreVersions', id: version.id, attributes: { versionString: marketingVersion(), copyright: `${new Date().getFullYear()} Laszlo Kiss and the Potato Browser contributors` } },
  });
  await upsert(`/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations`, 'appStoreVersionLocalizations', version.id, {
    locale: 'en-US',
    description: text('description.txt'),
    keywords: text('keywords.txt'),
    promotionalText: text('promotional-text.txt'),
    marketingUrl: SITE,
    supportUrl: 'https://github.com/potatobrowser/potato-browser/issues',
  }, { appStoreVersion: { data: { type: 'appStoreVersions', id: version.id } } });
  const [info] = (await api('GET', `/v1/apps/${a.id}/appInfos`)).data;
  await upsert(`/v1/appInfos/${info.id}/appInfoLocalizations`, 'appInfoLocalizations', info.id, {
    locale: 'en-US',
    subtitle: text('subtitle.txt'),
    privacyPolicyUrl: `${SITE}/privacy`,
  }, { appInfo: { data: { type: 'appInfos', id: info.id } } });
  console.log(`App Store texts set on version ${marketingVersion()}; screenshots, App Privacy and the age rating stay in App Store Connect`);
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'testers') await testers();
else if (cmd === 'wait') await wait(arg);
else if (cmd === 'beta-info') await betaInfo();
else if (cmd === 'public-beta') await publicBeta(arg);
else if (cmd === 'store-info') await storeInfo();
else {
  console.error('usage: node scripts/asc.mjs testers | wait <build> | beta-info | public-beta [build] | store-info');
  process.exit(1);
}
