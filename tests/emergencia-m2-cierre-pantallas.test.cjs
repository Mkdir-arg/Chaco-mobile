// Pantallas de M2 · Llegada de familias, parte 3: cerrar el ingreso (EmergenciaCierreScreen: alojar,
// con diferencia, cancelar), la familia sin derivación (EmergenciaPuertaScreen: ingresar igual, avisar
// a la mesa) y su tramo del router de EmergenciaApp. La lógica (services/emergenciaLlegadas) y la API
// (services/emergenciaApi) son las reales, sobre el fetch falso del runtime.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const React = require('react');
const renderer = require('react-test-renderer');
const {transformSync} = require('@babel/core');
const {setup, response} = require('./helpers/mobile-runtime.cjs');
global.IS_REACT_ACT_ENVIRONMENT = true;

const root = path.join(__dirname, '..');
const native = Object.fromEntries(['View', 'Text', 'ScrollView', 'Pressable', 'ActivityIndicator', 'Image', 'TextInput',
  'RefreshControl'].map(name => [name, name]));
const plataforma = {OS: 'android'};
Object.assign(native, {Platform: plataforma, StyleSheet: {create: value => value}});
const theme = {colors: new Proxy({}, {get: (_, k) => (k === 'danger' ? '#D00000' : '#5059BC')})};
const typography = {bold: 'Manrope', medium: 'Manrope', semibold: 'Manrope', regular: 'Manrope'};
const text = node => node.children.map(value => typeof value === 'string' ? value : typeof value === 'number' ? String(value) : text(value)).join('');
const esperar = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
const plano = valor => JSON.parse(JSON.stringify(valor ?? null));

function loadPure(relative) {
  const {code} = transformSync(fs.readFileSync(path.join(root, relative), 'utf8'), {
    babelrc: false, configFile: false, plugins: ['@babel/plugin-transform-modules-commonjs']});
  const module = {exports: {}};
  vm.runInNewContext('(function(module,exports){' + code + '\n})', {})(module, module.exports);
  return module.exports;
}

function loadScreen(relative, mocks, extra = {}) {
  const filename = path.join(root, relative);
  const {code} = transformSync(fs.readFileSync(filename, 'utf8'), {
    filename, babelrc: false, configFile: false,
    plugins: ['@babel/plugin-transform-react-jsx', '@babel/plugin-transform-modules-commonjs']});
  const module = {exports: {}};
  const context = vm.createContext({console, setTimeout, clearTimeout, Date, setInterval: () => 0, clearInterval: () => {}, ...extra});
  vm.runInContext('(function(require,module,exports){' + code + '\n})', context)(
    name => { assert.ok(mocks[name], 'Missing screen mock: ' + name); return mocks[name]; }, module, module.exports);
  return module.exports.default;
}

async function render(Screen, props) {
  let tree;
  await renderer.act(async () => { tree = renderer.create(React.createElement(Screen, props)); });
  await renderer.act(async () => { await esperar(5); });
  const labels = () => tree.root.findAllByType('Text').map(text);
  const pressables = () => tree.root.findAllByType('Pressable');
  const press = async (label) => {
    const nodo = pressables().find(n => n.props.accessibilityLabel === label);
    assert.ok(nodo, 'Missing pressable ' + label + ' — hay: ' + pressables().map(p => p.props.accessibilityLabel));
    await renderer.act(async () => { await nodo.props.onPress(); await esperar(5); });
  };
  const button = title => tree.root.findAllByType('CustomButton').find(node => node.props.title === title);
  const titulos = () => tree.root.findAllByType('CustomButton').map(b => b.props.title);
  const pressButton = async (title) => {
    const found = button(title);
    assert.ok(found, 'Missing CustomButton ' + title + ' — hay: ' + titulos());
    await renderer.act(async () => { await found.props.onPress(); await esperar(5); });
  };
  const input = label => tree.root.findAllByType('TextInput').find(node => node.props.accessibilityLabel === label);
  const escribir = async (label, valor) => {
    const found = input(label);
    assert.ok(found, 'Missing input ' + label);
    await renderer.act(async () => { found.props.onChangeText(valor); });
  };
  const rerender = async (nuevas) => renderer.act(async () => { tree.update(React.createElement(Screen, {...props, ...nuevas})); await esperar(5); });
  return {tree, labels, pressables, press, button, titulos, pressButton, input, escribir, rerender,
    close: async () => renderer.act(async () => tree.unmount())};
}

const CASO = {id: 184, numero: '2026-000184', estado: 'INGRESO_EN_CURSO', prioridad: 'ALTA', total_declarado: 3};
const FILA = (n, extra = {}) => ({n, estado: 'SIN_CONFIRMAR', ficha_completa: false, persona: null, plaza: null, parentesco: '',
  confirmada_en: null, egresado_en: null, ...extra});
const CONFIRMADAS = [1, 2, 3].map(n => FILA(n, {estado: 'CONFIRMADA', plaza: {id: 50 + n, codigo: `B-0${n}`, nombre: `B-0${n} (Pabellón B)`}}));
const MAPA = {caso: 184, sectores: [
  {sector: {id: 3, nombre: 'Pabellón A', perfil: 'Familias'}, total: 1, libres: 1, reservadas_familia: 0, plazas: [{id: 40, codigo: 'A-00', estado: 'LIBRE', elegible: true}]},
  {sector: {id: 4, nombre: 'Pabellón B', perfil: 'Familias'}, total: 3, libres: 0, reservadas_familia: 0,
    plazas: [51, 52, 53].map(id => ({id, codigo: `B-0${id - 50}`, estado: 'OCUPADA', elegible: false}))}]};
const ALOJADA_409 = {detail: 'La familia del caso 2026-000184 ya figura alojada. Recargá la pantalla.', estado_actual: 'ALOJADO'};
const INGRESO = {caso: {id: 190, numero: '2026-000190', estado: 'INGRESO_EN_CURSO', prioridad: 'MEDIA', total_declarado: 1},
  reservadas: 1, faltantes: 0, integrantes: [FILA(1)]};
const AVISO = {caso: {id: 191, numero: '2026-000191', estado: 'NUEVO', prioridad: 'MEDIA', total_declarado: 1}};
const fallaDeRed = () => Promise.reject(new TypeError('Load failed'));
const nunca = () => new Promise(() => {});
const SIN_RED = 'Sin conexión: no podés buscar familias ni reservar camas. La llegada de familias necesita señal; probá cuando vuelva la red.';
const posts = calls => calls.filter(c => c.method === 'POST');

