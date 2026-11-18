// services/emergenciaLlegadas.js (M2 · Llegada de familias, parte 1) contra contrato-app-emergencia
// §13.1 a §13.5: buscar por DNI (429), aceptar y rechazar (no idempotentes), integrantes, agregar
// persona (idempotente), el router por `estado_actual` y la sesión fijada al abrir.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {setup, response} = require('./helpers/mobile-runtime.cjs');

const igual = (actual, esperado, mensaje) => assert.deepEqual(JSON.parse(JSON.stringify(actual ?? null)), esperado, mensaje);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const CASO = {id: 184, numero: '2026-000184', estado: 'DERIVADO', prioridad: 'ALTA', total_declarado: 7};
const DERIVACION = {
  id: 55, estado: 'PENDIENTE', plazas_pedidas: 7, vence_en: '2026-11-12T12:00:00-03:00', vencida: false,
  derivada_en: '2026-11-12T10:00:00-03:00', derivada_por: 'Ana López', caso: CASO,
  responsable: {nombre: 'Rosa', apellido: 'Benítez', dni: '30111222'},
  grupo: {menores_f: 2, menores_m: 3, adultos_f: 1, adultos_m: 1, mayores_f: 0, mayores_m: 0, dependientes: 0, mayores_dependientes: 0, lactantes: 1},
  necesidades: ['embarazo'], telefono: '3624000000', observaciones: 'Vienen con un perro.',
};
const BUSQUEDA = {resultado: 'DERIVACION', dni: '30111222', plazas_libres: 9, mensaje: '', derivacion: DERIVACION,
  alojada_aca: null, alojada_en: '', alojada_desde: null};
const FILA = (n, extra = {}) => ({n, estado: 'SIN_CONFIRMAR', ficha_completa: false, persona: null, plaza: null, parentesco: '',
  confirmada_en: null, egresado_en: null, ...extra});
const INTEGRANTES = {
  caso: {...CASO, estado: 'INGRESO_EN_CURSO'},
  integrantes: [FILA(2), FILA(1, {estado: 'CONFIRMADA', persona: {id: 9, nombre: 'Benítez, Rosa', dni: '30111222'},
    plaza: {id: 41, codigo: 'B-12', nombre: 'B-12 (Pabellón B)'}, parentesco: 'Jefe/a de hogar', confirmada_en: '2026-11-12T10:20:00-03:00'})],
  confirmadas: 1, total_declarado: 7, declaradas_al_relevar: 7, con_ficha_incompleta: 1,
};
const ACEPTACION = {caso: {...CASO, estado: 'INGRESO_EN_CURSO'}, reservadas: 5, faltantes: 2, mensaje: 'Reservé 5 de 7 · faltan 2 camas',
  integrantes: [FILA(1), FILA(2)]};

async function preparar() {
  const r = await setup();
  r.setFetch(async () => response(200, {token: 'tok', user_id: 7, username: 'guardia', modulos: ['emergencia']}));
  await r.api.loginBecas({username: 'guardia', password: 'x'});
  const l = r.load('./emergenciaLlegadas');
  const sesion = await l.abrirSesion();
  return {r, l, sesion};
}
const router = (r, handler) => {
  const calls = [];
  r.setFetch(async (url, init = {}) => {
    const call = {url: String(url).replace('https://example.test', ''), method: init.method || 'GET', init,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body, auth: init.headers?.Authorization};
    calls.push(call);
    return handler(call, calls);
  });
  return calls;
};
const fallaDeRed = () => Promise.reject(new TypeError('Load failed'));
const nunca = () => new Promise(() => {});
const clasificacion = async (promesa) => {
  try { await promesa; } catch (e) { return JSON.parse(JSON.stringify({...e.clasificacion, incierto: e.incierto})); }
  assert.fail('no falló');
};

// ---- Lógica pura ----

