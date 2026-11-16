// services/emergenciaLlegadas.js (M2 · Llegada de familias, parte 3) contra contrato-app-emergencia
// §13.9 (alojar, cerrar con diferencia, cancelar el ingreso: NO idempotentes) y §13.10 (ingresar igual
// y avisar a la mesa: idempotentes por uuid_cliente), más la limpieza de lo que queda en el teléfono.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {setup, response} = require('./helpers/mobile-runtime.cjs');

const igual = (actual, esperado, mensaje) => assert.deepEqual(JSON.parse(JSON.stringify(actual ?? null)), esperado, mensaje);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const CASO = {id: 184, numero: '2026-000184', estado: 'INGRESO_EN_CURSO', prioridad: 'ALTA', total_declarado: 7};
const FILA = (n, extra = {}) => ({n, estado: 'SIN_CONFIRMAR', ficha_completa: false, persona: null, plaza: null, parentesco: '',
  confirmada_en: null, egresado_en: null, ...extra});
const CASO_PUERTA = {id: 190, numero: '2026-000190', estado: 'INGRESO_EN_CURSO', prioridad: 'MEDIA', total_declarado: 3};
const INGRESO = {caso: CASO_PUERTA, reservadas: 3, faltantes: 0, integrantes: [FILA(1), FILA(2), FILA(3)]};
const AVISO = {caso: {id: 191, numero: '2026-000191', estado: 'NUEVO', prioridad: 'MEDIA', total_declarado: 3}};
const DATOS = {traslado: 'BOMBEROS', dni: '30.111.222', nombre: ' Rosa ', apellido: 'Benítez', fecha_nacimiento: '02/03/1984',
  adultos_f: 1, menores_m: 2, embarazo: true, observaciones: '  Llegaron solos  '};

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
      body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body, auth: init.headers?.Authorization,
      tipo: init.headers?.['Content-Type']};
    calls.push(call);
    return handler(call, calls);
  });
  return calls;
};
const api = calls => calls.filter(c => !c.url.endsWith('/perfil/'));
const fallaDeRed = () => Promise.reject(new TypeError('Load failed'));
const nunca = () => new Promise(() => {});
const waf = () => ({status: 403, ok: false, headers: {get: n => (n.toLowerCase() === 'content-type' ? 'text/html' : null)}, text: async () => '<html>WAF</html>'});
const clasificacion = async (promesa) => {
  try { await promesa; } catch (e) { return JSON.parse(JSON.stringify({...e.clasificacion, incierto: e.incierto, uuid: e.uuid})); }
  assert.fail('no falló');
};
const ALOJADA_409 = {detail: 'La familia del caso 2026-000184 ya figura alojada. Recargá la pantalla.', estado_actual: 'ALOJADO'};
const CANCELADO_409 = {detail: 'La derivación ya fue rechazada o el ingreso se canceló. Buscá a la familia de nuevo.', estado_actual: 'EN_GESTION'};

// ---- Lógica pura ----

test('cierres: validación de cliente igual a la del servicio del back', async () => {
  const {l} = await preparar();
  igual(l.validarAlojar({}), {});
  igual(l.validarAlojar({tarjeta_entregada: true, tarjeta_numero: '  '}), {tarjeta_numero: [l.FALTA_TARJETA]});
  igual(l.validarAlojar({tarjeta_entregada: false, tarjeta_numero: 'x'.repeat(99)}), {}, 'sin tarjeta, el número no cuenta');
  igual(Object.keys(l.validarAlojar({aula: 'x'.repeat(81), tarjeta_entregada: true, tarjeta_numero: 'x'.repeat(41), encargado: 'x'.repeat(121)})),
    ['aula', 'tarjeta_numero', 'encargado']);
  igual(l.validarDiferencia({}), {motivo: [l.FALTA_MOTIVO_DIFERENCIA]});
  igual(l.validarDiferencia({motivo: 'OTRO', observacion: ' '}), {observacion: [l.FALTA_OBSERVACION]});
  igual(l.validarDiferencia({motivo: 'NO_LLEGO'}), {});
  igual(l.MOTIVOS_DIFERENCIA.map(m => m.valor), ['QUEDO_CON_FAMILIARES', 'NO_LLEGO', 'DERIVADO_A_SALUD', 'OTRO']);
  igual(l.validarCancelar({motivo: '   '}), {motivo: [l.FALTA_MOTIVO_CANCELAR]});
  igual(l.validarCancelar({motivo: 'x'.repeat(201)}), {motivo: ['Hasta 200 caracteres.']});
  igual(l.validarCancelar({motivo: 'No vinieron'}), {});
});

test('cierres: normaliza la respuesta de §13.9, el texto de camas liberadas y el sector que se propone', async () => {
  const {l} = await preparar();
  igual(l.normalizarCierre({estado: 'ALOJADO', total_alojado: 5, liberadas: 2}), {estado: 'ALOJADO', total_alojado: 5, liberadas: 2});
  igual(l.normalizarCierre({estado: 'EN_GESTION', total_alojado: null, liberadas: 7}), {estado: 'EN_GESTION', total_alojado: null, liberadas: 7});
  igual([l.textoDeLiberadas(0), l.textoDeLiberadas(1), l.textoDeLiberadas(3)], [null, 'Se liberó 1 cama reservada.', 'Se liberaron 3 camas reservadas.']);
  const mapa = l.normalizarMapa({caso: 184, sectores: [
    {sector: {id: 3, nombre: 'Pabellón A'}, total: 2, libres: 1, reservadas_familia: 1, plazas: [{id: 40, estado: 'OCUPADA'}, {id: 41, estado: 'RESERVADA_FAMILIA', elegible: true}]},
    {sector: {id: 4, nombre: 'Pabellón B'}, total: 3, libres: 0, reservadas_familia: 0, plazas: [{id: 50, estado: 'OCUPADA'}, {id: 51, estado: 'OCUPADA'}, {id: 52, estado: 'OCUPADA'}]}]});
  assert.equal(l.sectorDeLaFamilia(mapa, [{plaza: {id: 40}}, {plaza: {id: 50}}, {plaza: {id: 51}}]), 4, 'el de la mayoría de sus camas');
  assert.equal(l.sectorDeLaFamilia(mapa, [{plaza: {id: 40}}, {plaza: {id: 50}}]), 3, 'empate: el primero del mapa');
  assert.equal(l.sectorDeLaFamilia(mapa, [{plaza: null}]), 3, 'sin camas ubicables: el que tiene guardadas para la familia');
  assert.equal(l.sectorDeLaFamilia({sectores: []}, []), null);
});

// ---- Alojar ----

