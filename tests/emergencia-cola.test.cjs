// services/emergenciaCola.js (M1 · Ingreso de familias): borrador con uuid, cola sin señal y
// clasificación de respuestas según contrato-app-emergencia §6, cachés de localidades (§5) y
// «Mis envíos» (§7). La red y el reloj son los del runtime de prueba.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {setup, response} = require('./helpers/mobile-runtime.cjs');

const T0 = Date.parse('2026-11-14T13:00:00Z');
const MIN = 60 * 1000;
const CASOS = '/api/emergencia/casos/';
const PERFIL = '/api/emergencia/perfil/';
const LOCALIDADES = '/api/emergencia/localidades/';
const MIOS = '/api/emergencia/casos/mios/';

const FORMULARIO = {
  traslado: 'BOMBEROS', dni: '30.111.222', sexo: 'F', nombre: 'Rosa', apellido: 'Benitez',
  fecha_nacimiento: '02/03/1984', adultos_f: 1, menores_m: 2, lactantes: 1, embarazo: true,
  direccion: 'Av. 9 de Julio 1200', localidad: 12, localidad_nombre: 'Barranqueras',
};

async function preparar(platform = 'android') {
  const borrados = [];
  const copias = [];
  let existe = () => true;
  const fs = {
    documentDirectory: 'file:///test/', EncodingType: {Base64: 'base64'},
    getInfoAsync: async (uri) => ({exists: existe(uri), size: 2048}),
    copyAsync: async (args) => { copias.push(args); }, makeDirectoryAsync: async () => {},
    readAsStringAsync: async () => '/9j/', deleteAsync: async (uri) => { borrados.push(uri); },
  };
  const r = await setup(platform, {mocks: {'expo-file-system/legacy': fs}});
  r.setNow(T0);
  r.setFetch(async () => response(200, {token: 'tok', user_id: 7, username: 'agente', modulos: ['emergencia']}));
  await r.api.loginBecas({username: 'agente', password: 'x'});
  const cola = r.load('./emergenciaCola');
  const perfil = r.load('./emergenciaPerfil');
  return {r, cola, perfil, borrados, copias, setExiste: (fn) => { existe = fn; }};
}

const router = (r, handler) => {
  const calls = [];
  r.setFetch(async (url, init = {}) => {
    const call = {url: String(url).replace('https://example.test', ''), method: init.method || 'GET', init};
    calls.push(call);
    return handler(call, calls);
  });
  return calls;
};
const campos = (call) => Object.fromEntries(call.init.body.fields.map(([n, v]) => [n, typeof v === 'string' ? v : v]));
const nombres = (call) => call.init.body.fields.map(([n]) => n);
const posts = (calls) => calls.filter((c) => c.method === 'POST' && c.url === CASOS);
const op = (r) => r.sql.prepare('SELECT * FROM outbox_casos ORDER BY rowid DESC').get();
const borradorRow = (r, uuid) => r.sql.prepare('SELECT * FROM borradores_casos WHERE uuid_cliente = ?').get(uuid);
const CREADO = {id: 184, numero: '2026-000184', prioridad: 'MEDIA', total_declarado: 3};
const jpeg = (nombre) => ({uri: `file:///cache/ImageManipulator/${nombre}`, fileName: nombre, mimeType: 'image/jpeg', size: 1500});

// Borrador con datos y dos fotos, encolado sin red.
async function encolado(ctx, {formulario = FORMULARIO, fotos = true} = {}) {
  const {r, cola} = ctx;
  const borrador = await cola.abrirBorrador();
  await cola.guardarBorrador(borrador.uuid_cliente, {...borrador.datos, ...formulario});
  if (fotos) {
    await cola.ponerFoto(borrador.uuid_cliente, 'foto_vivienda', jpeg('v.jpg'), {temporal: true});
    await cola.ponerFoto(borrador.uuid_cliente, 'foto_acceso', jpeg('a.jpg'));
  }
  r.setOnline(false);
  const res = await cola.encolarCaso(borrador.uuid_cliente, {relevadoEn: new Date(T0)});
  r.setOnline(true);
  return {uuid: borrador.uuid_cliente, res};
}