async function entorno(rutas) {
  const runtime = await setup();
  runtime.setFetch(async () => response(200, {token: 'tok', user_id: 7, username: 'guardia', modulos: ['emergencia']}));
  await runtime.api.loginBecas({username: 'guardia', password: 'x'});
  const calls = [];
  runtime.setFetch(async (url, init = {}) => {
    const call = {url: String(url).replace('https://example.test', ''), method: init.method || 'GET', init,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body};
    calls.push(call);
    return rutas(call, calls);
  });
  const toasts = [];
  const alerts = [];
  const llegadas = runtime.load('./emergenciaLlegadas');
  const mocks = {
    react: React, 'react-native': native, '@expo/vector-icons': {Ionicons: 'Ionicons'},
    '../context/ThemeContext': {useTheme: () => ({theme, typography})},
    '../context/ToastContext': {useToast: () => ({showToast: value => toasts.push(value), showAlert: (...args) => alerts.push(args)})},
    '../theme/statusBadges': loadPure('src/theme/statusBadges.js'),
    '../theme': loadPure('src/theme/tokens.js'),
    '../components/CustomButton': {__esModule: true, default: 'CustomButton'},
    '../components/FormInput': {__esModule: true, default: native.TextInput},
    '../components/FechaInput': {__esModule: true, default: 'FechaInput'},
    '../utils/teclado': {keyboardDismissModeFor: () => 'on-drag'},
    '../utils/dni': runtime.load('../utils/dni'),
    '../utils/emergencia': runtime.load('../utils/emergencia'),
    '../services/emergenciaLlegadas': llegadas,
  };
  const aceptarAlerta = async (texto) => {
    const opcion = alerts.at(-1)[2].find(o => o.text === texto);
    assert.ok(opcion, 'Falta la opción ' + texto + ' — hay: ' + alerts.at(-1)[2].map(o => o.text));
    await renderer.act(async () => { await opcion.onPress(); await esperar(5); });
  };
  return {runtime, calls, toasts, alerts, llegadas, mocks, aceptarAlerta};
}
const fondoDe = (tree, contenido) => {
  const nodo = tree.root.findAllByType('Text').find(n => text(n) === contenido);
  assert.ok(nodo, 'Falta ' + contenido);
  const estilos = [].concat(nodo.parent.props.style || []).flat();
  return estilos.find(e => e && e.backgroundColor)?.backgroundColor;
};

// ---- Cerrar el ingreso ----

async function montarCierre(rutas, {cierre = 'alojar', confirmadas = 3, total = 3, integrantes = CONFIRMADAS, online = true, env: previo, derivacion} = {}) {
  const env = previo || await entorno(rutas);
  env.runtime.setOnline(online);
  const eventos = [];
  const enviando = [];
  const Screen = loadScreen('src/screens/EmergenciaCierreScreen.js', env.mocks);
  const ui = await render(Screen, {caso: CASO, cierre, confirmadas, total, integrantes, dispositivo: {id: 9, nombre: 'Escuela 12'},
    ...(derivacion !== undefined ? {derivacion} : {}),
    onCerrado: r => eventos.push(['cerrado', plano(r)]), onConflicto: c => eventos.push(['conflicto', plano(c)]),
    onNoEncontrado: () => eventos.push(['no_encontrado']), onSinModulo: m => eventos.push(['sin_modulo', m]),
    onEnviando: v => enviando.push(v)});
  await renderer.act(async () => { await esperar(10); });
  return {...env, ...ui, eventos, enviando};
}
const rutasCierre = (accion) => (call, calls) => (call.method === 'GET' ? response(200, MAPA) : accion(call, calls));

test('Alojar: propone el sector de las camas de la familia, confirma antes y manda la sección 4; avisa al padre mientras manda', async () => {
  const ui = await montarCierre(rutasCierre(() => response(200, {estado: 'ALOJADO', total_alojado: 3, liberadas: 1})));
  try {
    assert.deepEqual(ui.calls.map(c => c.url), ['/api/emergencia/dispositivos/9/plazas/?caso=184']);
    assert.ok(ui.labels().includes('Familia alojada · Caso 2026-000184'));
    assert.ok(ui.labels().includes('Están las 3 personas confirmadas. El ingreso se cierra con la familia alojada y las camas reservadas que sobren se liberan.'));
    const sector = nombre => ui.pressables().find(p => p.props.accessibilityLabel === `Sector: ${nombre}`).props.accessibilityState.selected;
    assert.deepEqual([sector('Pabellón A'), sector('Pabellón B')], [false, true]);
    await ui.escribir('Aula o dormitorio', 'Aula 3');
    await ui.press('Se entregó la tarjeta familiar');
    await ui.escribir('Número de tarjeta', '0042');
    await ui.pressButton('Alojar a la familia');
    assert.equal(posts(ui.calls).length, 0, 'primero pregunta');
    assert.deepEqual(ui.alerts.at(-1).slice(0, 2), ['Familia alojada', 'Se aloja a la familia: 3 de 3. El ingreso se cierra y no se puede deshacer desde la app.']);
    await ui.aceptarAlerta('Alojar');
    const [post] = posts(ui.calls);
    assert.equal(post.url, '/api/emergencia/casos/184/alojar/');
    assert.deepEqual(post.body, {tarjeta_entregada: true, sector: 4, aula: 'Aula 3', tarjeta_numero: '0042'});
    assert.deepEqual(ui.eventos, [['cerrado', {cierre: 'alojar', resultado: 'hecho', estado: 'ALOJADO', total_alojado: 3, liberadas: 1}]]);
    assert.deepEqual(plano(ui.toasts.at(-1)), {type: 'success', message: 'Familia alojada · 3 personas. Se liberó 1 cama reservada.'});
    assert.deepEqual(ui.enviando, [true, false]);
  } finally { await ui.close(); }
});

test('Alojar: la tarjeta entregada sin número no manda nada y lo marca; sin el mapa se puede alojar sin sector', async () => {
  const ui = await montarCierre((call) => (call.method === 'GET' ? response(503, {}) : response(200, {estado: 'ALOJADO', total_alojado: 3, liberadas: 0})));
  try {
    assert.ok(ui.labels().includes('No se pudieron traer los sectores. Podés alojar sin elegir sector.'));
    await ui.press('Se entregó la tarjeta familiar');
    await ui.pressButton('Alojar a la familia');
    assert.equal(ui.alerts.length, 0);
    assert.ok(ui.labels().includes('Indicá el número de la tarjeta familiar entregada.'));
    await ui.press('Se entregó la tarjeta familiar');
    await ui.pressButton('Alojar a la familia');
    await ui.aceptarAlerta('Alojar');
    assert.deepEqual(posts(ui.calls)[0].body, {tarjeta_entregada: false});
  } finally { await ui.close(); }
});

test('Alojar: un corte deja «Reintentar» sin volver a preguntar y con todo fijo; el 409 ALOJADO del reintento es «se hizo»', async () => {
  let intento = 0;
  const ui = await montarCierre(rutasCierre(() => { intento += 1; return intento === 1 ? fallaDeRed() : response(409, ALOJADA_409); }));
  try {
    await ui.pressButton('Alojar a la familia');
    await ui.aceptarAlerta('Alojar');
    assert.ok(ui.labels().includes('No se pudo saber si la familia quedó alojada. «Reintentar» lo vuelve a mandar: si ya había llegado, el caso figura alojado y se muestra en lectura.'));
    assert.equal(ui.input('Aula o dormitorio').props.editable, false, 'lo mandado no cambia hasta saber el resultado');
    assert.equal(ui.pressables().find(p => p.props.accessibilityLabel === 'Sector: Pabellón A').props.disabled, true);
    const alertas = ui.alerts.length;
    await ui.pressButton('Reintentar: alojar a la familia');
    assert.equal(ui.alerts.length, alertas, 'el reintento no pregunta de nuevo');
    assert.equal(posts(ui.calls).length, 2);
    assert.deepEqual(ui.eventos.map(e => [e[0], e[1].resultado, e[1].estado]), [['cerrado', 'ya_hecho', 'ALOJADO']]);
    assert.deepEqual(plano(ui.toasts.at(-1)), {type: 'info', message: `${ALOJADA_409.detail} Revisá los datos de alojamiento en la ficha: si lo cerró otra guardia, lo que cargaste acá no se guardó.`});
  } finally { await ui.close(); }
});