test('mis dispositivos: solo los que admiten familias, con derivaciones pendientes y camas libres', async () => {
  const {l} = await preparar();
  igual(l.dispositivosQueAdmiten([
    {id: 7, nombre: 'Club Sarmiento', admite: true, recibe_kits: true, entregas_pendientes: 2, plazas_libres: 9, derivaciones_pendientes: 1},
    {id: 9, nombre: 'Escuela 12', admite: false, recibe_kits: true, plazas_libres: 0, derivaciones_pendientes: 0},
    {id: 11, nombre: '', admite: true},
    {nombre: 'sin id', admite: true}, null,
  ]), [{id: 7, nombre: 'Club Sarmiento', plazas_libres: 9, derivaciones_pendientes: 1},
    {id: 11, nombre: 'Dispositivo 11', plazas_libres: 0, derivaciones_pendientes: 0}]);
  igual(l.dispositivosQueAdmiten({detail: 'x'}), []);
});

test('búsqueda: normaliza las ocho claves de §13.2 y decide el paso por resultado y estado', async () => {
  const {l} = await preparar();
  const b = l.normalizarBusqueda(BUSQUEDA);
  assert.equal(l.pasoDeBusqueda(b), 'derivacion');
  igual(b.derivacion.caso, CASO);
  assert.equal(l.nombreDelResponsable(b.derivacion.responsable), 'Rosa Benítez · DNI 30111222');
  assert.equal(l.resumenDelGrupo(b.derivacion.grupo), 'Menores (F): 2 · Menores (M): 3 · Adultos (F): 1 · Adultos (M): 1');
  // Con el responsable aparte de las franjas, se lo nombra; solo él ya no es «sin detalle».
  assert.equal(l.resumenDelGrupo({...b.derivacion.grupo, responsable_aparte: true}),
    'Menores (F): 2 · Menores (M): 3 · Adultos (F): 1 · Adultos (M): 1 · Responsable: 1');
  assert.equal(l.resumenDelGrupo({responsable_aparte: true}), 'Responsable: 1');
  assert.equal(l.resumenDeAsistencia(b.derivacion.grupo), 'Lactantes: 1');
  assert.equal(l.tituloDeNecesidad('medicacion_critica'), 'Medicación crítica');
  assert.equal(l.pasoDeBusqueda(l.normalizarBusqueda({...BUSQUEDA, derivacion: {...DERIVACION, estado: 'ACEPTADA'}})), 'integrantes');
  assert.equal(l.pasoDeBusqueda(l.normalizarBusqueda({...BUSQUEDA, resultado: 'SIN_DERIVACION', derivacion: null})), 'sin_derivacion');
  assert.equal(l.pasoDeBusqueda(l.normalizarBusqueda({...BUSQUEDA, resultado: 'ALOJADA', derivacion: null, alojada_aca: true})), 'alojada');
  assert.equal(l.pasoDeBusqueda(l.normalizarBusqueda({resultado: 'OTRA_COSA'})), 'desconocido');
  assert.equal(l.pasoDeBusqueda(l.normalizarBusqueda({...BUSQUEDA, derivacion: {...DERIVACION, estado: 'RECHAZADA'}})), 'desconocido');
});

test('router §13.1: cada estado_actual vuelve a su pantalla', async () => {
  const {l} = await preparar();
  igual(['DERIVADO', 'INGRESO_EN_CURSO', 'ALOJADO', 'CERRADO', 'EN_GESTION', 'NUEVO', 'RARO', ''].map(l.destinoPorEstado),
    ['derivacion', 'integrantes', 'integrantes', 'integrantes', 'buscar', 'buscar', 'buscar', 'buscar']);
});

test('integrantes: normaliza, ordena por n, contador, crecimiento, lectura y cierre por contador', async () => {
  const {l} = await preparar();
  const d = l.normalizarIntegrantes(INTEGRANTES);
  igual(d.integrantes.map(i => i.n), [1, 2]);
  assert.equal(l.textoDelContador(d), '1 de 7 confirmadas');
  assert.equal(l.textoDeCrecimiento(d), null);
  assert.equal(l.textoDeCrecimiento({total_declarado: 8, declaradas_al_relevar: 7}), 'Llegaron 8 sobre 7 declaradas al relevar');
  assert.equal(l.cierreDisponible(d), 'diferencia');
  assert.equal(l.cierreDisponible({...d, confirmadas: 7}), 'alojar');
  assert.equal(l.cierreDisponible({...d, confirmadas: 0}), 'cancelar');
  assert.equal(l.cierreDisponible({...d, caso: {...d.caso, estado: 'ALOJADO'}}), null);
  assert.equal(l.esSoloLectura({estado: 'CERRADO'}), true);
  assert.equal(l.esSoloLectura({estado: 'INGRESO_EN_CURSO'}), false);
  igual(l.estadoDeIntegrante('EGRESADA'), {titulo: 'Egresada', tono: 'info'});
});