test('el borrador nace con su uuid_cliente y abrirlo de nuevo devuelve el mismo', async () => {
  const {cola} = await preparar();
  const a = await cola.abrirBorrador();
  assert.match(a.uuid_cliente, /^[0-9a-f-]{36}$/);
  assert.equal(a.nuevo, true);
  const b = await cola.abrirBorrador();
  assert.equal(b.uuid_cliente, a.uuid_cliente);
  assert.equal(b.datos.adultos_f, 0);
  await cola.guardarBorrador(a.uuid_cliente, {...a.datos, direccion: 'Calle 1'});
  assert.equal((await cola.abrirBorrador()).datos.direccion, 'Calle 1');
  assert.equal(await cola.getPendingCount(), 0, 'un borrador en curso no es un envío pendiente');
});

test('sin red encola; al volver la red manda el multipart exacto del §6 y queda DONE con el número', async () => {
  const ctx = await preparar();
  const {r, cola, borrados, copias} = ctx;
  const {uuid, res} = await encolado(ctx);
  assert.equal(res.envio.estado, 'pendiente');
  assert.equal(await cola.getPendingCount(), 1);
  assert.equal(borradorRow(r, uuid), undefined, 'el borrador pasó a la cola');
  // Las fotos se copiaron a la carpeta propia y la salida temporal de aJpeg se borró.
  assert.ok(copias.every(({to}) => to.startsWith('file:///test/attachments/emergencia/')));
  assert.ok(borrados.includes('file:///cache/ImageManipulator/v.jpg'));
  assert.ok(!borrados.includes('file:///cache/ImageManipulator/a.jpg'));

  r.setOnline(false);
  assert.equal((await cola.syncPendientes()).offline, true);
  r.setOnline(true);
  const calls = router(r, async () => response(201, CREADO));
  const resultado = await cola.syncPendientes();
  assert.equal(resultado.synced, 1);
  assert.equal(posts(calls).length, 1);
  const [post] = posts(calls);
  assert.deepEqual(nombres(post), ['uuid_cliente', 'relevado_en', 'traslado', 'dni', 'nombre', 'apellido',
    'fecha_nacimiento', 'documento_extraviado', 'menores_f', 'menores_m', 'adultos_f', 'adultos_m', 'mayores_f',
    'mayores_m', 'dependientes', 'mayores_dependientes', 'lactantes', 'embarazo', 'electrodependiente',
    'medicacion_critica', 'mascotas', 'direccion', 'localidad', 'foto_vivienda', 'foto_acceso']);
  const f = campos(post);
  assert.equal(f.uuid_cliente, uuid);
  assert.match(f.relevado_en, /^2026-11-14T\d{2}:00:00[+-]\d{2}:\d{2}$/);
  assert.equal(Date.parse(f.relevado_en), T0);
  assert.equal(f.dni, '30111222'); assert.equal(f.fecha_nacimiento, '1984-03-02');
  assert.equal(f.menores_m, '2'); assert.equal(f.adultos_m, '0'); assert.equal(f.embarazo, 'true');
  assert.equal(f.mascotas, 'false'); assert.equal(f.localidad, '12');
  assert.equal(f.foto_vivienda.type, 'image/jpeg'); assert.match(f.foto_vivienda.name, /\.jpg$/);
  assert.ok(f.foto_vivienda.uri.startsWith('file:///test/attachments/emergencia/'));
  assert.ok(!('sexo' in f) && !('localidad_nombre' in f) && !('total' in f) && !('prioridad' in f));
  const fila = op(r);
  assert.equal(fila.status, 'DONE');
  assert.equal(JSON.parse(fila.resultado_json).numero, '2026-000184');
  assert.equal(await cola.getPendingCount(), 0);
  // Fotos borradas al terminar.
  assert.ok(borrados.includes(f.foto_vivienda.uri) && borrados.includes(f.foto_acceso.uri));
  // Lo entregado no se vuelve a mandar.
  await cola.syncPendientes();
  assert.equal(posts(calls).length, 1);
});

test('un 200 (ya existía) también cierra el envío como DONE', async () => {
  const ctx = await preparar();
  await encolado(ctx, {fotos: false});
  router(ctx.r, async () => response(200, CREADO));
  assert.equal((await ctx.cola.syncPendientes()).synced, 1);
  assert.equal(op(ctx.r).status, 'DONE');
});

