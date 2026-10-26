// Avisos dentro de la app (etapa A): bandeja, detectores y aislamiento.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {setup, response} = require('./helpers/mobile-runtime.cjs');

const AHORA = '2026-10-26T12:00:00Z';
const HORA = 3600 * 1000;
const DIA = 24 * HORA;

async function entorno({owner = '7'} = {}) {
  const t = await setup();
  t.setNow(AHORA);
  t.values.set('user_data', JSON.stringify({id: Number(owner)}));
  const avisos = t.load('./avisos');
  const detectores = t.load('./detectoresAvisos');
  const db = await t.service.getAvisosDb();
  const llamadas = {pedidos: [], enCurso: 0, maximoEnParalelo: 0};
  let respuestas = {};
  const pedir = async (ruta) => {
    llamadas.pedidos.push(ruta); llamadas.enCurso += 1;
    llamadas.maximoEnParalelo = Math.max(llamadas.maximoEnParalelo, llamadas.enCurso);
    try {
      await new Promise(resolve => setTimeout(resolve, 1));
      const hecho = respuestas[ruta];
      if (hecho instanceof Error) throw hecho;
      return hecho ?? [];
    } finally { llamadas.enCurso -= 1; }
  };
  const ctx = (extra = {}) => ({db, owner, pedir, hayRed: async () => true, ...extra});
  return {t, avisos, detectores, db, llamadas, pedir, ctx, responder: valor => { respuestas = valor; }, owner};
}

const rel = (id, extra = {}) => ({id, backend: 'django_becas', numero: `N${id}`, titulo: `Rel ${id}`,
  fecha_hasta: '2099-12-31T23:59:59-03:00', estado: 'ASIGNADO', ...extra});
const ruta = id => `/api/becas/relevamientos/${id}/formularios/`;
const rechazado = (id, extra = {}) => ({id, estado: 'RECHAZADO', ciudadano_apellido: 'Perez', ciudadano_nombre: 'Ana',
  ciudadano_dni: '30111222', motivo_rechazo: 'DNI ilegible', ...extra});
const errorHttp = status => Object.assign(new Error(`HTTP ${status}`), {status});