test('clasificarErrorLlegada: cada respuesta del contrato, por status y code', async () => {
  const {l} = await preparar();
  const tipo = (error, opciones) => l.clasificarErrorLlegada(error, opciones).tipo;
  assert.equal(tipo({status: 401}), 'sesion');
  assert.equal(tipo({status: 403, payload: {code: 'SIN_MODULO', detail: 'x'}}), 'sin_modulo');
  assert.equal(tipo({status: 403, payload: {code: 'SIN_MODULO'}, unexpectedHtml: true}), 'reintentable', 'un 403 del WAF no es SIN_MODULO');
  const c409 = l.clasificarErrorLlegada({status: 409, payload: {detail: 'Ya la aceptó Juan.', estado_actual: 'INGRESO_EN_CURSO'}});
  igual(c409, {tipo: 'conflicto', mensaje: 'Ya la aceptó Juan.', estadoActual: 'INGRESO_EN_CURSO', destino: 'integrantes'});
  assert.equal(tipo({status: 409, payload: {code: 'UUID_EN_USO', detail: 'x'}}), 'uuid_en_uso');
  assert.equal(tipo({status: 409, payload: null, unexpectedHtml: true}), 'reintentable', 'un 409 del WAF no es de estado');
  assert.equal(tipo({status: 404, payload: {detail: 'No encontrado.'}}), 'no_encontrado');
  const v = l.clasificarErrorLlegada({status: 400, payload: {code: 'VALIDACION', detail: 'Ingresá un DNI válido', dni: ['Ingresá un DNI válido'], non_field_errors: ['Ingresá un DNI válido']}}, {campos: ['dni']});
  igual(v.errores, {dni: ['Ingresá un DNI válido']});
  assert.equal(tipo({status: 400, payload: {detail: 'JSON parse error'}}), 'rechazo', 'un 400 sin code no es VALIDACION');
  igual(l.clasificarErrorLlegada({status: 429, payload: {detail: 'x'}, retryAfter: 30000}), {tipo: 'espera', mensaje: l.TEXTO_ESPERAR_ACCION, espera: 30000});
  assert.equal(tipo({network: true}), 'reintentable');
  assert.equal(tipo({network: true, timeout: true}), 'reintentable');
  assert.equal(tipo({status: 503, payload: {}}), 'reintentable');
  assert.equal(tipo({status: 200, unexpectedHtml: true}), 'reintentable');
  assert.equal(tipo({obsoleto: true}), 'obsoleto');
});

// ---- Buscar ----

test('buscar: GET a /dispositivos/{id}/buscar/?dni= con el token de la sesión; DNI con puntos se limpia', async () => {
  const {r, l, sesion} = await preparar();
  const calls = router(r, () => response(200, BUSQUEDA));
  const b = await l.buscar(sesion, 7, '30.111.222');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/emergencia/dispositivos/7/buscar/?dni=30111222');
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].auth, 'Token tok');
  assert.equal(b.derivacion.id, 55);
});

test('buscar: un DNI inválido no pide nada; 400 VALIDACION `dni` va al campo', async () => {
  const {r, l, sesion} = await preparar();
  const calls = router(r, () => response(400, {code: 'VALIDACION', detail: 'Ingresá un DNI válido de 7 u 8 dígitos, sin puntos.', dni: ['Ingresá un DNI válido de 7 u 8 dígitos, sin puntos.']}));
  igual((await clasificacion(l.buscar(sesion, 7, '123'))).errores, {dni: [l.DNI_INVALIDO]});
  assert.equal(calls.length, 0);
  const c = await clasificacion(l.buscar(sesion, 7, '1234567'));
  assert.equal(c.tipo, 'validacion');
  igual(c.errores, {dni: ['Ingresá un DNI válido de 7 u 8 dígitos, sin puntos.']});
});