test('400 VALIDACION: vuelve a borrador editable con los errores por campo y el MISMO uuid', async () => {
  const ctx = await preparar();
  const {r, cola, borrados} = ctx;
  const {uuid} = await encolado(ctx);
  const fotosEncoladas = JSON.parse(op(r).payload_json).fotos;
  const cuerpo = {total: ['Cargá al menos una persona.'], direccion: ['Escribí la dirección.'],
    detail: 'Cargá al menos una persona.', non_field_errors: ['Cargá al menos una persona.', 'Escribí la dirección.'], code: 'VALIDACION'};
  const calls = router(r, async () => response(400, cuerpo));
  await cola.syncPendientes();
  assert.equal(r.sql.prepare('SELECT COUNT(*) AS n FROM outbox_casos').get().n, 0);
  const fila = borradorRow(r, uuid);
  assert.ok(fila, 'volvió a borrador con el mismo uuid');
  assert.deepEqual(JSON.parse(fila.errores_json), {total: ['Cargá al menos una persona.'], direccion: ['Escribí la dirección.']});
  assert.deepEqual(JSON.parse(fila.fotos_json), fotosEncoladas, 'las fotos siguen');
  assert.equal(borrados.filter((u) => u.startsWith('file:///test/attachments/')).length, 0, 'no se borraron fotos');
  assert.equal(await cola.getPendingCount(), 1, 'sigue contando: hay una familia sin entregar');
  const [local] = await cola.getEnviosLocales();
  assert.equal(local.estado, 'corregir'); assert.equal(local.uuid_cliente, uuid);
  // No se reintenta solo.
  await cola.syncPendientes();
  assert.equal(posts(calls).length, 1);
  // Abrir sin uuid no lo toma: es otro borrador nuevo.
  assert.notEqual((await cola.abrirBorrador()).uuid_cliente, uuid);
  // Se corrige y se reenvía con el mismo uuid.
  const corregir = await cola.abrirBorrador({uuid});
  assert.equal(corregir.datos.direccion, FORMULARIO.direccion);
  router(r, async () => response(201, CREADO));
  const reenvio = await cola.encolarCaso(uuid, {datos: {...corregir.datos, direccion: 'Otra'}, relevadoEn: new Date(T0 + MIN)});
  assert.equal(reenvio.envio.estado, 'enviado');
  assert.equal(op(r).uuid_cliente, uuid);
  assert.equal(borradorRow(r, uuid), undefined);
});

test('409 UUID_EN_USO es permanente: no se reintenta ni se cambia el uuid', async () => {
  const ctx = await preparar();
  const {r, cola} = ctx;
  const {uuid} = await encolado(ctx, {fotos: false});
  const calls = router(r, async () => response(409, {detail: 'Ese identificador de envío ya se usó en otro caso.', code: 'UUID_EN_USO'}));
  await cola.syncPendientes();
  assert.equal(op(r).status, 'FAILED_PERMANENT'); assert.equal(op(r).last_error_code, 'UUID_EN_USO');
  assert.equal(op(r).uuid_cliente, uuid); assert.equal(JSON.parse(op(r).payload_json).datos.uuid_cliente, uuid);
  const envio = await cola.getEnvio(uuid);
  assert.equal(envio.puedeReintentar, false); assert.equal(envio.puedeDescartar, true);
  await cola.reintentar(uuid);
  await cola.reintentar();
  r.setNow(T0 + 60 * MIN);
  await cola.syncPendientes();
  assert.equal(posts(calls).length, 1);
  assert.equal(op(r).status, 'FAILED_PERMANENT');
  assert.equal(await cola.descartar(uuid), true);
  assert.equal(op(r).status, 'DISCARDED');
  assert.equal(await cola.getPendingCount(), 0);
});

test('429 respeta Retry-After sin gastar reintentos', async () => {
  const ctx = await preparar();
  const {r, cola} = ctx;
  await encolado(ctx, {fotos: false});
  let estado = 429;
  const calls = router(r, async () => (estado === 429 ? response(429, {detail: 'Pará'}, {'Retry-After': '120'}) : response(201, CREADO)));
  await cola.syncPendientes();
  assert.equal(op(r).status, 'PENDING'); assert.equal(op(r).retry_count, 0);
  assert.equal(Date.parse(op(r).next_retry_at), T0 + 2 * MIN);
  r.setNow(T0 + MIN);
  await cola.syncPendientes();
  assert.equal(posts(calls).length, 1, 'no antes del Retry-After');
  // Ni con el botón de sincronizar.
  await cola.reintentar();
  assert.equal(posts(calls).length, 1);
  r.setNow(T0 + 2 * MIN + 1000); estado = 201;
  await cola.syncPendientes();
  assert.equal(posts(calls).length, 2); assert.equal(op(r).status, 'DONE');
});