const insertarOperacion = (t, id, {status = 'PENDING', creada, codigo = null, error = null, relevamiento = 1, tipo = 'insert_relevamiento', owner = '7'} = {}) =>
  t.sql.prepare(`INSERT INTO outbox_relevamientos (local_id,op_id,type,payload_json,created_at,status,updated_at,last_error,last_error_code)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(id, `op-${id}`, tipo,
    JSON.stringify({_owner_user_id: owner, relevamiento_id: relevamiento}), creada, status, creada, error, codigo);
const operaciones = async t => t.service.getOperacionesParaAvisos();

// ---------------------------------------------------------------- relevamiento nuevo
test('relevamiento nuevo: la primera pasada es la línea de base y la segunda avisa el id nuevo', async () => {
  const e = await entorno();
  assert.equal((await e.detectores.detectarRelevamientosNuevos(e.ctx(), [rel(1), rel(2)])).length, 0);
  assert.equal(await e.avisos.contarNoLeidos(e.db, e.owner), 0);
  const creados = await e.detectores.detectarRelevamientosNuevos(e.ctx(), [rel(1), rel(2), rel(3, {fecha_hasta: '2099-11-05T23:59:59-03:00'})]);
  assert.equal(creados.length, 1);
  const [aviso] = await e.avisos.listarAvisos(e.db, e.owner);
  assert.equal(aviso.clave, 'rel:3');
  assert.equal(aviso.titulo, 'Te asignaron el relevamiento N° N3');
  assert.equal(aviso.texto, 'Rel 3 · vence el 05/11');
  assert.equal(String(aviso.relevamiento_id), '3');
  assert.equal(aviso.tipo, 'relevamiento_nuevo');
});

test('relevamiento nuevo: el número cae al id si el listado no lo trae y los ids locales no cuentan', async () => {
  const e = await entorno();
  await e.detectores.detectarRelevamientosNuevos(e.ctx(), [rel(1)]);
  await e.detectores.detectarRelevamientosNuevos(e.ctx(), [rel(1), rel(9, {numero: null}), {...rel('local_rel_1'), backend: 'otro'}]);
  const lista = await e.avisos.listarAvisos(e.db, e.owner);
  assert.equal(lista.length, 1);
  assert.equal(lista[0].titulo, 'Te asignaron el relevamiento N° 9');
});

test('clave única: el mismo evento dos veces deja un solo aviso', async () => {
  const e = await entorno();
  const base = {tipo: 'relevamiento_nuevo', clave: 'rel:5', titulo: 'T', texto: 'x'};
  assert.equal(await e.avisos.crearAviso(e.db, e.owner, base), true);
  assert.equal(await e.avisos.crearAviso(e.db, e.owner, base), false);
  await e.detectores.detectarRelevamientosNuevos(e.ctx(), [rel(1)]);
  await e.detectores.detectarRelevamientosNuevos(e.ctx(), [rel(1), rel(2)]);
  await e.db.runAsync('DELETE FROM avisos_relevamientos_vistos WHERE relevamiento_id = ?', '2');
  await e.detectores.detectarRelevamientosNuevos(e.ctx(), [rel(1), rel(2)]);
  assert.equal((await e.avisos.listarAvisos(e.db, e.owner)).filter(a => a.clave === 'rel:2').length, 1);
  assert.equal((await e.avisos.listarAvisos(e.db, e.owner)).length, 2);
});

test('la tabla impone la unicidad por dueño y clave aunque el código no la compruebe', async () => {
  const e = await entorno();
  const insertar = () => e.db.runAsync(`INSERT INTO avisos (owner,tipo,clave,titulo,creado_en) VALUES ('7','x','k','t','2026-10-26T12:00:00Z')`);
  await insertar();
  await assert.rejects(insertar, /UNIQUE/);
});

// ---------------------------------------------------------------- rechazos
test('rechazos: un rechazo nuevo avisa con el motivo; el que ya existía al seguir el relevamiento, no', async () => {
  const e = await entorno();
  await e.detectores.detectarRelevamientosNuevos(e.ctx(), [rel(1)]);
  e.responder({[ruta(1)]: [rechazado(10), {id: 11, estado: 'ENVIADO'}]});
  assert.equal((await e.detectores.detectarRechazos(e.ctx(), [rel(1)])).length, 0);
  e.responder({[ruta(1)]: {results: [rechazado(10), rechazado(12, {ciudadano_apellido: 'Gomez', ciudadano_nombre: 'Luis', ciudadano_dni: '22333444', motivo_rechazo: 'Falta firma'}), {id: 11, estado: 'RECHAZADO'}]}});
  const creados = await e.detectores.detectarRechazos(e.ctx(), [rel(1)]);
  assert.equal(creados.length, 2);
  const lista = await e.avisos.listarAvisos(e.db, e.owner);
  const aviso = lista.find(a => a.clave === 'rech:12');
  assert.equal(aviso.tipo, 'caso_rechazado');
  assert.equal(aviso.titulo, 'Rechazaron un caso del relevamiento N° N1');
  assert.equal(aviso.texto, 'Gomez, Luis (DNI 22333444) · Motivo: Falta firma');
  assert.equal(String(aviso.relevamiento_id), '1');
  assert.equal(String(aviso.formulario_id), '12');
  // El rechazo sin datos omite los campos vacíos.
  assert.equal(lista.find(a => a.clave === 'rech:11').texto, '');
  // Otra pasada no repite.
  assert.equal((await e.detectores.detectarRechazos(e.ctx(), [rel(1)])).length, 0);
});

test('rechazos: un relevamiento que aparece después también arranca con su propia línea de base', async () => {
  const e = await entorno();
  await e.detectores.detectarRelevamientosNuevos(e.ctx(), [rel(1)]);
  e.responder({[ruta(1)]: [], [ruta(2)]: [rechazado(50)]});
  await e.detectores.detectarRechazos(e.ctx(), [rel(1)]);
  await e.detectores.detectarRelevamientosNuevos(e.ctx(), [rel(1), rel(2)]);
  assert.equal((await e.detectores.detectarRechazos(e.ctx(), [rel(1), rel(2)])).length, 0);
  assert.equal((await e.avisos.listarAvisos(e.db, e.owner)).filter(a => a.tipo === 'caso_rechazado').length, 0);
});

test('rechazos: un relevamiento vencido hace más de 30 días y fuera del listado deja de consultarse', async () => {
  const e = await entorno();
  const viejo = rel(1, {fecha_hasta: '2026-08-01T23:59:59-03:00'});
  const reciente = rel(2, {fecha_hasta: '2026-10-20T23:59:59-03:00'});
  await e.detectores.detectarRelevamientosNuevos(e.ctx(), [viejo, reciente, rel(3)]);
  await e.detectores.detectarRechazos(e.ctx(), [rel(3)]);
  assert.deepEqual([...e.llamadas.pedidos].sort(), [ruta(2), ruta(3)]);
});

test('rechazos: un 404 en JSON de un relevamiento que ya no está en el listado deja de seguirlo', async () => {
  const e = await entorno();
  await e.detectores.detectarRelevamientosNuevos(e.ctx(), [rel(1), rel(2)]);
  e.responder({[ruta(1)]: errorHttp(404), [ruta(2)]: []});
  await e.detectores.detectarRechazos(e.ctx(), [rel(2)]);
  e.llamadas.pedidos.length = 0;
  await e.detectores.detectarRechazos(e.ctx(), [rel(2)]);
  assert.deepEqual(e.llamadas.pedidos, [ruta(2)]);
  // Aunque vuelva a aparecer en el listado, ya no se sigue.
  e.llamadas.pedidos.length = 0;
  await e.detectores.detectarRechazos(e.ctx(), [rel(1), rel(2)]);
  assert.deepEqual(e.llamadas.pedidos, [ruta(2)]);
});

test('rechazos: un 404 con el relevamiento todavía en el listado, o un 404 HTML, se saltea sin dejar de seguir', async () => {
  const e = await entorno();
  await e.detectores.detectarRelevamientosNuevos(e.ctx(), [rel(1), rel(2)]);
  const html = Object.assign(errorHttp(404), {unexpectedHtml: true});
  e.responder({[ruta(1)]: errorHttp(404), [ruta(2)]: html});
  await e.detectores.detectarRechazos(e.ctx(), [rel(1)]); // 1 listado con 404 JSON; 2 fuera del listado con 404 HTML
  e.llamadas.pedidos.length = 0;
  e.responder({[ruta(1)]: [], [ruta(2)]: []});
  await e.detectores.detectarRechazos(e.ctx(), [rel(1)]);
  assert.deepEqual([...e.llamadas.pedidos].sort(), [ruta(1), ruta(2)]);
});

test('rechazos: 401/403 cortan la pasada y 5xx o red se saltean y se reintentan', async () => {
  const e = await entorno();
  await e.detectores.detectarRelevamientosNuevos(e.ctx(), [rel(1), rel(2), rel(3)]);
  e.responder({[ruta(1)]: errorHttp(403), [ruta(2)]: [], [ruta(3)]: []});
  await e.detectores.detectarRechazos(e.ctx(), [rel(1), rel(2), rel(3)]);
  assert.deepEqual(e.llamadas.pedidos, [ruta(1)]);
  e.llamadas.pedidos.length = 0;
  e.responder({[ruta(1)]: errorHttp(502), [ruta(2)]: Object.assign(new Error('Network request failed'), {network: true}), [ruta(3)]: []});
  await e.detectores.detectarRechazos(e.ctx(), [rel(1), rel(2), rel(3)]);
  assert.deepEqual(e.llamadas.pedidos, [ruta(1), ruta(2), ruta(3)]);
  e.llamadas.pedidos.length = 0;
  // La línea de base del que falló no se asentó: cuando responde, lo existente no avisa.
  e.responder({[ruta(1)]: [rechazado(70)], [ruta(2)]: [], [ruta(3)]: []});
  assert.equal((await e.detectores.detectarRechazos(e.ctx(), [rel(1), rel(2), rel(3)])).length, 0);
  assert.deepEqual(e.llamadas.pedidos, [ruta(1), ruta(2), ruta(3)]);
});

test('rechazos: sin red no consulta y las consultas van de a una', async () => {
  const e = await entorno();
  await e.detectores.detectarRelevamientosNuevos(e.ctx(), [rel(1), rel(2), rel(3), rel(4)]);
  await e.detectores.detectarRechazos(e.ctx({hayRed: async () => false}), [rel(1), rel(2)]);
  assert.equal(e.llamadas.pedidos.length, 0);
  await e.detectores.detectarRechazos(e.ctx(), [rel(1), rel(2), rel(3), rel(4)]);
  assert.equal(e.llamadas.pedidos.length, 4);
  assert.equal(e.llamadas.maximoEnParalelo, 1);
});

test('rechazos con la API real: un 404 JSON de un relevamiento fuera del listado se reconoce; el HTML no', async () => {
  const e = await entorno();
  await e.detectores.detectarRelevamientosNuevos(e.ctx(), [rel(1), rel(2)]);
  const pedidos = [];
  e.t.setFetch(async url => {
    pedidos.push(String(url).includes('/1/') ? 1 : 2);
    return String(url).includes('/1/') ? response(404, {detail: 'No encontrado'})
      : response(404, '<!doctype html><html></html>', {'content-type': 'text/html'});
  });
  const ctx = e.ctx({pedir: ruta => e.t.api.becasRequest(ruta)});
  await e.detectores.detectarRechazos(ctx, []);
  await e.detectores.detectarRechazos(ctx, []);
  assert.deepEqual(pedidos, [1, 2, 2]);
});

test('rechazos: un 200 que no es una lista no asienta la línea de base ni marca nada', async () => {
  const e = await entorno();
  await e.detectores.detectarRelevamientosNuevos(e.ctx(), [rel(1)]);
  e.responder({[ruta(1)]: {detail: '<!doctype html><html>'}});
  assert.equal((await e.detectores.detectarRechazos(e.ctx(), [rel(1)])).length, 0);
  e.responder({[ruta(1)]: {foo: 'bar'}});
  await e.detectores.detectarRechazos(e.ctx(), [rel(1)]);
  assert.equal(await e.avisos.leerEstado(e.db, e.owner, 'base_rechazos:1'), null);
  // La primera respuesta buena es la línea de base: lo que ya estaba rechazado no avisa.
  e.responder({[ruta(1)]: [rechazado(70), rechazado(71)]});
  assert.equal((await e.detectores.detectarRechazos(e.ctx(), [rel(1)])).length, 0);
  assert.equal(await e.avisos.contarNoLeidos(e.db, e.owner), 0);
});

test('listado: un 200 con HTML no es dato fresco; una lista bien formada sí', async () => {
  const e = await entorno();
  e.t.setFetch(async () => response(200, '<html>login</html>', {'content-type': 'text/html'}));
  const malo = await e.t.service.getRelevamientos({refreshFromRemote: true});
  assert.notEqual(malo.remoto_bien_formado, true);
  e.t.setFetch(async () => response(200, []));
  assert.equal((await e.t.service.getRelevamientos({refreshFromRemote: true})).remoto_bien_formado, true);
});

test('el «N°» del aviso sale del numero del back y no del id (pasando por getRelevamientos)', async () => {
  const e = await entorno();
  const fila = (id, numero) => ({id, numero, nombre: 'Relevamiento 00' + numero + ' · Conv', estado: 'ASIGNADO',
    fecha_asignada: '2020-01-01T00:00:00-03:00', fecha_hasta: '2099-11-05T23:59:59-03:00'});
  let listado = [fila(5, 1)];
  e.t.setFetch(async url => String(url).endsWith('/api/becas/relevamientos/') ? response(200, listado)
    : response(200, {...listado[0], definicion_formulario: {version: 3, globales: [], requisitos: []}}));
  await e.detectores.detectarRelevamientosNuevos(e.ctx(), (await e.t.service.getRelevamientos({refreshFromRemote: true})).records);
  listado = [fila(5, 1), fila(347, 3)];
  const records = (await e.t.service.getRelevamientos({refreshFromRemote: true})).records;
  await e.detectores.detectarRelevamientosNuevos(e.ctx(), records);
  const aviso = (await e.avisos.listarAvisos(e.db, e.owner)).find(a => a.clave === 'rel:347');
  assert.equal(aviso.titulo, 'Te asignaron el relevamiento N° 3');
  assert.equal(aviso.texto, 'Relevamiento 003 · Conv · vence el 05/11');
});

// ---------------------------------------------------------------- cola
test('cola: una carga que requiere atención crea un aviso con su motivo y no se repite', async () => {
  const e = await entorno();
  insertarOperacion(e.t, 'op1', {status: 'FAILED_PERMANENT', creada: '2026-10-26T11:00:00Z', codigo: 'ALTA_INVALIDA', error: 'DNI: ya existe', relevamiento: 4});
  insertarOperacion(e.t, 'op2', {status: 'FAILED_PERMANENT', creada: '2026-10-26T11:00:00Z', codigo: 'SIN_ACCESO', error: 'otra cosa'});
  assert.equal((await e.detectores.detectarCola(e.ctx(), await operaciones(e.t))).length, 1);
  assert.equal((await e.detectores.detectarCola(e.ctx(), await operaciones(e.t))).length, 0);
  const [aviso] = await e.avisos.listarAvisos(e.db, e.owner);
  assert.equal(aviso.clave, 'cola:op1');
  assert.equal(aviso.titulo, 'Una carga necesita tu atención');
  assert.equal(aviso.texto, 'DNI: ya existe');
  assert.equal(String(aviso.relevamiento_id), '4');
  assert.equal(aviso.tipo, 'carga_atencion');
});

test('cola: una carga pendiente de más de 2 horas avisa una vez, y otra vez al vaciarse la cola o a las 24 h', async () => {
  const e = await entorno();
  insertarOperacion(e.t, 'a', {creada: '2026-10-26T09:00:00Z', relevamiento: 6});
  insertarOperacion(e.t, 'b', {creada: '2026-10-26T11:30:00Z'});
  const texto = async () => (await e.avisos.listarAvisos(e.db, e.owner)).filter(a => a.tipo === 'cargas_sin_subir');
  assert.equal((await e.detectores.detectarCola(e.ctx(), await operaciones(e.t))).length, 1);
  assert.equal((await texto())[0].titulo, 'Tenés 2 cargas sin subir');
  assert.equal(String((await texto())[0].relevamiento_id), '6');
  assert.equal((await e.detectores.detectarCola(e.ctx(), await operaciones(e.t))).length, 0);
  // Pasa una hora y sigue pendiente: no repite.
  e.t.setNow('2026-10-26T13:00:00Z');
  assert.equal((await e.detectores.detectarCola(e.ctx(), await operaciones(e.t))).length, 0);
  // La cola se vacía y vuelve a llenarse con una carga vieja: avisa otra vez.
  e.t.sql.exec('DELETE FROM outbox_relevamientos');
  await e.detectores.detectarCola(e.ctx(), await operaciones(e.t));
  insertarOperacion(e.t, 'c', {creada: '2026-10-26T10:00:00Z'});
  assert.equal((await e.detectores.detectarCola(e.ctx(), await operaciones(e.t))).length, 1);
  assert.equal((await texto())[0].titulo, 'Tenés 1 carga sin subir');
  // A las 24 h del último aviso, con la cola aún pendiente, repite.
  e.t.setNow(new Date(Date.parse('2026-10-26T13:00:00Z') + DIA + HORA).toISOString());
  assert.equal((await e.detectores.detectarCola(e.ctx(), await operaciones(e.t))).length, 1);
});

test('cola: menos de 2 horas, otro dueño o cargas que no son altas no avisan', async () => {
  const e = await entorno();
  insertarOperacion(e.t, 'nueva', {creada: '2026-10-26T10:30:00Z'});
  insertarOperacion(e.t, 'ajena', {creada: '2026-10-26T01:00:00Z', owner: '8'});
  insertarOperacion(e.t, 'accion', {creada: '2026-10-26T01:00:00Z', tipo: 'finalizar_relevamiento'});
  assert.equal((await e.detectores.detectarCola(e.ctx(), await operaciones(e.t))).length, 0);
});

// ---------------------------------------------------------------- bandeja
test('bandeja: el más nuevo arriba, marcar leído, marcar todo y contador', async () => {
  const e = await entorno();
  const crear = async (n, minutos) => e.avisos.crearAviso(e.db, e.owner, {tipo: 'x', clave: `k${n}`, titulo: `T${n}`, texto: ''},
    Date.parse(AHORA) - minutos * 60000);
  await crear(1, 30); await crear(2, 10); await crear(3, 20);
  assert.deepEqual((await e.avisos.listarAvisos(e.db, e.owner)).map(a => a.titulo), ['T2', 'T3', 'T1']);
  assert.equal(await e.avisos.contarNoLeidos(e.db, e.owner), 3);
  const [primero] = await e.avisos.listarAvisos(e.db, e.owner);
  await e.avisos.marcarLeido(e.db, e.owner, primero.id, Date.parse(AHORA));
  assert.equal(await e.avisos.contarNoLeidos(e.db, e.owner), 2);
  await e.avisos.marcarTodoLeido(e.db, e.owner, Date.parse(AHORA));
  assert.equal(await e.avisos.contarNoLeidos(e.db, e.owner), 0);
  assert.equal((await e.avisos.listarAvisos(e.db, e.owner)).length, 3);
});

test('retención: los avisos con más de 30 días se borran, leídos o no y de todos los dueños, y no reaparecen', async () => {
  const e = await entorno();
  const hace = dias => Date.parse(AHORA) - dias * DIA;
  await e.avisos.crearAviso(e.db, '7', {tipo: 'x', clave: 'viejo-leido', titulo: 'a'}, hace(40));
  await e.avisos.crearAviso(e.db, '7', {tipo: 'x', clave: 'viejo-sin-leer', titulo: 'b'}, hace(40));
  await e.avisos.crearAviso(e.db, '8', {tipo: 'x', clave: 'viejo-ajeno', titulo: 'c', texto: 'DNI 1'}, hace(31));
  await e.avisos.marcarTodoLeido(e.db, '7', hace(35));
  await e.avisos.crearAviso(e.db, '7', {tipo: 'x', clave: 'reciente-sin-leer', titulo: 'e'}, hace(2));
  await e.avisos.purgarAvisosViejos(e.db, Date.parse(AHORA));
  assert.deepEqual((await e.avisos.listarAvisos(e.db, '7')).map(a => a.clave).sort(), ['reciente-sin-leer']);
  assert.equal((await e.avisos.listarAvisos(e.db, '8')).length, 0);
  // El mismo hecho (misma clave) no reaparece como aviso nuevo.
  assert.equal(await e.avisos.crearAviso(e.db, '7', {tipo: 'x', clave: 'viejo-sin-leer', titulo: 'b'}, Date.parse(AHORA)), false);
  assert.equal(await e.avisos.crearAviso(e.db, '8', {tipo: 'x', clave: 'viejo-ajeno', titulo: 'c'}, Date.parse(AHORA)), false);
});

test('bandeja: «hace cuánto» en minutos, horas y días', async () => {
  const e = await entorno();
  const ahora = Date.parse(AHORA);
  const hace = ms => e.avisos.haceCuanto(new Date(ahora - ms).toISOString(), ahora);
  assert.equal(hace(10 * 1000), 'hace un momento');
  assert.equal(hace(5 * 60000), 'hace 5 min');
  assert.equal(hace(3 * HORA), 'hace 3 h');
  assert.equal(hace(2 * DIA), 'hace 2 días');
  assert.equal(hace(1 * DIA), 'hace 1 día');
});

// ---------------------------------------------------------------- usuarios
test('usuarios: el usuario A no ve los avisos ni los vistos del usuario B', async () => {
  const e = await entorno();
  await e.detectores.detectarRelevamientosNuevos(e.ctx(), [rel(1)]);
  await e.detectores.detectarRelevamientosNuevos(e.ctx(), [rel(1), rel(2)]);
  assert.equal(await e.avisos.contarNoLeidos(e.db, '7'), 1);
  assert.equal(await e.avisos.contarNoLeidos(e.db, '8'), 0);
  // B inicia sesión en el mismo teléfono: su primera pasada es línea de base, no avalancha.
  const b = e.ctx({owner: '8'});
  assert.equal((await e.detectores.detectarRelevamientosNuevos(b, [rel(1), rel(2)])).length, 0);
  assert.equal((await e.avisos.listarAvisos(e.db, '8')).length, 0);
  assert.equal(await e.avisos.contarNoLeidos(e.db, '8'), 0);
  // Y no puede marcar leído un aviso del otro.
  const [deA] = await e.avisos.listarAvisos(e.db, '7');
  await e.avisos.marcarLeido(e.db, '8', deA.id, Date.parse(AHORA));
  assert.equal(await e.avisos.contarNoLeidos(e.db, '7'), 1);
  // Las operaciones de la cola que devuelve el servicio son del usuario de la sesión.
  insertarOperacion(e.t, 'del-b', {creada: '2026-10-26T01:00:00Z', owner: '8'});
  assert.equal((await operaciones(e.t)).length, 0);
});

test('el servicio no crea avisos sin dueño', async () => {
  const e = await entorno();
  assert.equal(await e.avisos.crearAviso(e.db, '', {tipo: 'x', clave: 'k', titulo: 't'}), false);
});

// ---------------------------------------------------------------- aislamiento
test('aislamiento: un detector que falla no propaga el error y la sincronización sigue', async () => {
  const e = await entorno();
  const roto = e.ctx({db: {getAllAsync: async () => { throw new Error('boom'); }, getFirstAsync: async () => { throw new Error('boom'); },
    runAsync: async () => { throw new Error('boom'); }, execAsync: async () => { throw new Error('boom'); }}});
  assert.equal((await e.detectores.detectarRelevamientosNuevos(roto, [rel(1)])).length, 0);
  assert.equal((await e.detectores.detectarRechazos(roto, [rel(1)])).length, 0);
  assert.equal((await e.detectores.detectarCola(roto, [{local_id: 'x', status: 'FAILED_PERMANENT', last_error_code: 'ALTA_INVALIDA', payload: {}}])).length, 0);
  const fallaPedir = e.ctx({pedir: async () => { throw new Error('boom'); }});
  await e.detectores.detectarRelevamientosNuevos(fallaPedir, [rel(1)]);
  assert.equal((await e.detectores.detectarRechazos(fallaPedir, [rel(1)])).length, 0);
  // La cola y la sincronización siguen andando.
  insertarOperacion(e.t, 'pendiente', {creada: '2026-10-26T11:59:00Z'});
  e.t.setOnline(false);
  const resultado = await e.t.service.syncPendingOperations();
  assert.equal(resultado.failed, 0);
  assert.equal(await e.t.service.getPendingCount(), 1);
});

test('crear las tablas es idempotente y no toca la cola', async () => {
  const e = await entorno();
  insertarOperacion(e.t, 'persistente', {creada: '2026-10-26T11:00:00Z'});
  await e.avisos.crearTablasAvisos(e.db);
  await e.avisos.crearTablasAvisos(e.db);
  await e.t.service.getAvisosDb();
  assert.equal(e.t.sql.prepare('SELECT COUNT(*) AS n FROM outbox_relevamientos').get().n, 1);
});

// ---------------------------------------------------------------- sesión y lectura de la cola
test('sesión: si cambia a mitad de la pasada de rechazos no se graba nada más', async () => {
  const e = await entorno();
  await e.detectores.detectarRelevamientosNuevos(e.ctx(), [rel(1), rel(2)]);
  e.responder({[ruta(1)]: [], [ruta(2)]: []});
  await e.detectores.detectarRechazos(e.ctx(), [rel(1), rel(2)]); // línea de base
  let vigente = true;
  const ctx = e.ctx({sesionVigente: async () => vigente,
    pedir: async () => { vigente = false; return [rechazado(90)]; }});
  assert.equal((await e.detectores.detectarRechazos(ctx, [rel(1), rel(2)])).length, 0);
  assert.equal(await e.avisos.contarNoLeidos(e.db, e.owner), 0);
  assert.equal(e.t.sql.prepare('SELECT COUNT(*) AS n FROM avisos_rechazos_conocidos').get().n, 0);
  // Y con la sesión ya cambiada la pasada ni consulta ni graba.
  const cuenta = e.llamadas.pedidos.length;
  const cambiada = e.ctx({sesionVigente: async () => false});
  await e.detectores.detectarRechazos(cambiada, [rel(1)]);
  assert.equal((await e.detectores.detectarRelevamientosNuevos(cambiada, [rel(1), rel(77)])).length, 0);
  assert.equal(e.llamadas.pedidos.length, cuenta);
  assert.equal(e.t.sql.prepare("SELECT COUNT(*) AS n FROM avisos_relevamientos_vistos WHERE relevamiento_id = '77'").get().n, 0);
});

test('sesión: nunca se muestra un toast de un dueño que no es el usuario actual', async () => {
  const e = await entorno();
  const mostrados = [];
  assert.equal(await e.detectores.avisarSiVigente(e.ctx({sesionVigente: async () => false}), [{titulo: 'x'}], n => mostrados.push(n)), false);
  assert.equal(mostrados.length, 0);
  assert.equal(await e.detectores.avisarSiVigente(e.ctx({sesionVigente: async () => true}), [{titulo: 'x'}], n => mostrados.push(n)), true);
  assert.equal(mostrados.length, 1);
});

test('la cola para avisos trae solo las columnas necesarias, sin el payload', async () => {
  const e = await entorno();
  insertarOperacion(e.t, 'grande', {creada: '2026-10-26T01:00:00Z', relevamiento: 12});
  e.t.sql.prepare("UPDATE outbox_relevamientos SET payload_json = json_set(payload_json, '$.adjuntos', ?)").run('x'.repeat(5000));
  const [op] = await operaciones(e.t);
  assert.deepEqual(Object.keys(op.payload), ['relevamiento_id']);
  assert.equal(String(op.payload.relevamiento_id), '12');
  assert.equal(op.status, 'PENDING');
  assert.equal(op.local_id, 'grande');
});