test('buscar: 429 con Retry-After es `espera` con los ms; 404 y 403 SIN_MODULO (re-pide el perfil)', async () => {
  const {r, l, sesion} = await preparar();
  router(r, () => response(429, {detail: 'Request was throttled.'}, {'Retry-After': '42'}));
  const c = await clasificacion(l.buscar(sesion, 7, '30111222'));
  assert.equal(c.tipo, 'espera');
  assert.equal(c.espera, 42000);
  router(r, () => response(404, {detail: 'No encontrado.'}));
  assert.equal((await clasificacion(l.buscar(sesion, 7, '30111222'))).tipo, 'no_encontrado');
  const calls = router(r, (call) => (call.url.endsWith('/perfil/') ? response(200, {relevar: true, llegadas: false, kits: true})
    : response(403, {detail: 'El usuario no admite familias en ningún dispositivo.', code: 'SIN_MODULO'})));
  const s = await clasificacion(l.buscar(sesion, 7, '30111222'));
  igual([s.tipo, s.mensaje, s.verificacion], ['sin_modulo', 'El usuario no admite familias en ningún dispositivo.', 'actualizado']);
  assert.ok(calls.some(c2 => c2.url.endsWith('/perfil/')), '403 parcial vuelve a pedir el perfil');
});

test('sin red no sale ningún pedido de M2 (bloquea, sin lectura guardada)', async () => {
  const {r, l, sesion} = await preparar();
  const calls = router(r, () => response(200, BUSQUEDA));
  r.setOnline(false);
  assert.equal((await clasificacion(l.buscar(sesion, 7, '30111222'))).tipo, 'sin_red');
  assert.equal((await clasificacion(l.aceptar(sesion, l.normalizarBusqueda(BUSQUEDA).derivacion))).tipo, 'sin_red');
  assert.equal((await clasificacion(l.cargarIntegrantes(sesion, 184))).tipo, 'sin_red');
  assert.equal(calls.length, 0);
});

test('red caída, timeout y página HTML del WAF son reintentables', async () => {
  const {r, l, sesion} = await preparar();
  router(r, fallaDeRed);
  assert.equal((await clasificacion(l.buscar(sesion, 7, '30111222'))).tipo, 'reintentable');
  l.LIMITES.lecturaMs = 20;
  try {
    router(r, nunca);
    assert.equal((await clasificacion(l.buscar(sesion, 7, '30111222'))).tipo, 'reintentable', 'un pedido colgado se corta');
  } finally { l.LIMITES.lecturaMs = 20000; }
  router(r, () => ({status: 403, ok: false, headers: {get: n => (n.toLowerCase() === 'content-type' ? 'text/html' : null)}, text: async () => '<html>WAF</html>'}));
  assert.equal((await clasificacion(l.buscar(sesion, 7, '30111222'))).tipo, 'reintentable');
});

// ---- Sesión ----

test('sesión: con otra sesión abierta no sale ningún pedido de la anterior (acciones ni lecturas)', async () => {
  const {r, l, sesion} = await preparar();
  r.setFetch(async () => response(200, {token: 'tok-2', user_id: 8, username: 'otra', modulos: ['emergencia']}));
  await r.api.loginBecas({username: 'otra', password: 'x'});
  const calls = router(r, () => response(200, BUSQUEDA));
  const derivacion = l.normalizarBusqueda(BUSQUEDA).derivacion;
  for (const accion of [
    () => l.buscar(sesion, 7, '30111222'), () => l.aceptar(sesion, derivacion), () => l.rechazar(sesion, derivacion, {motivo: 'NO_LLEGO'}),
    () => l.agregarPersona(sesion, 184), () => l.cargarIntegrantes(sesion, 184),
  ]) {
    assert.equal((await clasificacion(accion())).tipo, 'obsoleto');
  }
  assert.equal(calls.length, 0, 'ni con su propio token');
  assert.equal(await r.api.getBecasToken(), 'tok-2');

  const otra = await l.abrirSesion();
  router(r, async () => {
    r.setFetch(async () => response(200, {token: 'tok-3', user_id: 9, username: 'tercera', modulos: ['emergencia']}));
    await r.api.loginBecas({username: 'tercera', password: 'x'});
    return response(200, BUSQUEDA);
  });
  assert.equal((await clasificacion(l.buscar(otra, 7, '30111222'))).tipo, 'obsoleto', 'la respuesta tardía no se usa');
});

