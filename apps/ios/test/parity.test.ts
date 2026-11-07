import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ENGINE_OPTIONS as MAC_ENGINE_OPTIONS } from '../../browser/src/main/adblock/compile';
import { AI_GLOBALS } from '../web/ai';
import { ENGINE_OPTIONS } from '../web/engine-api';

describe('parity with the Mac app', () => {
  it('removes every AI global the Mac app forbids', () => {
    const src = fs.readFileSync(path.resolve(import.meta.dirname, '../../browser/src/main/engine.ts'), 'utf8');
    const block = /FORBIDDEN_GLOBALS = \[([\s\S]*?)\]/.exec(src)![1]!;
    const mac = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
    expect(mac.length).toBeGreaterThan(5);
    for (const name of mac) expect(AI_GLOBALS).toContain(name);
  });

  it('compiles engines with the same options', () => {
    expect(ENGINE_OPTIONS).toEqual(MAC_ENGINE_OPTIONS);
  });
});
