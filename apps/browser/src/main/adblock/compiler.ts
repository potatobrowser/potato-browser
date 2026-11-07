import { compileEngine, type CompileJob } from './compile';

/**
 * Compiles filter lists into a serialized engine, off the main process. Runs as an Electron
 * utility process (jobs over parentPort) or from the build: `node filters-compiler.js <job.json>`.
 */
const port = (process as unknown as { parentPort?: { on(e: 'message', cb: (m: { data: CompileJob }) => void): void; postMessage(m: unknown): void } })
  .parentPort;

if (port) {
  port.on('message', ({ data }) => {
    try {
      port.postMessage({ ok: true, ...compileEngine(data) });
    } catch (err) {
      port.postMessage({ ok: false, error: String((err as Error)?.stack ?? err) });
    }
  });
} else if (process.argv[2]) {
  const fs = require('node:fs') as typeof import('node:fs');
  const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')) as CompileJob;
  const r = compileEngine(job);
  console.log(`compiled ad blocker engine: ${(r.bytes / 1e6).toFixed(1)} MB in ${r.ms} ms`);
}