test('Alojar: sin intento incierto, el 409 va al router; 404 y 403 al padre; 400 `non_field_errors` queda en la pantalla', async () => {
  const ui = await montarCierre(rutasCierre(() => response(409, ALOJADA_409)));
  try {
    await ui.pressButton('Alojar a la familia');
    await ui.aceptarAlerta('Alojar');
    assert.deepEqual(ui.eventos.map(e => [e[0], e[1].destino, e[1].mensaje]), [['conflicto', 'integrantes', ALOJADA_409.detail]]);
  } finally { await ui.close(); }
  const falta = await montarCierre(rutasCierre(() => response(400, {code: 'VALIDACION', detail: 'Falta confirmar a 1 persona.', non_field_errors: ['Falta confirmar a 1 persona.']})));
  try {
    await falta.pressButton('Alojar a la familia');
    await falta.aceptarAlerta('Alojar');
    assert.ok(falta.labels().includes('Falta confirmar a 1 persona.'));
    assert.equal(fondoDe(falta.tree, 'Falta confirmar a 1 persona.'), loadPure('src/theme/statusBadges.js').statusTones.danger.bg);
    assert.ok(falta.button('Alojar a la familia'), 'un 400 no deja incierto');
  } finally { await falta.close(); }
  const ajena = await montarCierre(rutasCierre((call) => (call.url.endsWith('/perfil/') ? response(200, {llegadas: false})
    : response(403, {detail: 'Sin admitir.', code: 'SIN_MODULO'}))), {cierre: 'cancelar', confirmadas: 0});
  try {
    await ajena.escribir('Motivo de la cancelación', 'Se fueron');
    await ajena.pressButton('Cancelar el ingreso');
    await ajena.aceptarAlerta('Cancelar el ingreso');
    assert.deepEqual(ajena.eventos, [['sin_modulo', 'Sin admitir.']]);
  } finally { await ajena.close(); }
  const borrada = await montarCierre(rutasCierre(() => response(404, {detail: 'No encontrado.'})), {cierre: 'cancelar', confirmadas: 0});
  try {
    await borrada.escribir('Motivo de la cancelación', 'Se fueron');
    await borrada.pressButton('Cancelar el ingreso');
    await borrada.aceptarAlerta('Cancelar el ingreso');
    assert.deepEqual(borrada.eventos, [['no_encontrado']]);
  } finally { await borrada.close(); }
});

test('Cerrar con diferencia: motivo obligatorio y qué pasó con «Otro»; confirmación destructiva; manda y avisa', async () => {
  const ui = await montarCierre(() => response(200, {estado: 'ALOJADO', total_alojado: 2, liberadas: 1}), {cierre: 'diferencia', confirmadas: 2, total: 3});
  try {
    assert.deepEqual(ui.calls, [], 'sin alojar no pide el mapa');
    assert.ok(ui.labels().includes('Llegaron menos personas: 2 de 3 confirmadas. Se alojan las confirmadas y las camas reservadas sin usar se liberan.'));
    await ui.pressButton('Cerrar con diferencia');
    assert.ok(ui.labels().includes('Elegí por qué llegaron menos personas.'));
    await ui.press('Motivo: Otro (también: no sabe su número de DNI)');
    await ui.pressButton('Cerrar con diferencia');
    assert.ok(ui.labels().includes('Con el motivo «Otro», contá qué pasó.'));
    assert.equal(ui.alerts.length, 0);
    await ui.escribir('Observación de la diferencia', 'No sabe su DNI');
    await ui.pressButton('Cerrar con diferencia');
    const [titulo, cuerpo, opciones] = ui.alerts.at(-1);
    assert.deepEqual([titulo, cuerpo], ['Cerrar con diferencia', 'Se cierra el ingreso con 2 de 3: 1 persona sin confirmar quedan afuera y sus camas se liberan. No se puede deshacer desde la app.']);
    assert.equal(opciones.find(o => o.text === 'Cerrar con diferencia').style, 'destructive');
    await ui.aceptarAlerta('Cerrar con diferencia');
    assert.deepEqual(posts(ui.calls).map(c => [c.url, c.body]), [['/api/emergencia/casos/184/cerrar-diferencia/', {motivo: 'OTRO', observacion: 'No sabe su DNI'}]]);
    assert.deepEqual(ui.eventos.map(e => [e[1].cierre, e[1].estado]), [['diferencia', 'ALOJADO']]);
  } finally { await ui.close(); }
});

test('Cancelar ingreso: pide motivo; 200 avisa que volvió a la mesa; tras un corte, relee y el caso en la mesa es «se hizo» sin reenviar', async () => {
  let intento = 0;
  const ui = await montarCierre(() => { intento += 1; return intento === 1 ? fallaDeRed() : response(409, {detail: 'La derivación ya fue rechazada o el ingreso se canceló. Buscá a la familia de nuevo.', estado_actual: 'NUEVO'}); },
    {cierre: 'cancelar', confirmadas: 0});
  try {
    assert.ok(ui.labels().includes('Todavía no se confirmó a nadie. Se liberan todas las camas reservadas para la familia y el caso vuelve a la mesa.'));
    await ui.pressButton('Cancelar el ingreso');
    assert.ok(ui.labels().includes('Contá por qué se cancela el ingreso.'));
    await ui.escribir('Motivo de la cancelación', 'La familia se fue con parientes');
    await ui.pressButton('Cancelar el ingreso');
    assert.equal(ui.alerts.at(-1)[2].find(o => o.text === 'Cancelar el ingreso').style, 'destructive');
    await ui.aceptarAlerta('Cancelar el ingreso');
    assert.ok(ui.button('Reintentar: cancelar el ingreso'));
    await ui.pressButton('Reintentar: cancelar el ingreso');
    assert.deepEqual(ui.calls.map(c => [c.method, c.url]), [['POST', '/api/emergencia/casos/184/cancelar-ingreso/'], ['GET', '/api/emergencia/casos/184/integrantes/']],
      'el reintento relee antes y, con el caso ya en la mesa, no reenvía');
    assert.deepEqual(ui.eventos.map(e => [e[0], e[1].cierre, e[1].resultado, e[1].estado]), [['cerrado', 'cancelar', 'ya_hecho', 'NUEVO']]);
  } finally { await ui.close(); }
  const ok = await montarCierre(() => response(200, {estado: 'EN_GESTION', total_alojado: null, liberadas: 3}), {cierre: 'cancelar', confirmadas: 0});
  try {
    await ok.escribir('Motivo de la cancelación', 'No llegaron');
    await ok.pressButton('Cancelar el ingreso');
    await ok.aceptarAlerta('Cancelar el ingreso');
    assert.deepEqual(plano(ok.toasts.at(-1)), {type: 'success', message: 'Ingreso cancelado: el caso volvió a la mesa. Se liberaron 3 camas reservadas.'});
  } finally { await ok.close(); }
});

