const {test} = require('node:test');
const assert = require('node:assert/strict');
const {setup, response} = require('./helpers/mobile-runtime.cjs');

const colgado = (r) => {
  const pedidos = [];
  r.setFetch((url, init) => { pedidos.push(init); return new Promise(() => {}); });
  return pedidos;
};

test('becasRequest tiene un límite por defecto y es el de TIMEOUT_JSON_MS', async () => {
  const r = await setup();
  assert.equal(r.api.TIMEOUT_JSON_MS, 30000);
  const pedidos = [];
  r.setFetch(async (url, init) => { pedidos.push(init); return response(200, {ok: 1}); });
  assert.equal((await r.api.becasRequest('/x/')).ok, 1);
  assert.ok(pedidos[0].signal, 'sin timeoutMs igual sale con señal: rige el límite por defecto');
  assert.equal(pedidos[0].timeoutMs, undefined, 'timeoutMs no llega a fetch');
});

test('becasRequest corta un pedido colgado y sale como timeout de red', async () => {
  const r = await setup();
  const pedidos = colgado(r);
  const inicio = Date.now();
  await assert.rejects(r.api.becasRequest('/x/', {timeoutMs: 30}),
    (error) => error.timeout === true && error.network === true);
  assert.ok(Date.now() - inicio < 2000);
  assert.equal(pedidos[0].signal.aborted, true);
});

test('becasRequest con timeoutMs null no pone límite', async () => {
  const r = await setup();
  const pedidos = [];
  r.setFetch(async (url, init) => { pedidos.push(init); return response(200, {ok: 1}); });
  await r.api.becasRequest('/x/', {timeoutMs: null});
  assert.equal(pedidos[0].signal, undefined);
});

test('becasRequest respeta la señal del que llama: abortarla corta el pedido sin error de tiempo', async () => {
  const r = await setup();
  const pedidos = [];
  r.setFetch((url, init) => {
    pedidos.push(init);
    // Como fetch: con la señal ya abortada rechaza enseguida; si no, al abortarse.
    if (init.signal.aborted) return Promise.reject(new Error('aborted'));
    return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  });
  const control = new AbortController();
  const pedido = r.api.becasRequest('/x/', {signal: control.signal});
  control.abort();
  await assert.rejects(pedido, (error) => error.timeout !== true && error.network === true);
  assert.equal(pedidos[0].signal.aborted, true);
});

test('un timeout no invalida la sesión', async () => {
  const r = await setup();
  colgado(r);
  await assert.rejects(r.api.becasRequest('/x/', {timeoutMs: 20}));
  assert.equal(await r.api.getBecasToken(), 'old-token');
});
