// Runs the app on the iOS simulator with test steps and collects what it reports.
//   node scripts/simrun.mjs <steps.json> [--out dir] [--fresh] [--env KEY=VALUE ...]
// The app (built for the simulator with -potato-test support) prints `POTATO_TEST {json}` per
// step and `POTATO_SHOT name` when it wants a screenshot.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const BUNDLE = 'com.potatobrowser.app';
export const DEVICE = process.env.POTATO_SIM ?? 'potato-ios';
const root = path.resolve(import.meta.dirname, '..');

export function appPath() {
  return path.join(root, 'build/DerivedData/Build/Products/Debug-iphonesimulator/PotatoBrowser.app');
}

export function simctl(...args) {
  const r = spawnSync('xcrun', ['simctl', ...args], { encoding: 'utf8' });
  if (r.status !== 0 && !String(r.stderr).includes('current state: Booted')) throw new Error(`simctl ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

export function boot() {
  try {
    simctl('boot', DEVICE);
  } catch (e) {
    if (!String(e.message).includes('Booted')) throw e;
  }
  spawnSync('xcrun', ['simctl', 'bootstatus', DEVICE, '-b'], { stdio: 'ignore' });
}

export async function runSteps(steps, { out, fresh = true, env = {}, install = true, timeoutMs = 600_000 } = {}) {
  boot();
  if (install) simctl('install', DEVICE, appPath());
  spawnSync('xcrun', ['simctl', 'terminate', DEVICE, BUNDLE], { stdio: 'ignore' });
  if (out) fs.mkdirSync(out, { recursive: true });
  const childEnv = { ...process.env, SIMCTL_CHILD_POTATO_TEST_STEPS: JSON.stringify(steps) };
  for (const [k, v] of Object.entries(env)) childEnv[`SIMCTL_CHILD_${k}`] = v;
  const args = ['simctl', 'launch', '--console-pty', '--terminate-running-process', DEVICE, BUNDLE, '-potato-test'];
  if (fresh) args.push('-potato-fresh');
  const child = spawn('xcrun', args, { env: childEnv });
  const results = [];
  let buf = '';
  let log = '';
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`timed out; last output:\n${log.slice(-3000)}`));
    }, timeoutMs);
    const onLine = (line) => {
      if (line.startsWith('POTATO_TEST ')) {
        let obj;
        try {
          obj = JSON.parse(line.slice('POTATO_TEST '.length));
        } catch {
          return;
        }
        if (obj.event === 'done') {
          clearTimeout(timer);
          spawnSync('xcrun', ['simctl', 'terminate', DEVICE, BUNDLE], { stdio: 'ignore' });
          child.kill('SIGTERM');
          resolve({ results, log });
          return;
        }
        if (obj.event !== 'start') {
          obj.at = Date.now();
          results.push(obj);
          process.stderr.write(`  ${obj.action}${obj.name ? ` ${obj.name}` : ''}${obj.error ? ` ERROR ${obj.error}` : ''}\n`);
        }
      } else if (line.startsWith('POTATO_SHOT ') && out) {
        const name = line.slice('POTATO_SHOT '.length).trim().replace(/[^\w.-]+/g, '_');
        spawnSync('xcrun', ['simctl', 'io', DEVICE, 'screenshot', path.join(out, `${name}.png`)], { stdio: 'ignore' });
      }
    };
    const feed = (d) => {
      const text = d.toString();
      log += text;
      buf += text;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        onLine(buf.slice(0, i).replace(/\r$/, ''));
        buf = buf.slice(i + 1);
      }
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (!results.length) reject(new Error(`app exited (${code}) before reporting:\n${log.slice(-3000)}`));
      else resolve({ results, log });
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const [stepsFile, ...rest] = process.argv.slice(2);
  const outIdx = rest.indexOf('--out');
  const out = outIdx >= 0 ? rest[outIdx + 1] : undefined;
  const env = Object.fromEntries(rest.filter((a, i) => rest[i - 1] === '--env').map((kv) => kv.split(/=(.*)/s).slice(0, 2)));
  const steps = JSON.parse(fs.readFileSync(stepsFile, 'utf8'));
  const { results } = await runSteps(steps, { out, fresh: !rest.includes('--keep'), env });
  console.log(JSON.stringify(results, null, 2));
}