test('alojar: POST JSON a /casos/{id}/alojar/ con la sección 4; lo vacío no viaja; 200 → hecho', async () => {
  const {r, l, sesion} = await preparar();
  const calls = router(r, () => response(200, {estado: 'ALOJADO', total_alojado: 7, liberadas: 2}));
  const a = await l.alojar(sesion, 184, {sector: '3', aula: ' Aula 3 ', tarjeta_entregada: true, tarjeta_numero: ' 0042 ', encargado: ''});
  igual(a, {resultado: 'hecho', estado: 'ALOJADO', total_alojado: 7, liberadas: 2});
  igual([calls[0].method, calls[0].url, calls[0].auth, calls[0].tipo], ['POST', '/api/emergencia/casos/184/alojar/', 'Token tok', 'application/json']);
  igual(calls[0].body, {tarjeta_entregada: true, sector: 3, aula: 'Aula 3', tarjeta_numero: '0042'});
  await l.alojar(sesion, 184, {sector: null, tarjeta_entregada: false, tarjeta_numero: 'olvidado', encargado: ' Ana '});
  igual(calls[1].body, {tarjeta_entregada: false, encargado: 'Ana'}, 'sin tarjeta no va el número');
  assert.ok(!('uuid_cliente' in calls[0].body), 'alojar no lleva uuid: no es idempotente');
});

test('alojar: sin número de tarjeta no pide nada; 400 por campo y `non_field_errors` (falta confirmar)', async () => {
  const {r, l, sesion} = await preparar();
  const calls = router(r, () => response(400, {code: 'VALIDACION', detail: 'Falta confirmar a 2 personas. Confirmalas, o cerrá el ingreso con diferencia si no llegaron.',
    non_field_errors: ['Falta confirmar a 2 personas. Confirmalas, o cerrá el ingreso con diferencia si no llegaron.']}));
  igual((await clasificacion(l.alojar(sesion, 184, {tarjeta_entregada: true}))).errores, {tarjeta_numero: [l.FALTA_TARJETA]});
  assert.equal(calls.length, 0);
  const c = await clasificacion(l.alojar(sesion, 184, {}, {incierto: true}));
  igual([c.tipo, c.errores, c.incierto], ['validacion', {generales: ['Falta confirmar a 2 personas. Confirmalas, o cerrá el ingreso con diferencia si no llegaron.']}, false],
    'el 400 dice en qué quedó: destraba el incierto');
  router(r, () => response(400, {code: 'VALIDACION', detail: 'Elegí un sector de este dispositivo.', sector: ['Elegí un sector de este dispositivo.']}));
  igual((await clasificacion(l.alojar(sesion, 184, {sector: 99}))).errores, {sector: ['Elegí un sector de este dispositivo.']});
});

test('alojar NO es idempotente: tras un intento incierto, el 409 ALOJADO o CERRADO es «se hizo» con el detail del servidor', async () => {
  const {r, l, sesion} = await preparar();
  let intento = 0;
  router(r, () => { intento += 1; return intento === 1 ? fallaDeRed() : response(409, ALOJADA_409); });
  const primero = await clasificacion(l.alojar(sesion, 184, {}));
  igual([primero.tipo, primero.incierto, primero.mensaje], ['reintentable', true, l.TEXTO_ALOJAR_INCIERTO]);
  const segundo = await l.alojar(sesion, 184, {}, {incierto: true});
  igual([segundo.resultado, segundo.estado, segundo.mensaje, segundo.detalle, segundo.destino],
    ['ya_hecho', 'ALOJADO', l.TEXTO_YA_ALOJADA, ALOJADA_409.detail, 'integrantes']);
  router(r, () => response(409, {detail: 'El caso 2026-000184 está cerrado. Recargá la pantalla.', estado_actual: 'CERRADO'}));
  assert.equal((await l.alojar(sesion, 184, {}, {incierto: true})).estado, 'CERRADO');
});

test('alojar: sin intento incierto el 409 es conflicto (router); con incierto, un estado que alojar no produce también', async () => {
  const {r, l, sesion} = await preparar();
  router(r, () => response(409, ALOJADA_409));
  igual(await clasificacion(l.alojar(sesion, 184, {})).then(c => [c.tipo, c.destino, c.incierto]), ['conflicto', 'integrantes', false]);
  router(r, () => response(409, CANCELADO_409));
  igual(await clasificacion(l.alojar(sesion, 184, {}, {incierto: true})).then(c => [c.tipo, c.destino, c.mensaje]),
    ['conflicto', 'buscar', CANCELADO_409.detail], 'EN_GESTION es de otro (la mesa o un cancelar), no de alojar');
});

test('cierres: timeout, 5xx y WAF dejan incierto; 429 no destraba un incierto ni inventa uno; 404 y 403 SIN_MODULO', async () => {
  const {r, l, sesion} = await preparar();
  l.LIMITES.accionMs = 20;
  try {
    router(r, nunca);
    igual(await clasificacion(l.alojar(sesion, 184, {})).then(c => [c.tipo, c.incierto]), ['reintentable', true]);
  } finally { l.LIMITES.accionMs = 30000; }
  router(r, () => response(502, {detail: 'Bad gateway'}));
  igual(await clasificacion(l.cerrarDiferencia(sesion, 184, {motivo: 'NO_LLEGO'})).then(c => [c.tipo, c.incierto, c.mensaje]),
    ['reintentable', true, l.TEXTO_DIFERENCIA_INCIERTA]);
  router(r, waf);
  igual(await clasificacion(l.cancelar(sesion, 184, {motivo: 'x'})).then(c => [c.tipo, c.incierto, c.mensaje]),
    ['reintentable', true, l.TEXTO_CANCELAR_INCIERTO], 'un 403 HTML del WAF no es SIN_MODULO');
  router(r, () => response(429, {detail: 'x'}, {'Retry-After': '5'}));
  igual(await clasificacion(l.alojar(sesion, 184, {}, {incierto: true})).then(c => [c.tipo, c.espera, c.incierto]), ['espera', 5000, true]);
  assert.equal((await clasificacion(l.alojar(sesion, 184, {}))).incierto, false);
  router(r, () => response(404, {detail: 'No encontrado.'}));
  igual(await clasificacion(l.alojar(sesion, 184, {}, {incierto: true})).then(c => [c.tipo, c.incierto]), ['no_encontrado', false]);
  const calls = router(r, (call) => (call.url.endsWith('/perfil/') ? response(200, {relevar: true, llegadas: false})
    : response(403, {detail: 'El usuario no admite familias en ningún dispositivo.', code: 'SIN_MODULO'})));
  const s = await clasificacion(l.cancelar(sesion, 184, {motivo: 'x'}));
  igual([s.tipo, s.mensaje, s.verificacion], ['sin_modulo', 'El usuario no admite familias en ningún dispositivo.', 'actualizado']);
  assert.ok(calls.some(c => c.url.endsWith('/perfil/')), 'un 403 parcial vuelve a pedir el perfil');
});

// ---- Diferencia ----

