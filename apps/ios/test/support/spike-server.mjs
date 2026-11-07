// Local pages for the WebKit spike tests (run on the Mac; the simulator reaches it at 127.0.0.1).
import http from 'node:http';

const port = Number(process.argv[2] ?? 8791);
const pages = {
  '/spike.html': `<!doctype html><title>spike</title>
<script src="/blocked.js"></script>
<script src="/redirected.js"></script>
<script>
  window.results = { blockedRan: !!window.blockedRan, redirectedRan: !!window.redirectedRan, standIn: !!window.standInRan };
  fetch('/echo').then(r => r.json()).then(j => { window.results.gpcHeader = j['sec-gpc'] ?? null; window.results.done = true; }, e => { window.results.fetchError = String(e); window.results.done = true; });
</script>`,
  '/csp.html': `<!doctype html><title>csp</title><script>window.inlineRan = true;</script>`,
  '/plain.html': `<!doctype html><title>plain</title><p>plain</p>`,
};

http
  .createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (url.pathname === '/echo') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.headers));
      return;
    }
    if (url.pathname === '/blocked.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end('window.blockedRan = true;');
      return;
    }
    if (url.pathname === '/redirected.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end('window.redirectedRan = true;');
      return;
    }
    const page = pages[url.pathname];
    if (page) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page);
      return;
    }
    res.writeHead(404);
    res.end('not found');
  })
  .listen(port, '127.0.0.1', () => console.log(`spike server on ${port}`));