test('5xx y falta de red reintentan con backoff y el mismo uuid; al agotar, error que se puede reintentar', async () => {
  const ctx = await preparar();
  const {r, cola} = ctx;
  const {uuid} = await encolado(ctx, {fotos: false});
  let modo = 'red';
  const calls = router(r, async () => {
    if (modo === 'red') throw new TypeError('Failed to fetch');
    if (modo === '503') return response(503, {detail: 'caído'}, {'Retry-After': '600'});
    return response(201, CREADO);
  });
  await cola.syncPendientes();
  assert.equal(op(r).status, 'PENDING'); assert.equal(op(r).retry_count, 1);
  assert.equal(Date.parse(op(r).next_retry_at), T0 + 5000);
  await cola.syncPendientes();
  assert.equal(posts(calls).length, 1, 'espera el backoff');
  modo = '503'; r.setNow(T0 + 6000);
  await cola.syncPendientes();
  assert.equal(op(r).retry_count, 2);
  assert.equal(Date.parse(op(r).next_retry_at), T0 + 6000 + 600 * 1000, 'el Retry-After del 5xx manda si es mayor');
  let ahora = T0 + 6000;
  for (let i = 0; i < 10 && op(r).status === 'PENDING'; i += 1) {
    ahora += 11 * MIN; r.setNow(ahora);
    await cola.syncPendientes();
  }
  assert.equal(op(r).status, 'FAILED_PERMANENT'); assert.equal(op(r).last_error_code, 'REINTENTOS_AGOTADOS');
  assert.ok(new Set(posts(calls).map((c) => campos(c).uuid_cliente)).size === 1);
  assert.equal(campos(posts(calls)[0]).uuid_cliente, uuid);
  modo = 'ok';
  const res = await cola.reintentar(uuid);
  assert.equal(res.synced, 1); assert.equal(op(r).status, 'DONE');
});

test('timeout del pedido reintenta (no es un rechazo)', async () => {
  const ctx = await preparar();
  const {r, cola} = ctx;
  await encolado(ctx, {fotos: false});
  const {clasificarError} = cola;
  assert.equal(clasificarError(Object.assign(new Error('tardó'), {network: true, timeout: true})).accion, 'reintento');
  assert.equal(clasificarError({status: 502, unexpectedHtml: true}).accion, 'reintento');
  assert.equal(clasificarError({status: 400, unexpectedHtml: true}).accion, 'reintento');
  assert.equal(clasificarError({status: 404, payload: {detail: 'No'}}).accion, 'permanente');
  assert.equal(r.sql.prepare('SELECT COUNT(*) AS n FROM outbox_casos').get().n, 1);
});

test('rescata una IN_FLIGHT colgada (proceso muerto) y no toca una reciente', async () => {
  const ctx = await preparar();
  const {r, cola} = ctx;
  await encolado(ctx, {fotos: false});
  r.sql.prepare("UPDATE outbox_casos SET status = 'IN_FLIGHT', started_at = ?").run(new Date(T0 - 30 * 1000).toISOString());
  const calls = router(r, async () => response(201, CREADO));
  await cola.syncPendientes();
  assert.equal(posts(calls).length, 0, 'reciente: puede seguir en vuelo');
  assert.equal(await cola.getPendingCount(), 1);
  r.setNow(T0 + 3 * MIN);
  await cola.syncPendientes();
  assert.equal(posts(calls).length, 1);
  assert.equal(op(r).status, 'DONE');
});

test('401 deja el envío en la cola sin gastar reintentos y corta la pasada', async () => {
  const ctx = await preparar();
  const {r, cola} = ctx;
  await encolado(ctx, {fotos: false});
  await encolado(ctx, {fotos: false});
  const calls = router(r, async () => response(401, {detail: 'Invalid token.'}));
  await cola.syncPendientes();
  assert.equal(posts(calls).length, 1);
  const filas = r.sql.prepare('SELECT * FROM outbox_casos').all();
  assert.deepEqual(filas.map((f) => f.status), ['PENDING', 'PENDING']);
  assert.ok(filas.every((f) => f.retry_count === 0));
  assert.equal(await r.api.getBecasToken(), null);
});

