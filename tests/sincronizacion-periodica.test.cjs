const {test} = require('node:test');
const assert = require('node:assert/strict');
const {setup} = require('./helpers/mobile-runtime.cjs');

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const appStateFalso = (inicial = 'active') => {
  const listeners = new Set();
  const appState = {
    currentState: inicial,
    addEventListener: (evento, fn) => { listeners.add(fn); return {remove: () => listeners.delete(fn)}; },
  };
  return {
    appState,
    cambiar: (estado) => { appState.currentState = estado; listeners.forEach((fn) => fn(estado)); },
    cantidad: () => listeners.size,
  };
};

const cargar = async (estado) => {
  const r = await setup('web', {mocks: {'react-native': {Platform: {OS: 'web'}, AppState: estado.appState}}});
  r.setGlobal('setInterval', setInterval);
  r.setGlobal('clearInterval', clearInterval);
  return r.load('./sincronizacionPeriodica');
};

test('el intervalo de fondo es de 60 s', async () => {
  const modulo = await cargar(appStateFalso());
  assert.equal(modulo.SYNC_INTERVAL_MS, 60000);
});

test('repite con la app activa, se frena en segundo plano y al volver corre en el momento', async () => {
  const estado = appStateFalso('active');
  const {repetirMientrasActiva} = await cargar(estado);
  let pasadas = 0;
  const dejar = repetirMientrasActiva(() => { pasadas += 1; }, 20);
  await esperar(70);
  const activas = pasadas;
  assert.ok(activas >= 2, `con la app activa repite (${activas})`);

  estado.cambiar('background');
  await esperar(70);
  assert.equal(pasadas, activas, 'en segundo plano no corre');

  estado.cambiar('active');
  assert.equal(pasadas, activas + 1, 'al volver al frente corre en el momento');
  await esperar(50);
  assert.ok(pasadas > activas + 1, 'y retoma el intervalo');

  dejar();
  const alFinal = pasadas;
  await esperar(50);
  assert.equal(pasadas, alFinal, 'después de dejar no corre más');
  assert.equal(estado.cantidad(), 0, 'y suelta el listener');
});

test('inactive (pantalla de permisos, multitarea de iOS) no frena ni duplica', async () => {
  const estado = appStateFalso('active');
  const {repetirMientrasActiva} = await cargar(estado);
  let pasadas = 0;
  const dejar = repetirMientrasActiva(() => { pasadas += 1; }, 1000);
  estado.cambiar('inactive');
  estado.cambiar('active');
  assert.equal(pasadas, 0, 'volver de inactive no dispara una pasada extra');
  dejar();
});

test('si arranca en segundo plano espera a que la app vuelva al frente', async () => {
  const estado = appStateFalso('background');
  const {repetirMientrasActiva} = await cargar(estado);
  let pasadas = 0;
  const dejar = repetirMientrasActiva(() => { pasadas += 1; }, 20);
  await esperar(60);
  assert.equal(pasadas, 0);
  estado.cambiar('active');
  assert.equal(pasadas, 1);
  dejar();
});
