// M2 · Llegada de familias, parte 2, contra contrato-app-emergencia §13.6 a §13.8 y §13.11: la ficha
// (utils/fichaEmergencia), el mapa de camas, «confirmar persona» (idempotente por uuid guardado por
// persona), «completar la ficha» (PATCH por sección) y el borrador local de la ficha en curso.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {setup, response} = require('./helpers/mobile-runtime.cjs');

const igual = (actual, esperado, mensaje) => assert.deepEqual(JSON.parse(JSON.stringify(actual ?? null)), esperado, mensaje);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HOY = new Date(2026, 10, 15);

const PLAZA = (id, codigo, estado, extra = {}) => ({id, codigo, nombre: `${codigo} (Pabellón ${codigo[0]})`, estado,
  elegible: ['LIBRE', 'RESERVADA_FAMILIA'].includes(estado), texto: '', tono: '', detalle: '', ...extra});
const MAPA = {caso: 184, sectores: [
  {sector: {id: 3, nombre: 'Pabellón A', perfil: 'Familias'}, total: 3, libres: 1, reservadas_familia: 1,
    plazas: [PLAZA(40, 'A-00', 'OCUPADA'), PLAZA(41, 'A-01', 'RESERVADA_FAMILIA'), PLAZA(42, 'A-02', 'LIBRE')]},
  {sector: {id: 4, nombre: 'Pabellón B', perfil: ''}, total: 250, libres: 0, reservadas_familia: 1,
    plazas: [PLAZA(50, 'B-01', 'FUERA_SERVICIO', {detalle: 'Colchón roto'}), PLAZA(51, 'B-02', 'RESERVADA_FAMILIA'), PLAZA(52, 'B-03', 'RESERVADA')]},
]};
const FILA = (n, extra = {}) => ({n, estado: 'SIN_CONFIRMAR', ficha_completa: false, persona: null, plaza: null, parentesco: '',
  confirmada_en: null, egresado_en: null, ...extra});
const CONFIRMADA = (n, plaza = {id: 41, codigo: 'A-01', nombre: 'A-01 (Pabellón A)'}) => FILA(n, {estado: 'CONFIRMADA',
  persona: {id: 90, nombre: 'Benítez, Juan', dni: '45111222'}, plaza, parentesco: 'Hijo/a', confirmada_en: '2026-11-12T10:20:00-03:00'});
// El mínimo completo de un adulto, aplanado como lo arma la pantalla.
const MINIMO = {parentesco: 'HIJO', dni: '45.111.222', nombre: ' Juan ', apellido: 'Benítez', sexo: 'M', fecha_nacimiento: '10/03/1990',
  embarazo: false, discapacidad: false, electrodependiente: false, medicacion_critica: false, alergias_graves: false};

