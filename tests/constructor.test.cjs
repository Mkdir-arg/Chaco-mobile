const {test} = require('node:test');
const assert = require('node:assert/strict');
const {setup, response} = require('./helpers/mobile-runtime.cjs');
const plain = value => JSON.parse(JSON.stringify(value));
const field = (clave, extra = {}) => ({tipo_item: 'campo', clave, id: Number(clave.split('-')[1]) || null,
  tipo: 'STRING', texto: clave, origen: 'pregunta', canal: 'ambos', ...extra});
const group = (clave, items, extra = {}) => ({tipo: 'grupo', clave, titulo: clave, items, ...extra});
const definition = items => ({version: 3, acepta_respuestas: true, items});
const state = (valores = {}, extra = {}) => ({valores, identidad: {}, contacto: {}, apoderado: {}, ...extra});
const capturedAt = '2026-10-17T11:00:00-03:00';

test('constructor order overrides catalogue orden and the former fixed scope steps', async () => {
  const {definition: api} = await setup();
  const d = definition([group('g-segmento', [field('rn-2', {orden: 99}), field('pg-1', {orden: 0})]),
    group('g-global', [field('cp-otro', {orden: 1})])]);
  assert.equal(api.camposDelDiseno(d).map(f => f.id).join(','), 'rn-2,pg-1,cp-otro');
  const moved = definition([d.items[1], group('g-segmento', [...d.items[0].items].reverse())]);
  const evaluated = api.evaluarDiseno(moved, state(), capturedAt);
  assert.equal(evaluated.grupos.map(g => g.clave).join(','), 'g-global,g-segmento');
  assert.equal(evaluated.campos.map(f => f.clave).join(','), 'cp-otro,pg-1,rn-2');
  assert.equal(api.usaConstructor({globales: []}), false);
  assert.equal(api.usaConstructor({items: []}), false); // P9: items vacio cae al camino legacy
});

test('ordered texts, overridden labels and group subtitles are preserved', async () => {
  const {definition: api} = await setup();
  const d = definition([group('g-info', [{tipo: 'texto', clave: 't-info', texto: 'Ver https://example.com'},
    field('pg-1', {texto: 'Etiqueta del diseño'})], {subtitulo: 'Indicaciones'})]);
  const result = api.evaluarDiseno(d, state(), capturedAt);
  assert.equal(result.grupos[0].items[0].tipo, 'texto');
  assert.equal(result.grupos[0].subtitulo, 'Indicaciones');
  assert.equal(result.campos[0].etiqueta, 'Etiqueta del diseño');
});

test('linked identity and contact values travel by the design keys', async () => {
  const {definition: api} = await setup();
  const d = definition([group('g-datos', [field('pg-1', {origen: 'legajo', vinculo: 'nombre'}),
    field('pg-2', {origen: 'legajo', vinculo: 'fecha_nacimiento', tipo: 'DATE'}),
    field('pg-3', {origen: 'legajo', vinculo: 'email'})])]);
  const result = api.evaluarDiseno(d, state({}, {identidad: {nombres: 'Ana', fecha_nacimiento: '14/03/1991'},
    contacto: {email_contacto: 'qa@example.com'}}), capturedAt);
  assert.deepEqual(plain(result.efectivas), {'pg-1': 'Ana', 'pg-2': '1991-03-14', 'pg-3': 'qa@example.com'});
  assert.equal(api.datosDelDiseno(d, result).email_contacto, 'qa@example.com');
  assert.equal(api.esIdentidad(result.campos[0]), true);
  assert.equal(api.esIdentidad(result.campos[2]), false);
});