test('Cierre: 429 deja «Reintentar en N s» deshabilitado; sin red no manda y avisa; dos toques mandan un solo POST', async () => {
  const espera = await montarCierre(rutasCierre(() => response(429, {detail: 'x'}, {'Retry-After': '5'})));
  try {
    await espera.pressButton('Alojar a la familia');
    await espera.aceptarAlerta('Alojar');
    assert.equal(espera.button('Reintentar en 5 s').props.disabled, true);
    assert.ok(espera.labels().includes('El servidor pidió esperar antes de volver a intentar.'));
  } finally { await espera.close(); }
  const sinRed = await montarCierre(() => response(200, {}), {cierre: 'diferencia', confirmadas: 1, online: false});
  try {
    assert.ok(sinRed.labels().includes(SIN_RED));
    await sinRed.press('Motivo: No llegó al centro');
    await sinRed.pressButton('Cerrar con diferencia');
    await sinRed.aceptarAlerta('Cerrar con diferencia');
    assert.deepEqual(sinRed.calls, []);
    assert.equal(sinRed.alerts.at(-1)[0], 'Sin conexión');
  } finally { await sinRed.close(); }
  const doble = await montarCierre(rutasCierre(nunca));
  doble.llegadas.LIMITES.accionMs = 200;
  try {
    await doble.pressButton('Alojar a la familia');
    const mandar = doble.alerts.at(-1)[2].find(o => o.text === 'Alojar').onPress;
    await renderer.act(async () => { mandar(); mandar(); await esperar(10); });
    assert.equal(posts(doble.calls).length, 1);
    assert.deepEqual(doble.enviando, [true]);
  } finally { await doble.close(); }
});

test('Cierre: la respuesta que llega después de salir llega igual al padre y no rompe', async () => {
  let soltar;
  const ui = await montarCierre(rutasCierre(() => new Promise(resolve => { soltar = () => resolve(response(200, {estado: 'ALOJADO', total_alojado: 3, liberadas: 0})); })));
  await ui.pressButton('Alojar a la familia');
  const mandar = ui.alerts.at(-1)[2].find(o => o.text === 'Alojar').onPress;
  await renderer.act(async () => { mandar(); await esperar(10); });
  assert.equal(typeof soltar, 'function', 'el POST salió');
  await ui.close();
  await renderer.act(async () => { soltar(); await esperar(10); });
  assert.deepEqual(ui.eventos.map(e => e[1].resultado), ['hecho']);
  assert.deepEqual(ui.enviando, [true, false]);
});

// ---- Sin derivación ----

async function montarPuerta(rutas, {plazasLibres = 2, accion = 'ingresar', online = true, env: previo} = {}) {
  const env = previo || await entorno(rutas);
  env.runtime.setOnline(online);
  const eventos = [];
  const enviando = [];
  const Screen = loadScreen('src/screens/EmergenciaPuertaScreen.js', env.mocks);
  const ui = await render(Screen, {dispositivo: {id: 9, nombre: 'Escuela 12'}, dni: '30111222', plazasLibres, accion,
    mensaje: 'No hay una derivación para este DNI en tu dispositivo.',
    onIngresado: (c, r) => eventos.push(['ingresado', c?.id, r.reservadas]), onAvisado: r => eventos.push(['avisado', r.caso?.numero]),
    onNoEncontrado: () => eventos.push(['no_encontrado']), onSinModulo: m => eventos.push(['sin_modulo', m]),
    onEnviando: v => enviando.push(v)});
  await renderer.act(async () => { await esperar(10); });
  const llenar = async () => {
    await ui.press('Traslado: Policía');
    await ui.press('Sumar Adultos · Mujeres');
  };
  return {...env, ...ui, eventos, enviando, llenar};
}

test('Puerta: arranca con el DNI buscado; sin traslado ni personas no manda y lo lista; «Ingresar igual» confirma, manda y sigue', async () => {
  const ui = await montarPuerta(() => response(201, INGRESO));
  try {
    assert.equal(ui.input('DNI del responsable').props.value, '30111222');
    assert.ok(ui.labels().includes('Sin derivación · DNI 30111222'));
    assert.ok(ui.labels().includes('No hay una derivación para este DNI en tu dispositivo.'));
    assert.deepEqual(ui.titulos(), ['Ingresar igual', 'Avisar a la mesa']);
    await ui.pressButton('Ingresar igual');
    assert.deepEqual(ui.calls, []);
    assert.ok(ui.labels().includes('Para corregir'));
    assert.ok(ui.labels().includes('• Traslado: Elegí cómo llegó la familia.'));
    await ui.llenar();
    await ui.escribir('Nombre', 'Rosa');
    await ui.pressButton('Ingresar igual');
    assert.deepEqual(ui.alerts.at(-1).slice(0, 2), ['Ingresar igual', 'Se crea el caso de 1 persona con el ingreso en curso y se reservan las camas libres que alcancen. No se puede deshacer desde la app.']);
    await ui.aceptarAlerta('Ingresar igual');
    const [post] = posts(ui.calls);
    assert.equal(post.url, '/api/emergencia/dispositivos/9/ingreso-directo/');
    assert.deepEqual([post.body.traslado, post.body.dni, post.body.nombre, post.body.adultos_f, 'direccion' in post.body, 'relevado_en' in post.body],
      ['POLICIA', '30111222', 'Rosa', 1, false, false]);
    assert.deepEqual(ui.eventos, [['ingresado', 190, 1]]);
    assert.deepEqual(plano(ui.toasts.at(-1)), {type: 'success', message: 'Caso 2026-000190 · ingreso en curso · 1 cama reservada.'});
    assert.deepEqual(ui.enviando, [true, false]);
  } finally { await ui.close(); }
});

test('Puerta: sin camas solo ofrece «Avisar a la mesa»; avisar confirma, manda al mismo cuerpo y vuelve', async () => {
  const ui = await montarPuerta(() => response(201, AVISO), {plazasLibres: 0, accion: 'ingresar'});
  try {
    assert.deepEqual(ui.titulos(), ['Avisar a la mesa']);
    assert.ok(ui.labels().includes('No hay camas libres para ingresar a la familia: avisale a la mesa para que la derive a otro lado.'));
    await ui.llenar();
    await ui.pressButton('Avisar a la mesa');
    assert.equal(ui.alerts.at(-1)[1], 'Se crea el caso de 1 persona en la mesa con la marca «En la puerta de Escuela 12». No se puede deshacer desde la app.');
    await ui.aceptarAlerta('Avisar a la mesa');
    assert.deepEqual(posts(ui.calls).map(c => c.url), ['/api/emergencia/dispositivos/9/avisar-mesa/']);
    assert.deepEqual(ui.eventos, [['avisado', '2026-000191']]);
    assert.equal(ui.alerts.at(-1)[0], 'Aviso enviado');
  } finally { await ui.close(); }
});

