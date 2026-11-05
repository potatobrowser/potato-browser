import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { startApiServer } from './api-server';
import { startFixtureServer } from './fixture-server';

export default async function globalSetup() {
  if (!process.env.NOAI_E2E_SKIP_BUILD) {
    execFileSync(process.execPath, [path.resolve(__dirname, '../../../scripts/build.mjs')], { stdio: 'inherit' });
  }
  const fixtures = await startFixtureServer();
  const api = await startApiServer();
  process.env.NOAI_E2E_FIXTURES = fixtures.url;
  process.env.NOAI_E2E_API = api.url;
  return async () => {
    await api.stop();
    await fixtures.close();
  };
}