test('apoderado follows the configured condition and clears hidden data', async () => {
  const {definition: api} = await setup();
  const d = definition([group('g-persona', [field('pg-1', {origen: 'legajo', vinculo: 'fecha_nacimiento', tipo: 'DATE'})]),
    group('g-apoderado', [field('pg-2', {origen: 'persona_vinculada', vinculo: 'nombre', obligatorio: true})],
      {condicion: {modo: 'todas', reglas: [{fuente: 'pg-1', op: 'edad_menor', valor: 18}]}})]);
  const values = state({}, {identidad: {fecha_nacimiento: '2010-01-01'}, apoderado: {nombre: 'Eva'}});
  const minor = api.evaluarDiseno(d, values, capturedAt);
  assert.equal(minor.grupos.length, 2);
  assert.equal(api.datosDelDiseno(d, minor).apoderado_nombre, 'Eva');
  values.identidad.fecha_nacimiento = '1990-01-01';
  const adult = api.evaluarDiseno(d, values, capturedAt);
  assert.equal(adult.grupos.length, 1);
  assert.equal(Object.hasOwn(adult.efectivas, 'pg-2'), false);
  assert.equal(api.datosDelDiseno(d, adult).apoderado_nombre, '');
  d.items[1].condicion = null;
  assert.equal(api.evaluarDiseno(d, values, capturedAt).grupos.length, 2, 'without a condition it is required for adults too');
});

test('age uses the captured day, including when correcting an old case', async () => {
  const {definition: api} = await setup();
  const d = definition([group('g-persona', [field('pg-1', {origen: 'legajo', vinculo: 'fecha_nacimiento', tipo: 'DATE'})]),
    group('g-menor', [field('cp-extra')], {condicion: {reglas: [{fuente: 'pg-1', op: 'edad_menor', valor: 18}]}})]);
  const values = state({}, {identidad: {fecha_nacimiento: '2008-10-18'}});
  assert.equal(api.evaluarDiseno(d, values, '2026-10-17T23:00:00-03:00').grupos.length, 2);
  assert.equal(api.evaluarDiseno(d, values, '2026-10-18T01:00:00-03:00').grupos.length, 1);
});

test('hidden required attachment is neither required nor included in answers', async () => {
  const {definition: api} = await setup();
  const d = definition([group('g-datos', [field('pg-1', {tipo: 'SELECTOR'}),
    field('cp-certificado', {tipo: 'ARCHIVO', obligatorio: true, condicion: {reglas: [{fuente: 'pg-1', op: 'es', valor: 'Secundario'}]}})])]);
  const values = state({'pg-1': 'Secundario'});
  let result = api.evaluarDiseno(d, values, capturedAt);
  assert.deepEqual(plain(api.faltantesDelDiseno(result.campos, result.efectivas)), ['cp-certificado']);
  values.valores['cp-certificado'] = {uri: 'file:///photo.jpg'};
  values.valores['pg-1'] = 'Primario';
  result = api.evaluarDiseno(d, values, capturedAt);
  assert.equal(result.campos.length, 1);
  assert.equal(Object.hasOwn(result.efectivas, 'cp-certificado'), false);
  assert.equal(api.faltantesDelDiseno(result.campos, result.efectivas).length, 0);
});

// Parity with condiciones.py: the server already nulls conditions on sources outside the
// channel when it serves the definition (BEC-04); whatever still arrives is evaluated as is.
test('link-only fields and empty groups disappear; a source missing from the definition evaluates as empty', async () => {
  const {definition: api} = await setup();
  const d = definition([group('g-link', [field('pg-1', {canal: 'link', obligatorio: true})]),
    group('g-app', [field('cp-vacio', {condicion: {reglas: [{fuente: 'pg-1', op: 'vacio'}]}}),
      field('cp-completo', {condicion: {reglas: [{fuente: 'pg-1', op: 'completo'}]}})])]);
  const result = api.evaluarDiseno(d, state({'pg-1': 'Sí'}), capturedAt);
  assert.equal(result.grupos.length, 1);
  assert.equal(result.grupos[0].clave, 'g-app');
  assert.equal(result.campos.map(f => f.clave).join(','), 'cp-vacio');
});

