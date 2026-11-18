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
  let directorio = [];
  let alCopiar = async () => {};
  const fs = {
    readDirectoryAsync: async () => directorio,
    documentDirectory: 'file:///test/', EncodingType: {Base64: 'base64'},
    getInfoAsync: async (uri) => ({exists: existe(uri), size: 2048}),
    copyAsync: async (args) => { copias.push(args); await alCopiar(args); }, makeDirectoryAsync: async () => {},
    readAsStringAsync: async () => '/9j/', deleteAsync: async (uri) => { borrados.push(uri); },
  };
  const r = await setup(platform, {mocks: {'expo-file-system/legacy': fs}});
  r.setNow(T0);
  r.setFetch(async () => response(200, {token: 'tok', user_id: 7, username: 'agente', modulos: ['emergencia']}));
  await r.api.loginBecas({username: 'agente', password: 'x'});
  const cola = r.load('./emergenciaCola');
  const perfil = r.load('./emergenciaPerfil');
  return {r, cola, perfil, borrados, copias, setExiste: (fn) => { existe = fn; }, setDirectorio: (lista) => { directorio = lista; },
    setAlCopiar: (fn) => { alCopiar = fn; }};
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
    'fecha_nacimiento', 'documento_extraviado', 'responsable_aparte', 'menores_f', 'menores_m', 'adultos_f', 'adultos_m',
    'mayores_f', 'mayores_m', 'dependientes', 'mayores_dependientes', 'lactantes', 'embarazo', 'electrodependiente',
    'medicacion_critica', 'mascotas', 'direccion', 'localidad', 'foto_vivienda', 'foto_acceso']);
  const f = campos(post);
  assert.equal(f.uuid_cliente, uuid);
  assert.match(f.relevado_en, /^2026-11-14T\d{2}:00:00[+-]\d{2}:\d{2}$/);
  assert.equal(Date.parse(f.relevado_en), T0);
  assert.equal(f.dni, '30111222'); assert.equal(f.fecha_nacimiento, '1984-03-02');
  assert.equal(f.menores_m, '2'); assert.equal(f.adultos_m, '0'); assert.equal(f.embarazo, 'true');
  assert.equal(f.mascotas, 'false'); assert.equal(f.localidad, '12');
  // Las cantidades son los acompañantes: el back suma al responsable.
  assert.equal(f.responsable_aparte, 'true');
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
  const fotosEncoladas = JSON.parse(op(r).fotos_json);
  assert.ok(!('fotos' in JSON.parse(op(r).payload_json)), 'las fotos no van en el payload');
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