test('cerrar con diferencia: valida antes de pedir; manda motivo y observación; tras un incierto el 409 ALOJADO es «se hizo»', async () => {
  const {r, l, sesion} = await preparar();
  const calls = router(r, () => response(200, {estado: 'ALOJADO', total_alojado: 5, liberadas: 2}));
  igual((await clasificacion(l.cerrarDiferencia(sesion, 184, {motivo: 'OTRO'}))).errores, {observacion: [l.FALTA_OBSERVACION]});
  assert.equal(calls.length, 0);
  igual(await l.cerrarDiferencia(sesion, 184, {motivo: 'NO_LLEGO'}), {resultado: 'hecho', estado: 'ALOJADO', total_alojado: 5, liberadas: 2});
  igual([calls[0].url, calls[0].body], ['/api/emergencia/casos/184/cerrar-diferencia/', {motivo: 'NO_LLEGO'}]);
  await l.cerrarDiferencia(sesion, 184, {motivo: 'OTRO', observacion: '  No sabe su número de DNI  '});
  igual(calls[1].body, {motivo: 'OTRO', observacion: 'No sabe su número de DNI'});
  router(r, () => response(409, ALOJADA_409));
  igual(await l.cerrarDiferencia(sesion, 184, {motivo: 'NO_LLEGO'}, {incierto: true}).then(x => [x.resultado, x.detalle]), ['ya_hecho', ALOJADA_409.detail]);
  router(r, () => response(400, {code: 'VALIDACION', detail: 'Están todas las personas confirmadas: no hay diferencia. Usá «Familia alojada».',
    non_field_errors: ['Están todas las personas confirmadas: no hay diferencia. Usá «Familia alojada».']}));
  igual((await clasificacion(l.cerrarDiferencia(sesion, 184, {motivo: 'NO_LLEGO'}))).errores,
    {generales: ['Están todas las personas confirmadas: no hay diferencia. Usá «Familia alojada».']});
});

// ---- Cancelar ----

test('cancelar el ingreso: motivo obligatorio y recortado; 200 con el caso en la mesa y todas las camas liberadas', async () => {
  const {r, l, sesion} = await preparar();
  const calls = router(r, () => response(200, {estado: 'EN_GESTION', total_alojado: null, liberadas: 7}));
  igual((await clasificacion(l.cancelar(sesion, 184, {motivo: ''}))).errores, {motivo: [l.FALTA_MOTIVO_CANCELAR]});
  assert.equal(calls.length, 0);
  igual(await l.cancelar(sesion, 184, {motivo: '  La familia se fue  '}), {resultado: 'hecho', estado: 'EN_GESTION', total_alojado: null, liberadas: 7});
  igual([calls[0].url, calls[0].body], ['/api/emergencia/casos/184/cancelar-ingreso/', {motivo: 'La familia se fue'}]);
});

test('cancelar NO es idempotente: tras un incierto, el 409 EN_GESTION o NUEVO es «se hizo»; ALOJADO (otra guardia alojó) no', async () => {
  const {r, l, sesion} = await preparar();
  for (const estado of ['EN_GESTION', 'NUEVO']) {
    router(r, () => response(409, {...CANCELADO_409, estado_actual: estado}));
    const hecho = await l.cancelar(sesion, 184, {motivo: 'x'}, {incierto: true});
    igual([hecho.resultado, hecho.estado, hecho.mensaje, hecho.detalle, hecho.destino], ['ya_hecho', estado, l.TEXTO_YA_CANCELADO, CANCELADO_409.detail, 'buscar']);
  }
  router(r, () => response(409, ALOJADA_409));
  igual(await clasificacion(l.cancelar(sesion, 184, {motivo: 'x'}, {incierto: true})).then(c => [c.tipo, c.destino]), ['conflicto', 'integrantes']);
  router(r, () => response(409, CANCELADO_409));
  igual(await clasificacion(l.cancelar(sesion, 184, {motivo: 'x'})).then(c => [c.tipo, c.destino]), ['conflicto', 'buscar'], 'sin incierto es un conflicto');
});

test('cierres sin red no salen; con otra sesión abierta tampoco (ni con su propio token)', async () => {
  const {r, l, sesion} = await preparar();
  const calls = router(r, () => response(200, {estado: 'ALOJADO', total_alojado: 1, liberadas: 0}));
  r.setOnline(false);
  for (const accion of [() => l.alojar(sesion, 184, {}), () => l.cerrarDiferencia(sesion, 184, {motivo: 'NO_LLEGO'}), () => l.cancelar(sesion, 184, {motivo: 'x'})]) {
    assert.equal((await clasificacion(accion())).tipo, 'sin_red');
  }
  r.setOnline(true);
  r.setFetch(async () => response(200, {token: 'tok-2', user_id: 8, username: 'otra', modulos: ['emergencia']}));
  await r.api.loginBecas({username: 'otra', password: 'x'});
  const despues = router(r, () => response(200, {estado: 'ALOJADO', total_alojado: 1, liberadas: 0}));
  for (const accion of [() => l.alojar(sesion, 184, {}), () => l.cancelar(sesion, 184, {motivo: 'x'}),
    () => l.enviarPuerta(sesion, 9, 'ingresar', DATOS)]) {
    assert.equal((await clasificacion(accion())).tipo, 'obsoleto');
  }
  assert.equal(calls.length + despues.length, 0);
});

// ---- Sin derivación (§13.10) ----

test('puerta: validación sin dirección ni nombre obligatorios; el resto como M1', async () => {
  const {l} = await preparar();
  igual(Object.keys(l.validarPuerta(l.datosDeLaPuerta('30111222'))).sort(), ['total', 'traslado']);
  igual(l.validarPuerta({...l.datosDeLaPuerta('30111222'), traslado: 'POLICIA', adultos_m: 1}), {});
  igual(Object.keys(l.validarPuerta({...l.datosDeLaPuerta('30111222'), traslado: 'POLICIA', adultos_m: 1, direccion: 'x'.repeat(241), lactantes: 1})).sort(),
    ['direccion', 'lactantes']);
  assert.equal(l.datosDeLaPuerta('30.111.222').dni, '30111222');
});