test('required numeric zero is valid, empty multiple choice and impossible dates are not', async () => {
  const {definition: api} = await setup();
  const d = definition([group('g', [field('cp-num', {tipo: 'INT', obligatorio: true}),
    field('cp-opciones', {tipo: 'SELECTOR_MULTIPLE', obligatorio: true}), field('cp-fecha', {tipo: 'DATE'})])]);
  const result = api.evaluarDiseno(d, state({'cp-num': 0, 'cp-opciones': [], 'cp-fecha': '31/02/2026'}), capturedAt);
  assert.deepEqual(plain(api.faltantesDelDiseno(result.campos, result.efectivas)), ['cp-opciones', 'cp-fecha']);
});

test('cached detail uses constructor order and keeps its immutable version when server changes', async () => {
  const r = await setup('android');
  const d = definition([group('g', [field('rn-2', {orden: 9}), field('pg-1', {orden: 0})])]);
  r.setFetch(async () => response(200, {id: 1, estado: 'EN_CURSO',
    fecha_asignada: '2020-01-01T00:00:00-03:00', fecha_hasta: '2099-12-31T23:59:59-03:00', definicion_formulario: d}));
  const detail = (await r.service.getRelevamientoDetail(1)).detail;
  assert.equal(detail.campos_definicion.map(f => f.clave).join(','), 'rn-2,pg-1');
  r.setOnline(false);
  const saved = await r.service.saveBecasFormulario({relevamiento_id: 1, version_capturada: d.version,
    definicion_formulario: d, campos_definicion: detail.campos_definicion, respuestas: {'rn-2': 'A', 'pg-1': 'B'}});
  const localId = saved.record.local_id;
  r.setOnline(true);
  let body;
  r.setFetch(async (url, options) => {
    body = JSON.parse(options.body);
    assert.equal(body.version_capturada, 3);
    assert.deepEqual(body.respuestas, {'rn-2': 'A', 'pg-1': 'B'});
    assert.equal(Object.hasOwn(body, 'definicion'), false);
    return response(201, {id: 99, version_capturada: 3, observaciones_carga: 'Versión anterior: vigente 4'});
  });
  r.sql.prepare("UPDATE local_relevamientos SET payload_json=? WHERE local_id='remote_django_becas_1'")
    .run(JSON.stringify({...detail, definicion_formulario: {...d, version: 4, items: []}}));
  await r.service.syncPendingOperations();
  const row = r.sql.prepare('SELECT * FROM outbox_relevamientos WHERE local_id=?').get(localId);
  assert.equal(row.status, 'SYNCED');
  assert.equal(JSON.parse(row.payload_json).definicion_formulario.version, 3);
  assert.equal(JSON.parse(row.payload_json).definicion_formulario.items[0].items[0].clave, 'rn-2');
});

test('own-field attachment is persisted offline and uploaded with its stable key', async () => {
  const r = await setup('android');
  const d = definition([group('g', [field('cp-doc', {tipo: 'ARCHIVO'})])]);
  r.setOnline(false);
  const saved = await r.service.saveBecasFormulario({relevamiento_id: 1, version_capturada: 3,
    definicion_formulario: d, campos_definicion: r.definition.camposDelDiseno(d),
    respuestas: {'cp-doc': {uri: 'file:///photo.jpg', fileName: 'photo.jpg', mimeType: 'image/jpeg', size: 100}}});
  const local = JSON.parse(r.sql.prepare('SELECT payload_json FROM outbox_relevamientos WHERE local_id=?').get(saved.record.local_id).payload_json);
  assert.equal(local.adjuntos_formulario[0].key, 'cp-doc');
  assert.equal(local.respuestas['cp-doc'].archivo_adjunto, true);
  r.setOnline(true);
  let uploaded = false;
  r.setFetch(async (url, options) => {
    if (url.endsWith('/adjuntos/')) {
      uploaded = true;
      assert.ok(options.body.fields.some(([key, value]) => key === 'clave' && value === 'cp-doc'));
      assert.equal(options.body.fields.some(([key]) => ['pregunta_global', 'requisito_nativo'].includes(key)), false);
    } else assert.equal(JSON.parse(options.body).respuestas['cp-doc'].archivo_adjunto, true);
    return response(201, {id: 99});
  });
  assert.equal((await r.service.syncPendingOperations()).synced, 1);
  assert.equal(uploaded, true);
});