async function preparar(plataforma) {
  const r = await setup(plataforma);
  r.setFetch(async () => response(200, {token: 'tok', user_id: 7, username: 'guardia', modulos: ['emergencia']}));
  await r.api.loginBecas({username: 'guardia', password: 'x'});
  const l = r.load('./emergenciaLlegadas');
  const f = r.load('../utils/fichaEmergencia');
  const sesion = await l.abrirSesion();
  return {r, l, f, sesion};
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
const waf = () => ({status: 403, ok: false, headers: {get: n => (n.toLowerCase() === 'content-type' ? 'text/html' : null)}, text: async () => '<html>WAF</html>'});
const clasificacion = async (promesa) => {
  try { await promesa; } catch (e) { return JSON.parse(JSON.stringify(e.clasificacion)); }
  assert.fail('no falló');
};

// ---- La ficha (pura) ----

test('ficha: plano ↔ anidado; sin responder no va, `false` sí; fecha en AAAA-MM-DD; DNI solo dígitos; «sin datos»', async () => {
  const {f} = await preparar();
  const anidada = f.fichaDesdePlano({...MINIMO, telefono: '  ', escuela: ' Escuela 12 ', asiste_escuela: false, nivel_educativo: 'PRIMARIO',
    vacunacion_sin_datos: true, mascotas: null, ajeno: 'x'});
  igual(anidada, {
    parentesco: {parentesco: 'HIJO'},
    datos_personales: {dni: '45111222', nombre: 'Juan', apellido: 'Benítez', sexo: 'M', fecha_nacimiento: '1990-03-10'},
    avisos_salud: {embarazo: false, discapacidad: false, electrodependiente: false, medicacion_critica: false, alergias_graves: false},
    educacion: {nivel_educativo: 'PRIMARIO', escuela: 'Escuela 12', asiste_escuela: false},
    vacunacion: {sin_datos: true},
    salud: {}, trabajo: {}, observaciones: {},
  });
  // La ficha guardada (con `version`) vuelve a la pantalla con la fecha local.
  const plano = f.fichaAPlano({version: 1, ...anidada, otra: {x: 1}});
  igual([plano.fecha_nacimiento, plano.dni, plano.asiste_escuela, plano.vacunacion_sin_datos, 'telefono' in plano, 'version' in plano],
    ['10/03/1990', '45111222', false, true, false, false]);
  igual(f.fichaDesdePlano(plano), JSON.parse(JSON.stringify(anidada)), 'ida y vuelta');
  igual(f.fichaDesdePlano({}, ['educacion']), {educacion: {}});
});

test('ficha: el mínimo bloquea lo que el back exige siempre; nombre, apellido, sexo y fecha los completa el legajo', async () => {
  const {f} = await preparar();
  const v = (plano, extra = {}) => Object.keys(f.validarConfirmacion(plano, {plazaId: 41, hoy: HOY, ...extra})).sort();
  igual(v({}), ['alergias_graves', 'discapacidad', 'dni', 'electrodependiente', 'embarazo', 'medicacion_critica', 'parentesco'].sort());
  igual(v({...MINIMO, nombre: '', apellido: '', sexo: null, fecha_nacimiento: ''}), [], 'con legajo alcanza el DNI');
  igual(v({...MINIMO, parentesco: 'OTRO'}), ['parentesco_otro']);
  igual(v({...MINIMO, parentesco: 'OTRO', parentesco_otro: 'Tía'}), []);
  igual(v({...MINIMO, dni: '123'}), ['dni']);
  igual(v({...MINIMO, embarazo: null}), ['embarazo'], '`false` es respuesta; sin responder no');
  igual(v({...MINIMO, medicacion_critica: true}), ['medicacion_critica_nombre', 'medicacion_critica_tiene_dosis']);
  igual(v({...MINIMO, medicacion_critica: true, medicacion_critica_nombre: 'Insulina', medicacion_critica_tiene_dosis: false}), []);
  igual(v({...MINIMO, fecha_nacimiento: '10/03/2012'}), ['adulto_responsable'], 'menor de 16');
  igual(v({...MINIMO, fecha_nacimiento: '10/03/2012', adulto_responsable: 'Rosa Benítez'}), []);
  igual(v({...MINIMO, fecha_nacimiento: '15/11/2010'}), [], 'cumplió 16 hoy');
  igual(v({...MINIMO, fecha_nacimiento: '16/11/2010'}), ['adulto_responsable'], 'cumple 16 mañana');
  igual(v(MINIMO, {plazaId: null}), ['plaza']);
  igual(v({...MINIMO, fecha_nacimiento: '31/02/2000'}), ['fecha_nacimiento']);
  igual(v({...MINIMO, fecha_nacimiento: '01/01/2030'}), ['fecha_nacimiento'], 'futura');
  igual(v({...MINIMO, nivel_educativo: 'DOCTORADO', parentesco_otro: 'x'.repeat(81), observaciones: 'x'.repeat(1001)}),
    ['nivel_educativo', 'observaciones', 'parentesco_otro']);
  assert.equal(f.validarConfirmacion({}, {hoy: HOY}).embarazo[0], 'Falta: avisos de salud · respondé sí o no a embarazo.');
});

test('ficha: completar valida tipos y el adulto de un menor; solo cambian las secciones tocadas; las que faltan', async () => {
  const {f} = await preparar();
  const guardada = {version: 1, ...f.fichaDesdePlano({...MINIMO, fecha_nacimiento: '10/03/2012', adulto_responsable: 'Rosa',
    escuela: 'N.° 12', trabajo_sin_datos: true})};
  const plano = f.fichaAPlano(guardada);
  igual(f.seccionesCambiadas(plano, guardada), []);
  igual(f.seccionesIncompletas(plano), ['Vacunación', 'Salud y medicación']);
  igual(f.seccionesCambiadas({...plano, escuela: 'N.° 12 '}, guardada), [], 'los espacios no son un cambio');
  igual(f.seccionesCambiadas({...plano, obra_social: 'PAMI', vacunacion_sin_datos: true}, guardada), ['vacunacion', 'salud']);
  igual(Object.keys(f.validarCompletar({...plano, adulto_responsable: ''}, {hoy: HOY})), ['adulto_responsable']);
  igual(Object.keys(f.validarCompletar({...plano, ocupacion: 'x'.repeat(201)}, {hoy: HOY})), ['ocupacion']);
  igual(f.validarCompletar(plano, {hoy: HOY}), {});
});

// ---- El mapa (§13.7) ----

test('mapa: normaliza; la cama por defecto es la primera guardada para la familia; elegibles; revisar la elegida', async () => {
  const {l} = await preparar();
  const m = l.normalizarMapa(MAPA);
  igual(m.sectores.map(s => [s.sector.nombre, s.plazas.length, s.total]), [['Pabellón A', 3, 3], ['Pabellón B', 3, 250]]);
  assert.equal(l.camaPorDefecto(m).id, 41);
  igual(l.camasElegibles(m).map(p => p.id), [41, 42, 51]);
  igual([l.revisarCama(m, 42).plaza.id, l.revisarCama(m, 42).cambio], [42, false]);
  igual([l.revisarCama(m, 40).plaza.id, l.revisarCama(m, 40).cambio, l.revisarCama(m, 40).anterior.codigo], [41, true, 'A-00'], 'la ocupada se cambia');
  igual([l.revisarCama(m, null).plaza.id, l.revisarCama(m, null).cambio], [41, false]);
  const sinFamilia = l.normalizarMapa({caso: 184, sectores: [{...MAPA.sectores[0], plazas: [PLAZA(42, 'A-02', 'LIBRE')]}]});
  assert.equal(l.camaPorDefecto(sinFamilia), null, 'una libre no se elige sola');
  igual(l.estadoDeCama('RESERVADA'), {titulo: 'Reservada para otra persona', tono: 'gray'});
  igual(l.normalizarMapa({detail: 'x'}), {caso: null, sectores: []});
});

test('cargar persona y camas: GET de §13.6 y §13.7 con el token de la sesión; 404 y 409', async () => {
  const {r, l, sesion} = await preparar();
  const calls = router(r, (call) => (call.url.includes('/plazas/') ? response(200, MAPA)
    : response(200, {...CONFIRMADA(2), ficha: {version: 1, educacion: {sin_datos: true}}, secciones_incompletas: ['Vacunación']})));
  const p = await l.cargarPersona(sesion, 184, 2);
  igual([p.n, p.estado, p.ficha.educacion, p.secciones_incompletas], [2, 'CONFIRMADA', {sin_datos: true}, ['Vacunación']]);
  const m = await l.cargarCamas(sesion, 9, 184);
  assert.equal(m.sectores.length, 2);
  igual(calls.map(c => [c.method, c.url, c.auth]), [['GET', '/api/emergencia/casos/184/integrantes/2/', 'Token tok'],
    ['GET', '/api/emergencia/dispositivos/9/plazas/?caso=184', 'Token tok']]);
  router(r, () => response(404, {detail: 'No encontrado.'}));
  assert.equal((await clasificacion(l.cargarPersona(sesion, 184, 9))).tipo, 'no_encontrado');
  assert.equal((await clasificacion(l.cargarCamas(sesion, 9, 184))).tipo, 'no_encontrado');
  router(r, () => response(409, {detail: 'La mesa canceló la derivación.', estado_actual: 'EN_GESTION'}));
  igual(await clasificacion(l.cargarPersona(sesion, 184, 2)).then(c => [c.tipo, c.destino]), ['conflicto', 'buscar']);
  router(r, () => response(200, {detail: 'raro'}));
  assert.equal((await clasificacion(l.cargarPersona(sesion, 184, 2))).tipo, 'rechazo', 'una respuesta sin fila no se toma como persona');
});

// ---- Confirmar (§13.8) ----

test('confirmar: POST JSON con uuid, plaza_id y la ficha anidada (las ocho secciones); 201 trae la fila y el contador', async () => {
  const {r, l, sesion} = await preparar();
  const calls = router(r, () => response(201, {integrante: CONFIRMADA(2), confirmadas: 2, total_declarado: 7, reserva_liberada: false}));
  const res = await l.confirmarPersona(sesion, 184, 2, {plano: {...MINIMO, escuela: 'N.° 12'}, plazaId: 41});
  assert.equal(calls[0].url, '/api/emergencia/casos/184/integrantes/2/confirmar/');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].auth, 'Token tok');
  assert.match(calls[0].init.headers['Content-Type'], /application\/json/);
  assert.match(calls[0].body.uuid_cliente, UUID);
  assert.equal(calls[0].body.plaza_id, 41);
  igual(Object.keys(calls[0].body.ficha), ['parentesco', 'datos_personales', 'avisos_salud', 'educacion', 'vacunacion', 'salud', 'trabajo', 'observaciones']);
  igual(calls[0].body.ficha.datos_personales.dni, '45111222');
  igual(calls[0].body.ficha.educacion, {escuela: 'N.° 12'});
  igual([res.integrante.estado, res.confirmadas, res.total_declarado, res.reserva_liberada, res.otraCama], ['CONFIRMADA', 2, 7, false, null]);
  assert.equal(await l.confirmarPendiente(sesion, 184, 2), null, 'el 2xx olvida el uuid');
  await l.confirmarPersona(sesion, 184, 3, {plano: MINIMO, plazaId: 42});
  assert.notEqual(calls[1].body.uuid_cliente, calls[0].body.uuid_cliente, 'otra persona, otro pedido');
});