test('sesión: el pedido sale con el token de la sesión aunque otra entre justo antes de mandarlo', async () => {
  const r = await setup('web');
  r.setFetch(async () => response(200, {token: 'tok', user_id: 7, username: 'guardia', modulos: ['emergencia']}));
  await r.api.loginBecas({username: 'guardia', password: 'x'});
  const l = r.load('./emergenciaLlegadas');
  const sesion = await l.abrirSesion();
  const calls = router(r, () => response(200, BUSQUEDA));
  // La 1.ª lectura del token es la del chequeo previo; desde la 2.ª ya hay otra sesión.
  const leer = r.legacy.get.bind(r.legacy);
  let lecturas = 0;
  r.legacy.get = (clave) => (clave === 'becas_auth_token' && ++lecturas >= 2 ? 'tok-otra' : leer(clave));
  assert.equal((await clasificacion(l.buscar(sesion, 7, '30111222'))).tipo, 'obsoleto', 'y la respuesta se descarta');
  assert.equal(calls[0].auth, 'Token tok', 'nunca con el token de la otra sesión');
});

test('sesión: 401 de la sesión vigente invalida; sin sesión no abre', async () => {
  const {r, l, sesion} = await preparar();
  router(r, () => response(401, {detail: 'Invalid token.'}));
  assert.equal((await clasificacion(l.buscar(sesion, 7, '30111222'))).tipo, 'obsoleto', 'tras el 401 la sesión ya no es esta');
  assert.equal(await r.api.getBecasToken(), null, 'el 401 del token vigente cierra la sesión');
  await assert.rejects(l.abrirSesion(), {code: 'SIN_SESION'});
});

// ---- Aceptar ----

test('aceptar: POST JSON con uuid_cliente nuevo cada vez; 200 trae caso, reservas e integrantes', async () => {
  const {r, l, sesion} = await preparar();
  const derivacion = l.normalizarBusqueda(BUSQUEDA).derivacion;
  const calls = router(r, () => response(200, ACEPTACION));
  const a = await l.aceptar(sesion, derivacion);
  assert.equal(calls[0].url, '/api/emergencia/derivaciones/55/aceptar/');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].auth, 'Token tok');
  assert.match(calls[0].body.uuid_cliente, UUID);
  igual(Object.keys(calls[0].body), ['uuid_cliente']);
  igual([a.resultado, a.caso.estado, a.reservadas, a.faltantes, a.mensaje, a.integrantes.integrantes.length],
    ['aceptada', 'INGRESO_EN_CURSO', 5, 2, 'Reservé 5 de 7 · faltan 2 camas', 2]);
  await l.aceptar(sesion, derivacion);
  assert.notEqual(calls[1].body.uuid_cliente, calls[0].body.uuid_cliente, 'el back no lo guarda: no hay que reusarlo');
});

test('aceptar no es idempotente: tras un intento incierto, el 409 INGRESO_EN_CURSO es «se hizo»', async () => {
  const {r, l, sesion} = await preparar();
  const derivacion = l.normalizarBusqueda(BUSQUEDA).derivacion;
  let intento = 0;
  router(r, () => { intento += 1; return intento === 1 ? fallaDeRed() : response(409, {detail: 'La derivación ya la aceptó Guardia a las 10:20.', estado_actual: 'INGRESO_EN_CURSO'}); });
  const primero = await clasificacion(l.aceptar(sesion, derivacion));
  igual([primero.tipo, primero.incierto, primero.mensaje], ['reintentable', true, l.TEXTO_ACEPTAR_INCIERTO]);
  const segundo = await l.aceptar(sesion, derivacion, {incierto: true});
  igual([segundo.resultado, segundo.caso.id, segundo.mensaje], ['ya_aceptada', 184, l.TEXTO_ACEPTADA_ANTES]);
});