test('403 SIN_MODULO: verifica el perfil, guarda el envío sin reintentarlo solo y corta la pasada', async () => {
  const ctx = await preparar();
  const {r, cola} = ctx;
  await encolado(ctx, {fotos: false});
  await encolado(ctx, {fotos: false});
  const detalle = 'El usuario no tiene permiso para relevar familias en Emergencia.';
  const calls = router(r, async (call) => (call.url === PERFIL
    ? response(200, {relevar: false, llegadas: true, kits: false, dispositivo: true})
    : response(403, {detail: detalle, code: 'SIN_MODULO'})));
  await cola.syncPendientes();
  assert.equal(posts(calls).length, 1);
  assert.equal(calls.filter((c) => c.url === PERFIL).length, 1, 'se volvió a pedir el perfil');
  const [primera, segunda] = r.sql.prepare('SELECT * FROM outbox_casos ORDER BY rowid').all();
  assert.equal(primera.status, 'FAILED_PERMANENT'); assert.equal(primera.last_error_code, 'SIN_MODULO');
  assert.equal(JSON.parse(primera.last_error_json).detail, detalle);
  assert.equal(JSON.parse(primera.last_error_json).verificacion, 'actualizado');
  assert.equal(segunda.status, 'PENDING');
  assert.equal(await cola.getPendingCount(), 2);
  r.setNow(T0 + 60 * MIN);
  await cola.syncPendientes();
  assert.equal(posts(calls).length, 2, 'la siguiente sí se intenta, la fallida no');
});

test('una foto que ya no está en el teléfono devuelve el envío a borrador con el error en esa foto', async () => {
  const ctx = await preparar();
  const {r, cola} = ctx;
  const {uuid} = await encolado(ctx);
  const acceso = JSON.parse(op(r).payload_json).fotos.foto_acceso.uri;
  ctx.setExiste((uri) => uri !== acceso);
  const calls = router(r, async () => response(201, CREADO));
  await cola.syncPendientes();
  assert.equal(posts(calls).length, 0);
  const fila = borradorRow(r, uuid);
  assert.equal(fila.error_code, 'ARCHIVO_LOCAL_FALTANTE');
  assert.deepEqual(Object.keys(JSON.parse(fila.errores_json)), ['foto_acceso']);
});

test('valida en el cliente antes de encolar y no deja encolar dos veces el mismo uuid', async () => {
  const {cola, r} = await preparar();
  const b = await cola.abrirBorrador();
  await assert.rejects(cola.encolarCaso(b.uuid_cliente, {datos: {traslado: 'OTRA', dni: '12'}}, {sincronizar: false}),
    (e) => e.code === 'VALIDACION_LOCAL' && ['traslado_otro', 'dni', 'nombre', 'apellido', 'total', 'direccion']
      .every((k) => k in e.errores));
  assert.equal(r.sql.prepare('SELECT COUNT(*) AS n FROM outbox_casos').get().n, 0);
  r.setOnline(false);
  await cola.encolarCaso(b.uuid_cliente, {datos: FORMULARIO}, {sincronizar: false});
  await assert.rejects(cola.encolarCaso(b.uuid_cliente, {datos: FORMULARIO}), (e) => e.code === 'SIN_BORRADOR');
});

test('reemplazar o quitar una foto del borrador borra el archivo anterior; descartar borra todo', async () => {
  const {cola, borrados} = await preparar();
  const b = await cola.abrirBorrador();
  const primera = await cola.ponerFoto(b.uuid_cliente, 'foto_vivienda', jpeg('1.jpg'));
  const segunda = await cola.ponerFoto(b.uuid_cliente, 'foto_vivienda', jpeg('2.jpg'));
  assert.ok(borrados.includes(primera.uri));
  const acceso = await cola.ponerFoto(b.uuid_cliente, 'foto_acceso', jpeg('3.jpg'));
  assert.equal(await cola.quitarFoto(b.uuid_cliente, 'foto_acceso'), true);
  assert.ok(borrados.includes(acceso.uri));
  await assert.rejects(cola.ponerFoto(b.uuid_cliente, 'foto_x', jpeg('4.jpg')), (e) => e.code === 'FOTO_INVALIDA');
  await assert.rejects(cola.ponerFoto(b.uuid_cliente, 'foto_acceso', {...jpeg('5.png'), mimeType: 'image/png'}), (e) => e.code === 'FOTO_INVALIDA');
  await assert.rejects(cola.ponerFoto(b.uuid_cliente, 'foto_acceso', {...jpeg('6.jpg'), size: 6 * 1024 * 1024}), (e) => e.code === 'FOTO_INVALIDA');
  assert.equal(await cola.descartar(b.uuid_cliente), true);
  assert.ok(borrados.includes(segunda.uri));
  assert.equal((await cola.abrirBorrador()).nuevo, true);
});

