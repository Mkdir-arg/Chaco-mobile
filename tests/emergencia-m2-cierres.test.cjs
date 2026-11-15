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

test('limpieza: el logout borra los envíos de la puerta (tienen DNI y lo tipeado); al abrir el módulo, los de otro usuario y los vencidos', async () => {
  const {r, l, sesion} = await preparar();
  router(r, fallaDeRed);
  await clasificacion(l.enviarPuerta(sesion, 9, 'ingresar', DATOS));
  const limpieza = r.load('./emergenciaLimpieza');
  r.legacy.set('emergencia_llegadas_puerta:8', JSON.stringify({'9:1': {accion: 'avisar', uuid: 'u', datos: {}, guardado_en: Date.now()}}));
  await limpieza.depurarBorradoresFicha('7');
  assert.ok(!r.legacy.has('emergencia_llegadas_puerta:8'), 'el de otro usuario se borra');
  assert.ok(await l.puertaPendiente(sesion, 9, '30111222'), 'el propio vigente queda');
  const viejo = JSON.parse(r.legacy.get('emergencia_llegadas_puerta:7'));
  Object.values(viejo).forEach(p => { p.guardado_en = Date.now() - 49 * 60 * 60 * 1000; });
  r.legacy.set('emergencia_llegadas_puerta:7', JSON.stringify(viejo));
  assert.equal(await l.puertaPendiente(sesion, 9, '30111222'), null, 'vencido no se ofrece');
  await limpieza.depurarBorradoresFicha('7');
  assert.ok(!r.legacy.has('emergencia_llegadas_puerta:7'), 'vencido se borra');
  await clasificacion(l.enviarPuerta(sesion, 9, 'ingresar', DATOS));
  r.legacy.set('emergencia_llegadas_agregar:7', JSON.stringify({184: 'uuid'}));
  await limpieza.limpiarDatosLocalesEmergencia();
  assert.ok(!r.legacy.has('emergencia_llegadas_puerta:7'), 'el logout lo borra');
  assert.ok(r.legacy.has('emergencia_llegadas_agregar:7'), 'los uuid sin datos de nadie quedan');
});
