// E2: los textos del Alert de la sincronización manual (ícono de nube).
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {transformSync} = require('@babel/core');

const {code} = transformSync(fs.readFileSync(path.join(__dirname, '../src/utils/syncManual.js'), 'utf8'), {
  babelrc: false, configFile: false, plugins: ['@babel/plugin-transform-modules-commonjs']});
const module_ = {exports: {}};
new Function('module', 'exports', code)(module_, module_.exports);
const resumen = resultado => ({...module_.exports.resumenSyncManual(resultado)});

const DEPENDENCIA = 'esperando que suba primero otra operación del mismo relevamiento';

test('sincronización completa: «Sincronizados: N» y la línea «En espera: N (motivo)»', () => {
  assert.deepEqual(resumen({synced: 2}), {title: 'Sincronizacion completa', message: 'Sincronizados: 2'});
  assert.deepEqual(resumen({synced: 2, waiting: 1, waitingReason: 'el servidor pidió esperar'}),
    {title: 'Sincronizacion completa', message: 'Sincronizados: 2\nEn espera: 1 (el servidor pidió esperar)'});
  assert.equal(resumen({synced: 1, waiting: 3}).message, 'Sincronizados: 1\nEn espera: 3');
});

test('sincronización parcial: fallidos, detalle del primer error y línea de espera', () => {
  assert.deepEqual(resumen({synced: 1, failed: 2, errors: [{message: 'Boom'}, {message: 'Otro'}], waiting: 1, waitingReason: 'el relevamiento está pausado'}),
    {title: 'Sincronizacion parcial', message: 'Sincronizados: 1\nFallidos: 2\nDetalle: Boom\nEn espera: 1 (el relevamiento está pausado)'});
  assert.equal(resumen({synced: 0, failed: 1}).message, 'Sincronizados: 0\nFallidos: 1');
});

test('solo en espera: «Quedan N en espera: motivo. Se reintentan solas cada 5 minutos.»', () => {
  assert.deepEqual(resumen({synced: 0, failed: 0, waiting: 2, waitingReason: 'el servidor no respondió'}),
    {title: 'Sincronizacion', message: 'Quedan 2 en espera: el servidor no respondió. Se reintentan solas cada 5 minutos.'});
  assert.equal(resumen({waiting: 1}).message, 'Quedan 1 en espera. Se reintentan solas cada 5 minutos.');
});

test('dependencia de otra operación del mismo relevamiento (E1)', () => {
  assert.equal(resumen({synced: 1, waiting: 1, waitingReason: DEPENDENCIA}).message,
    `Sincronizados: 1\nEn espera: 1 (${DEPENDENCIA})`);
  assert.equal(resumen({waiting: 2, waitingReason: DEPENDENCIA}).message,
    `Quedan 2 en espera: ${DEPENDENCIA}. Se reintentan solas cada 5 minutos.`);
});

test('sin conexión y sin nada pendiente', () => {
  assert.deepEqual(resumen({offline: true, waiting: 1}),
    {title: 'Sin conexion', message: 'Adjuntos pendientes. Se reintentara automaticamente al recuperar internet.'});
  assert.deepEqual(resumen({}), {title: 'Sincronizacion', message: 'No habia elementos pendientes.'});
  assert.deepEqual(resumen(undefined), {title: 'Sincronizacion', message: 'No habia elementos pendientes.'});
});

test('App.js arma el Alert de la sincronización manual con resumenSyncManual', () => {
  const app = fs.readFileSync(path.join(__dirname, '../App.js'), 'utf8');
  assert.match(app, /import \{ resumenSyncManual \} from '\.\/src\/utils\/syncManual'/);
  assert.match(app, /const \{ title, message \} = resumenSyncManual\(relevamientoResult\);\s+Alert\.alert\(title, message\)/);
});