test('ingresar igual: POST JSON con el Formulario 1 sin hora, con uuid; 201 trae el caso en curso y sus integrantes', async () => {
  const {r, l, sesion} = await preparar();
  const calls = router(r, () => response(201, INGRESO));
  const i = await l.enviarPuerta(sesion, 9, 'ingresar', DATOS);
  igual([calls[0].method, calls[0].url, calls[0].auth, calls[0].tipo], ['POST', '/api/emergencia/dispositivos/9/ingreso-directo/', 'Token tok', 'application/json']);
  const body = calls[0].body;
  assert.match(body.uuid_cliente, UUID);
  igual({...body, uuid_cliente: 'u'}, {uuid_cliente: 'u', traslado: 'BOMBEROS', dni: '30111222', nombre: 'Rosa', apellido: 'Benítez',
    fecha_nacimiento: '1984-03-02', documento_extraviado: false, menores_f: 0, menores_m: 2, adultos_f: 1, adultos_m: 0, mayores_f: 0, mayores_m: 0,
    dependientes: 0, mayores_dependientes: 0, lactantes: 0, embarazo: true, electrodependiente: false, medicacion_critica: false, mascotas: false,
    observaciones: 'Llegaron solos'});
  assert.ok(!('relevado_en' in body) && !('direccion' in body) && !('localidad' in body), 'sin hora; dirección y localidad vacías no viajan');
  igual([i.accion, i.caso.id, i.reservadas, i.faltantes, i.integrantes.integrantes.length, i.uuid], ['ingresar', 190, 3, 0, 3, body.uuid_cliente]);
  assert.equal(await l.puertaPendiente(sesion, 9, '30111222'), null, 'el 2xx no deja pendiente');
  await l.enviarPuerta(sesion, 9, 'ingresar', DATOS);
  assert.notEqual(calls[1].body.uuid_cliente, body.uuid_cliente, 'otro ingreso es otro pedido');
});

test('avisar a la mesa: mismo cuerpo a /avisar-mesa/; 201 con el caso NUEVO', async () => {
  const {r, l, sesion} = await preparar();
  const calls = router(r, () => response(201, AVISO));
  const a = await l.enviarPuerta(sesion, 9, 'avisar', {...DATOS, direccion: ' Ruta 11 km 3 '});
  igual([calls[0].url, calls[0].body.direccion, calls[0].body.dni], ['/api/emergencia/dispositivos/9/avisar-mesa/', 'Ruta 11 km 3', '30111222']);
  igual([a.accion, a.caso.numero, a.caso.estado], ['avisar', '2026-000191', 'NUEVO']);
});

test('puerta: un formulario incompleto o una fecha imposible no pide nada ni deja pendiente', async () => {
  const {r, l, sesion} = await preparar();
  const calls = router(r, () => response(201, INGRESO));
  igual(Object.keys((await clasificacion(l.enviarPuerta(sesion, 9, 'ingresar', {dni: '30111222'}))).errores).sort(), ['total', 'traslado']);
  igual((await clasificacion(l.enviarPuerta(sesion, 9, 'ingresar', {...DATOS, fecha_nacimiento: '31/02/1984'}))).errores,
    {fecha_nacimiento: ['La fecha de nacimiento no es válida: tiene que ser DD/MM/AAAA.']});
  assert.equal(calls.length, 0);
  assert.equal(await l.puertaPendiente(sesion, 9, '30111222'), null);
});

test('puerta: incierto → el uuid y lo cargado quedan por usuario, dispositivo y DNI (sobreviven a recargar); el reintento manda el MISMO', async () => {
  const {r, l, sesion} = await preparar();
  let intento = 0;
  const calls = router(r, () => { intento += 1; return intento === 1 ? fallaDeRed() : response(200, INGRESO); });
  const primero = await clasificacion(l.enviarPuerta(sesion, 9, 'ingresar', DATOS));
  igual([primero.tipo, primero.incierto, primero.mensaje], ['reintentable', true, l.TEXTO_INGRESAR_INCIERTO]);
  const l2 = r.reload('./emergenciaLlegadas');
  const pendiente = await l2.puertaPendiente(sesion, 9, '30111222');
  igual([pendiente.accion, pendiente.uuid, pendiente.datos.nombre], ['ingresar', primero.uuid, ' Rosa ']);
  assert.equal(await l2.puertaPendiente(sesion, 7, '30111222'), null, 'es por dispositivo');
  assert.equal(await l2.puertaPendiente(sesion, 9, '30111223'), null, 'y por DNI');
  assert.ok(r.legacy.has('emergencia_llegadas_puerta:7'), 'bajo el prefijo que limpia el logout');
  const ok = await l2.enviarPuerta(sesion, 9, 'ingresar', pendiente.datos);
  igual([ok.caso.id, calls[1].body.uuid_cliente], [190, primero.uuid]);
  assert.equal(await l2.puertaPendiente(sesion, 9, '30111222'), null);
});

test('puerta: con un envío sin resultado la otra acción no sale (con otro uuid crearía un segundo caso)', async () => {
  const {r, l, sesion} = await preparar();
  router(r, fallaDeRed);
  await clasificacion(l.enviarPuerta(sesion, 9, 'ingresar', DATOS));
  const calls = router(r, () => response(201, AVISO));
  const c = await clasificacion(l.enviarPuerta(sesion, 9, 'avisar', DATOS));
  igual([c.tipo, c.mensaje], ['rechazo', 'Primero reintentá «Ingresar igual»: ese envío todavía no tiene resultado.']);
  assert.equal(calls.length, 0);
  assert.equal((await l.puertaPendiente(sesion, 9, '30111222')).accion, 'ingresar', 'el pendiente sigue');
});

test('puerta: 400 (por campo y `plazas`), 404 y 409 UUID_EN_USO olvidan el uuid; red, timeout, 5xx, WAF, 429 y 403 lo conservan', async () => {
  const {r, l, sesion} = await preparar();
  const casos = [
    [() => response(400, {code: 'VALIDACION', detail: 'No hay camas libres.', plazas: ['No hay camas libres.']}), false, 'validacion'],
    [() => response(400, {code: 'VALIDACION', detail: 'Escribí el nombre.', nombre: ['Escribí el nombre.']}), false, 'validacion'],
    [() => response(404, {detail: 'No encontrado.'}), false, 'no_encontrado'],
    [() => response(409, {detail: 'Ese identificador de envío ya se usó en otro caso.', code: 'UUID_EN_USO'}), false, 'uuid_en_uso'],
    [fallaDeRed, true, 'reintentable'],
    [() => response(503, {}), true, 'reintentable'],
    [waf, true, 'reintentable'],
    [() => response(429, {detail: 'x'}, {'Retry-After': '5'}), true, 'espera'],
    [(call) => (call.url.endsWith('/perfil/') ? response(200, {llegadas: false}) : response(403, {detail: 'x', code: 'SIN_MODULO'})), true, 'sin_modulo'],
  ];
  for (const [respuesta, conserva, tipo] of casos) {
    router(r, respuesta);
    const c = await clasificacion(l.enviarPuerta(sesion, 9, 'ingresar', DATOS));
    assert.equal(c.tipo, tipo);
    assert.equal(!!await l.puertaPendiente(sesion, 9, '30111222'), conserva, `${tipo} ${conserva ? 'conserva' : 'olvida'}`);
    assert.equal(c.incierto, conserva);
    if (conserva) {
      router(r, () => response(200, INGRESO));
      await l.enviarPuerta(sesion, 9, 'ingresar', DATOS);
    }
  }
  router(r, () => response(400, {code: 'VALIDACION', detail: 'No hay camas.', plazas: ['No hay camas.'], nombre: ['Escribí el nombre.'], dispositivo: ['No recibe familias.']}));
  igual((await clasificacion(l.enviarPuerta(sesion, 9, 'ingresar', DATOS))).errores,
    {plazas: ['No hay camas.'], nombre: ['Escribí el nombre.'], generales: ['No recibe familias.']});
  l.LIMITES.accionMs = 20;
  try {
    router(r, nunca);
    assert.equal((await clasificacion(l.enviarPuerta(sesion, 9, 'avisar', DATOS))).incierto, true);
    assert.equal((await l.puertaPendiente(sesion, 9, '30111222')).accion, 'avisar', 'timeout conserva');
  } finally { l.LIMITES.accionMs = 30000; }
});

