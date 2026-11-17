const {test} = require('node:test');
const assert = require('node:assert/strict');
const {setup, response} = require('./helpers/mobile-runtime.cjs');

// Campo FIRMA: imagen PNG que viaja como un ARCHIVO + datos de quien firma.
const plain = value => JSON.parse(JSON.stringify(value));
const campo = (clave, extra = {}) => ({tipo_item: 'campo', clave, id: Number(clave.split('-')[1]) || null,
  tipo: 'FIRMA', texto: 'Firma', origen: 'pregunta', canal: 'ambos', ...extra});
const definicion = items => ({version: 3, acepta_respuestas: true, items: [{tipo: 'grupo', clave: 'g', titulo: 'G', items}]});
const PNG_WEB = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
const firma = (extra = {}) => ({uri: 'file:///cache/123_firma-pg-5.png', fileName: 'firma-pg-5.png', mimeType: 'image/png',
  size: 300, source: 'firma', firmante: {nombre: 'Ana Pérez', dni: '30123456'}, ...extra});

test('validación local: FIRMA obligatoria completa, incompleta y con DNI inválido', async () => {
  const {definition: api} = await setup();
  const requerida = {tipo: 'FIRMA', requerido: true};
  const opcional = {tipo: 'FIRMA', requerido: false};
  assert.equal(api.errorDelCampo(requerida, firma()), '');
  assert.equal(api.errorDelCampo(requerida, firma({firmante: {nombre: 'Ana', dni: '1234567'}})), '', '7 dígitos vale');
  assert.match(api.errorDelCampo(requerida, ''), /Falta la firma/);
  assert.match(api.errorDelCampo(requerida, null), /Falta la firma/);
  assert.match(api.errorDelCampo(requerida, {firmante: {nombre: 'Ana', dni: '30123456'}}), /^Falta la firma\.$/);
  assert.match(api.errorDelCampo(requerida, firma({firmante: {nombre: '  ', dni: '30123456'}})), /nombre y apellido/);
  assert.match(api.errorDelCampo(requerida, firma({firmante: {nombre: 'Ana'}})), /DNI válido/);
  for (const dni of ['123456', '123456789', '30.123.456', '3012345a']) {
    assert.match(api.errorDelCampo(requerida, firma({firmante: {nombre: 'Ana', dni}})), /DNI válido/, dni);
  }
  // Opcional: vacía vale; a medias es error.
  assert.equal(api.errorDelCampo(opcional, ''), '');
  assert.equal(api.errorDelCampo(opcional, undefined), '');
  assert.match(api.errorDelCampo(opcional, {firmante: {nombre: 'Ana', dni: ''}}), /Falta la firma/);
  assert.match(api.errorDelCampo(opcional, firma({firmante: {nombre: 'Ana', dni: '12'}})), /DNI válido/);
  assert.equal(api.errorDelCampo(opcional, firma()), '');
});

test('validación del diseño: los faltantes de FIRMA salen con su etiqueta, también ocultos por condición', async () => {
  const {definition: api} = await setup();
  const d = definicion([{...campo('pg-1'), tipo: 'SELECTOR'},
    campo('cp-firma', {texto: 'Firma del titular', obligatorio: true}),
    campo('cp-cond', {texto: 'Firma del tutor', obligatorio: true, condicion: {reglas: [{fuente: 'pg-1', op: 'es', valor: 'Menor'}]}})]);
  const estado = valores => ({valores, identidad: {}, contacto: {}, apoderado: {}});
  let r = api.evaluarDiseno(d, estado({'pg-1': 'Mayor'}), '2026-10-17T11:00:00-03:00');
  assert.deepEqual(plain(api.faltantesDelDiseno(r.campos, r.efectivas)), ['Firma del titular']);
  assert.deepEqual(plain(api.problemasDelDiseno(r.campos, r.efectivas)),
    ['Firma del titular: Falta la firma con el nombre y el DNI de quien firma.']);
  r = api.evaluarDiseno(d, estado({'pg-1': 'Mayor', 'cp-firma': firma()}), '2026-10-17T11:00:00-03:00');
  assert.equal(api.problemasDelDiseno(r.campos, r.efectivas).length, 0);
  assert.deepEqual(plain(api.firmanteDe(firma({firmante: {nombre: ' Ana ', dni: '30.123.456'}}))), {nombre: 'Ana', dni: '30123456'});
});