test('confirmar es idempotente: tras un corte el uuid queda guardado por persona y el reintento (también tras cerrar la app) manda el MISMO', async () => {
  const {r, l, sesion} = await preparar();
  let intento = 0;
  const calls = router(r, () => { intento += 1; return intento === 1 ? fallaDeRed()
    : response(intento === 2 ? 200 : 201, {integrante: CONFIRMADA(2), confirmadas: 2, total_declarado: 7, reserva_liberada: true}); });
  const c = await clasificacion(l.confirmarPersona(sesion, 184, 2, {plano: MINIMO, plazaId: 41}));
  igual([c.tipo, c.mensaje], ['reintentable', l.TEXTO_CONFIRMAR_INCIERTO]);
  const pendiente = await l.confirmarPendiente(sesion, 184, 2);
  assert.match(pendiente, UUID);
  assert.equal(await l.confirmarPendiente(sesion, 184, 3), null, 'es por persona');
  assert.equal(await l.confirmarPendiente(sesion, 190, 2), null, 'y por caso');
  const l2 = r.reload('./emergenciaLlegadas');
  assert.equal(await l2.confirmarPendiente(sesion, 184, 2), pendiente);
  // El primero había llegado con la A-01; el reintento eligió la A-02: vale lo del servidor y se avisa.
  const res = await l2.confirmarPersona(sesion, 184, 2, {plano: MINIMO, plazaId: 42});
  igual([res.otraCama?.codigo, res.reserva_liberada], ['A-01', true]);
  assert.equal(await l2.confirmarPendiente(sesion, 184, 2), null);
  igual(calls.map(x => x.body.uuid_cliente === pendiente), [true, true]);
});