test('Puerta: 400 `plazas` (las camas se ocuparon) pasa a «Avisar a la mesa» con lo cargado; 400 por campo va al campo', async () => {
  let paso = 0;
  const ui = await montarPuerta((call) => {
    paso += 1;
    if (call.url.endsWith('/ingreso-directo/') && paso === 1) return response(400, {code: 'VALIDACION', detail: 'No hay camas libres.', plazas: ['No hay camas libres para ingresar a la familia.']});
    if (call.url.endsWith('/avisar-mesa/') && paso === 2) return response(400, {code: 'VALIDACION', detail: 'Escribí el nombre.', nombre: ['Escribí el nombre del responsable.']});
    return response(201, AVISO);
  });
  try {
    await ui.llenar();
    await ui.pressButton('Ingresar igual');
    await ui.aceptarAlerta('Ingresar igual');
    assert.ok(ui.labels().includes('No hay camas libres para ingresar a la familia.'));
    assert.deepEqual(ui.titulos(), ['Avisar a la mesa'], 'sin camas ya no se ofrece ingresar');
    await ui.pressButton('Avisar a la mesa');
    await ui.aceptarAlerta('Avisar a la mesa');
    assert.ok(ui.labels().includes('Escribí el nombre del responsable.'));
    assert.equal(ui.input('Nombre').props.style.at(-1).borderColor, '#D00000');
    await ui.escribir('Nombre', 'Rosa');
    await ui.pressButton('Avisar a la mesa');
    await ui.aceptarAlerta('Avisar a la mesa');
    assert.deepEqual(ui.eventos, [['avisado', '2026-000191']]);
    const uuids = posts(ui.calls).map(c => c.body.uuid_cliente);
    assert.equal(new Set(uuids).size, 3, 'cada 400 olvida el uuid: no se creó nada');
  } finally { await ui.close(); }
});

test('Puerta: un corte deja el envío guardado; al volver a la familia solo se ofrece reintentar ESE, con lo cargado fijo y el MISMO uuid', async () => {
  let intento = 0;
  const env = await entorno(() => { intento += 1; return intento === 1 ? fallaDeRed() : response(200, INGRESO); });
  const primera = await montarPuerta(null, {env});
  await primera.llenar();
  await primera.escribir('Nombre', 'Rosa');
  await primera.pressButton('Ingresar igual');
  await primera.aceptarAlerta('Ingresar igual');
  assert.ok(primera.labels().includes('No se pudo saber si el ingreso llegó. «Reintentar» manda el mismo pedido: si ya había llegado, no crea otro caso.'));
  assert.deepEqual(primera.titulos(), ['Reintentar: ingresar igual'], 'avisar con otro uuid crearía un segundo caso');
  await primera.close();
  const segunda = await montarPuerta(null, {env});
  try {
    assert.deepEqual(segunda.titulos(), ['Reintentar: ingresar igual']);
    assert.equal(segunda.input('Nombre').props.value, 'Rosa', 'lo cargado vuelve');
    assert.equal(segunda.input('Nombre').props.editable, false);
    assert.equal(segunda.pressables().find(p => p.props.accessibilityLabel === 'Sumar Adultos · Mujeres').props.disabled, true);
    const alertas = env.alerts.length;
    await segunda.pressButton('Reintentar: ingresar igual');
    assert.equal(env.alerts.length, alertas, 'el reintento no pregunta');
    const [a, b] = posts(env.calls);
    assert.equal(b.body.uuid_cliente, a.body.uuid_cliente);
    assert.deepEqual(segunda.eventos, [['ingresado', 190, 1]]);
  } finally { await segunda.close(); }
});

test('Puerta: 404 y 403 al padre; UUID_EN_USO lo dice y deja mandar con otro; 429 cuenta; sin red no manda', async () => {
  const ajena = await montarPuerta(() => response(404, {detail: 'No encontrado.'}));
  try {
    await ajena.llenar();
    await ajena.pressButton('Ingresar igual');
    await ajena.aceptarAlerta('Ingresar igual');
    assert.deepEqual(ajena.eventos, [['no_encontrado']]);
  } finally { await ajena.close(); }
  const sinPermiso = await montarPuerta((call) => (call.url.endsWith('/perfil/') ? response(200, {llegadas: false})
    : response(403, {detail: 'Sin admitir.', code: 'SIN_MODULO'})));
  try {
    await sinPermiso.llenar();
    await sinPermiso.pressButton('Avisar a la mesa');
    await sinPermiso.aceptarAlerta('Avisar a la mesa');
    assert.deepEqual(sinPermiso.eventos, [['sin_modulo', 'Sin admitir.']]);
  } finally { await sinPermiso.close(); }
  const enUso = await montarPuerta(() => response(409, {detail: 'Ese identificador de envío ya se usó en otro caso.', code: 'UUID_EN_USO'}));
  try {
    await enUso.llenar();
    await enUso.pressButton('Ingresar igual');
    await enUso.aceptarAlerta('Ingresar igual');
    assert.ok(enUso.labels().includes('Este envío no se pudo mandar: su identificador ya se usó en otro caso. Volvé a tocar el botón: sale con uno nuevo.'));
    assert.deepEqual(enUso.titulos(), ['Ingresar igual', 'Avisar a la mesa']);
  } finally { await enUso.close(); }
  const espera = await montarPuerta(() => response(429, {detail: 'x'}, {'Retry-After': '7'}));
  try {
    await espera.llenar();
    await espera.pressButton('Ingresar igual');
    await espera.aceptarAlerta('Ingresar igual');
    assert.equal(espera.button('Reintentar en 7 s').props.disabled, true);
  } finally { await espera.close(); }
  const sinRed = await montarPuerta(() => response(201, INGRESO), {online: false});
  try {
    assert.ok(sinRed.labels().includes(SIN_RED));
    await sinRed.llenar();
    await sinRed.pressButton('Ingresar igual');
    await sinRed.aceptarAlerta('Ingresar igual');
    assert.deepEqual(sinRed.calls, []);
    assert.equal(sinRed.alerts.at(-1)[0], 'Sin conexión');
    assert.deepEqual(sinRed.titulos(), ['Ingresar igual', 'Avisar a la mesa'], 'sin red no queda pendiente');
  } finally { await sinRed.close(); }
});

test('Puerta: dos toques sin espera mandan un solo POST; la respuesta de otra sesión se descarta', async () => {
  const doble = await montarPuerta(nunca);
  doble.llegadas.LIMITES.accionMs = 200;
  try {
    await doble.llenar();
    await doble.pressButton('Ingresar igual');
    const mandar = doble.alerts.at(-1)[2].find(o => o.text === 'Ingresar igual').onPress;
    await renderer.act(async () => { mandar(); mandar(); await esperar(10); });
    assert.equal(posts(doble.calls).length, 1);
  } finally { await doble.close(); }
  let env;
  env = await entorno(async () => {
    env.runtime.setFetch(async () => response(200, {token: 'tok-2', user_id: 8, username: 'otra', modulos: ['emergencia']}));
    await env.runtime.api.loginBecas({username: 'otra', password: 'x'});
    return response(201, INGRESO);
  });
  const otra = await montarPuerta(null, {env});
  try {
    await otra.llenar();
    await otra.pressButton('Ingresar igual');
    await otra.aceptarAlerta('Ingresar igual');
    assert.deepEqual(otra.eventos, [], 'la respuesta era de la sesión anterior');
  } finally { await otra.close(); }
});

test('Cancelar (m3): tras un corte, si el ingreso cambió (alguien confirmado) no reenvía y va a los integrantes', async () => {
  let intento = 0;
  const ui = await montarCierre((call) => {
    intento += 1;
    if (intento === 1) return fallaDeRed();
    return response(200, {caso: CASO, integrantes: [CONFIRMADAS[0]], confirmadas: 1, total_declarado: 3, declaradas_al_relevar: 3, con_ficha_incompleta: 0});
  }, {cierre: 'cancelar', confirmadas: 0});
  try {
    await ui.escribir('Motivo de la cancelación', 'Se fueron');
    await ui.pressButton('Cancelar el ingreso');
    await ui.aceptarAlerta('Cancelar el ingreso');
    await ui.pressButton('Reintentar: cancelar el ingreso');
    assert.equal(posts(ui.calls).length, 1, 'no se reenvía');
    assert.deepEqual(ui.eventos.map(e => [e[0], e[1].destino, e[1].mensaje]),
      [['conflicto', 'integrantes', ui.llegadas.TEXTO_INGRESO_CAMBIO]]);
  } finally { await ui.close(); }
});