test('Becas constructor: respuestas[clave] = {nombre, dni} y el PNG sube como adjunto por clave', async () => {
  const r = await setup('android');
  const d = definicion([campo('cp-firma', {obligatorio: true})]);
  r.setOnline(false);
  const saved = await r.service.saveBecasFormulario({relevamiento_id: 1, version_capturada: 3,
    definicion_formulario: d, campos_definicion: r.definition.camposDelDiseno(d),
    respuestas: {'cp-firma': firma({fileName: 'firma-cp-firma.png'})}});
  const local = JSON.parse(r.sql.prepare('SELECT payload_json FROM outbox_relevamientos WHERE local_id=?').get(saved.record.local_id).payload_json);
  assert.deepEqual(local.respuestas['cp-firma'], {nombre: 'Ana Pérez', dni: '30123456'});
  assert.equal(local.adjuntos_formulario.length, 1);
  assert.equal(local.adjuntos_formulario[0].key, 'cp-firma');
  assert.equal(local.adjuntos_formulario[0].fileName, 'firma-cp-firma.png');
  assert.equal(local.adjuntos_formulario[0].mimeType, 'image/png');
  assert.deepEqual(local.adjuntos_formulario[0].firmante, {nombre: 'Ana Pérez', dni: '30123456'});
  r.setOnline(true);
  const calls = [];
  r.setFetch(async (url, options) => {
    calls.push({url, options});
    return response(201, {id: 99});
  });
  assert.equal((await r.service.syncPendingOperations()).synced, 1);
  const alta = calls.find(c => typeof c.options.body === 'string');
  const body = JSON.parse(alta.options.body);
  assert.deepEqual(body.respuestas, {'cp-firma': {nombre: 'Ana Pérez', dni: '30123456'}});
  assert.equal(Object.hasOwn(body.respuestas['cp-firma'], 'fecha'), false, 'la fecha la pone el servidor');
  const subida = calls.find(c => c.url.endsWith('/api/becas/formularios/99/adjuntos/'));
  assert.ok(subida, 'sube la imagen al endpoint de adjuntos');
  assert.ok(subida.options.body.fields.some(([k, v]) => k === 'clave' && v === 'cp-firma'));
  const archivo = subida.options.body.fields.find(([k]) => k === 'archivo');
  assert.equal(archivo[1].name, 'firma-cp-firma.png');
  assert.equal(archivo[1].type, 'image/png');
});

test('Becas legacy: data[bucket][id] = {nombre, dni} y el PNG sube con pregunta_global / requisito_nativo', async () => {
  const r = await setup('android');
  r.setOnline(false);
  const saved = await r.service.saveBecasFormulario({relevamiento_id: 1, version_capturada: 3,
    definicion_formulario: {version: 3, globales: [], requisitos: []},
    data: {globales: {5: firma()}, requisitos: {8: firma({fileName: 'firma-rn-8.png', firmante: {nombre: 'Eva', dni: '1234567'}})}, meta: {}},
    campos_definicion: [{id: 5, original_id: 5, scope: 'globales', tipo: 'FIRMA'}, {id: 8, original_id: 8, scope: 'requisitos', tipo: 'FIRMA'}]});
  const local = JSON.parse(r.sql.prepare('SELECT payload_json FROM outbox_relevamientos WHERE local_id=?').get(saved.record.local_id).payload_json);
  assert.deepEqual(local.data.globales['5'], {nombre: 'Ana Pérez', dni: '30123456'});
  assert.deepEqual(local.data.requisitos['8'], {nombre: 'Eva', dni: '1234567'});
  r.setOnline(true);
  const calls = [];
  r.setFetch(async (url, options) => {calls.push({url, options}); return response(201, {id: 77});});
  assert.equal((await r.service.syncPendingOperations()).synced, 1);
  const body = JSON.parse(calls.find(c => typeof c.options.body === 'string').options.body);
  assert.deepEqual(body.data.globales, {5: {nombre: 'Ana Pérez', dni: '30123456'}});
  assert.deepEqual(body.data.requisitos, {8: {nombre: 'Eva', dni: '1234567'}});
  assert.equal(Object.hasOwn(body, 'respuestas'), false);
  const subidas = calls.filter(c => c.url.endsWith('/api/becas/formularios/77/adjuntos/'))
    .map(c => Object.fromEntries(c.options.body.fields.filter(([, v]) => typeof v === 'string' || typeof v === 'number')));
  assert.deepEqual(plain(subidas), [{pregunta_global: '5'}, {requisito_nativo: '8'}]);
});

test('Becas web offline: la firma (data: URI) queda en SQLite y sube sin fetch', async () => {
  const r = await setup('web');
  r.setOnline(false);
  const d = definicion([campo('cp-firma', {obligatorio: true})]);
  const saved = await r.service.saveBecasFormulario({relevamiento_id: 1, version_capturada: 3,
    definicion_formulario: d, campos_definicion: r.definition.camposDelDiseno(d),
    respuestas: {'cp-firma': firma({uri: PNG_WEB, fileName: 'firma-cp-firma.png', size: null})}});
  const outbox = JSON.parse(r.sql.prepare('SELECT payload_json FROM outbox_relevamientos WHERE local_id=?').get(saved.record.local_id).payload_json);
  assert.equal(outbox.adjuntos_formulario[0].uri, PNG_WEB);
  assert.deepEqual(outbox.respuestas['cp-firma'], {nombre: 'Ana Pérez', dni: '30123456'});
  r.setOnline(true);
  let subida;
  r.setFetch(async (url, options) => {
    if (url.endsWith('/adjuntos/')) subida = options.body.fields.find(([k]) => k === 'archivo');
    return response(201, {id: 99});
  });
  assert.equal((await r.service.syncPendingOperations()).synced, 1);
  assert.ok(subida, 'subió la imagen');
  assert.equal(subida[1].type, 'image/png');
});

