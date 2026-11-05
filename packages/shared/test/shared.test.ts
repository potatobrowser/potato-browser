import { describe, expect, it } from 'vitest';
import {
  compareVersions,
  contentKey,
  hashContentKey,
  hashPrefix,
  isClientId,
  isFullHash,
  isHashPrefix,
  parseContentKey,
  PREFIX_HEX_LENGTH,
} from '../src/index';

describe('content keys', () => {
  it('builds and parses canonical keys', () => {
    expect(contentKey('reddit', ' t3_abc ')).toBe('reddit:t3_abc');
    expect(parseContentKey('instagram:C9xYzAbCdEf')).toEqual({ platform: 'instagram', id: 'C9xYzAbCdEf' });
    expect(parseContentKey('myspace:1')).toBeNull();
    expect(parseContentKey('x:')).toBeNull();
    expect(parseContentKey('nocolon')).toBeNull();
  });

  it('hashes deterministically with a domain separator', async () => {
    const a = await hashContentKey('x:1790000000000000000');
    const b = await hashContentKey('x:1790000000000000000');
    const c = await hashContentKey('x:1790000000000000001');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(isFullHash(a)).toBe(true);
    // Known vector: sha256("noai-flag:v1:reddit:t3_test"), so client and server never drift.
    expect(await hashContentKey('reddit:t3_test')).toBe(
      'e497d2d34a98c9a63d58f64b1fd775b27fed8c0f82a4b54c5ad3a4787fec0659',
    );
    expect(hashPrefix(a)).toHaveLength(PREFIX_HEX_LENGTH);
    expect(isHashPrefix(hashPrefix(a))).toBe(true);
  });

  it('validates inputs strictly', () => {
    expect(isFullHash('A'.repeat(64))).toBe(false);
    expect(isFullHash('a'.repeat(63))).toBe(false);
    expect(isHashPrefix('abcdef')).toBe(false);
    expect(isHashPrefix('abcdz')).toBe(false);
    expect(isClientId('0123456789abcdef0123456789abcdef')).toBe(true);
    expect(isClientId('0123456789abcdef')).toBe(false);
  });
});

describe('compareVersions', () => {
  it('orders dotted versions', () => {
    expect(compareVersions('0.2.0', '0.1.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0', '1.0.1')).toBeLessThan(0);
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0);
  });
});