test('legacy server receives the old payload; own fields are not silently lost', async () => {
  const r = await setup('android');
  let body;
  r.setFetch(async (url, options) => {body = JSON.parse(options.body); return response(201, {id: 99});});
  await r.service.saveBecasFormulario({relevamiento_id: 1, definicion_formulario: {globales: []},
    respuestas: {'pg-1': 'No usar'}, data: {globales: {'1': 'Legacy'}}});
  assert.equal(Object.hasOwn(body, 'respuestas'), false);
  assert.equal(body.data.globales['1'], 'Legacy');
  await assert.rejects(r.service.saveBecasFormulario({relevamiento_id: 1,
    definicion_formulario: {items: []}, campos_definicion: [{scope: 'propios'}]}), /actualizarse/);
});


test('offline without a cached definition asks to download the form first', async () => {
  const r = await setup();
  r.sql.prepare("UPDATE local_relevamientos SET payload_json=? WHERE local_id='remote_django_becas_1'")
    .run(JSON.stringify({id: 1, _owner_user_id: '7', backend: 'django_becas'}));
  r.setOnline(false);
  const result = await r.service.getRelevamientoDetail(1);
  assert.equal(result.success, false);
  assert.match(result.error, /descargar el formulario/);
});


for (const [op, value, expected, result] of [
  ['vacio', '', null, true], ['completo', 0, null, true], ['completo', [], null, false],
  ['no_adjuntado', {}, null, true], ['adjuntado', {uri: 'file:///a.jpg'}, null, true],
  ['es', 'Sí', 'Sí', true], ['no_es', '', 'Sí', false], ['es_alguno', 'B', ['A', 'B'], true],
  ['incluye', ['A', 'B'], 'A', true], ['no_incluye', ['A'], 'B', true], ['incluye_alguno', ['A'], ['B', 'A'], true],
  ['eq', '1,5', 1.5, true], ['ne', true, 1, false], ['lt', '2', 3, true], ['gt', 4, 3, true],
  ['le', 2, 2, true], ['ge', 2, 2, true], ['edad_menor', '2010-01-01', 18, true],
  ['edad_mayor', '1990-01-01', 18, true], ['edad_igual', '2008-10-17', 18, true],
  ['edad_entre', '2010-01-01', [18, 12], true], ['anterior', '2026-01-01', '2026-02-01', true],
  ['posterior', '01/03/2026', '2026-02-01', true], ['op_inexistente', 'A', 'A', false],
]) test('condition operator ' + op + ' matches the form semantics', async () => {
  const r = await setup();
  assert.equal(r.conditions.evaluarRegla({op, valor: expected}, value, new Date('2026-10-17T12:00:00')), result);
});

test('hidden source behaves as empty in chained conditions; any/all modes are preserved', async () => {
  const {definition: api} = await setup();
  const d = definition([group('g', [field('pg-1'),
    field('cp-hidden', {condicion: {reglas: [{fuente: 'pg-1', op: 'es', valor: 'Sí'}]}}),
    field('cp-next', {condicion: {modo: 'alguna', reglas: [{fuente: 'cp-hidden', op: 'vacio'}, {fuente: 'pg-1', op: 'es', valor: 'No'}]}})])]);
  const result = api.evaluarDiseno(d, state({'pg-1': 'No', 'cp-hidden': 'Old answer'}), capturedAt);
  assert.equal(Object.hasOwn(result.efectivas, 'cp-hidden'), false);
  assert.ok(result.campos.some(f => f.clave === 'cp-next'));
});