test('Relevamiento edilicio: respuestas[clave] = {nombre, dni} y archivos[clave] = el PNG', async () => {
  const r = await setup();
  const FORMULARIO = {version: 10, definicion: {version: 10, items: [{tipo: 'grupo', clave: 'g1', items: [
    {tipo_item: 'campo', clave: 'cp-firma', tipo: 'FIRMA', opciones: [], obligatorio: true}]}]}};
  const detalle = {id: 5, estado: 'ASIGNADA', formulario_version: 10, formulario: FORMULARIO, edificio: {id: 1}, fotos: []};
  const calls = [];
  r.setFetch(async (url, init = {}) => {
    calls.push({url: String(url), method: init.method || 'GET', body: init.body});
    if (String(url).endsWith('resultado/')) return response(200, {...detalle, estado: 'REALIZADA'});
    if ((init.method || 'GET') === 'GET') return response(200, detalle);
    return response(201, {id: 1});
  });
  const d = r.load('./dispositivosService');
  await d.getInspeccion(5);
  const png = firma({fileName: 'firma-cp-firma.png'});
  await d.enviarResultado(5, {criticidad: 'BAJA', respuestas: {'cp-firma': {nombre: 'Ana Pérez', dni: '30123456'}},
    archivos: {'cp-firma': png}, fotos: []}, {sincronizar: false});
  const op = JSON.parse(r.sql.prepare('SELECT payload_json FROM outbox_dispositivos ORDER BY rowid DESC').get().payload_json);
  assert.deepEqual(op.respuestas, {'cp-firma': {nombre: 'Ana Pérez', dni: '30123456'}});
  assert.equal(op.archivos.length, 1);
  assert.equal(op.archivos[0].clave, 'cp-firma');
  assert.equal(op.archivos[0].fileName, 'firma-cp-firma.png');
  assert.equal(op.archivos[0].mimeType, 'image/png');
  assert.deepEqual(op.archivos[0].firmante, {nombre: 'Ana Pérez', dni: '30123456'});
  assert.equal((await d.syncPendientes()).synced, 1);
  const resultado = calls.find(c => c.url.endsWith('resultado/'));
  assert.deepEqual(JSON.parse(resultado.body).respuestas, {'cp-firma': {nombre: 'Ana Pérez', dni: '30123456'}});
  const adjunto = calls.find(c => c.url.endsWith('adjuntos/'));
  assert.ok(adjunto.body.fields.some(([k, v]) => k === 'clave' && v === 'cp-firma'));
  assert.equal(adjunto.body.fields.find(([k]) => k === 'archivo')[1].name, 'firma-cp-firma.png');
});

test('Relevamiento edilicio: una carga rechazada devuelve la firma con su firmante', async () => {
  const r = await setup();
  const FORMULARIO = {version: 10, definicion: {version: 10, items: [{tipo: 'grupo', clave: 'g1', items: [
    {tipo_item: 'campo', clave: 'cp-firma', tipo: 'FIRMA', opciones: [], obligatorio: true}]}]}};
  const detalle = {id: 5, estado: 'ASIGNADA', formulario_version: 10, formulario: FORMULARIO, edificio: {id: 1}, fotos: []};
  r.setFetch(async (url, init = {}) => (init.method === 'POST'
    ? response(400, {code: 'VALIDACION', detail: 'cp-otro: requerido'}) : response(200, detalle)));
  const d = r.load('./dispositivosService');
  await d.getInspeccion(5);
  await d.enviarResultado(5, {criticidad: 'BAJA', respuestas: {'cp-firma': {nombre: 'Ana Pérez', dni: '30123456'}},
    archivos: {'cp-firma': firma({fileName: 'firma-cp-firma.png'})}, fotos: []}, {sincronizar: false});
  await d.syncPendientes();
  const previa = await d.getCargaRechazada(5);
  assert.ok(previa, 'quedó rechazada');
  assert.deepEqual(plain(previa.archivos['cp-firma'].firmante), {nombre: 'Ana Pérez', dni: '30123456'});
  assert.equal(previa.archivos['cp-firma'].fileName, 'firma-cp-firma.png');
});