test('Cancelar (m3): tras un corte, si el ingreso sigue en curso sin confirmados vuelve a preguntar con el estado real; «No» no manda nada', async () => {
  let posteos = 0;
  const ui = await montarCierre((call) => {
    if (call.method === 'GET') return response(200, {caso: CASO, integrantes: [FILA(1)], confirmadas: 0, total_declarado: 3, declaradas_al_relevar: 3, con_ficha_incompleta: 0});
    posteos += 1;
    return posteos === 1 ? fallaDeRed() : response(200, {estado: 'EN_GESTION', total_alojado: null, liberadas: 3});
  }, {cierre: 'cancelar', confirmadas: 0});
  try {
    await ui.escribir('Motivo de la cancelación', 'Se fueron');
    await ui.pressButton('Cancelar el ingreso');
    await ui.aceptarAlerta('Cancelar el ingreso');
    await ui.pressButton('Reintentar: cancelar el ingreso');
    assert.equal(posteos, 1, 'no se reenvía sin preguntar');
    const [titulo, cuerpo, opciones] = ui.alerts.at(-1);
    assert.deepEqual([titulo, cuerpo], ['Cancelar ingreso', 'No sabemos si la cancelación llegó. El ingreso figura en curso, sin nadie confirmado. ¿Cancelarlo?']);
    assert.deepEqual(plano(opciones.map(o => [o.text, o.style])), [['No', 'cancel'], ['Cancelar el ingreso', 'destructive']]);
    assert.equal(opciones[0].onPress, undefined, '«No» no hace nada');
    assert.equal(posteos, 1);
    await ui.aceptarAlerta('Cancelar el ingreso');
    assert.equal(posteos, 2);
    assert.deepEqual(ui.eventos.map(e => [e[0], e[1].cierre, e[1].resultado]), [['cerrado', 'cancelar', 'hecho']]);
  } finally { await ui.close(); }
});

// ---- La derivación vista (Cambio 477) ----
const CAMBIO_409 = {detail: 'El ingreso del caso 2026-000184 cambió: la derivación que viste ya no es la vigente. Recargá la pantalla.', estado_actual: 'INGRESO_EN_CURSO'};

test('477: alojar y diferencia mandan la derivación que vio la guardia al abrir, también en el reintento (aunque cambie la prop)', async () => {
  let intento = 0;
  const ui = await montarCierre(rutasCierre(() => { intento += 1; return intento === 1 ? fallaDeRed() : response(409, ALOJADA_409); }), {derivacion: 55});
  try {
    await ui.pressButton('Alojar a la familia');
    await ui.aceptarAlerta('Alojar');
    await ui.rerender({derivacion: 77});
    await ui.pressButton('Reintentar: alojar a la familia');
    assert.deepEqual(posts(ui.calls).map(c => c.body.derivacion), [55, 55]);
    assert.deepEqual(ui.eventos.map(e => [e[0], e[1].resultado]), [['cerrado', 'ya_hecho']]);
  } finally { await ui.close(); }
  const dif = await montarCierre(() => response(409, CAMBIO_409), {cierre: 'diferencia', confirmadas: 1, derivacion: 55});
  try {
    await dif.press('Motivo: No llegó al centro');
    await dif.pressButton('Cerrar con diferencia');
    await dif.aceptarAlerta('Cerrar con diferencia');
    assert.deepEqual(posts(dif.calls).map(c => c.body), [{motivo: 'NO_LLEGO', derivacion: 55}]);
    assert.deepEqual(dif.eventos.map(e => [e[0], e[1].destino, e[1].mensaje]), [['conflicto', 'integrantes', CAMBIO_409.detail]],
      'la derivación vieja: el detail y al router');
  } finally { await dif.close(); }
});

test('477: cancelar con la derivación, tras un corte el reintento sale directo (sin releer ni volver a preguntar); 409 en la mesa = «se hizo»', async () => {
  let intento = 0;
  const ui = await montarCierre(() => { intento += 1; return intento === 1 ? fallaDeRed() : response(409, {detail: 'La derivación ya fue rechazada o el ingreso se canceló. Buscá a la familia de nuevo.', estado_actual: 'EN_GESTION'}); },
    {cierre: 'cancelar', confirmadas: 0, derivacion: 55});
  try {
    await ui.escribir('Motivo de la cancelación', 'Se fueron');
    await ui.pressButton('Cancelar el ingreso');
    await ui.aceptarAlerta('Cancelar el ingreso');
    const alertas = ui.alerts.length;
    await ui.pressButton('Reintentar: cancelar el ingreso');
    assert.equal(ui.alerts.length, alertas, 'no vuelve a preguntar');
    assert.deepEqual(ui.calls.map(c => [c.method, c.body]), [['POST', {motivo: 'Se fueron', derivacion: 55}], ['POST', {motivo: 'Se fueron', derivacion: 55}]]);
    assert.deepEqual(ui.eventos.map(e => [e[0], e[1].cierre, e[1].resultado, e[1].estado]), [['cerrado', 'cancelar', 'ya_hecho', 'EN_GESTION']]);
    assert.deepEqual(plano(ui.toasts.at(-1)), {type: 'info', message: 'El ingreso ya figura cancelado: el caso está de vuelta en la mesa.'});
  } finally { await ui.close(); }
});

test('477: cancelar con la derivación y 400 `non_field_errors` (alguien se confirmó) no queda trabado: avisa y va a integrantes', async () => {
  const NFE = 'Hay personas confirmadas: no se puede cancelar. Cerrá con diferencia.';
  const ui = await montarCierre(() => response(400, {code: 'VALIDACION', detail: NFE, non_field_errors: [NFE]}), {cierre: 'cancelar', confirmadas: 0, derivacion: 55});
  try {
    await ui.escribir('Motivo de la cancelación', 'Se fueron');
    await ui.pressButton('Cancelar el ingreso');
    await ui.aceptarAlerta('Cancelar el ingreso');
    assert.deepEqual(ui.eventos.map(e => [e[0], e[1].destino, e[1].mensaje]), [['conflicto', 'integrantes', NFE]]);
  } finally { await ui.close(); }
});

test('477: cancelar con la derivación, tras un corte el 409 «cambió»: el reintento no hizo nada, el ingreso anterior ya terminó; avisa y va a integrantes', async () => {
  let intento = 0;
  const ui = await montarCierre(() => { intento += 1; return intento === 1 ? fallaDeRed() : response(409, CAMBIO_409); },
    {cierre: 'cancelar', confirmadas: 0, derivacion: 55});
  try {
    await ui.escribir('Motivo de la cancelación', 'Se fueron');
    await ui.pressButton('Cancelar el ingreso');
    await ui.aceptarAlerta('Cancelar el ingreso');
    const alertas = ui.alerts.length;
    await ui.pressButton('Reintentar: cancelar el ingreso');
    assert.equal(ui.alerts.length, alertas);
    assert.deepEqual(ui.calls.map(c => c.method), ['POST', 'POST']);
    assert.deepEqual(ui.eventos.map(e => [e[0], e[1].destino, e[1].estadoActual, e[1].mensaje]),
      [['conflicto', 'integrantes', 'INGRESO_EN_CURSO', `Este reintento no hizo nada: el ingreso anterior ya terminó y ahora hay otro. ${CAMBIO_409.detail}`]]);
    assert.ok(!ui.eventos.some(e => e[0] === 'cerrado'), 'no dice que se canceló');
  } finally { await ui.close(); }
});