test('confirmar: 400, 404 y 409 olvidan el uuid; red, timeout, 5xx, WAF, 429 y 403 lo conservan; sin red no deja uno nuevo', async () => {
  const {r, l, sesion} = await preparar();
  const casos = [
    [() => response(400, {code: 'VALIDACION', detail: 'x', embarazo: ['Falta']}), false],
    [() => response(404, {detail: 'No encontrado.'}), false],
    [() => response(409, {detail: 'La persona 2 ya fue confirmada. Recargá la lista.', estado_actual: 'INGRESO_EN_CURSO'}), false],
    [fallaDeRed, true],
    [() => response(503, {}), true],
    [waf, true],
    [() => response(429, {detail: 'x'}, {'Retry-After': '5'}), true],
    [(call) => (call.url.endsWith('/perfil/') ? response(200, {llegadas: false}) : response(403, {detail: 'x', code: 'SIN_MODULO'})), true],
  ];
  for (const [respuesta, conserva] of casos) {
    router(r, respuesta);
    const error = await l.confirmarPersona(sesion, 184, 2, {plano: MINIMO, plazaId: 41}).catch(e => e);
    assert.ok(error?.clasificacion, 'tiene que fallar');
    assert.equal(!!await l.confirmarPendiente(sesion, 184, 2), conserva, `${error.clasificacion.tipo} ${conserva ? 'conserva' : 'olvida'}`);
    if (conserva) await l.olvidarConfirmarPendiente(sesion, 184, 2);
  }
  l.LIMITES.accionMs = 20;
  try {
    router(r, nunca);
    igual(await clasificacion(l.confirmarPersona(sesion, 184, 2, {plano: MINIMO, plazaId: 41})).then(c => c.tipo), 'reintentable');
    const guardado = await l.confirmarPendiente(sesion, 184, 2);
    assert.ok(guardado, 'timeout conserva');
    // Sin red no sale nada: el pendiente de antes sigue, y uno recién nacido no queda.
    const calls = router(r, () => response(201, {}));
    r.setOnline(false);
    assert.equal((await clasificacion(l.confirmarPersona(sesion, 184, 2, {plano: MINIMO, plazaId: 41}))).tipo, 'sin_red');
    assert.equal(await l.confirmarPendiente(sesion, 184, 2), guardado);
    assert.equal((await clasificacion(l.confirmarPersona(sesion, 184, 5, {plano: MINIMO, plazaId: 41}))).tipo, 'sin_red');
    assert.equal(await l.confirmarPendiente(sesion, 184, 5), null);
    assert.equal(calls.length, 0);
  } finally { l.LIMITES.accionMs = 30000; }
});