test('aceptar: sin intento incierto, el 409 es un conflicto que recarga; uno con otro estado también', async () => {
  const {r, l, sesion} = await preparar();
  const derivacion = l.normalizarBusqueda(BUSQUEDA).derivacion;
  router(r, () => response(409, {detail: 'Ya la aceptó otra persona de la guardia.', estado_actual: 'INGRESO_EN_CURSO'}));
  const c = await clasificacion(l.aceptar(sesion, derivacion));
  igual([c.tipo, c.destino, c.incierto], ['conflicto', 'integrantes', false]);
  router(r, () => response(409, {detail: 'La mesa canceló la derivación.', estado_actual: 'EN_GESTION'}));
  const m = await clasificacion(l.aceptar(sesion, derivacion, {incierto: true}));
  igual([m.tipo, m.destino, m.mensaje, m.incierto], ['conflicto', 'buscar', 'La mesa canceló la derivación.', false]);
});

test('aceptar: 400 `plazas` (sin camas) se muestra y destraba; 5xx y timeout dejan incierto; 429 no lo destraba', async () => {
  const {r, l, sesion} = await preparar();
  const derivacion = l.normalizarBusqueda(BUSQUEDA).derivacion;
  router(r, () => response(400, {code: 'VALIDACION', detail: 'Sin plazas · rechazá con motivo o liberá camas.', plazas: ['Sin plazas · rechazá con motivo o liberá camas.'], non_field_errors: ['Sin plazas · rechazá con motivo o liberá camas.']}));
  const p = await clasificacion(l.aceptar(sesion, derivacion, {incierto: true}));
  igual([p.tipo, p.errores, p.incierto], ['validacion', {plazas: ['Sin plazas · rechazá con motivo o liberá camas.']}, false]);
  router(r, () => response(503, {detail: 'x'}));
  assert.equal((await clasificacion(l.aceptar(sesion, derivacion))).incierto, true);
  l.LIMITES.accionMs = 20;
  try {
    router(r, nunca);
    igual(await clasificacion(l.aceptar(sesion, derivacion)).then(c => [c.tipo, c.incierto]), ['reintentable', true]);
  } finally { l.LIMITES.accionMs = 30000; }
  router(r, () => response(429, {detail: 'x'}, {'Retry-After': '5'}));
  assert.equal((await clasificacion(l.aceptar(sesion, derivacion, {incierto: true}))).incierto, true, '429 no dice nada del intento anterior');
  assert.equal((await clasificacion(l.aceptar(sesion, derivacion, {incierto: false}))).incierto, false);
});

// ---- Rechazar ----

test('rechazar: valida motivo y observación con OTRO antes de pedir nada; manda el JSON de §13.4', async () => {
  const {r, l, sesion} = await preparar();
  const derivacion = l.normalizarBusqueda(BUSQUEDA).derivacion;
  const calls = router(r, () => response(200, {caso_estado: 'EN_GESTION'}));
  igual((await clasificacion(l.rechazar(sesion, derivacion, {}))).errores, {motivo: [l.FALTA_MOTIVO]});
  igual((await clasificacion(l.rechazar(sesion, derivacion, {motivo: 'OTRO', observacion: '  '}))).errores, {observacion: [l.FALTA_OBSERVACION]});
  assert.equal(calls.length, 0);
  igual(await l.rechazar(sesion, derivacion, {motivo: 'SIN_PLAZAS'}), {resultado: 'rechazada', caso_estado: 'EN_GESTION'});
  igual(calls[0].body, {motivo: 'SIN_PLAZAS'});
  assert.equal(calls[0].url, '/api/emergencia/derivaciones/55/rechazar/');
  await l.rechazar(sesion, derivacion, {motivo: 'OTRO', observacion: '  Se fueron con familiares  '});
  igual(calls[1].body, {motivo: 'OTRO', observacion: 'Se fueron con familiares'});
});

