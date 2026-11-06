/** Builds the HTML for network error and crash pages, injected into Chromium's error document. */

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

interface ErrorCopy {
  title: string;
  body: string;
  proceed?: boolean;
  allowChatbot?: boolean;
}

function copyFor(code: number, desc: string, host: string): ErrorCopy {
  const h = `<strong>${esc(host)}</strong>`;
  if (desc === 'ERR_NAME_NOT_RESOLVED') return { title: "This site can't be reached", body: `We dug around, but couldn't find the server for ${h}. Check the address for typos.` };
  if (desc === 'ERR_INTERNET_DISCONNECTED') return { title: "You're offline", body: 'Check your Wi-Fi or network cable, then try again. Until then, enjoy being a couch potato.' };
  if (desc === 'ERR_CONNECTION_REFUSED') return { title: "This site can't be reached", body: `${h} refused to connect. Hot potato.` };
  if (desc === 'ERR_CONNECTION_TIMED_OUT' || desc === 'ERR_TIMED_OUT') return { title: "This site can't be reached", body: `${h} took too long to respond. Slower than a potato in a cold oven.` };
  if (desc === 'ERR_CONNECTION_RESET' || desc === 'ERR_CONNECTION_CLOSED') return { title: "This site can't be reached", body: `The connection to ${h} was interrupted.` };
  if (desc.startsWith('ERR_CERT_') || desc === 'ERR_SSL_PROTOCOL_ERROR' || desc.includes('SSL')) {
    return {
      title: 'Your connection is not private',
      body: `Someone might be trying to read what you send to ${h}, or the site's security certificate is broken.`,
      proceed: desc.startsWith('ERR_CERT_'),
    };
  }
  if (desc === 'ERR_BLOCKED_BY_CLIENT') {
    return {
      title: 'AI chatbot blocked',
      body: `${h} is an AI chatbot, and you asked to keep those out of the pantry in Settings. This is a no-artificial-ingredients zone.`,
      allowChatbot: true,
    };
  }
  if (desc === 'ERR_TOO_MANY_REDIRECTS') return { title: "This page isn't working", body: `${h} redirected you too many times.` };
  if (code === -1000) return { title: 'This tab got mashed', body: 'Something went wrong while showing this page. Trying again usually un-mashes it.' };
  return { title: "This page isn't working", body: `${h} could not be loaded.` };
}

/** `token` is the tab's secret for this error page; its action links carry it (see Tab.handleAction). */
export function errorPageHtml(url: string, code: number, desc: string, token = ''): string {
  let host = url;
  try {
    host = new URL(url).host || url;
  } catch {}
  const c = copyFor(code, desc, host);
  const proceed = c.proceed
    ? `<p class="adv"><a href="potato://action/proceed?url=${encodeURIComponent(url)}&amp;t=${token}">Continue to ${esc(host)} anyway (unsafe)</a></p>`
    : c.allowChatbot
      ? `<p class="adv"><a href="potato://action/allow-chatbot?url=${encodeURIComponent(url)}&amp;t=${token}">Open ${esc(host)} this time</a></p>`
      : '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(host)}</title>
<style>
:root{color-scheme:light dark;--fg:#1d1d1f;--muted:#6e6e73;--bg:#fff;--btn:#1d1d1f;--btnfg:#fff}
@media (prefers-color-scheme:dark){:root{--fg:#f2f2f2;--muted:#a1a1a6;--bg:#1c1c1e;--btn:#f2f2f2;--btnfg:#111}}
html,body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Helvetica Neue",sans-serif}
main{max-width:560px;margin:14vh auto 0;padding:0 28px}
.icon{width:44px;height:44px;border-radius:12px;border:2px solid currentColor;display:grid;place-items:center;font-weight:700;font-size:22px;margin-bottom:22px;opacity:.8}
h1{font-size:26px;line-height:1.2;margin:0 0 12px;letter-spacing:-.01em}
p{margin:0 0 10px;color:var(--muted)}
code{font:12px ui-monospace,Menlo,monospace;color:var(--muted)}
.row{margin-top:26px;display:flex;gap:12px;align-items:center}
a.btn{background:var(--btn);color:var(--btnfg);text-decoration:none;padding:9px 18px;border-radius:999px;font-weight:600}
.adv a{color:#c2410c}
</style></head><body><main>
<div class="icon">!</div>
<h1>${esc(c.title)}</h1>
<p>${c.body}</p>
<p><code>${esc(desc || String(code))}</code></p>
<div class="row"><a class="btn" href="potato://action/retry">Try again</a></div>
${proceed}
</main></body></html>`;
}

export function crashPageHtml(url: string): string {
  return errorPageHtml(url, -1000, 'RENDERER_CRASHED');
}