test('477: sin la derivación (back viejo) el cancelar incierto relee y vuelve a preguntar, y no manda el campo', async () => {
  let posteos = 0;
  const ui = await montarCierre((call) => {
    if (call.method === 'GET') return response(200, {caso: CASO, integrantes: [FILA(1)], confirmadas: 0, total_declarado: 3, declaradas_al_relevar: 3, con_ficha_incompleta: 0});
    posteos += 1;
    return posteos === 1 ? fallaDeRed() : response(200, {estado: 'EN_GESTION', total_alojado: null, liberadas: 3});
  }, {cierre: 'cancelar', confirmadas: 0, derivacion: null});
  try {
    await ui.escribir('Motivo de la cancelación', 'Se fueron');
    await ui.pressButton('Cancelar el ingreso');
    await ui.aceptarAlerta('Cancelar el ingreso');
    await ui.pressButton('Reintentar: cancelar el ingreso');
    assert.equal(ui.alerts.at(-1)[1], 'No sabemos si la cancelación llegó. El ingreso figura en curso, sin nadie confirmado. ¿Cancelarlo?');
    await ui.aceptarAlerta('Cancelar el ingreso');
    assert.deepEqual(ui.calls.map(c => [c.method, c.body ?? null]), [['POST', {motivo: 'Se fueron'}], ['GET', null], ['POST', {motivo: 'Se fueron'}]]);
  } finally { await ui.close(); }
});

test('Puerta (M1, m5): el DNI es el buscado y no se edita; con un envío pendiente la fecha queda fija también', async () => {
  const env = await entorno(fallaDeRed);
  const ui = await montarPuerta(null, {env});
  try {
    const dni = ui.input('DNI del responsable');
    assert.deepEqual([dni.props.editable, dni.props.value, dni.props.onChangeText], [false, '30111222', undefined]);
    assert.ok(ui.labels().includes('Es el DNI que buscaste. Para otra persona, volvé y buscá de nuevo.'));
    assert.equal(ui.tree.root.findByType('FechaInput').props.disabled, false);
    await ui.llenar();
    await ui.pressButton('Ingresar igual');
    await ui.aceptarAlerta('Ingresar igual');
    assert.equal(ui.tree.root.findByType('FechaInput').props.disabled, true);
    assert.equal(posts(env.calls)[0].body.dni, '30111222');
  } finally { await ui.close(); }
});

test('Puerta (m6): con el uuid solo (lo cargado se borró), no muestra el formulario y «Reintentar» manda uuid y DNI', async () => {
  let respuesta = fallaDeRed;
  const env = await entorno((call) => respuesta(call));
  const primera = await montarPuerta(null, {env, accion: 'avisar'});
  await primera.llenar();
  await primera.pressButton('Avisar a la mesa');
  await primera.aceptarAlerta('Avisar a la mesa');
  await primera.close();
  await env.runtime.load('./emergenciaLimpieza').limpiarDatosLocalesEmergencia();
  const uuid = posts(env.calls)[0].body.uuid_cliente;
  respuesta = () => response(200, AVISO);
  const segunda = await montarPuerta(null, {env});
  try {
    assert.ok(segunda.labels().includes('Hay un envío de esta familia sin resultado, pero lo cargado ya se borró del teléfono (se cerró la sesión o pasaron 48 h). «Reintentar» manda solo su identificador: si había llegado, se recupera el caso; si no, vas a tener que cargar los datos de nuevo.'));
    assert.equal(segunda.input('Nombre'), undefined, 'sin formulario');
    assert.deepEqual(segunda.titulos(), ['Reintentar: avisar a la mesa']);
    await segunda.pressButton('Reintentar: avisar a la mesa');
    assert.deepEqual(posts(env.calls).at(-1).body, {uuid_cliente: uuid, dni: '30111222'});
    assert.deepEqual(segunda.eventos, [['avisado', '2026-000191']]);
  } finally { await segunda.close(); }
});

test('Puerta (m6): con el uuid solo, un 400 dice que no había llegado y vuelve al formulario vacío con las dos acciones', async () => {
  let respuesta = fallaDeRed;
  const env = await entorno((call) => respuesta(call));
  const primera = await montarPuerta(null, {env});
  await primera.llenar();
  await primera.pressButton('Ingresar igual');
  await primera.aceptarAlerta('Ingresar igual');
  await primera.close();
  await env.runtime.load('./emergenciaLimpieza').limpiarDatosLocalesEmergencia();
  respuesta = () => response(400, {code: 'VALIDACION', detail: 'Elegí el traslado.', traslado: ['Elegí el traslado.']});
  const segunda = await montarPuerta(null, {env});
  try {
    await segunda.pressButton('Reintentar: ingresar igual');
    assert.ok(segunda.labels().includes(env.llegadas.TEXTO_REINGRESAR));
    assert.deepEqual(segunda.titulos(), ['Ingresar igual', 'Avisar a la mesa']);
    assert.equal(segunda.input('Nombre').props.editable, true);
  } finally { await segunda.close(); }
});

test('Puerta (m1): si el reenvío devuelve el caso ya alojado, no dice «ingreso en curso»', async () => {
  const ui = await montarPuerta(() => response(200, {...INGRESO, caso: {...INGRESO.caso, estado: 'ALOJADO'}}));
  try {
    await ui.llenar();
    await ui.pressButton('Ingresar igual');
    await ui.aceptarAlerta('Ingresar igual');
    assert.deepEqual(plano(ui.toasts.at(-1)), {type: 'info', message: 'Caso 2026-000190: el ingreso ya se había hecho y la familia ya figura alojada.'});
  } finally { await ui.close(); }
});

// ---- EmergenciaApp: el tramo de la parte 3 ----