test('puerta sin red: no sale nada y un uuid recién nacido no queda; uno de antes sí', async () => {
  const {r, l, sesion} = await preparar();
  const calls = router(r, fallaDeRed);
  r.setOnline(false);
  assert.equal((await clasificacion(l.enviarPuerta(sesion, 9, 'ingresar', DATOS))).tipo, 'sin_red');
  assert.equal(await l.puertaPendiente(sesion, 9, '30111222'), null);
  r.setOnline(true);
  await clasificacion(l.enviarPuerta(sesion, 9, 'ingresar', DATOS));
  const pendiente = await l.puertaPendiente(sesion, 9, '30111222');
  r.setOnline(false);
  const c = await clasificacion(l.enviarPuerta(sesion, 9, 'ingresar', DATOS));
  igual([c.tipo, c.incierto, (await l.puertaPendiente(sesion, 9, '30111222')).uuid], ['sin_red', true, pendiente.uuid]);
  assert.equal(api(calls).length, 1);
});

const sha = (texto) => require('node:crypto').createHash('sha256').update(texto).digest('hex');
const HUELLA = sha('9:30111222');

test('limpieza (m6): logout, otro usuario y 48 h borran lo tipeado pero dejan el uuid sin datos ni DNI en claro, 7 días', async () => {
  const {r, l, sesion} = await preparar();
  router(r, fallaDeRed);
  await clasificacion(l.enviarPuerta(sesion, 9, 'ingresar', DATOS));
  const {uuid} = await l.puertaPendiente(sesion, 9, '30111222');
  const limpieza = r.load('./emergenciaLimpieza');
  r.legacy.set('emergencia_llegadas_puerta:8', JSON.stringify({'9:1234567': {accion: 'avisar', uuid: 'u-8', datos: {nombre: 'X'}, guardado_en: Date.now(), creado_en: Date.now()}}));
  r.legacy.set('emergencia_llegadas_puerta_uuid:8', JSON.stringify({[sha('9:7654321')]: {uuid: 'u-8b', accion: 'ingresar', dispositivo: '9', creado_en: Date.now()}}));
  await limpieza.depurarBorradoresFicha('7');
  assert.ok(!r.legacy.has('emergencia_llegadas_puerta:8'), 'lo tipeado de otro usuario se borra');
  assert.ok(!r.legacy.has('emergencia_llegadas_puerta_uuid:8'), 'y sus uuid sin datos: solo le sirven a su dueño');
  assert.ok((await l.puertaPendiente(sesion, 9, '30111222')).datos, 'el propio vigente queda con lo tipeado');
  // 48 h después de tipearlo: queda el uuid sin datos.
  const viejo = JSON.parse(r.legacy.get('emergencia_llegadas_puerta:7'));
  Object.values(viejo).forEach(p => { p.guardado_en = Date.now() - 49 * 60 * 60 * 1000; });
  r.legacy.set('emergencia_llegadas_puerta:7', JSON.stringify(viejo));
  igual(await l.puertaPendiente(sesion, 9, '30111222'), {accion: 'ingresar', uuid, datos: null}, 'sin lo tipeado, el uuid sigue');
  await limpieza.depurarBorradoresFicha('7');
  assert.ok(!r.legacy.has('emergencia_llegadas_puerta:7'), 'lo tipeado vencido se borra');
  const guardado = r.legacy.get('emergencia_llegadas_puerta_uuid:7');
  assert.ok(!guardado.includes('30111222') && !guardado.includes('Rosa'), 'ni el DNI en claro ni lo tipeado');
  igual(Object.keys(JSON.parse(guardado)), [HUELLA]);
  igual(await l.puertaPendiente(sesion, 9, '30111222'), {accion: 'ingresar', uuid, datos: null});
  // Logout: lo mismo para lo vigente; los uuid sin datos de nadie («agregar») quedan.
  await clasificacion(l.enviarPuerta(sesion, 9, 'avisar', DATOS, {dni: '30999888'}));
  r.legacy.set('emergencia_llegadas_agregar:7', JSON.stringify({184: 'uuid'}));
  await limpieza.limpiarDatosLocalesEmergencia();
  assert.ok(!r.legacy.has('emergencia_llegadas_puerta:7'), 'el logout borra lo tipeado');
  assert.equal((await l.puertaPendiente(sesion, 9, '30999888')).accion, 'avisar', 'y deja el uuid del aviso incierto');
  assert.ok(r.legacy.has('emergencia_llegadas_agregar:7'));
  // A los 7 días el uuid sin datos se va.
  const sinDatos = JSON.parse(r.legacy.get('emergencia_llegadas_puerta_uuid:7'));
  Object.values(sinDatos).forEach(p => { p.creado_en = Date.now() - 8 * 24 * 60 * 60 * 1000; });
  r.legacy.set('emergencia_llegadas_puerta_uuid:7', JSON.stringify(sinDatos));
  assert.equal(await l.puertaPendiente(sesion, 9, '30111222'), null);
  await limpieza.depurarBorradoresFicha('7');
  assert.ok(!r.legacy.has('emergencia_llegadas_puerta_uuid:7'));
  // El logout sí deja el uuid sin datos (es del mismo usuario que vuelve a entrar).
  r.legacy.set('emergencia_llegadas_puerta:8', JSON.stringify({'9:1234567': {accion: 'avisar', uuid: 'u-8', datos: {nombre: 'X'}, guardado_en: Date.now(), creado_en: Date.now()}}));
  await limpieza.limpiarDatosLocalesEmergencia();
  assert.equal(JSON.parse(r.legacy.get('emergencia_llegadas_puerta_uuid:8'))[sha('9:1234567')].uuid, 'u-8');
  await limpieza.depurarBorradoresFicha('8');
  assert.equal(JSON.parse(r.legacy.get('emergencia_llegadas_puerta_uuid:8'))[sha('9:1234567')].uuid, 'u-8', 'su dueño lo conserva');
  assert.ok(!r.legacy.has('emergencia_llegadas_puerta_uuid:7'), 'el de 7 se va cuando entra 8');
  router(r, fallaDeRed);
  await clasificacion(l.enviarPuerta(sesion, 9, 'ingresar', DATOS));
  await limpieza.depurarBorradoresFicha('7');
  assert.ok(!r.legacy.has('emergencia_llegadas_puerta_uuid:8'), 'y el de 8 cuando vuelve a entrar 7');
});

