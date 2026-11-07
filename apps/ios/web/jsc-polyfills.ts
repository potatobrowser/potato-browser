/**
 * The few web APIs Ghostery's engine expects that a bare JavaScriptCore context lacks:
 * TextEncoder/TextDecoder (UTF-8 only), btoa and console.
 */
const g = globalThis as Record<string, unknown>;

function utf8Encode(str: string, out?: Uint8Array): { bytes: Uint8Array; read: number; written: number } {
  const buf = out ?? new Uint8Array(str.length * 3);
  let w = 0;
  let r = 0;
  for (; r < str.length; r++) {
    let c = str.charCodeAt(r);
    if (c >= 0xd800 && c <= 0xdbff && r + 1 < str.length) {
      const d = str.charCodeAt(r + 1);
      if (d >= 0xdc00 && d <= 0xdfff) c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
    } else if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
    const len = c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
    if (w + len > buf.length) break;
    if (len === 1) buf[w++] = c;
    else if (len === 2) {
      buf[w++] = 0xc0 | (c >> 6);
      buf[w++] = 0x80 | (c & 63);
    } else if (len === 3) {
      buf[w++] = 0xe0 | (c >> 12);
      buf[w++] = 0x80 | ((c >> 6) & 63);
      buf[w++] = 0x80 | (c & 63);
    } else {
      buf[w++] = 0xf0 | (c >> 18);
      buf[w++] = 0x80 | ((c >> 12) & 63);
      buf[w++] = 0x80 | ((c >> 6) & 63);
      buf[w++] = 0x80 | (c & 63);
      r++;
    }
  }
  return { bytes: out ? buf : buf.subarray(0, w), read: r, written: w };
}

class TextEncoderPolyfill {
  readonly encoding = 'utf-8';
  encode(str = ''): Uint8Array {
    return utf8Encode(str).bytes;
  }
  encodeInto(str: string, dest: Uint8Array): { read: number; written: number } {
    const { read, written } = utf8Encode(str, dest);
    return { read, written };
  }
}

class TextDecoderPolyfill {
  readonly encoding = 'utf-8';
  decode(input?: ArrayBufferView | ArrayBuffer): string {
    if (!input) return '';
    const b = input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    let out = '';
    const chunk: number[] = [];
    for (let i = 0; i < b.length; ) {
      const c = b[i++]!;
      let cp: number;
      if (c < 0x80) cp = c;
      else if (c < 0xe0) cp = ((c & 31) << 6) | (b[i++]! & 63);
      else if (c < 0xf0) cp = ((c & 15) << 12) | ((b[i++]! & 63) << 6) | (b[i++]! & 63);
      else cp = ((c & 7) << 18) | ((b[i++]! & 63) << 12) | ((b[i++]! & 63) << 6) | (b[i++]! & 63);
      if (cp > 0xffff) {
        cp -= 0x10000;
        chunk.push(0xd800 + (cp >> 10), 0xdc00 + (cp & 1023));
      } else chunk.push(cp);
      if (chunk.length > 8000) {
        out += String.fromCharCode(...chunk);
        chunk.length = 0;
      }
    }
    return out + String.fromCharCode(...chunk);
  }
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function btoaPolyfill(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i += 3) {
    const a = s.charCodeAt(i) & 255;
    const b = i + 1 < s.length ? s.charCodeAt(i + 1) & 255 : NaN;
    const c = i + 2 < s.length ? s.charCodeAt(i + 2) & 255 : NaN;
    const n = (a << 16) | ((b || 0) << 8) | (c || 0);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + (Number.isNaN(b) ? '=' : B64[(n >> 6) & 63]!) + (Number.isNaN(c) ? '=' : B64[n & 63]!);
  }
  return out;
}

if (typeof g.TextEncoder === 'undefined') g.TextEncoder = TextEncoderPolyfill;
if (typeof g.TextDecoder === 'undefined') g.TextDecoder = TextDecoderPolyfill;
if (typeof g.btoa === 'undefined') g.btoa = btoaPolyfill;
if (typeof g.console === 'undefined') {
  const log = (...args: unknown[]) => (g.__potatoLog as ((s: string) => void) | undefined)?.(args.map(String).join(' '));
  g.console = { log, warn: log, error: log, info: log, debug: () => {} };
}

export {};