test('5xx y falta de red reintentan con backoff topeado en 5 min y el mismo uuid; nunca pasan a error', async () => {
  const ctx = await preparar();
  const {r, cola} = ctx;
  const {uuid} = await encolado(ctx, {fotos: false});
  let modo = 'red';
  const calls = router(r, async () => {
    if (modo === 'red') throw new TypeError('Failed to fetch');
    if (modo === '503') return response(503, {detail: 'caído'}, {'Retry-After': '600'});
    if (modo === 'waf') return {status: 403, ok: false, headers: {get: (n) => (String(n).toLowerCase() === 'content-type' ? 'text/html' : null)}, text: async () => '<html>WAF</html>'};
    if (modo === '429') return response(429, {detail: 'Pará'}, {'Retry-After': '30'});
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
  assert.equal(Date.parse(op(r).next_retry_at), T0 + 6000 + 5 * MIN, 'el Retry-After del 5xx manda, topeado en 5 min');
  let ahora = T0 + 6000;
  const modos = ['red', '503', 'waf', 'red', '503', 'waf', 'red', '503', 'waf', 'red', '503', 'waf', 'red', '503'];
  for (const m of modos) {
    modo = m; ahora += 5 * MIN + 1000; r.setNow(ahora);
    await cola.syncPendientes();
    assert.equal(op(r).status, 'PENDING', `sigue en la cola tras ${m}`);
    assert.ok(Date.parse(op(r).next_retry_at) - ahora <= 5 * MIN, 'espera topeada en 5 min');
  }
  assert.equal(op(r).retry_count, 2 + modos.length);
  const envio = await cola.getEnvio(uuid);
  assert.equal(envio.estado, 'pendiente'); assert.equal(envio.demorado, true); assert.equal(envio.puedeReintentar, false);
  assert.equal(await cola.getPendingCount(), 1);
  assert.ok(new Set(posts(calls).map((c) => campos(c).uuid_cliente)).size === 1);
  assert.equal(campos(posts(calls)[0]).uuid_cliente, uuid);
  modo = 'ok'; r.setNow(ahora + 5 * MIN + 1000);
  const res = await cola.syncPendientes();
  assert.equal(res.synced, 1); assert.equal(op(r).status, 'DONE');
});

test('demorado recién desde el intento INTENTOS_DEMORADO', async () => {
  const ctx = await preparar();
  const {r, cola} = ctx;
  const {uuid} = await encolado(ctx, {fotos: false});
  router(r, async () => { throw new TypeError('Failed to fetch'); });
  let ahora = T0;
  for (let i = 1; i <= cola.INTENTOS_DEMORADO; i += 1) {
    await cola.syncPendientes();
    assert.equal((await cola.getEnvio(uuid)).demorado, i >= cola.INTENTOS_DEMORADO, `intento ${i}`);
    ahora += 6 * MIN; r.setNow(ahora);
  }
});

test('timeout del envío proporcional al multipart, con tope', async () => {
  const ctx = await preparar();
  const {r, cola} = ctx;
  assert.equal(cola.timeoutDelEnvio(0), 90 * 1000);
  assert.equal(cola.timeoutDelEnvio(2 * 1024 * 1024), 130 * 1000);
  assert.equal(cola.timeoutDelEnvio(100 * 1024 * 1024), cola.ENVIO_TIMEOUT_MAX_MS);
  // El envío real usa el tamaño de sus fotos; uno que cuelga se corta y sigue en la cola.
  await encolado(ctx);
  const tiempos = [];
  const realSetTimeout = setTimeout;
  r.setGlobal('setTimeout', (fn, ms, ...a) => { tiempos.push(ms); return realSetTimeout(fn, 0, ...a); });
  router(r, async () => new Promise(() => {}));
  await cola.syncPendientes();
  r.setGlobal('setTimeout', realSetTimeout);
  const fotos = Object.values(JSON.parse(op(r).fotos_json)).reduce((n, f) => n + f.size, 0);
  assert.ok(fotos > 0);
  assert.ok(tiempos.includes(cola.timeoutDelEnvio(fotos)), JSON.stringify(tiempos));
  assert.equal(op(r).status, 'PENDING'); assert.equal(op(r).retry_count, 1);
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
  r.setNow(T0 + 4 * MIN);
  await cola.syncPendientes();
  assert.equal(posts(calls).length, 0, 'a los 4 min un envío grande puede seguir subiendo');
  r.setNow(T0 + 6 * MIN);
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
  const acceso = JSON.parse(op(r).fotos_json).foto_acceso.uri;
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
    (e) => e.code === 'VALIDACION_LOCAL' && ['traslado_otro', 'dni', 'nombre', 'apellido', 'direccion']
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

// ---- Sesión de la pasada (M-1) ----

test('una pasada de A no manda nada con el token de B: logout y login de B a mitad de la pasada', async () => {
  const ctx = await preparar();
  const {r, cola} = ctx;
  await encolado(ctx);
  await encolado(ctx);
  // A la mitad del primer envío (mientras se revisan sus fotos, antes de armar el multipart) A
  // cierra sesión y entra B en el mismo teléfono.
  let cambiada = false;
  ctx.setExiste(() => {
    if (!cambiada) {
      cambiada = true;
      r.values.set('becas_auth_token', 'tok-B');
      r.values.set('user_data', JSON.stringify({id: 8}));
    }
    return true;
  });
  const calls = router(r, async () => response(201, CREADO));
  await cola.syncPendientes();
  assert.ok(cambiada);
  const tokens = posts(calls).map((c) => c.init.headers.Authorization);
  assert.ok(tokens.length <= 1, 'la pasada se corta: el segundo de A no sale');
  assert.ok(tokens.every((t) => t === 'Token tok'), `ningún envío de A con el token de B: ${tokens}`);
  const filas = r.sql.prepare('SELECT status FROM outbox_casos ORDER BY rowid').all().map((f) => f.status);
  assert.ok(!filas.includes('IN_FLIGHT'), 'nada queda colgado en vuelo');
  assert.equal(filas.filter((f) => f === 'PENDING').length, 2 - tokens.length);
  // B no ve ni manda lo de A.
  await cola.syncPendientes();
  assert.ok(posts(calls).every((c) => c.init.headers.Authorization === 'Token tok'));
});

test('un 401 de un envío de A no borra la sesión de B que entró mientras tanto', async () => {
  const ctx = await preparar();
  const {r, cola} = ctx;
  await encolado(ctx, {fotos: false});
  router(r, async () => {
    r.values.set('becas_auth_token', 'tok-B');
    r.values.set('user_data', JSON.stringify({id: 8}));
    return response(401, {detail: 'Invalid token.'});
  });
  await cola.syncPendientes();
  assert.equal(await r.api.getBecasToken(), 'tok-B');
});

test('uploadMultipart con `token` explícito usa ese y no relee la sesión', async () => {
  const {r} = await preparar();
  const pedidos = [];
  r.setFetch(async (url, init) => { pedidos.push(init); return response(401, {detail: 'x'}); });
  await assert.rejects(r.api.uploadMultipart('/x/', {fields: {a: 1}, token: 'tok-viejo'}), (e) => e.status === 401);
  assert.equal(pedidos[0].headers.Authorization, 'Token tok-viejo');
  assert.equal(await r.api.getBecasToken(), 'tok', 'el 401 de otro token no borra la sesión actual');
  await assert.rejects(r.api.uploadMultipart('/x/', {fields: {a: 1}}), (e) => e.status === 401);
  assert.equal(pedidos[1].headers.Authorization, 'Token tok', 'sin `token`, lo de siempre');
  assert.equal(await r.api.getBecasToken(), null);
});

// ---- Fotos fuera de las listas (M-4) ----

const espiarConsultas = (r) => {
  const consultas = [];
  const prepare = r.sql.prepare.bind(r.sql);
  r.sql.prepare = (q) => { consultas.push(q); return prepare(q); };
  return {consultas, soltar: () => { r.sql.prepare = prepare; }};
};
const leeFotos = (q) => /SELECT\s+\*/i.test(q) || q.replace("(fotos_json <> '{}')", '').includes('fotos_json');

test('contar, listar y sincronizar sin red no leen las fotos ni la cola', async () => {
  const ctx = await preparar('web');
  const {r, cola} = ctx;
  const b = await cola.abrirBorrador();
  const file = new File([new Uint8Array(4096).fill(7)], 'v.jpg', {type: 'image/jpeg'});
  r.load('./webAttachments').rememberWebFile({uri: 'blob:https://app.test/9', file});
  await cola.ponerFoto(b.uuid_cliente, 'foto_vivienda', {uri: 'blob:https://app.test/9', file, fileName: 'v.jpg', mimeType: 'image/jpeg', size: file.size});
  r.setOnline(false);
  await cola.encolarCaso(b.uuid_cliente, {datos: FORMULARIO}, {sincronizar: false});
  assert.match(op(r).fotos_json, /data:image\/jpeg;base64,/);
  assert.ok(!op(r).payload_json.includes('data:image'), 'el payload no lleva fotos');
  const espia = espiarConsultas(r);
  try {
    assert.equal(await cola.getPendingCount(), 1);
    assert.equal((await cola.getEnviosLocales()).length, 1);
    assert.deepEqual({...await cola.getResumenPendientes()}, {enCola: 1, paraRevisar: 0, sinTerminar: 0});
  } finally { espia.soltar(); }
  assert.deepEqual(espia.consultas.filter(leeFotos), []);
  const espiaSync = espiarConsultas(r);
  try {
    const sync = await cola.syncPendientes();
    assert.equal(sync.offline, true); assert.equal(sync.skipped, 1);
  } finally { espiaSync.soltar(); }
  assert.ok(!espiaSync.consultas.some((q) => q.includes('payload_json') || q.includes('fotos_json')), 'sin red ni se lee la cola');
});

for (const plataforma of ['android', 'web']) {
  test(`${plataforma}: lo entregado queda una semana sin fotos`, async () => {
    const ctx = await preparar(plataforma);
    const {r, cola} = ctx;
    if (plataforma === 'web') {
      const b = await cola.abrirBorrador();
      await cola.guardarBorrador(b.uuid_cliente, {...b.datos, ...FORMULARIO});
      const file = new File([new Uint8Array([0xff, 0xd8, 0xff, 1])], 'v.jpg', {type: 'image/jpeg'});
      r.load('./webAttachments').rememberWebFile({uri: 'blob:https://app.test/2', file});
      await cola.ponerFoto(b.uuid_cliente, 'foto_vivienda', {uri: 'blob:https://app.test/2', file, fileName: 'v.jpg', mimeType: 'image/jpeg', size: 4});
      r.setOnline(false);
      await cola.encolarCaso(b.uuid_cliente, {relevadoEn: new Date(T0)});
      r.setOnline(true);
    } else {
      await encolado(ctx);
    }
    assert.notEqual(op(r).fotos_json, '{}');
    router(r, async () => response(201, CREADO));
    await cola.syncPendientes();
    assert.equal(op(r).status, 'DONE');
    assert.equal(op(r).fotos_json, '{}');
    assert.ok(!op(r).payload_json.includes('fotos') && !op(r).payload_json.includes('data:image'));
  });
}

test('una base de prueba con las fotos dentro del payload se separa al abrirla', async () => {
  const ctx = await preparar();
  const {r, cola} = ctx;
  r.sql.exec(`CREATE TABLE outbox_casos (op_id TEXT PRIMARY KEY NOT NULL, owner_user_id TEXT NOT NULL,
    uuid_cliente TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'PENDING', payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL, started_at TEXT, ack_at TEXT, retry_count INTEGER NOT NULL DEFAULT 0, next_retry_at TEXT,
    last_error TEXT, last_error_code TEXT, last_error_json TEXT, resultado_json TEXT, updated_at TEXT NOT NULL)`);
  const foto = {uri: 'file:///test/attachments/emergencia/v.jpg', fileName: 'v.jpg', mimeType: 'image/jpeg', size: 10};
  r.sql.prepare(`INSERT INTO outbox_casos (op_id, owner_user_id, uuid_cliente, payload_json, created_at, updated_at)
    VALUES ('o1', '7', 'u1', ?, 'x', 'x')`).run(JSON.stringify({uuid_cliente: 'u1', datos: {uuid_cliente: 'u1', traslado: 'BOMBEROS', dni: '30111222', direccion: 'a', adultos_f: 1}, formulario: FORMULARIO, fotos: {foto_vivienda: foto}}));
  assert.equal(await cola.getPendingCount(), 1);
  const fila = op(r);
  assert.deepEqual(JSON.parse(fila.fotos_json), {foto_vivienda: foto});
  assert.ok(!('fotos' in JSON.parse(fila.payload_json)));
  const calls = router(r, async () => response(201, CREADO));
  await cola.syncPendientes();
  assert.ok(campos(posts(calls)[0]).foto_vivienda, 'la foto sigue saliendo');
});

test('nativo: al abrir la cola se borran las fotos de la carpeta que ninguna fila nombra', async () => {
  const ctx = await preparar();
  const {r, cola, borrados} = ctx;
  r.sql.exec(`CREATE TABLE borradores_casos (uuid_cliente TEXT PRIMARY KEY NOT NULL, owner_user_id TEXT NOT NULL,
    datos_json TEXT NOT NULL, fotos_json TEXT NOT NULL DEFAULT '{}', errores_json TEXT, error_code TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  r.sql.prepare(`INSERT INTO borradores_casos VALUES ('b1', '9', '{}', ?, NULL, NULL, 'x', 'x')`)
    .run(JSON.stringify({foto_acceso: {uri: 'file:///test/attachments/emergencia/de-otro-usuario.jpg'}}));
  ctx.setDirectorio(['de-otro-usuario.jpg', 'huerfana.jpg']);
  await cola.getPendingCount();
  assert.ok(borrados.includes('file:///test/attachments/emergencia/huerfana.jpg'));
  assert.ok(!borrados.includes('file:///test/attachments/emergencia/de-otro-usuario.jpg'), 'la de otro usuario se respeta');
});

// ---- Borrador en curso y resumen para el logout (m-2, m-3) ----

test('borrador en curso: vacío no cuenta; con datos o fotos sí, con su resumen', async () => {
  const ctx = await preparar();
  const {cola} = ctx;
  assert.equal(await cola.getBorradorEnCurso(), null);
  const b = await cola.abrirBorrador();
  assert.equal(await cola.getBorradorEnCurso(), null, 'abierto y vacío');
  await cola.guardarBorrador(b.uuid_cliente, {...b.datos, apellido: 'Benitez', dni: '30111222'});
  const enCurso = await cola.getBorradorEnCurso();
  assert.equal(enCurso.uuid_cliente, b.uuid_cliente);
  // El responsable ya es una persona, aunque no se haya cargado ningún acompañante.
  assert.equal(enCurso.resumen, 'Benitez · DNI 30111222 · 1 persona');
  assert.deepEqual({...await cola.getResumenPendientes()}, {enCola: 0, paraRevisar: 0, sinTerminar: 1});
  await cola.guardarBorrador(b.uuid_cliente, b.datos);
  await cola.ponerFoto(b.uuid_cliente, 'foto_acceso', jpeg('a.jpg'));
  assert.ok(await cola.getBorradorEnCurso(), 'solo una foto también');
});

test('resumen de pendientes: en cola, para revisar (error y para corregir) y sin terminar', async () => {
  const ctx = await preparar();
  const {r, cola} = ctx;
  await encolado(ctx, {fotos: false});
  await encolado(ctx, {fotos: false});
  await encolado(ctx, {fotos: false});
  let n = 0;
  router(r, async () => {
    n += 1;
    if (n === 1) return response(404, {detail: 'No'});
    if (n === 2) return response(400, {direccion: ['Mal.'], code: 'VALIDACION'});
    throw new TypeError('Failed to fetch');
  });
  await cola.syncPendientes();
  assert.deepEqual({...await cola.getResumenPendientes()}, {enCola: 1, paraRevisar: 2, sinTerminar: 0});
  assert.equal(await cola.getPendingCount(), 3);
});

test('ponerFoto libera la salida de aJpeg aunque no haya sesión o el campo no exista', async () => {
  const ctx = await preparar('web');
  const {r, cola} = ctx;
  const jpegUtil = r.load('../utils/jpeg');
  const b = await cola.abrirBorrador();
  const liberadas = [];
  const original = jpegUtil.liberarJpeg;
  jpegUtil.liberarJpeg = (asset) => { liberadas.push(asset.uri); return original(asset); };
  try {
    await assert.rejects(cola.ponerFoto(b.uuid_cliente, 'foto_x', {uri: 'blob:x1'}), (e) => e.code === 'FOTO_INVALIDA');
    r.values.delete('user_data');
    await assert.rejects(cola.ponerFoto(b.uuid_cliente, 'foto_acceso', {uri: 'blob:x2'}), (e) => e.code === 'SIN_SESION');
  } finally { jpegUtil.liberarJpeg = original; }
  assert.deepEqual(liberadas, ['blob:x1', 'blob:x2']);
});

test('web: la red la dice navigator.onLine, no el estado guardado de NetInfo (CI de Playwright)', async () => {
  const ctx = await preparar('web');
  const {r, cola} = ctx;
  const b = await cola.abrirBorrador();
  r.setOnline(false);
  await cola.encolarCaso(b.uuid_cliente, {datos: FORMULARIO}, {sincronizar: false});
  // Volvió la red, pero NetInfo web sigue con su prueba de `/` hecha sin señal.
  r.setNavigator({onLine: true});
  const calls = router(r, async () => response(201, CREADO));
  assert.equal((await cola.syncPendientes()).synced, 1);
  assert.equal(posts(calls).length, 1);
  // Y al revés: sin red para el navegador no se intenta aunque NetInfo diga que hay.
  const otro = await cola.abrirBorrador();
  await cola.encolarCaso(otro.uuid_cliente, {datos: FORMULARIO}, {sincronizar: false});
  r.setOnline(true); r.setNavigator({onLine: false});
  assert.equal((await cola.syncPendientes()).offline, true);
  assert.equal(posts(calls).length, 1);
});

// ---- Revisión independiente de M1: contenedor de iOS, carrera de ponerFoto, 413, pasada y migración ----

// En iOS la ruta del contenedor cambia al actualizar la app: las filas guardan la de antes.
const VIEJO = 'file:///var/mobile/Containers/Data/Application/AAAA-OLD/Documents/attachments/emergencia/';
const ACTUAL = 'file:///test/attachments/emergencia/';
const aContenedorViejo = (json) => json.split(ACTUAL).join(VIEJO);

test('nativo: el barrido compara por nombre de archivo: una URI de otro contenedor NO se borra', async () => {
  const ctx = await preparar();
  const {r, cola, borrados} = ctx;
  r.sql.exec(`CREATE TABLE borradores_casos (uuid_cliente TEXT PRIMARY KEY NOT NULL, owner_user_id TEXT NOT NULL,
    datos_json TEXT NOT NULL, fotos_json TEXT NOT NULL DEFAULT '{}', errores_json TEXT, error_code TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  r.sql.prepare(`INSERT INTO borradores_casos VALUES ('b1', '7', '{}', ?, NULL, NULL, 'x', 'x')`)
    .run(JSON.stringify({foto_acceso: {uri: `${VIEJO}viva-borrador.jpg`}}));
  r.sql.exec(`CREATE TABLE outbox_casos (op_id TEXT PRIMARY KEY NOT NULL, owner_user_id TEXT NOT NULL,
    uuid_cliente TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'PENDING', payload_json TEXT NOT NULL,
    fotos_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, started_at TEXT, ack_at TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0, next_retry_at TEXT, last_error TEXT, last_error_code TEXT,
    last_error_json TEXT, resultado_json TEXT, updated_at TEXT NOT NULL)`);
  r.sql.prepare(`INSERT INTO outbox_casos (op_id, owner_user_id, uuid_cliente, payload_json, fotos_json, created_at, updated_at)
    VALUES ('o1', '7', 'u1', '{}', ?, 'x', 'x')`).run(JSON.stringify({foto_vivienda: {uri: `${VIEJO}viva-cola.jpg`}}));
  ctx.setDirectorio(['viva-borrador.jpg', 'viva-cola.jpg', 'huerfana.jpg']);
  await cola.getPendingCount();
  assert.deepEqual(borrados, [`${ACTUAL}huerfana.jpg`], 'solo la que ninguna fila nombra');
});

test('nativo: un envío guardado con la URI de otro contenedor encuentra sus fotos por nombre, las manda y las borra', async () => {
  const ctx = await preparar();
  const {r, cola, borrados} = ctx;
  await encolado(ctx);
  const actuales = JSON.parse(op(r).fotos_json);
  r.sql.prepare('UPDATE outbox_casos SET fotos_json = ?').run(aContenedorViejo(op(r).fotos_json));
  assert.ok(op(r).fotos_json.includes(VIEJO));
  // En el teléfono solo existe la carpeta del contenedor actual.
  ctx.setExiste((uri) => uri.startsWith(ACTUAL));
  const calls = router(r, async () => response(201, CREADO));
  await cola.syncPendientes();
  assert.equal(op(r).status, 'DONE', 'no la tomó como foto faltante');
  const f = campos(posts(calls)[0]);
  assert.equal(f.foto_vivienda.uri, actuales.foto_vivienda.uri);
  assert.equal(f.foto_acceso.uri, actuales.foto_acceso.uri);
  assert.ok(borrados.includes(actuales.foto_vivienda.uri) && borrados.includes(actuales.foto_acceso.uri), 'borra la del contenedor actual');
  assert.ok(!borrados.some((u) => u.startsWith(VIEJO)));
});

test('nativo: un borrador guardado con la URI de otro contenedor muestra y borra la foto actual', async () => {
  const ctx = await preparar();
  const {r, cola, borrados} = ctx;
  const b = await cola.abrirBorrador();
  const vivienda = await cola.ponerFoto(b.uuid_cliente, 'foto_vivienda', jpeg('v.jpg'));
  const acceso = await cola.ponerFoto(b.uuid_cliente, 'foto_acceso', jpeg('a.jpg'));
  r.sql.prepare('UPDATE borradores_casos SET fotos_json = ?').run(aContenedorViejo(borradorRow(r, b.uuid_cliente).fotos_json));
  const abierto = await cola.abrirBorrador();
  assert.equal(abierto.fotos.foto_vivienda.uri, vivienda.uri, 'la miniatura usa la URI actual');
  assert.equal(await cola.quitarFoto(b.uuid_cliente, 'foto_vivienda'), true);
  assert.ok(borrados.includes(vivienda.uri));
  // Reemplazar también borra la anterior en la carpeta actual.
  await cola.ponerFoto(b.uuid_cliente, 'foto_acceso', jpeg('a2.jpg'));
  assert.ok(borrados.includes(acceso.uri));
  assert.ok(!borrados.some((u) => u.startsWith(VIEJO)));
});

test('ponerFoto: si el borrador se fue mientras se copiaba, borra la copia nueva, no toca la anterior y tira SIN_BORRADOR', async () => {
  const ctx = await preparar();
  const {r, cola, borrados, copias} = ctx;
  const b = await cola.abrirBorrador();
  const anterior = await cola.ponerFoto(b.uuid_cliente, 'foto_vivienda', jpeg('1.jpg'));
  const fotosAntes = borradorRow(r, b.uuid_cliente).fotos_json;
  // Mientras se copia la nueva, el borrador pasa a la cola (otra pantalla, el botón Enviar).
  ctx.setAlCopiar(async () => {
    r.sql.prepare('DELETE FROM borradores_casos WHERE uuid_cliente = ?').run(b.uuid_cliente);
  });
  await assert.rejects(cola.ponerFoto(b.uuid_cliente, 'foto_vivienda', jpeg('2.jpg')), (e) => e.code === 'SIN_BORRADOR');
  const nueva = copias.at(-1).to;
  assert.ok(borrados.includes(nueva), 'la copia nueva se borró');
  assert.ok(!borrados.includes(anterior.uri), 'la anterior (ahora de la cola) sigue');
  assert.ok(fotosAntes.includes(anterior.uri));
});

const html413 = () => ({status: 413, ok: false,
  headers: {get: (n) => (String(n).toLowerCase() === 'content-type' ? 'text/html' : null)},
  text: async () => '<html><body><h1>413 Request Entity Too Large</h1></body></html>'});

test('413 (aunque venga en HTML del WAF/ingress) es permanente: vuelve a borrador para cambiar las fotos', async () => {
  const ctx = await preparar();
  const {r, cola, borrados} = ctx;
  assert.equal(cola.clasificarError({status: 413, unexpectedHtml: true}).accion, 'borrador');
  assert.equal(cola.clasificarError({status: 413, payload: {detail: 'Too large'}}).accion, 'borrador');
  const {uuid} = await encolado(ctx);
  const fotos = op(r).fotos_json;
  let calls = router(r, async () => response(413, {detail: 'Request Entity Too Large'}));
  const jsonRes = await cola.syncPendientes();
  assert.equal(jsonRes.errors[0].code, cola.ERROR_FOTOS_PESADAS, 'un 413 en JSON también');
  assert.match(JSON.parse(borradorRow(r, uuid).errores_json).fotos[0], /demasiado pesadas/);
  // Corregido y reenviado, ahora el 413 llega en HTML del WAF.
  r.setOnline(false);
  await cola.encolarCaso(uuid, {relevadoEn: new Date(T0)});
  r.setOnline(true);
  calls = router(r, async () => html413());
  const res = await cola.syncPendientes();
  assert.equal(res.errors[0].code, cola.ERROR_FOTOS_PESADAS);
  assert.equal(r.sql.prepare('SELECT COUNT(*) AS n FROM outbox_casos').get().n, 0, 'no queda en la cola');
  const fila = borradorRow(r, uuid);
  assert.equal(fila.error_code, cola.ERROR_FOTOS_PESADAS);
  assert.match(JSON.parse(fila.errores_json).fotos[0], /demasiado pesadas/);
  assert.equal(fila.fotos_json, fotos, 'las fotos siguen para poder cambiarlas');
  assert.equal(borrados.filter((u) => u.startsWith(ACTUAL)).length, 0);
  assert.equal((await cola.getEnvio(uuid)).estado, 'corregir');
  r.setNow(T0 + 60 * MIN);
  await cola.syncPendientes();
  assert.equal(posts(calls).length, 1, 'no se reintenta solo');
});

test('413 sin fotos: queda con error a la vista, sin reintentar', async () => {
  const ctx = await preparar();
  const {r, cola} = ctx;
  const {uuid} = await encolado(ctx, {fotos: false});
  const calls = router(r, async () => html413());
  await cola.syncPendientes();
  assert.equal(op(r).status, 'FAILED_PERMANENT');
  assert.equal(op(r).last_error_code, cola.ERROR_FOTOS_PESADAS);
  assert.match((await cola.getEnvio(uuid)).detail, /demasiado pesadas/);
  r.setNow(T0 + 60 * MIN);
  await cola.syncPendientes();
  assert.equal(posts(calls).length, 1);
});

test('sin red a mitad de la pasada se corta: los que siguen quedan para la próxima, sin gastar reintentos', async () => {
  const ctx = await preparar();
  const {r, cola} = ctx;
  await encolado(ctx, {fotos: false});
  await encolado(ctx, {fotos: false});
  await encolado(ctx, {fotos: false});
  const calls = router(r, async () => { throw new TypeError('Failed to fetch'); });
  const res = await cola.syncPendientes();
  assert.equal(posts(calls).length, 1);
  assert.equal(res.failed, 1);
  const filas = r.sql.prepare('SELECT status, retry_count FROM outbox_casos ORDER BY rowid').all();
  assert.deepEqual(filas.map((f) => [f.status, f.retry_count]), [['PENDING', 1], ['PENDING', 0], ['PENDING', 0]]);
  // Con red, la próxima pasada manda los que no se intentaron (el primero espera su backoff).
  router(r, async () => response(201, CREADO));
  assert.equal((await cola.syncPendientes()).synced, 2);
});

test('un timeout a mitad de la pasada también la corta', async () => {
  const ctx = await preparar();
  const {r, cola} = ctx;
  await encolado(ctx, {fotos: false});
  await encolado(ctx, {fotos: false});
  const realSetTimeout = setTimeout;
  r.setGlobal('setTimeout', (fn, ms, ...a) => realSetTimeout(fn, 0, ...a));
  let calls;
  try {
    calls = router(r, async () => new Promise(() => {}));
    await cola.syncPendientes();
  } finally { r.setGlobal('setTimeout', realSetTimeout); }
  assert.equal(posts(calls).length, 1, 'el segundo no espera otro timeout');
  const filas = r.sql.prepare('SELECT status, retry_count FROM outbox_casos ORDER BY rowid').all();
  assert.deepEqual(filas.map((f) => [f.status, f.retry_count]), [['PENDING', 1], ['PENDING', 0]]);
});

test('un 5xx no corta la pasada: el siguiente se intenta', async () => {
  const ctx = await preparar();
  const {r, cola} = ctx;
  await encolado(ctx, {fotos: false});
  await encolado(ctx, {fotos: false});
  const calls = router(r, async () => response(503, {detail: 'caído'}));
  await cola.syncPendientes();
  assert.equal(posts(calls).length, 2);
});

test('los que esperan su backoff no leen la sesión del storage', async () => {
  const ctx = await preparar();
  const {r, cola} = ctx;
  for (let i = 0; i < 3; i += 1) await encolado(ctx, {fotos: false});
  const futuro = new Date(T0 + 10 * MIN).toISOString();
  r.sql.prepare('UPDATE outbox_casos SET next_retry_at = ?').run(futuro);
  const calls = router(r, async () => response(201, CREADO));
  const lecturas = [];
  const get = r.secure.get.bind(r.secure);
  r.secure.get = (clave) => { lecturas.push(clave); return get(clave); };
  try {
    r.sql.prepare("UPDATE outbox_casos SET status = 'DISCARDED' WHERE rowid > (SELECT MIN(rowid) FROM outbox_casos)").run();
    await cola.syncPendientes();
    const conUno = lecturas.length;
    r.sql.prepare("UPDATE outbox_casos SET status = 'PENDING'").run();
    lecturas.length = 0;
    await cola.syncPendientes();
    assert.equal(lecturas.length, conUno, `tres en espera leen lo mismo que uno: ${lecturas}`);
  } finally { r.secure.get = get; }
  assert.equal(posts(calls).length, 0);
});

// ---- Migración de `fotos_json` (fotos que estaban dentro del payload) ----

const crearOutboxVieja = (r, n) => {
  r.sql.exec(`CREATE TABLE outbox_casos (op_id TEXT PRIMARY KEY NOT NULL, owner_user_id TEXT NOT NULL,
    uuid_cliente TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'PENDING', payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL, started_at TEXT, ack_at TEXT, retry_count INTEGER NOT NULL DEFAULT 0, next_retry_at TEXT,
    last_error TEXT, last_error_code TEXT, last_error_json TEXT, resultado_json TEXT, updated_at TEXT NOT NULL)`);
  const fotos = [];
  for (let i = 1; i <= n; i += 1) {
    const foto = {uri: `${ACTUAL}v${i}.jpg`, fileName: `v${i}.jpg`, mimeType: 'image/jpeg', size: 10};
    fotos.push(foto);
    r.sql.prepare(`INSERT INTO outbox_casos (op_id, owner_user_id, uuid_cliente, payload_json, created_at, updated_at)
      VALUES (?, '7', ?, ?, 'x', 'x')`).run(`o${i}`, `u${i}`, JSON.stringify({uuid_cliente: `u${i}`, datos: {uuid_cliente: `u${i}`, traslado: 'BOMBEROS', dni: '30111222', direccion: 'a', adultos_f: 1},
        formulario: FORMULARIO, fotos: {foto_vivienda: foto}}));
  }
  return fotos;
};
const filasOutbox = (r) => r.sql.prepare('SELECT op_id, payload_json, fotos_json FROM outbox_casos ORDER BY rowid').all()
  .map((f) => ({...f}));
const migrada = (fila, foto) => !('fotos' in JSON.parse(fila.payload_json))
  && JSON.stringify(JSON.parse(fila.fotos_json)) === JSON.stringify({foto_vivienda: foto});

test('migración de fotos_json: abrir dos veces seguidas es idempotente', async () => {
  const ctx = await preparar();
  const {r} = ctx;
  ctx.setExiste(() => true);
  const fotos = crearOutboxVieja(r, 2);
  ctx.setDirectorio(['v1.jpg', 'v2.jpg']);
  assert.equal(await ctx.cola.getPendingCount(), 2);
  const primera = filasOutbox(r);
  assert.ok(primera.every((fila, i) => migrada(fila, fotos[i])));
  const otra = r.reload('./emergenciaCola');
  assert.equal(await otra.getPendingCount(), 2);
  assert.deepEqual(filasOutbox(r), primera, 'la segunda apertura no cambia nada');
  assert.equal(r.sql.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('outbox_casos') WHERE name = 'fotos_json'").get().n, 1);
  assert.deepEqual(ctx.borrados, [], 'el barrido respeta las fotos migradas');
});

test('migración de fotos_json cortada a mitad: la próxima apertura completa las filas que faltaron', async () => {
  const ctx = await preparar();
  const {r} = ctx;
  const fotos = crearOutboxVieja(r, 3);
  const prepare = r.sql.prepare.bind(r.sql);
  let updates = 0;
  r.sql.prepare = (q) => {
    if (/^UPDATE outbox_casos SET payload_json = \?, fotos_json = \?/.test(q.trim()) && ++updates === 2) {
      throw new Error('proceso cortado');
    }
    return prepare(q);
  };
  try {
    await assert.rejects(ctx.cola.getPendingCount(), /proceso cortado/);
  } finally { r.sql.prepare = prepare; }
  const cortada = filasOutbox(r);
  assert.ok(migrada(cortada[0], fotos[0]), 'la primera llegó a migrarse');
  assert.ok('fotos' in JSON.parse(cortada[1].payload_json) && 'fotos' in JSON.parse(cortada[2].payload_json));
  const otra = r.reload('./emergenciaCola');
  assert.equal(await otra.getPendingCount(), 3);
  assert.ok(filasOutbox(r).every((fila, i) => migrada(fila, fotos[i])), 'todas migradas');
  const calls = router(r, async () => response(201, CREADO));
  await otra.syncPendientes();
  assert.equal(posts(calls).length, 3);
  assert.ok(posts(calls).every((c) => campos(c).foto_vivienda), 'cada envío sale con su foto');
});
