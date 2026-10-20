// Local production preview. Production hosting must send the same headers.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..', process.env.PWA_DIST || 'dist');
const types = {'.html':'text/html; charset=utf-8','.js':'application/javascript','.json':'application/json',
  '.webmanifest':'application/manifest+json','.wasm':'application/wasm','.png':'image/png',
  '.css':'text/css','.ttf':'font/ttf','.jpg':'image/jpeg','.jpeg':'image/jpeg'};
http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  let file = path.resolve(root, '.' + pathname);
  if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  if (pathname === '/') file = path.join(root, 'index.html');
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    if (pathname.startsWith('/api/') || path.extname(pathname)) { res.writeHead(404).end(); return; }
    file = path.join(root, 'index.html');
  }
  res.writeHead(200, {'Content-Type':types[path.extname(file)] || 'application/octet-stream',
    'Cross-Origin-Opener-Policy':'same-origin', 'Cross-Origin-Embedder-Policy':'require-corp',
    'Cache-Control':'no-cache', 'X-Content-Type-Options':'nosniff'});
  fs.createReadStream(file).pipe(res);
}).listen(Number(process.env.PORT || 4173), '127.0.0.1', () => console.log('PWA: http://localhost:' + (process.env.PORT || 4173)));
