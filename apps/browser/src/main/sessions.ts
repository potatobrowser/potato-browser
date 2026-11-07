import type { Session } from 'electron';
import { GOOGLE_SIGNIN_HOSTS, GOOGLE_SIGNIN_UA } from '../shared/constants';
import { ctx } from './context';
import { chromeUserAgent } from './engine';
import { isTest } from './paths';
import { installFixtureProxy, installInternalProtocol } from './protocol';


/** Main-frame hosts blocked when "Block AI chatbot sites" is on. */
export const AI_CHATBOT_HOSTS = [
  'chatgpt.com',
  'chat.openai.com',
  'gemini.google.com',
  'bard.google.com',
  'claude.ai',
  'copilot.microsoft.com',
  'perplexity.ai',
  'www.perplexity.ai',
  'chat.deepseek.com',
  'chat.mistral.ai',
  'grok.com',
  'meta.ai',
  'www.meta.ai',
  'poe.com',
  'character.ai',
  'pi.ai',
  'duck.ai',
  'you.com',
  'huggingface.co/chat',
];

export function isChatbotUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    return AI_CHATBOT_HOSTS.some((h) => {
      const [hh, p] = h.split('/', 2) as [string, string | undefined];
      return (host === hh || host.endsWith('.' + hh)) && (!p || u.pathname.startsWith('/' + p));
    });
  } catch {
    return false;
  }
}

const chatbotAllowedOnce = new Set<string>();
export function allowChatbotOnce(url: string): void {
  try {
    chatbotAllowedOnce.add(new URL(url).hostname);
  } catch {}
}

export function configureSession(ses: Session, opts: { isPrivate: boolean; ui?: boolean }): void {
  ses.setUserAgent(chromeUserAgent());
  installInternalProtocol(ses);
  if (opts.ui) return;

  if (isTest()) installFixtureProxy(ses);
  if (!ses.protocol.isProtocolHandled('potato-res')) ses.protocol.handle('potato-res', (req) => ctx.adblock.serveResource(req));
  ses.setSpellCheckerEnabled(true);
  ctx.permissions.install(ses, opts.isPrivate);
  ses.on('will-download', (_e, item, wc) => ctx.downloads.handle(item, wc, opts.isPrivate));

  ses.webRequest.onBeforeRequest((details, callback) => {
    const isMainFrame = details.resourceType === 'mainFrame';
    if (isMainFrame && ctx.settings.get().privacy.blockAiChatbots && isChatbotUrl(details.url)) {
      const host = new URL(details.url).hostname;
      // Cancelled loads surface as ERR_BLOCKED_BY_CLIENT; the error page offers "Continue anyway".
      if (!chatbotAllowedOnce.has(host)) return callback({ cancel: true });
    }
    const topUrl = isMainFrame ? details.url : (details.webContents?.getURL() ?? '');
    const verdict = ctx.shield.filterRequest(details.url, topUrl, isMainFrame);
    if (verdict === 'cancel') return callback({ cancel: true });
    if (verdict) return callback({ redirectURL: verdict });
    callback(ctx.adblock.filterRequest(details, opts.isPrivate) ?? {});
  });

  // Only documents can carry `$csp` filters; other responses skip the round trip.
  ses.webRequest.onHeadersReceived({ urls: ['<all_urls>'], types: ['mainFrame', 'subFrame'] }, (details, callback) => {
    const csp = ctx.adblock.cspFor(details);
    if (!csp) return callback({});
    // A separate policy: Chromium enforces every one, so the site's own CSP is never loosened.
    const headers = { ...(details.responseHeaders ?? {}) };
    const key = Object.keys(headers).find((k) => k.toLowerCase() === 'content-security-policy') ?? 'Content-Security-Policy';
    headers[key] = [...(headers[key] ?? []), csp];
    callback({ responseHeaders: headers });
  });

  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = details.requestHeaders;
    if (ctx.settings.get().privacy.globalPrivacyControl) headers['Sec-GPC'] = '1';
    try {
      const host = new URL(details.url).hostname;
      if (GOOGLE_SIGNIN_HOSTS.includes(host)) {
        headers['User-Agent'] = GOOGLE_SIGNIN_UA;
        for (const k of Object.keys(headers)) if (k.toLowerCase().startsWith('sec-ch-ua')) delete headers[k];
      }
    } catch {}
    callback({ requestHeaders: headers });
  });
}