test('m6: tras el logout, el reintento con el uuid solo manda uuid y DNI; si había llegado devuelve el caso (no crea otro)', async () => {
  const {r, l, sesion} = await preparar();
  router(r, fallaDeRed);
  const primero = await clasificacion(l.enviarPuerta(sesion, 9, 'avisar', DATOS));
  await r.load('./emergenciaLimpieza').limpiarDatosLocalesEmergencia();
  const calls = router(r, () => response(200, AVISO));
  const ok = await l.reintentarPuertaSinDatos(sesion, 9, '30111222');
  igual(calls.map(c => [c.url, c.body]), [['/api/emergencia/dispositivos/9/avisar-mesa/', {uuid_cliente: primero.uuid, dni: '30111222'}]]);
  igual([ok.accion, ok.caso.numero], ['avisar', '2026-000191']);
  assert.equal(await l.puertaPendiente(sesion, 9, '30111222'), null, 'resuelto, se olvida');
});

test('m6: con el uuid solo, un 400 (el primero no había llegado) lo olvida y pide cargar de nuevo; un corte lo conserva; enviar con datos lo reusa', async () => {
  const {r, l, sesion} = await preparar();
  router(r, fallaDeRed);
  const primero = await clasificacion(l.enviarPuerta(sesion, 9, 'ingresar', DATOS));
  await r.load('./emergenciaLimpieza').limpiarDatosLocalesEmergencia();
  router(r, fallaDeRed);
  const corte = await clasificacion(l.reintentarPuertaSinDatos(sesion, 9, '30111222'));
  igual([corte.tipo, corte.incierto, corte.mensaje], ['reintentable', true, l.TEXTO_INGRESAR_INCIERTO]);
  // Cargar los datos de nuevo con el uuid sin datos pendiente: el MISMO uuid (y la otra acción no sale).
  const otra = router(r, () => response(201, AVISO));
  assert.equal((await clasificacion(l.enviarPuerta(sesion, 9, 'avisar', DATOS))).tipo, 'rechazo');
  assert.equal(otra.length, 0);
  router(r, () => response(400, {code: 'VALIDACION', detail: 'Elegí el traslado.', traslado: ['Elegí el traslado.']}));
  await r.load('./emergenciaLimpieza').limpiarDatosLocalesEmergencia();
  const c = await clasificacion(l.reintentarPuertaSinDatos(sesion, 9, '30111222'));
  igual([c.tipo, c.mensaje, c.errores, c.incierto], ['validacion', l.TEXTO_REINGRESAR, {generales: [l.TEXTO_REINGRESAR]}, false]);
  assert.equal(await l.puertaPendiente(sesion, 9, '30111222'), null);
  router(r, fallaDeRed);
  await clasificacion(l.enviarPuerta(sesion, 9, 'ingresar', DATOS));
  await r.load('./emergenciaLimpieza').limpiarDatosLocalesEmergencia();
  const calls = router(r, () => response(200, INGRESO));
  await l.enviarPuerta(sesion, 9, 'ingresar', DATOS);
  assert.notEqual(calls[0].body.uuid_cliente, primero.uuid, 'el del 400 ya se había olvidado');
  assert.equal(await l.puertaPendiente(sesion, 9, '30111222'), null);
});

test('m6: cargar los datos de nuevo sobre un uuid sin datos manda el MISMO uuid', async () => {
  const {r, l, sesion} = await preparar();
  router(r, fallaDeRed);
  const primero = await clasificacion(l.enviarPuerta(sesion, 9, 'ingresar', DATOS));
  await r.load('./emergenciaLimpieza').limpiarDatosLocalesEmergencia();
  const calls = router(r, () => response(200, INGRESO));
  await l.enviarPuerta(sesion, 9, 'ingresar', DATOS);
  assert.equal(calls[0].body.uuid_cliente, primero.uuid);
  assert.ok(!r.legacy.has('emergencia_llegadas_puerta_uuid:7'), 'una sola copia, y resuelta se olvida');
});

test('M1: la clave del pendiente y el DNI que viaja son los de la búsqueda, aunque `datos.dni` diga otro', async () => {
  const {r, l, sesion} = await preparar();
  const calls = router(r, fallaDeRed);
  await clasificacion(l.enviarPuerta(sesion, 9, 'ingresar', {...DATOS, dni: '27000111'}, {dni: '30111222'}));
  assert.equal(calls[0].body.dni, '30111222');
  assert.ok(await l.puertaPendiente(sesion, 9, '30111222'));
  assert.equal(await l.puertaPendiente(sesion, 9, '27000111'), null);
});

test('m1: la búsqueda que ya trae derivación o la familia alojada olvida el envío de la puerta; sin derivación lo deja', async () => {
  const {r, l, sesion} = await preparar();
  for (const [resultado, queda] of [['SIN_DERIVACION', true], ['DERIVACION', false], ['ALOJADA', false]]) {
    // Un aviso incierto, con lo tipeado y además el uuid sin datos de un logout anterior.
    router(r, fallaDeRed);
    await clasificacion(l.enviarPuerta(sesion, 9, 'avisar', DATOS));
    router(r, () => response(200, {resultado, dni: '30111222', plazas_libres: 1, mensaje: '', alojada_aca: null, alojada_en: '', alojada_desde: null,
      derivacion: resultado === 'DERIVACION' ? {id: 55, estado: 'PENDIENTE', caso: CASO} : null}));
    await l.buscar(sesion, 9, '30111222');
    assert.equal(!!await l.puertaPendiente(sesion, 9, '30111222'), queda, resultado);
  }
  // También el uuid sin datos que dejó un logout.
  router(r, fallaDeRed);
  await clasificacion(l.enviarPuerta(sesion, 9, 'avisar', DATOS));
  await r.load('./emergenciaLimpieza').limpiarDatosLocalesEmergencia();
  router(r, () => response(200, {resultado: 'ALOJADA', dni: '30111222', plazas_libres: 0, mensaje: 'Alojada.', derivacion: null, alojada_aca: true, alojada_en: '', alojada_desde: null}));
  await l.buscar(sesion, 9, '30111222');
  assert.equal(await l.puertaPendiente(sesion, 9, '30111222'), null);
  assert.ok(!r.legacy.has('emergencia_llegadas_puerta_uuid:7'));
});