test('integer validation works offline for optional answers, zero, negatives and pasted text', async () => {
  const runtime = await setup();
  runtime.setOnline(false);
  const api = runtime.definition;
  for (const tipo of ['INT', 'NUMERO']) {
    const f = {clave: 'cp-num', etiqueta: 'Cantidad', tipo};
    for (const value of ['', 0, '-12', ' 23 ']) assert.equal(api.errorDelCampo(f, value), '');
    for (const value of ['abc', '12.5', '12,5', '1e3', '3 personas']) {
      assert.match(api.errorDelCampo(f, value), /número entero/);
      assert.match(api.problemasDelDiseno([f], {'cp-num': value})[0], /Cantidad: Ingresá/);
    }
    assert.match(api.errorDelCampo({...f, requerido: true}, ''), /obligatorio/);
  }
  assert.equal(api.errorDelCampo({tipo: 'STRING'}, '123 letras'), '');
});


test('linked email is validated before sync while plain text remains unrestricted', async () => {
  const r = await setup();
  r.setOnline(false);
  const f = {tipo: 'STRING', vinculo: 'email'};
  for (const value of ['mal', 'a@', 'a b@example.com', 'a@example']) assert.match(r.definition.errorDelCampo(f, value), /correo electrónico válido/);
  for (const value of ['', 'qa@example.com', 'qa+test@sub.example.com']) assert.equal(r.definition.errorDelCampo(f, value), '');
  assert.equal(r.definition.errorDelCampo({tipo: 'STRING'}, 'cualquier texto'), '');
});


test('DNI del apoderado: 7 u 8 dígitos tras quitar lo que no es dígito, vacío y oculto no se validan', async () => {
  const {definition: api} = await setup();
  const dni = field('pg-9', {origen: 'persona_vinculada', vinculo: 'dni', texto: 'DNI del apoderado'});
  const campo = {...dni, etiqueta: dni.texto};
  assert.match(api.errorDelCampo(campo, '343333333'), /DNI válido de 7 u 8 dígitos/);
  assert.match(api.problemasDelDiseno([campo], {'pg-9': '343333333'})[0], /DNI del apoderado: Ingresá un DNI válido/);
  for (const ok of ['34333333', '3433333', '34.333.333', '']) assert.equal(api.errorDelCampo(campo, ok), '');
  assert.match(api.errorDelCampo(campo, '123456'), /DNI válido/);
  // Otro vínculo de la persona vinculada no se ve afectado.
  assert.equal(api.errorDelCampo({...campo, vinculo: 'nombre'}, '343333333'), '');
  // Oculto por condición: el motor lo saca de efectivas y de los campos evaluados.
  const d = definition([group('g', [field('pg-1'),
    {...dni, condicion: {reglas: [{fuente: 'pg-1', op: 'es', valor: 'Sí'}]}}])]);
  const oculto = api.evaluarDiseno(d, state({'pg-1': 'No'}, {apoderado: {dni: '343333333'}}), capturedAt);
  assert.deepEqual(api.problemasDelDiseno(oculto.campos, oculto.efectivas), []);
  const visible = api.evaluarDiseno(d, state({'pg-1': 'Sí'}, {apoderado: {dni: '343333333'}}), capturedAt);
  assert.equal(api.problemasDelDiseno(visible.campos, visible.efectivas).length, 1);
});

test('DNI del apoderado viaja solo con dígitos en apoderado_dni y en respuestas', async () => {
  const {definition: api} = await setup();
  const d = definition([group('g', [field('pg-9', {origen: 'persona_vinculada', vinculo: 'dni'})])]);
  const result = api.evaluarDiseno(d, state({}, {apoderado: {dni: '34.333.333'}}), capturedAt);
  const datos = api.datosDelDiseno(d, result);
  assert.equal(datos.apoderado_dni, '34333333');
  assert.equal(datos.respuestas['pg-9'], '34333333');
});