test('web: la foto se guarda como data URL en la base, se libera la blob: de aJpeg y sube sin fetch', async () => {
  const ctx = await preparar('web');
  const {r, cola} = ctx;
  const attachments = r.load('./webAttachments');
  const jpegUtil = r.load('../utils/jpeg');
  const b = await cola.abrirBorrador();
  const file = new File([new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3])], 'vivienda.jpg', {type: 'image/jpeg'});
  const uri = 'blob:https://app.test/1';
  attachments.rememberWebFile({uri, file});
  const item = await cola.ponerFoto(b.uuid_cliente, 'foto_vivienda', {uri, file, fileName: 'vivienda.jpg', mimeType: 'image/jpeg', size: file.size});
  assert.match(item.uri, /^data:image\/jpeg;base64,/);
  assert.equal(jpegUtil.liberarJpeg({uri}), false, 'no era de aJpeg: no hay nada que liberar, y no rompe');
  r.setOnline(false);
  await cola.encolarCaso(b.uuid_cliente, {datos: FORMULARIO}, {sincronizar: false});
  r.setOnline(true);
  const calls = router(r, async () => response(201, CREADO));
  await cola.syncPendientes();
  const foto = posts(calls)[0].init.body.fields.find(([n]) => n === 'foto_vivienda');
  assert.ok(foto[1] instanceof Blob); assert.equal(foto[1].size, 6); assert.match(foto[2], /\.jpg$/);
  assert.equal(op(r).status, 'DONE');
});

test('localidades: se guardan, se usan sin red y se refrescan una vez por día', async () => {
  const {r, cola} = await preparar();
  let lista = [{id: 12, nombre: 'Barranqueras'}, {id: 3, nombre: 'Resistencia'}, {id: null, nombre: 'x'}];
  const calls = router(r, async (call) => (call.url === LOCALIDADES ? response(200, lista) : response(404, {})));
  const primera = await cola.getLocalidadesGuardadas();
  assert.deepEqual(JSON.parse(JSON.stringify(primera.localidades)), [{id: 12, nombre: 'Barranqueras'}, {id: 3, nombre: 'Resistencia'}]);
  assert.equal(primera.desdeCache, false);
  r.setNow(T0 + 60 * MIN);
  const misma = await cola.getLocalidadesGuardadas();
  assert.equal(misma.desdeCache, true); assert.equal(calls.length, 1, 'vigente: no pide');
  r.setOnline(false); r.setNow(T0 + 30 * 60 * MIN);
  const sinRed = await cola.getLocalidadesGuardadas();
  assert.equal(sinRed.localidades.length, 2); assert.equal(calls.length, 1);
  r.setOnline(true); lista = [{id: 12, nombre: 'Barranqueras'}];
  const nueva = await cola.getLocalidadesGuardadas();
  assert.equal(nueva.localidades.length, 1); assert.equal(calls.length, 2);
  // Si el refresco falla, sigue la guardada.
  r.setNow(T0 + 60 * 60 * MIN);
  router(r, async () => response(503, {}));
  assert.equal((await cola.getLocalidadesGuardadas()).localidades.length, 1);
});

test('localidades sin red y sin nada guardado: lista vacía, sin error', async () => {
  const {r, cola} = await preparar();
  r.setOnline(false);
  const res = await cola.getLocalidadesGuardadas();
  assert.deepEqual(JSON.parse(JSON.stringify(res.localidades)), []);
});

test('Mis envíos: guarda la lista del servidor y la muestra sin red', async () => {
  const {r, cola} = await preparar();
  const casos = [{numero: '2026-000185', estado: 'EN_GESTION', total_declarado: 2, creado_en: '2026-11-12T10:05:00-03:00'}];
  router(r, async (call) => (call.url === MIOS ? response(200, casos) : response(404, {})));
  const online = await cola.getMisEnvios();
  assert.equal(online.casos[0].numero, '2026-000185'); assert.equal(online.desdeCache, false);
  r.setOnline(false);
  const offline = await cola.getMisEnvios();
  assert.equal(offline.casos[0].numero, '2026-000185'); assert.equal(offline.desdeCache, true); assert.equal(offline.sinRed, true);
});

test('lo de otro usuario no se ve ni se envía', async () => {
  const ctx = await preparar();
  const {r, cola} = ctx;
  await encolado(ctx, {fotos: false});
  r.values.set('user_data', JSON.stringify({id: 8}));
  assert.equal(await cola.getPendingCount(), 0);
  assert.equal((await cola.getEnviosLocales()).length, 0);
  const calls = router(r, async () => response(201, CREADO));
  await cola.syncPendientes();
  assert.equal(posts(calls).length, 0);
});