test('m2: un 404 con un uuid de antes lo conserva (el back mira el alcance antes que el uuid); con uno nuevo lo olvida', async () => {
  const {r, l, sesion} = await preparar();
  router(r, () => response(404, {detail: 'No encontrado.'}));
  assert.equal((await clasificacion(l.enviarPuerta(sesion, 9, 'ingresar', DATOS))).incierto, false);
  assert.equal(await l.puertaPendiente(sesion, 9, '30111222'), null);
  router(r, fallaDeRed);
  const primero = await clasificacion(l.enviarPuerta(sesion, 9, 'ingresar', DATOS));
  router(r, () => response(404, {detail: 'No encontrado.'}));
  const c = await clasificacion(l.enviarPuerta(sesion, 9, 'ingresar', DATOS));
  igual([c.tipo, c.incierto, (await l.puertaPendiente(sesion, 9, '30111222')).uuid], ['no_encontrado', true, primero.uuid]);
});

test('m3: el reintento de un cancelar incierto relee los integrantes: en la mesa es «se hizo» sin reenviar; en curso sin confirmadas pide reconfirmar; si cambió, no', async () => {
  const {r, l, sesion} = await preparar();
  const integrantes = (extra = {}) => response(200, {caso: CASO, integrantes: [FILA(1)], confirmadas: 0, total_declarado: 1, declaradas_al_relevar: 1, ...extra});
  let calls = router(r, (call) => (call.method === 'GET' ? response(409, {detail: 'Se canceló.', estado_actual: 'EN_GESTION'}) : response(200, {})));
  const hecho = await l.cancelar(sesion, 184, {motivo: 'x'}, {incierto: true});
  igual([hecho.resultado, hecho.estado, hecho.detalle, calls.map(c => c.method)], ['ya_hecho', 'EN_GESTION', 'Se canceló.', ['GET']]);
  calls = router(r, (call) => (call.method === 'GET' ? integrantes() : response(200, {estado: 'EN_GESTION', total_alojado: null, liberadas: 1})));
  const pregunta = await clasificacion(l.cancelar(sesion, 184, {motivo: 'x'}, {incierto: true}));
  igual([pregunta.tipo, pregunta.mensaje, pregunta.incierto, calls.map(c => c.method)],
    ['confirmar_reenvio', 'No sabemos si la cancelación llegó. El ingreso figura en curso, sin nadie confirmado. ¿Cancelarlo?', true, ['GET']],
    'indistinguible de un ingreso nuevo: nunca se reenvía sin preguntar');
  assert.equal((await l.cancelar(sesion, 184, {motivo: 'x'}, {incierto: true, reconfirmado: true})).resultado, 'hecho');
  igual(calls.map(c => c.method), ['GET', 'POST'], 'reconfirmado manda sin volver a leer');
  router(r, () => response(409, {detail: 'Se canceló.', estado_actual: 'EN_GESTION'}));
  assert.equal((await l.cancelar(sesion, 184, {motivo: 'x'}, {incierto: true, reconfirmado: true})).resultado, 'ya_hecho',
    'reconfirmado sigue siendo incierto: el 409 en la mesa es «se hizo»');
  for (const cambio of [{confirmadas: 1}, {caso: {...CASO, estado: 'ALOJADO'}}]) {
    calls = router(r, (call) => (call.method === 'GET' ? integrantes(cambio) : response(200, {})));
    const c = await clasificacion(l.cancelar(sesion, 184, {motivo: 'x'}, {incierto: true}));
    igual([c.tipo, c.destino, c.mensaje, c.incierto, calls.map(x => x.method)], ['conflicto', 'integrantes', l.TEXTO_INGRESO_CAMBIO, false, ['GET']]);
  }
  calls = router(r, fallaDeRed);
  const corte = await clasificacion(l.cancelar(sesion, 184, {motivo: 'x'}, {incierto: true}));
  igual([corte.tipo, corte.incierto, calls.map(x => x.method)], ['reintentable', true, ['GET']]);
  calls = router(r, () => response(200, {estado: 'EN_GESTION', total_alojado: null, liberadas: 1}));
  await l.cancelar(sesion, 184, {motivo: 'x'});
  igual(calls.map(x => x.method), ['POST'], 'sin incierto no relee');
});

test('m4: el «se hizo» de alojar trae la nota de revisar el alojamiento; los otros no', async () => {
  const {r, l, sesion} = await preparar();
  router(r, () => response(409, ALOJADA_409));
  assert.equal((await l.alojar(sesion, 184, {}, {incierto: true})).nota, l.NOTA_REVISAR_ALOJAMIENTO);
  assert.equal((await l.cerrarDiferencia(sesion, 184, {motivo: 'NO_LLEGO'}, {incierto: true})).nota, null);
});

// ---- La derivación vista (Cambio 477, contrato §13.5 y §13.9) ----

const CAMBIO_409 = (estado = 'INGRESO_EN_CURSO') => ({
  detail: 'El ingreso del caso 2026-000184 cambió: la derivación que viste ya no es la vigente. Recargá la pantalla.', estado_actual: estado});

test('477: integrantes expone la derivación vigente; sin ella (back viejo) o con un id raro, null', async () => {
  const {r, l, sesion} = await preparar();
  const base = {caso: CASO, integrantes: [FILA(1)], confirmadas: 0, total_declarado: 1, declaradas_al_relevar: 1};
  assert.equal(l.normalizarIntegrantes({...base, derivacion: {id: 55}}).derivacion_id, 55);
  for (const derivacion of [undefined, null, {}, {id: null}, {id: 0}, {id: -3}, {id: 1.5}, {id: 'x'}, {id: true}, 55]) {
    assert.equal(l.normalizarIntegrantes({...base, derivacion}).derivacion_id, null, JSON.stringify(derivacion));
  }
  router(r, () => response(200, {...base, derivacion: {id: 77}}));
  assert.equal((await l.cargarIntegrantes(sesion, 184)).derivacion_id, 77);
});

test('477: los tres cierres mandan `derivacion` (entero) en el primer envío y en el reintento; sin id no viaja', async () => {
  const {r, l, sesion} = await preparar();
  let calls = router(r, () => response(200, {estado: 'ALOJADO', total_alojado: 3, liberadas: 0}));
  await l.alojar(sesion, 184, {aula: 'A'}, {derivacion: 55});
  await l.alojar(sesion, 184, {aula: 'A'}, {incierto: true, derivacion: 55});
  await l.cerrarDiferencia(sesion, 184, {motivo: 'NO_LLEGO'}, {derivacion: '55'});
  await l.cerrarDiferencia(sesion, 184, {motivo: 'NO_LLEGO'}, {incierto: true, derivacion: 55});
  igual(calls.map(c => c.body), [
    {tarjeta_entregada: false, aula: 'A', derivacion: 55}, {tarjeta_entregada: false, aula: 'A', derivacion: 55},
    {motivo: 'NO_LLEGO', derivacion: 55}, {motivo: 'NO_LLEGO', derivacion: 55}]);
  calls = router(r, () => response(200, {estado: 'EN_GESTION', total_alojado: null, liberadas: 1}));
  await l.cancelar(sesion, 184, {motivo: ' x '}, {derivacion: 55});
  await l.cancelar(sesion, 184, {motivo: ' x '}, {incierto: true, derivacion: 55});
  igual(calls.map(c => [c.method, c.body]), [['POST', {motivo: 'x', derivacion: 55}], ['POST', {motivo: 'x', derivacion: 55}]]);
  calls = router(r, () => response(200, {estado: 'ALOJADO', total_alojado: 3, liberadas: 0}));
  for (const derivacion of [null, undefined, 0, -1, 2.5, 'abc', true]) {
    await l.alojar(sesion, 184, {}, {derivacion});
    await l.cerrarDiferencia(sesion, 184, {motivo: 'NO_LLEGO'}, {derivacion});
  }
  await l.cancelar(sesion, 184, {motivo: 'x'});
  assert.ok(calls.every(c => !('derivacion' in c.body)), 'sin un id válido el campo no viaja (el back viejo sigue igual)');
});