test('confirmar: el 400 VALIDACION va por el nombre plano del campo; `orden` y lo demás a generales; 409 es conflicto', async () => {
  const {r, l, sesion} = await preparar();
  router(r, () => response(400, {code: 'VALIDACION', detail: 'Falta: avisos de salud.',
    embarazo: ['Falta: avisos de salud · respondé sí o no a embarazo.'],
    plaza: ['Cama A-01 (Pabellón A): La plaza ya está ocupada. Recargá el mapa y elegí otra.'],
    dni: ['Ya confirmaste a Benítez, Juan en la cama A-01 (Pabellón A).'], orden: ['Esa persona no es de esta familia. Recargá la lista.']}));
  const c = await clasificacion(l.confirmarPersona(sesion, 184, 2, {plano: MINIMO, plazaId: 41}));
  igual(c.errores, {embarazo: ['Falta: avisos de salud · respondé sí o no a embarazo.'],
    plaza: ['Cama A-01 (Pabellón A): La plaza ya está ocupada. Recargá el mapa y elegí otra.'],
    dni: ['Ya confirmaste a Benítez, Juan en la cama A-01 (Pabellón A).'], generales: ['Esa persona no es de esta familia. Recargá la lista.']});
  router(r, () => response(400, {code: 'VALIDACION', detail: 'No se puede.', non_field_errors: ['La persona tiene otra reserva.']}));
  igual((await clasificacion(l.confirmarPersona(sesion, 184, 2, {plano: MINIMO, plazaId: 41}))).errores, {generales: ['La persona tiene otra reserva.']});
  router(r, () => response(409, {detail: 'La persona 2 ya fue confirmada. Recargá la lista.', estado_actual: 'INGRESO_EN_CURSO'}));
  igual(await clasificacion(l.confirmarPersona(sesion, 184, 2, {plano: MINIMO, plazaId: 41})).then(x => [x.tipo, x.destino, x.mensaje]),
    ['conflicto', 'integrantes', 'La persona 2 ya fue confirmada. Recargá la lista.']);
});

// ---- Completar (§13.6) ----

