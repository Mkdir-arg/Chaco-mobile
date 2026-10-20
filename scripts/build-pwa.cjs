const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..', process.env.PWA_DIST || 'dist');
const files = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  const name = path.join(dir, entry.name);
  return entry.isDirectory() ? files(name) : [name];
});
let html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
// Load runtime settings before Expo executes the application bundle.
html = html.replace('<head>', '<head><script src="/runtime-config.js"></script>');
html = html.replace('</head>', `<link rel="manifest" href="/manifest.webmanifest" />
<meta name="theme-color" content="#F9FAFB" />
<link rel="apple-touch-icon" href="/icons/icon-192.png" /></head>`);
fs.writeFileSync(path.join(root, 'index.html'), html);
const assets = files(root).filter(file => !/\.(map)$/.test(file) && !['sw.js', '_headers'].includes(path.basename(file)));
const revision = crypto.createHash('sha256');
for (const file of assets.sort()) revision.update(fs.readFileSync(file));
const cache = 'datanach-shell-' + revision.digest('hex').slice(0, 16);
const urls = assets.map(file => '/' + path.relative(root, file).split(path.sep).join('/'));
fs.writeFileSync(path.join(root, 'sw.js'), `
const CACHE = ${JSON.stringify(cache)};
const ASSETS = ${JSON.stringify(urls)};
self.addEventListener('install', event => {
  // Atomic install. A partial download never replaces a usable offline shell.
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)));
  // Wait for open windows to close; never reload a form during capture.
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys
    .filter(key => key.startsWith('datanach-shell-') && key !== CACHE)
    .map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  // Never cache API responses, tokens, uploads or arbitrary remote documents.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin
    || url.pathname.startsWith('/api/')) return;
  if (url.pathname === '/runtime-config.js') {
    // Network first for environment changes; preserve the last configuration
    // offline together with the shell. No API/token response is cached.
    event.respondWith(caches.open(CACHE).then(async cache => {
      try {
        const response = await fetch(event.request, { cache: 'no-store' });
        if (!response.ok) throw new Error('Runtime configuration unavailable');
        await cache.put('/runtime-config.js', response.clone());
        return response;
      } catch {
        return cache.match('/runtime-config.js');
      }
    }));
  } else if (event.request.mode === 'navigate') {
    event.respondWith(caches.open(CACHE).then(cache => cache.match('/index.html')));
  } else if (ASSETS.includes(url.pathname)) {
    event.respondWith(caches.open(CACHE).then(async cache =>
      (await cache.match(url.pathname)) || fetch(event.request)));
  }
});
`);
console.log('PWA:', cache, urls.length, 'archivos precargados');