async function montarApp() {
  const pantallas = {};
  const alerts = [];
  const toasts = [];
  const capturar = nombre => props => { pantallas[nombre] = props; return null; };
  const nombres = {dispositivos: 'MisDispositivos', buscar: 'LlegadaBuscar', derivacion: 'Derivacion', integrantes: 'Integrantes', ficha: 'Ficha', cierre: 'Cierre', puerta: 'Puerta'};
  const mocks = {
    react: React, 'react-native': native,
    '../context/AuthContext': {useAuth: () => ({user: {nombre: 'Ana'}, logout() {}})},
    '../context/ThemeContext': {useTheme: () => ({theme, typography})},
    '../context/ToastContext': {useToast: () => ({showAlert: (...a) => alerts.push(a), showToast: t => toasts.push(t)})},
    '../components/Banner': {__esModule: true, default: 'Banner'},
    '../components/CustomButton': {__esModule: true, default: 'CustomButton'},
    '../components/SettingsPanel': {__esModule: true, default: 'SettingsPanel'},
    ...Object.fromEntries(['Inicio', 'MisEnvios', 'Formulario1', 'Entregas', 'RecibirEntrega'].map(n => [`../screens/Emergencia${n}Screen`, {__esModule: true, default: capturar(n)}])),
    ...Object.fromEntries(Object.entries(nombres).map(([clave, n]) => [`../screens/Emergencia${n}Screen`, {__esModule: true, default: capturar(clave)}])),
    '@react-native-community/netinfo': {__esModule: true, default: {addEventListener: () => () => {}}},
    '../services/emergenciaLimpieza': {depurarBorradoresFicha: async () => {}},
    '../services/emergenciaCola': {syncPendientes: async () => ({}), getPendingCount: async () => 0, getResumenPendientes: async () => ({}),
      reintentar: async () => ({}), getLocalidadesGuardadas: async () => ({localidades: []}), getBorradorEnCurso: async () => null, descartar: async () => true},
    '../utils/emergencia': {avisoDeSalida: () => null},
  };
  const App = loadScreen('src/navigation/EmergenciaApp.js', mocks);
  let tree;
  await renderer.act(async () => { tree = renderer.create(React.createElement(App, {})); });
  const banner = () => tree.root.findByType('Banner');
  const hacer = async (fn) => renderer.act(async () => { fn(); await esperar(2); });
  const vista = () => Object.keys(nombres).find(n => tree.root.findAll(x => x.type === mocks[`../screens/Emergencia${nombres[n]}Screen`].default).length);
  const alBuscar = async () => {
    await hacer(() => pantallas.Inicio.onAbrir({clave: 'llegadas', titulo: 'Llegada de familias'}));
    await hacer(() => pantallas.dispositivos.onElegir({id: 9, nombre: 'Escuela 12'}, {unico: false}));
  };
  return {pantallas, alerts, toasts, banner, hacer, vista, alBuscar, titulo: () => banner().props.title,
    atras: () => hacer(() => banner().props.onBackPress()), close: () => renderer.act(async () => tree.unmount())};
}

test('EmergenciaApp M2-5: integrantes -> cerrar (con contador, integrantes y dispositivo) -> volver; alojada vuelve a integrantes, cancelado a buscar', async () => {
  const ui = await montarApp();
  try {
    await ui.alBuscar();
    await ui.hacer(() => ui.pantallas.buscar.onIntegrantes(CASO, '30111222'));
    await ui.hacer(() => ui.pantallas.integrantes.onCerrar('alojar', {caso: CASO, confirmadas: 3, total_declarado: 3, integrantes: CONFIRMADAS}));
    assert.equal(ui.vista(), 'cierre');
    assert.equal(ui.titulo(), 'Familia alojada');
    const p = ui.pantallas.cierre;
    assert.deepEqual([p.cierre, p.caso.id, p.confirmadas, p.total, p.integrantes.length, p.dispositivo.id, p.derivacion], ['alojar', 184, 3, 3, 3, 9, null],
      'el back viejo no trae la derivación');
    await ui.hacer(() => p.onEnviando(true));
    assert.equal(ui.banner().props.showBackButton, false);
    await ui.atras();
    assert.equal(ui.vista(), 'cierre', 'volver no hace nada mientras se manda');
    await ui.hacer(() => p.onCerrado({cierre: 'alojar', resultado: 'hecho', estado: 'ALOJADO'}));
    assert.equal(ui.vista(), 'integrantes');
    assert.equal(ui.banner().props.showBackButton, true);
    assert.equal(ui.pantallas.integrantes.caso.estado, 'ALOJADO');
    await ui.hacer(() => ui.pantallas.integrantes.onCerrar('cancelar', {caso: CASO, confirmadas: 0, total_declarado: 3, integrantes: [], derivacion_id: 55}));
    assert.equal(ui.titulo(), 'Cancelar ingreso');
    assert.equal(ui.pantallas.cierre.derivacion, 55, 'la derivación de integrantes llega al cierre');
    await ui.atras();
    assert.equal(ui.vista(), 'integrantes', 'volver desde el cierre va a los integrantes');
    await ui.hacer(() => ui.pantallas.integrantes.onCerrar('cancelar', {caso: CASO, confirmadas: 0, total_declarado: 3, integrantes: []}));
    await ui.hacer(() => ui.pantallas.cierre.onCerrado({cierre: 'cancelar', resultado: 'ya_hecho', estado: 'NUEVO'}));
    assert.deepEqual([ui.vista(), ui.pantallas.buscar.dniInicial, ui.pantallas.buscar.autoBuscar], ['buscar', '30111222', false]);
    // Un 409 de un cierre va al router de §13.1.
    await ui.hacer(() => ui.pantallas.buscar.onIntegrantes(CASO, '30111222'));
    await ui.hacer(() => ui.pantallas.integrantes.onCerrar('diferencia', {caso: CASO, confirmadas: 1, total_declarado: 3, integrantes: []}));
    await ui.hacer(() => ui.pantallas.cierre.onConflicto({tipo: 'conflicto', destino: 'buscar', estadoActual: 'EN_GESTION', mensaje: 'La mesa canceló.'}));
    assert.equal(ui.vista(), 'buscar');
    assert.deepEqual(ui.alerts.at(-1).slice(0, 2), ['El caso cambió', 'La mesa canceló.']);
  } finally { await ui.close(); }
});

test('EmergenciaApp M2-6: buscar sin derivación -> puerta (con DNI, camas y mensaje) -> volver; ingresado va a integrantes, avisado a buscar', async () => {
  const ui = await montarApp();
  try {
    await ui.alBuscar();
    const busqueda = {resultado: 'SIN_DERIVACION', dni: '30111222', plazas_libres: 4, mensaje: 'No hay derivación.'};
    await ui.hacer(() => ui.pantallas.buscar.onSinDerivacion('ingresar', busqueda));
    assert.equal(ui.vista(), 'puerta');
    assert.equal(ui.titulo(), 'Sin derivación');
    const p = ui.pantallas.puerta;
    assert.deepEqual([p.dispositivo.id, p.dni, p.plazasLibres, p.accion, p.mensaje], [9, '30111222', 4, 'ingresar', 'No hay derivación.']);
    await ui.atras();
    assert.deepEqual([ui.vista(), ui.pantallas.buscar.dniInicial], ['buscar', '30111222']);
    await ui.hacer(() => ui.pantallas.buscar.onSinDerivacion('avisar', busqueda));
    await ui.hacer(() => ui.pantallas.puerta.onEnviando(true));
    assert.equal(ui.banner().props.showBackButton, false);
    await ui.hacer(() => ui.pantallas.puerta.onIngresado({id: 190, numero: '2026-000190', estado: 'INGRESO_EN_CURSO'}, {}));
    assert.deepEqual([ui.vista(), ui.pantallas.integrantes.caso.id, ui.banner().props.showBackButton], ['integrantes', 190, true]);
    await ui.atras();
    await ui.hacer(() => ui.pantallas.buscar.onSinDerivacion('avisar', busqueda));
    await ui.hacer(() => ui.pantallas.puerta.onAvisado({caso: AVISO.caso}));
    assert.deepEqual([ui.vista(), ui.pantallas.buscar.dniInicial, ui.pantallas.buscar.autoBuscar], ['buscar', '30111222', false]);
    await ui.hacer(() => ui.pantallas.buscar.onSinDerivacion('avisar', busqueda));
    await ui.hacer(() => ui.pantallas.puerta.onNoEncontrado());
    assert.equal(ui.vista(), 'dispositivos');
  } finally { await ui.close(); }
});