test('completar: PATCH solo con las secciones pedidas (4 a 8); 200 trae si quedó completa y lo que falta', async () => {
  const {r, l, sesion} = await preparar();
  const calls = router(r, () => response(200, {ficha_completa: false, secciones_incompletas: ['Salud y medicación', 'Trabajo']}));
  const res = await l.completarFicha(sesion, 184, 2, {plano: {...MINIMO, nivel_educativo: 'PRIMARIO', vacunacion_sin_datos: true},
    secciones: ['educacion', 'vacunacion', 'datos_personales']});
  igual(calls.map(c => [c.method, c.url]), [['PATCH', '/api/emergencia/casos/184/integrantes/2/']]);
  igual(calls[0].body, {ficha: {educacion: {nivel_educativo: 'PRIMARIO'}, vacunacion: {sin_datos: true}}}, 'el mínimo no se manda');
  igual(res, {ficha_completa: false, secciones_incompletas: ['Salud y medicación', 'Trabajo']});
  router(r, fallaDeRed);
  igual(await clasificacion(l.completarFicha(sesion, 184, 2, {plano: MINIMO})).then(c => [c.tipo, c.mensaje]), ['reintentable', l.TEXTO_FICHA_INCIERTA]);
  router(r, () => response(400, {code: 'VALIDACION', detail: 'x', adulto_responsable: ['Es menor de 16 años: indicá el adulto responsable (sección 8).']}));
  igual((await clasificacion(l.completarFicha(sesion, 184, 2, {plano: MINIMO}))).errores, {adulto_responsable: ['Es menor de 16 años: indicá el adulto responsable (sección 8).']});
  router(r, () => response(409, {detail: 'El caso está cerrado.', estado_actual: 'CERRADO'}));
  igual(await clasificacion(l.completarFicha(sesion, 184, 2, {plano: MINIMO})).then(c => [c.tipo, c.destino]), ['conflicto', 'integrantes']);
});

// ---- Sesión ----

test('sesión: con otra sesión abierta no sale ningún pedido de la parte 2 de la anterior', async () => {
  const {r, l, sesion} = await preparar();
  r.setFetch(async () => response(200, {token: 'tok-2', user_id: 8, username: 'otra', modulos: ['emergencia']}));
  await r.api.loginBecas({username: 'otra', password: 'x'});
  const calls = router(r, () => response(200, {}));
  for (const accion of [() => l.cargarPersona(sesion, 184, 2), () => l.cargarCamas(sesion, 9, 184),
    () => l.confirmarPersona(sesion, 184, 2, {plano: MINIMO, plazaId: 41}), () => l.completarFicha(sesion, 184, 2, {plano: MINIMO})]) {
    assert.equal((await clasificacion(accion())).tipo, 'obsoleto');
  }
  assert.equal(calls.length, 0, 'ni con su propio token');
  // La respuesta que vuelve con otra sesión ya abierta tampoco se usa.
  const otra = await l.abrirSesion();
  router(r, async () => {
    r.setFetch(async () => response(200, {token: 'tok-3', user_id: 9, username: 'tercera', modulos: ['emergencia']}));
    await r.api.loginBecas({username: 'tercera', password: 'x'});
    return response(201, {integrante: CONFIRMADA(2), confirmadas: 2, total_declarado: 7, reserva_liberada: false});
  });
  assert.equal((await clasificacion(l.confirmarPersona(otra, 184, 2, {plano: MINIMO, plazaId: 41}))).tipo, 'obsoleto');
});

// ---- Borrador ----

test('borrador de la ficha: por usuario, caso, persona y modo; vence a las 48 h; se borra', async () => {
  const {r, l, sesion} = await preparar();
  await l.guardarBorradorFicha(sesion, 184, 2, {modo: 'confirmar', plano: {dni: '45111222'}, plazaId: 42});
  igual(await l.leerBorradorFicha(sesion, 184, 2, 'confirmar'), {plano: {dni: '45111222'}, plazaId: 42});
  assert.equal(await l.leerBorradorFicha(sesion, 184, 3, 'confirmar'), null, 'es por persona');
  assert.equal(await l.leerBorradorFicha({owner: '8'}, 184, 2, 'confirmar'), null, 'es por usuario');
  // La persona ya está confirmada: el borrador de confirmación no sirve para completar, y se borra.
  assert.equal(await l.leerBorradorFicha(sesion, 184, 2, 'completar'), null);
  assert.equal(await l.leerBorradorFicha(sesion, 184, 2, 'confirmar'), null);
  await l.guardarBorradorFicha(sesion, 184, 2, {modo: 'completar', plano: {escuela: 'N.° 12'}});
  r.setNow(Date.now() + l.VIDA_BORRADOR_MS + 1000);
  assert.equal(await l.leerBorradorFicha(sesion, 184, 2, 'completar'), null, 'vencido');
  await l.guardarBorradorFicha(sesion, 184, 2, {modo: 'completar', plano: {escuela: 'N.° 12'}});
  await l.borrarBorradorFicha(sesion, 184, 2);
  assert.equal(await l.leerBorradorFicha(sesion, 184, 2, 'completar'), null);
});
