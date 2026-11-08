import { net, protocol, type Session } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { paths } from './paths';

export const INTERNAL_PAGES = ['ui', 'autofill', 'newtab', 'settings', 'history', 'bookmarks', 'downloads', 'passwords', 'welcome', 'error'];
const ALIASES: Record<string, string> = { about: 'settings', import: 'settings', preferences: 'settings' };

export function registerSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'potato',
      privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true },
    },
    // Ad blocker stand-ins (a harmless gpt.js, a blank gif): Chromium will not follow a redirect
    // of a page's request to a data: URL.
    {
      scheme: 'potato-res',
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, bypassCSP: true },
    },
  ]);
}

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: http:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

function notFound(): Response {
  return new Response('<!doctype html><title>Not found</title><p>Page not found.</p>', {
    status: 404,
    headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': CSP },
  });
}

/** Serves the internal pages (`potato://settings/`, ...) from the bundled renderer build. */
export async function handleInternal(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const host = ALIASES[url.hostname] ?? url.hostname;
  if (host === 'action') return new Response('', { status: 204 });
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') {
    if (!INTERNAL_PAGES.includes(host)) return notFound();
    rel = `/${host}.html`;
  }
  // Only the host's own page and the shared build assets, so potato://newtab/settings.html
  // cannot open another page under the new tab page's host.
  if (!(rel === `/${host}.html` && INTERNAL_PAGES.includes(host)) && !rel.startsWith('/assets/')) return notFound();
  const root = paths.renderer;
  const file = path.normalize(path.join(root, rel));
  if (!file.startsWith(root + path.sep)) return notFound();
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return notFound();
  const res = await net.fetch(pathToFileURL(file).toString());
  const headers = new Headers(res.headers);
  if (file.endsWith('.html')) {
    headers.set('content-security-policy', CSP);
    headers.set('cache-control', 'no-store');
  }
  headers.set('x-content-type-options', 'nosniff');
  return new Response(res.body, { status: res.status, headers });
}

export function installInternalProtocol(ses: Session): void {
  if (!ses.protocol.isProtocolHandled('potato')) ses.protocol.handle('potato', handleInternal);
}

/**
 * Test mode only: requests to the listed hosts are answered by a local fixture server, so
 * e2e tests exercise real hostnames (www.google.com, www.reddit.com, ...) fully offline.
 */
export function installFixtureProxy(ses: Session): void {
  const proxy = process.env.POTATO_FIXTURE_PROXY;
  const entries = (process.env.POTATO_FIXTURE_HOSTS || '').split(',').map((h) => h.trim()).filter(Boolean);
  if (!proxy || !entries.length) return;
  // "-host" entries always use the real network (e.g. to test DNS failures).
  const excluded = entries.filter((h) => h.startsWith('-')).map((h) => h.slice(1));
  const hosts = entries.filter((h) => !h.startsWith('-'));
  const matches = (host: string) =>
    !excluded.includes(host) && hosts.some((h) => h === '*' || host === h || (h.startsWith('*.') && host.endsWith(h.slice(1))));
  for (const scheme of ['https', 'http']) {
    ses.protocol.handle(scheme, async (request) => {
      const u = new URL(request.url);
      if (!matches(u.hostname)) return net.fetch(request, { bypassCustomProtocolHandlers: true });
      const target = `${proxy}/${u.hostname}${u.pathname}${u.search}`;
      const headers = new Headers(request.headers);
      const init: RequestInit = { method: request.method, headers, redirect: 'manual' };
      // Form posts: net.fetch fails on a streamed body and on an Origin header it did not set.
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        headers.delete('origin');
        init.body = await request.arrayBuffer();
      }
      return net.fetch(target, init);
    });
  }
}
