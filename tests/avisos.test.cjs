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

test('rechazos: el listado actual se consulta aunque haya vencido, pero un 404 deja de seguirlo', async () => {
  const e = await entorno();
  await e.detectores.detectarRelevamientosNuevos(e.ctx(), [rel(1), rel(2)]);
  e.responder({[ruta(1)]: errorHttp(404), [ruta(2)]: []});
  await e.detectores.detectarRechazos(e.ctx(), [rel(1), rel(2)]);
  e.llamadas.pedidos.length = 0;
  await e.detectores.detectarRechazos(e.ctx(), [rel(1), rel(2)]);
  assert.deepEqual(e.llamadas.pedidos, [ruta(2)]);
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

test('rechazos con la API real: un 404 del servidor se reconoce por su status', async () => {
  const e = await entorno();
  await e.detectores.detectarRelevamientosNuevos(e.ctx(), [rel(1)]);
  let pedidos = 0;
  e.t.setFetch(async () => { pedidos += 1; return response(404, {detail: 'No encontrado'}); });
  const ctx = e.ctx({pedir: ruta => e.t.api.becasRequest(ruta)});
  await e.detectores.detectarRechazos(ctx, [rel(1)]);
  await e.detectores.detectarRechazos(ctx, [rel(1)]);
  assert.equal(pedidos, 1);
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

test('bandeja: los leídos con más de 30 días se borran solos y los no leídos se quedan', async () => {
  const e = await entorno();
  const hace = dias => Date.parse(AHORA) - dias * DIA;
  await e.avisos.crearAviso(e.db, e.owner, {tipo: 'x', clave: 'viejo-leido', titulo: 'a'}, hace(40));
  await e.avisos.crearAviso(e.db, e.owner, {tipo: 'x', clave: 'viejo-sin-leer', titulo: 'b'}, hace(40));
  await e.avisos.crearAviso(e.db, e.owner, {tipo: 'x', clave: 'reciente-leido', titulo: 'c'}, hace(5));
  const lista = await e.avisos.listarAvisos(e.db, e.owner);
  for (const clave of ['viejo-leido', 'reciente-leido']) {
    await e.avisos.marcarLeido(e.db, e.owner, lista.find(a => a.clave === clave).id, hace(clave === 'viejo-leido' ? 35 : 1));
  }
  await e.avisos.purgarLeidosViejos(e.db, e.owner, Date.parse(AHORA));
  assert.deepEqual((await e.avisos.listarAvisos(e.db, e.owner)).map(a => a.clave).sort(), ['reciente-leido', 'viejo-sin-leer']);
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