test('477: cancelar incierto con la derivación sale directo, sin releer ni volver a preguntar; 409 en la mesa = «se hizo»', async () => {
  const {r, l, sesion} = await preparar();
  for (const estado of ['EN_GESTION', 'NUEVO']) {
    const calls = router(r, () => response(409, {...CANCELADO_409, estado_actual: estado}));
    const hecho = await l.cancelar(sesion, 184, {motivo: 'x'}, {incierto: true, derivacion: 55});
    igual([hecho.resultado, hecho.estado, hecho.mensaje, hecho.detalle, hecho.destino], ['ya_hecho', estado, l.TEXTO_YA_CANCELADO, CANCELADO_409.detail, 'buscar']);
    igual(calls.map(c => [c.method, c.body]), [['POST', {motivo: 'x', derivacion: 55}]], 'ningún GET antes');
  }
  const calls = router(r, () => response(200, {estado: 'EN_GESTION', total_alojado: null, liberadas: 2}));
  igual(await l.cancelar(sesion, 184, {motivo: 'x'}, {incierto: true, derivacion: 55}),
    {resultado: 'hecho', estado: 'EN_GESTION', total_alojado: null, liberadas: 2}, 'el primero no había llegado: este cancela');
  igual(calls.map(c => c.method), ['POST']);
  router(r, fallaDeRed);
  igual(await clasificacion(l.cancelar(sesion, 184, {motivo: 'x'}, {incierto: true, derivacion: 55})).then(c => [c.tipo, c.incierto, c.mensaje]),
    ['reintentable', true, l.TEXTO_CANCELAR_INCIERTO]);
});

test('477: cancelar incierto, 409 «cambió» (INGRESO_EN_CURSO) = otro ingreso: no se hizo, conflicto a integrantes con el detail', async () => {
  const {r, l, sesion} = await preparar();
  router(r, () => response(409, CAMBIO_409()));
  const c = await clasificacion(l.cancelar(sesion, 184, {motivo: 'x'}, {incierto: true, derivacion: 55}));
  igual([c.tipo, c.ingresoCambio, c.destino, c.estadoActual, c.mensaje, c.incierto],
    ['conflicto', true, 'integrantes', 'INGRESO_EN_CURSO', CAMBIO_409().detail, false]);
  router(r, () => response(409, CAMBIO_409('DERIVADO')));
  const d = await clasificacion(l.cancelar(sesion, 184, {motivo: 'x'}, {incierto: true, derivacion: 55}));
  igual([d.tipo, d.destino, d.mensaje, d.incierto], ['conflicto', 'derivacion', CAMBIO_409().detail, false],
    'derivado de nuevo y sin aceptar: tampoco es «se hizo»; el router vuelve a buscar');
  router(r, () => response(409, {estado_actual: 'INGRESO_EN_CURSO'}));
  igual(await clasificacion(l.cancelar(sesion, 184, {motivo: 'x'}, {derivacion: 55})).then(x => [x.ingresoCambio, x.mensaje]),
    [true, l.TEXTO_DERIVACION_CAMBIO], 'sin detail, el texto propio');
  router(r, () => response(409, {detail: 'La derivación sigue pendiente.', estado_actual: 'INGRESO_EN_CURSO'}));
  igual(await clasificacion(l.alojar(sesion, 184, {})).then(x => [x.tipo, x.ingresoCambio ?? null, x.mensaje]),
    ['conflicto', null, 'La derivación sigue pendiente.'], 'sin derivación no se marca nada (no se mandó)');
});

test('477: con el back viejo (sin derivación) el cancelar incierto conserva la relectura y la reconfirmación', async () => {
  const {r, l, sesion} = await preparar();
  const calls = router(r, (call) => (call.method === 'GET'
    ? response(200, {caso: CASO, integrantes: [FILA(1)], confirmadas: 0, total_declarado: 1, declaradas_al_relevar: 1})
    : response(200, {estado: 'EN_GESTION', total_alojado: null, liberadas: 1})));
  for (const derivacion of [null, undefined, 0]) {
    const pregunta = await clasificacion(l.cancelar(sesion, 184, {motivo: 'x'}, {incierto: true, derivacion}));
    assert.equal(pregunta.tipo, 'confirmar_reenvio');
  }
  igual(calls.map(c => c.method), ['GET', 'GET', 'GET']);
  await l.cancelar(sesion, 184, {motivo: 'x'}, {incierto: true, reconfirmado: true, derivacion: null});
  igual(calls.at(-1).body, {motivo: 'x'});
});

test('477: alojar y diferencia inciertos con la derivación: el 409 «cambió» va al router con el detail; ALOJADO sigue siendo «se hizo»', async () => {
  const {r, l, sesion} = await preparar();
  router(r, () => response(409, CAMBIO_409()));
  for (const accion of [
    () => l.alojar(sesion, 184, {}, {incierto: true, derivacion: 55}),
    () => l.cerrarDiferencia(sesion, 184, {motivo: 'NO_LLEGO'}, {incierto: true, derivacion: 55}),
    () => l.alojar(sesion, 184, {}, {derivacion: 55}),
  ]) {
    const c = await clasificacion(accion());
    igual([c.tipo, c.ingresoCambio, c.destino, c.mensaje, c.incierto], ['conflicto', true, 'integrantes', CAMBIO_409().detail, false]);
  }
  router(r, () => response(409, CAMBIO_409('DERIVADO')));
  igual(await clasificacion(l.alojar(sesion, 184, {}, {incierto: true, derivacion: 55})).then(c => [c.tipo, c.destino]), ['conflicto', 'derivacion']);
  router(r, () => response(409, ALOJADA_409));
  igual(await l.alojar(sesion, 184, {}, {incierto: true, derivacion: 55}).then(x => [x.resultado, x.estado]), ['ya_hecho', 'ALOJADO']);
  igual(await l.cerrarDiferencia(sesion, 184, {motivo: 'NO_LLEGO'}, {incierto: true, derivacion: 55}).then(x => [x.resultado, x.estado]), ['ya_hecho', 'ALOJADO']);
});