test('rechazar no es idempotente: tras un intento incierto, el 409 con el caso en la mesa es «se hizo»; si no, conflicto', async () => {
  const {r, l, sesion} = await preparar();
  const derivacion = l.normalizarBusqueda(BUSQUEDA).derivacion;
  router(r, () => response(409, {detail: 'La derivación ya fue rechazada o el ingreso se canceló. Buscá a la familia de nuevo.', estado_actual: 'EN_GESTION'}));
  const hecho = await l.rechazar(sesion, derivacion, {motivo: 'NO_LLEGO'}, {incierto: true});
  igual([hecho.resultado, hecho.caso_estado], ['ya_rechazada', 'EN_GESTION']);
  const c = await clasificacion(l.rechazar(sesion, derivacion, {motivo: 'NO_LLEGO'}));
  igual([c.tipo, c.destino], ['conflicto', 'buscar']);
  router(r, () => response(409, {detail: 'Ya la aceptó Juan.', estado_actual: 'INGRESO_EN_CURSO'}));
  const otra = await clasificacion(l.rechazar(sesion, derivacion, {motivo: 'NO_LLEGO'}, {incierto: true}));
  igual([otra.tipo, otra.destino], ['conflicto', 'integrantes'], 'otro estado no es el que produce rechazar');
  router(r, fallaDeRed);
  igual(await clasificacion(l.rechazar(sesion, derivacion, {motivo: 'NO_LLEGO'})).then(x => [x.tipo, x.incierto, x.mensaje]),
    ['reintentable', true, l.TEXTO_RECHAZAR_INCIERTO]);
});

// ---- Integrantes ----

test('integrantes: GET de §13.5; 409 con estado_actual va al router', async () => {
  const {r, l, sesion} = await preparar();
  const calls = router(r, () => response(200, INTEGRANTES));
  const d = await l.cargarIntegrantes(sesion, 184);
  assert.equal(calls[0].url, '/api/emergencia/casos/184/integrantes/');
  assert.equal(d.confirmadas, 1);
  assert.equal(d.integrantes[0].plaza.nombre, 'B-12 (Pabellón B)');
  router(r, () => response(409, {detail: 'El caso 2026-000184 ya no está para esto. Buscá a la familia de nuevo.', estado_actual: 'DERIVADO'}));
  igual(await clasificacion(l.cargarIntegrantes(sesion, 184)).then(c => [c.tipo, c.destino]), ['conflicto', 'derivacion']);
});

test('agregar persona: el uuid se guarda por usuario y caso; el reintento (también tras recargar la app) manda el MISMO', async () => {
  const {r, l, sesion} = await preparar();
  let intento = 0;
  const calls = router(r, () => { intento += 1; return intento === 1 ? fallaDeRed() : response(intento === 2 ? 201 : 200, {integrante: FILA(8), total_declarado: 8}); });
  assert.equal(await l.agregarPendiente(sesion, 184), null);
  igual(await clasificacion(l.agregarPersona(sesion, 184)).then(c => [c.tipo, c.mensaje]), ['reintentable', l.TEXTO_AGREGAR_INCIERTO]);
  const pendiente = await l.agregarPendiente(sesion, 184);
  assert.match(pendiente, UUID);
  assert.equal(await l.agregarPendiente(sesion, 190), null, 'es por caso');
  // Otra instancia del módulo (la app cerrada y vuelta a abrir) ve el mismo uuid.
  const l2 = r.reload('./emergenciaLlegadas');
  assert.equal(await l2.agregarPendiente(sesion, 184), pendiente);
  const r1 = await l2.agregarPersona(sesion, 184);
  igual([r1.integrante.n, r1.total_declarado], [8, 8]);
  assert.equal(await l2.agregarPendiente(sesion, 184), null, 'el 2xx lo olvida');
  await l2.agregarPersona(sesion, 184);
  const uuids = calls.map(c => c.body.uuid_cliente);
  igual(calls.map(c => [c.method, c.url]), [0, 1, 2].map(() => ['POST', '/api/emergencia/casos/184/integrantes/']));
  igual([uuids[0] === pendiente, uuids[1] === pendiente, uuids[2] === pendiente], [true, true, false], 'la persona siguiente es otro pedido');
});

