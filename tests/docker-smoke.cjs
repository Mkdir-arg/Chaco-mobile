const assert = require('node:assert/strict');
const {execFileSync, spawnSync} = require('node:child_process');
const vm = require('node:vm');
const http = require('node:http');
const image = process.argv[2] || 'chaco-mobile:pwa-test';
const docker = args => execFileSync('docker', args, {encoding:'utf8'}).trim();
let container;
const start = async (backend) => {
  container = docker(['run','-d','--rm','-p','127.0.0.1::8080',
    ...(backend ? ['-e', 'URL_backoffice=' + backend] : []), image]);
  const port = docker(['port',container,'8080/tcp']).split(':').pop();
  const origin = 'http://127.0.0.1:' + port;
  for (let n=0;n<100;n++) {
    try { if ((await fetch(origin + '/healthz')).ok) return origin; } catch {}
    await new Promise(resolve => setTimeout(resolve,100));
  }
  throw new Error('Container did not become healthy');
};
const stop = () => { if(container) {docker(['stop',container]); container=null;} };
(async () => {
  try {
    const origin = await start();
    const root = await fetch(origin); const html = await root.text();
    assert.equal(root.status,200);
    const scriptPosition = html.indexOf('src="/runtime-config.js"');
    assert.ok(scriptPosition >= 0 && scriptPosition < html.indexOf('src="/_expo/'));
    const bundle = html.match(/src="([^"]*\/_expo\/[^"]+\.js)"/)[1];
    const wasm = docker(['exec',container,'find','/usr/share/nginx/html','-name','*.wasm'])
      .split('\n')[0].replace('/usr/share/nginx/html','');
    for (const route of ['/', '/relevamientos/9', '/index.html','/sw.js','/runtime-config.js',bundle,wasm]) {
      const response = await fetch(origin + route);
      assert.equal(response.status,200,route);
      assert.equal(response.headers.get('cross-origin-opener-policy'),'same-origin',route);
      assert.equal(response.headers.get('cross-origin-embedder-policy'),'require-corp',route);
    }
    assert.equal(await (await fetch(origin + '/relevamientos/9')).text(),html);
    assert.match((await fetch(origin + '/runtime-config.js')).headers.get('cache-control'),/no-store/);
    assert.match((await fetch(origin + '/sw.js')).headers.get('cache-control'),/no-cache/);
    assert.match((await fetch(origin + bundle)).headers.get('cache-control'),/immutable/);
    assert.match((await fetch(origin + wasm)).headers.get('content-type'),/application\/wasm/);
    // Sin compresion el bundle son 2,2 MB en el primer arranque de cada dispositivo.
    // Los .gz los genera el build: si el find del Dockerfile deja de matchear, esto falla.
    const rawHeaders = (route, encoding) => new Promise((resolve, reject) => {
      const target = new URL(origin + route);
      http.get({hostname: target.hostname, port: target.port, path: target.pathname,
        headers: {'Accept-Encoding': encoding}}, response => { response.resume(); resolve(response.headers); })
        .on('error', reject);
    });
    const comprimido = await rawHeaders(bundle, 'gzip');
    const crudo = await rawHeaders(bundle, 'identity');
    assert.equal(comprimido['content-encoding'],'gzip','el bundle debe viajar comprimido');
    assert.equal(crudo['content-encoding'],undefined,'un cliente sin gzip igual recibe el bundle');
    assert.ok(Number(comprimido['content-length'])*2 < Number(crudo['content-length']),'el .gz precomprimido no se esta sirviendo');
    assert.match(comprimido['vary']||'',/accept-encoding/i);
    assert.equal(comprimido['cache-control'],crudo['cache-control']);
    // Un .gz viejo de runtime-config.js serviria la URL del backend equivocada.
    assert.equal(docker(['exec',container,'sh','-c','test ! -e /usr/share/nginx/html/runtime-config.js.gz && echo ok']),'ok');
    for(const route of ['/missing.js','/missing.wasm','/api/becas/relevamientos/']) {
      assert.equal((await fetch(origin + route)).status,404,route);
    }
    const readConfig = async base => {
      const window={}; vm.runInNewContext(await (await fetch(base+'/runtime-config.js')).text(), {window});
      return window.__DATANACH_CONFIG__.URL_backoffice;
    };
    assert.equal(await readConfig(origin),'https://datanach.ecomdev.ar');
    assert.equal(docker(['exec',container,'sh','-c','test ! -e /app/.env.local && test ! -e /usr/share/nginx/html/.env.local && echo clean']),'clean');
    stop();
    const production = await start('https://datanach.chaco.gob.ar/');
    assert.equal(await readConfig(production),'https://datanach.chaco.gob.ar');
    stop();
    for(const value of ['http://example.test','https://example.test/api','https://user:pass@example.test','https://example.test/";alert(1)','https://example.test\nalert(1)']) {
      const result=spawnSync('docker',['run','--rm','-e','URL_backoffice='+value,image,'nginx','-t'],{encoding:'utf8'});
      assert.notEqual(result.status,0,'Invalid URL must fail: '+value);
    }
    console.log('PASS: static container, SPA fallback, isolation, WASM, cache policy, runtime test/production URLs and invalid URL rejection.');
  } finally {stop();}
})().catch(error => {console.error(error);process.exitCode=1;});