test('agregar persona: 400, 404 y 409 olvidan el uuid; red, timeout, 5xx, WAF, 429 y 403 lo conservan', async () => {
  const {r, l, sesion} = await preparar();
  const casos = [
    [() => response(400, {code: 'VALIDACION', detail: 'x', uuid_cliente: ['x']}), false],
    [() => response(404, {detail: 'No encontrado.'}), false],
    [() => response(409, {detail: 'Cerrado.', estado_actual: 'CERRADO'}), false],
    [() => response(409, {detail: 'En uso.', code: 'UUID_EN_USO'}), false],
    [fallaDeRed, true],
    [() => response(503, {}), true],
    [() => ({status: 200, ok: false, headers: {get: n => (n.toLowerCase() === 'content-type' ? 'text/html' : null)}, text: async () => '<html>WAF</html>'}), true],
    [() => response(429, {detail: 'x'}, {'Retry-After': '5'}), true],
    [(call) => (call.url.endsWith('/perfil/') ? response(200, {llegadas: false}) : response(403, {detail: 'x', code: 'SIN_MODULO'})), true],
  ];
  for (const [respuesta, conserva] of casos) {
    router(r, respuesta);
    const error = await l.agregarPersona(sesion, 184).catch(e => e);
    assert.ok(error?.clasificacion, 'tiene que fallar');
    assert.equal(!!await l.agregarPendiente(sesion, 184), conserva, `${error.clasificacion.tipo} ${conserva ? 'conserva' : 'olvida'}`);
    if (conserva) {
      router(r, () => response(200, {integrante: FILA(3), total_declarado: 3}));
      await l.agregarPersona(sesion, 184);
    }
  }
  l.LIMITES.accionMs = 20;
  try {
    router(r, nunca);
    await l.agregarPersona(sesion, 184).catch(() => {});
    assert.ok(await l.agregarPendiente(sesion, 184), 'timeout conserva');
  } finally { l.LIMITES.accionMs = 30000; }
});

test('429: la búsqueda lo dice con el texto del tope de búsquedas; aceptar, con el genérico', async () => {
  const {r, l, sesion} = await preparar();
  router(r, () => response(429, {detail: 'x'}, {'Retry-After': '5'}));
  assert.equal((await clasificacion(l.buscar(sesion, 7, '30111222'))).mensaje, l.TEXTO_ESPERAR);
  assert.equal((await clasificacion(l.aceptar(sesion, l.normalizarBusqueda(BUSQUEDA).derivacion))).mensaje, l.TEXTO_ESPERAR_ACCION);
  assert.equal((await clasificacion(l.agregarPersona(sesion, 184))).mensaje, l.TEXTO_ESPERAR_ACCION);
});

// MINOR 4 de la revisión del PR #28, resuelto con `becasRequest(path, { token })` (PR #29): el 401 del
// token viejo no cierra la sesión que entró en el medio.
test('sesión: un 401 del token viejo (otra persona ya entró) no cierra la sesión nueva', async () => {
  const {r, l} = await preparar();
  r.setFetch(async () => response(200, {token: 'tok-2', user_id: 8, username: 'otra', modulos: ['emergencia']}));
  await r.api.loginBecas({username: 'otra', password: 'x'});
  // La otra entra mientras el pedido de la sesión anterior está en vuelo, y el back le contesta 401.
  const nueva = await l.abrirSesion();
  const calls = router(r, async () => {
    r.setFetch(async () => response(200, {token: 'tok-3', user_id: 9, username: 'tercera', modulos: ['emergencia']}));
    await r.api.loginBecas({username: 'tercera', password: 'x'});
    return response(401, {detail: 'Invalid token.'});
  });
  assert.equal((await clasificacion(l.buscar(nueva, 7, '30111222'))).tipo, 'obsoleto');
  assert.deepEqual(calls.map(c => c.auth), ['Token tok-2'], 'salió con su token, no con el de quien entró');
  assert.equal(await r.api.getBecasToken(), 'tok-3', 'el 401 del token viejo no cierra la sesión nueva');
});
