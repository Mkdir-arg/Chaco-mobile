// Pantallas de M2 · Llegada de familias, parte 1: mis dispositivos (modo llegadas), buscar por DNI,
// la derivación (aceptar / rechazar) y los integrantes, más el router de EmergenciaApp. La lógica
// (services/emergenciaLlegadas) y la API (services/emergenciaApi) son las reales, sobre el fetch falso
// del runtime: lo que se prueba acá llega hasta el pedido HTTP.
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

const CASO = {id: 184, numero: '2026-000184', estado: 'DERIVADO', prioridad: 'ALTA', total_declarado: 7};
const DERIVACION = {
  id: 55, estado: 'PENDIENTE', plazas_pedidas: 7, vence_en: '2026-11-12T12:00:00-03:00', vencida: false,
  derivada_en: '2026-11-12T10:00:00-03:00', derivada_por: 'Ana López', caso: CASO,
  responsable: {nombre: 'Rosa', apellido: 'Benítez', dni: '30111222'},
  grupo: {menores_f: 2, menores_m: 3, adultos_f: 1, adultos_m: 1, mayores_f: 0, mayores_m: 0, dependientes: 0, mayores_dependientes: 0, lactantes: 1},
  necesidades: ['embarazo', 'mascotas'], telefono: '3624000000', observaciones: 'Vienen con un perro.',
};
const BUSQUEDA = {resultado: 'DERIVACION', dni: '30111222', plazas_libres: 9, mensaje: '', derivacion: DERIVACION,
  alojada_aca: null, alojada_en: '', alojada_desde: null};
const SIN_DERIVACION = {resultado: 'SIN_DERIVACION', dni: '30111222', plazas_libres: 3,
  mensaje: 'La derivación venció a las 12:00. Pedile a la mesa que vuelva a derivar o ingresala igual si tenés plazas.',
  derivacion: null, alojada_aca: null, alojada_en: '', alojada_desde: null};
const FILA = (n, extra = {}) => ({n, estado: 'SIN_CONFIRMAR', ficha_completa: false, persona: null, plaza: null, parentesco: '',
  confirmada_en: null, egresado_en: null, ...extra});
const CONFIRMADA = FILA(1, {estado: 'CONFIRMADA', persona: {id: 9, nombre: 'Benítez, Rosa', dni: '30111222'},
  plaza: {id: 41, codigo: 'B-12', nombre: 'B-12 (Pabellón B)'}, parentesco: 'Jefe/a de hogar', confirmada_en: '2026-11-12T10:20:00-03:00'});
const INTEGRANTES = {caso: {...CASO, estado: 'INGRESO_EN_CURSO'}, integrantes: [CONFIRMADA, FILA(2)],
  confirmadas: 1, total_declarado: 2, declaradas_al_relevar: 2, con_ficha_incompleta: 1};
const ACEPTACION = {caso: {...CASO, estado: 'INGRESO_EN_CURSO'}, reservadas: 7, faltantes: 0, mensaje: 'Reservé 7 de 7 camas', integrantes: [FILA(1)]};
const fallaDeRed = () => Promise.reject(new TypeError('Load failed'));
const nunca = () => new Promise(() => {});
const SIN_RED = 'Sin conexión: no podés buscar familias ni reservar camas. La llegada de familias necesita señal; probá cuando vuelva la red.';

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
    '../utils/teclado': {keyboardDismissModeFor: () => 'on-drag'},
    '../utils/dni': runtime.load('../utils/dni'),
    '../utils/dates': runtime.dates,
    '../services/emergenciaApi': runtime.load('./emergenciaApi'),
    '../services/emergenciaKits': runtime.load('./emergenciaKits'),
    '../services/emergenciaLlegadas': llegadas,
    '../services/sinModulo': runtime.load('./sinModulo'),
  };
  const aceptarAlerta = async (texto) => {
    const opcion = alerts.at(-1)[2].find(o => o.text === texto);
    assert.ok(opcion, 'Falta la opción ' + texto);
    await renderer.act(async () => { await opcion.onPress(); await esperar(5); });
  };
  return {runtime, calls, toasts, alerts, llegadas, mocks, aceptarAlerta};
}
const fondoDe = (tree, texto) => {
  const nodo = tree.root.findAllByType('Text').find(n => text(n) === texto);
  assert.ok(nodo, 'Falta ' + texto);
  const estilos = [].concat(nodo.parent.props.style || []).flat();
  return estilos.find(e => e && e.backgroundColor)?.backgroundColor;
};
const api = calls => calls.filter(c => c.url.startsWith('/api/emergencia/') && !c.url.endsWith('/perfil/'));

// ---- Mis dispositivos (modo llegadas) ----

test('Mis dispositivos (llegadas): solo los que admiten, con derivaciones por aceptar y camas libres; M3 no cambia', async () => {
  const env = await entorno(() => response(200, [
    {id: 7, nombre: 'Club Sarmiento', admite: true, recibe_kits: true, entregas_pendientes: 2, plazas_libres: 9, derivaciones_pendientes: 1},
    {id: 9, nombre: 'Escuela 12', admite: false, recibe_kits: true, entregas_pendientes: 1, plazas_libres: 0, derivaciones_pendientes: 0},
    {id: 11, nombre: 'Parroquia', admite: true, recibe_kits: false, entregas_pendientes: 0, plazas_libres: 1, derivaciones_pendientes: 0}]));
  const Screen = loadScreen('src/screens/EmergenciaMisDispositivosScreen.js', env.mocks);
  const elegidos = [];
  const ui = await render(Screen, {modo: 'llegadas', onElegir: (d, o) => elegidos.push([plano(d), plano(o)]), onSinModulo: () => {}});
  try {
    assert.deepEqual(ui.pressables().map(p => p.props.accessibilityLabel), [
      'Club Sarmiento, 1 derivación por aceptar · 9 camas libres', 'Parroquia, Sin derivaciones por aceptar · 1 cama libre']);
    await ui.press('Club Sarmiento, 1 derivación por aceptar · 9 camas libres');
    assert.deepEqual(elegidos, [[{id: 7, nombre: 'Club Sarmiento', plazas_libres: 9, derivaciones_pendientes: 1}, {unico: false}]]);
  } finally { await ui.close(); }
  const kits = await render(Screen, {onElegir: () => {}, onSinModulo: () => {}});
  try {
    assert.deepEqual(kits.pressables().map(p => p.props.accessibilityLabel), ['Club Sarmiento, 2 entregas por recibir', 'Escuela 12, 1 entrega por recibir']);
  } finally { await kits.close(); }
});

test('Mis dispositivos (llegadas): sin ninguno lo dice; sin red avisa con el texto de M2', async () => {
  let red = true;
  const env = await entorno(() => (red ? response(200, [{id: 9, nombre: 'Escuela 12', admite: false, recibe_kits: true}]) : fallaDeRed()));
  const Screen = loadScreen('src/screens/EmergenciaMisDispositivosScreen.js', env.mocks);
  const ui = await render(Screen, {modo: 'llegadas', onElegir: () => {}, onSinModulo: () => {}});
  try {
    assert.ok(ui.labels().includes('No admitís familias en ningún dispositivo. Pedí que te sumen al equipo de un dispositivo con un rol que admita familias.'));
  } finally { await ui.close(); }
  red = false;
  const sinRed = await render(Screen, {modo: 'llegadas', onElegir: () => {}, onSinModulo: () => {}});
  try {
    assert.ok(sinRed.labels().includes('Sin conexión: no se pudo traer tus dispositivos. La llegada de familias necesita señal.'));
  } finally { await sinRed.close(); }
});

// ---- Buscar ----

async function montarBuscar(rutas, {online = true, props = {}, antes} = {}) {
  const env = await entorno(rutas);
  env.runtime.setOnline(online);
  if (antes) await antes(env);
  const eventos = [];
  const Screen = loadScreen('src/screens/EmergenciaLlegadaBuscarScreen.js', env.mocks);
  const ui = await render(Screen, {dispositivo: {id: 7, nombre: 'Club Sarmiento'},
    onDerivacion: b => eventos.push(['derivacion', plano(b)]), onIntegrantes: (c, dni) => eventos.push(['integrantes', plano(c), dni]),
    onNoEncontrado: () => eventos.push(['no_encontrado']), onSinModulo: m => eventos.push(['sin_modulo', m]),
    onProximamente: t => eventos.push(['proximamente', t]), ...props});
  return {...env, ...ui, eventos};
}

test('Buscar: DERIVACION PENDIENTE abre la derivación; ACEPTADA va a los integrantes', async () => {
  let resultado = BUSQUEDA;
  const ui = await montarBuscar(() => response(200, resultado));
  try {
    assert.equal(ui.input('DNI').props.keyboardType, 'number-pad');
    await ui.escribir('DNI', '30.111.222');
    assert.equal(ui.input('DNI').props.value, '30111222', 'solo dígitos');
    await ui.pressButton('Buscar');
    assert.deepEqual(api(ui.calls).map(c => c.url), ['/api/emergencia/dispositivos/7/buscar/?dni=30111222']);
    assert.equal(ui.eventos[0][0], 'derivacion');
    assert.equal(ui.eventos[0][1].derivacion.id, 55);
    resultado = {...BUSQUEDA, derivacion: {...DERIVACION, estado: 'ACEPTADA', caso: {...CASO, estado: 'INGRESO_EN_CURSO'}}};
    await ui.pressButton('Buscar');
    assert.deepEqual(ui.eventos[1], ['integrantes', {...CASO, estado: 'INGRESO_EN_CURSO'}, '30111222']);
  } finally { await ui.close(); }
});

test('Buscar: SIN_DERIVACION muestra el mensaje y ofrece «Ingresar igual» solo con camas; «Avisar a la mesa» siempre (próximamente)', async () => {
  let resultado = SIN_DERIVACION;
  const ui = await montarBuscar(() => response(200, resultado));
  try {
    await ui.escribir('DNI', '30111222');
    await ui.pressButton('Buscar');
    assert.ok(ui.labels().includes(SIN_DERIVACION.mensaje));
    assert.ok(ui.labels().includes('3 camas libres en este dispositivo'));
    await ui.pressButton('Ingresar igual');
    await ui.pressButton('Avisar a la mesa');
    assert.deepEqual(ui.eventos, [['proximamente', 'Ingresar igual'], ['proximamente', 'Avisar a la mesa']]);
    resultado = {...SIN_DERIVACION, plazas_libres: 0, mensaje: 'No hay una derivación para este DNI en tu dispositivo.'};
    await ui.pressButton('Buscar');
    assert.ok(!ui.button('Ingresar igual'), 'sin camas no se ofrece ingresar');
    assert.ok(ui.button('Avisar a la mesa'));
  } finally { await ui.close(); }
});

test('Buscar: ALOJADA muestra el mensaje, si es acá y dónde (solo si viene)', async () => {
  const ui = await montarBuscar(() => response(200, {resultado: 'ALOJADA', dni: '30111222', plazas_libres: 2,
    mensaje: 'Alojada en Club Sarmiento desde el 12/11.', derivacion: null, alojada_aca: true, alojada_en: 'Club Sarmiento',
    alojada_desde: '2026-11-12T10:20:00-03:00'}));
  try {
    await ui.escribir('DNI', '30111222');
    await ui.pressButton('Buscar');
    const labels = ui.labels();
    for (const t of ['Ya está alojada', 'En este dispositivo', 'Alojada en Club Sarmiento desde el 12/11.', 'Club Sarmiento · desde el 12/11/2026 10:20']) {
      assert.ok(labels.includes(t), t);
    }
    assert.equal(fondoDe(ui.tree, 'En este dispositivo'), '#ECFDF5', 'insignia sobre su fondo de statusTones');
    assert.deepEqual(ui.eventos, []);
  } finally { await ui.close(); }
});

test('Buscar: un DNI inválido no pide nada; 400 VALIDACION `dni` se marca en el campo', async () => {
  const ui = await montarBuscar(() => response(400, {code: 'VALIDACION', detail: 'DNI raro', dni: ['DNI raro'], non_field_errors: ['DNI raro']}));
  try {
    await ui.escribir('DNI', '123');
    await ui.pressButton('Buscar');
    assert.equal(api(ui.calls).length, 0);
    assert.ok(ui.labels().includes('Ingresá un DNI válido de 7 u 8 dígitos, sin puntos.'));
    assert.equal(ui.input('DNI').props.style.find(s => s && s.borderColor).borderColor, '#D00000');
    await ui.escribir('DNI', '1234567');
    assert.ok(!ui.labels().includes('Ingresá un DNI válido de 7 u 8 dígitos, sin puntos.'), 'al escribir se limpia');
    await ui.pressButton('Buscar');
    assert.ok(ui.labels().includes('DNI raro'));
  } finally { await ui.close(); }
});

test('Buscar: 429 con Retry-After deshabilita el botón con la cuenta regresiva y lo dice', async () => {
  const ui = await montarBuscar(() => response(429, {detail: 'Request was throttled.'}, {'Retry-After': '30'}));
  try {
    await ui.escribir('DNI', '30111222');
    await ui.pressButton('Buscar');
    const boton = ui.button('Buscar en 30 s');
    assert.ok(boton, 'botones: ' + ui.titulos());
    assert.equal(boton.props.disabled, true);
    assert.ok(ui.labels().includes('Hiciste muchas búsquedas seguidas. Esperá a que termine la cuenta para volver a buscar.'));
    await renderer.act(async () => { await boton.props.onPress(); await esperar(5); });
    assert.equal(api(ui.calls).length, 1, 'durante la espera no vuelve a pedir');
  } finally { await ui.close(); }
});

test('Buscar: 404 vuelve a mis dispositivos; 403 SIN_MODULO avisa al módulo; red caída deja reintentar', async () => {
  let modo = '404';
  const ui = await montarBuscar((call) => {
    if (call.url.endsWith('/perfil/')) return response(200, {relevar: true, llegadas: false, kits: false});
    if (modo === '404') return response(404, {detail: 'No encontrado.'});
    if (modo === '403') return response(403, {detail: 'El usuario no admite familias en ningún dispositivo.', code: 'SIN_MODULO'});
    return fallaDeRed();
  });
  try {
    await ui.escribir('DNI', '30111222');
    await ui.pressButton('Buscar');
    modo = '403';
    await ui.pressButton('Buscar');
    modo = 'red';
    await ui.pressButton('Buscar');
    assert.deepEqual(ui.eventos, [['no_encontrado'], ['sin_modulo', 'El usuario no admite familias en ningún dispositivo.']]);
    assert.ok(ui.labels().includes('No se pudo hablar con el servidor. Probá de nuevo.'));
    assert.equal(ui.button('Buscar').props.disabled, false);
  } finally { await ui.close(); }
});

test('Buscar sin red: se bloquea con aviso y no pide nada; con red vuelve a andar', async () => {
  const ui = await montarBuscar(() => response(200, BUSQUEDA), {online: false});
  try {
    assert.ok(ui.labels().includes(SIN_RED), 'el aviso se ve al abrir');
    assert.equal(ui.button('Buscar').props.disabled, true);
    assert.equal(fondoDe(ui.tree, SIN_RED), '#FFF8F1');
    await ui.escribir('DNI', '30111222');
    await ui.pressButton('Buscar');
    assert.equal(api(ui.calls).length, 0);
    ui.runtime.setOnline(true);
    await ui.rerender({});
    // El aviso sigue hasta que la red avisa; tocar con red vuelve a probar.
    const boton = ui.button('Buscar');
    await renderer.act(async () => { await boton.props.onPress(); await esperar(5); });
    assert.equal(api(ui.calls).length, 1, 'con red la búsqueda sale');
    assert.equal(ui.eventos[0][0], 'derivacion');
  } finally { await ui.close(); }
});

test('Buscar: un segundo toque mientras busca no pide de nuevo; la respuesta tras salir no navega', async () => {
  let soltar;
  const ui = await montarBuscar(() => new Promise(resolve => { soltar = () => resolve(response(200, BUSQUEDA)); }));
  await ui.escribir('DNI', '30111222');
  await renderer.act(async () => { ui.button('Buscar').props.onPress(); await esperar(5); });
  await renderer.act(async () => { ui.button('Buscar').props.onPress(); await esperar(5); });
  assert.equal(api(ui.calls).length, 1);
  await ui.close();
  soltar();
  await esperar(20);
  assert.deepEqual(ui.eventos, [], 'desmontada, la respuesta tardía se descarta');
});

test('Buscar: toques sin espera entre medio (la red tarda en contestar) mandan una sola búsqueda', async () => {
  const ui = await montarBuscar(() => response(200, BUSQUEDA));
  try {
    await ui.escribir('DNI', '30111222');
    await renderer.act(async () => { const p = ui.button('Buscar').props.onPress; p(); p(); p(); await esperar(10); });
    assert.equal(api(ui.calls).length, 1);
  } finally { await ui.close(); }
});

test('Buscar: la espera del 429 viene del padre (sobrevive a re-entrar) y se le avisa la nueva', async () => {
  const esperas = [];
  const ui = await montarBuscar(() => response(429, {detail: 'x'}, {'Retry-After': '20'}), {props: {onEspera: h => esperas.push(h)}});
  try {
    await ui.escribir('DNI', '30111222');
    await ui.pressButton('Buscar');
    assert.equal(esperas.length, 1);
    assert.ok(esperas[0] > Date.now() + 15000);
  } finally { await ui.close(); }
  const otra = await montarBuscar(() => response(200, BUSQUEDA), {props: {esperaHasta: Date.now() + 10000, dniInicial: '30111222', autoBuscar: true}});
  try {
    assert.ok(otra.button('Buscar en 10 s') || otra.button('Buscar en 9 s'), 'botones: ' + otra.titulos());
    assert.equal(api(otra.calls).length, 0, 'ni la búsqueda automática sale durante la espera');
  } finally { await otra.close(); }
});

test('Buscar: con `autoBuscar` (recarga por DERIVADO) busca sola con el DNI que trae', async () => {
  const ui = await montarBuscar(() => response(200, BUSQUEDA), {props: {dniInicial: '30111222', autoBuscar: true}});
  try {
    assert.deepEqual(api(ui.calls).map(c => c.url), ['/api/emergencia/dispositivos/7/buscar/?dni=30111222']);
    assert.equal(ui.eventos[0][0], 'derivacion');
  } finally { await ui.close(); }
  const sinAuto = await montarBuscar(() => response(200, BUSQUEDA), {props: {dniInicial: '30111222'}});
  try {
    assert.equal(api(sinAuto.calls).length, 0);
    assert.equal(sinAuto.input('DNI').props.value, '30111222');
  } finally { await sinAuto.close(); }
});

test('Buscar: la respuesta que llega con otra sesión ya abierta se descarta', async () => {
  const ui = await montarBuscar(async () => {
    ui.runtime.setFetch(async () => response(200, {token: 'tok-2', user_id: 8, username: 'otra', modulos: ['emergencia']}));
    await ui.runtime.api.loginBecas({username: 'otra', password: 'x'});
    return response(200, BUSQUEDA);
  });
  try {
    await ui.escribir('DNI', '30111222');
    await ui.pressButton('Buscar');
    assert.deepEqual(ui.eventos, []);
  } finally { await ui.close(); }
});

// ---- Derivación ----

async function montarDerivacion(rutas, {online = true, busqueda = BUSQUEDA} = {}) {
  const env = await entorno(rutas);
  env.runtime.setOnline(online);
  const eventos = [];
  const enviando = [];
  const Screen = loadScreen('src/screens/EmergenciaDerivacionScreen.js', env.mocks);
  const ui = await render(Screen, {busqueda: env.llegadas.normalizarBusqueda(busqueda),
    onAceptada: (c, r) => eventos.push(['aceptada', plano(c), r.resultado]), onRechazada: r => eventos.push(['rechazada', plano(r)]),
    onConflicto: c => eventos.push(['conflicto', plano(c)]), onNoEncontrado: () => eventos.push(['no_encontrado']),
    onSinModulo: m => eventos.push(['sin_modulo', m]), onEnviando: v => enviando.push(v)});
  return {...env, ...ui, eventos, enviando};
}
const posts = (calls, accion) => calls.filter(c => c.method === 'POST' && c.url.endsWith(`/${accion}/`));

test('Derivación: muestra caso, prioridad, responsable, camas, quién derivó, la familia y sus necesidades', async () => {
  const ui = await montarDerivacion(() => response(200, ACEPTACION), {busqueda: {...BUSQUEDA, derivacion: {...DERIVACION, vencida: true}}});
  try {
    const labels = ui.labels();
    for (const t of ['Caso 2026-000184', 'Por aceptar', 'Prioridad alta', 'Vencida', 'Rosa Benítez · DNI 30111222', '7 · 7 personas declaradas',
      '9 camas libres en este dispositivo', 'Ana López · 12/11/2026 10:00', '12/11/2026 12:00',
      'Menores (F): 2 · Menores (M): 3 · Adultos (F): 1 · Adultos (M): 1', 'Lactantes: 1', 'Embarazo', 'Mascotas', '3624000000',
      'Vienen con un perro.', 'Venció el plazo, pero la mesa todavía no la cerró: se puede aceptar igual.']) {
      assert.ok(labels.includes(t), t);
    }
    assert.equal(fondoDe(ui.tree, 'Prioridad alta'), '#FEF0F2');
    assert.equal(api(ui.calls).length, 0, 'abrir no pide nada');
  } finally { await ui.close(); }
});

test('Derivación: «Aceptar» manda el POST con uuid y sigue a los integrantes; avisa al padre mientras manda', async () => {
  const ui = await montarDerivacion(() => response(200, ACEPTACION));
  try {
    await ui.pressButton('Aceptar y reservar camas');
    const [post] = posts(ui.calls, 'aceptar');
    assert.equal(post.url, '/api/emergencia/derivaciones/55/aceptar/');
    assert.match(post.body.uuid_cliente, /^[0-9a-f-]{36}$/);
    assert.deepEqual(ui.eventos, [['aceptada', {...CASO, estado: 'INGRESO_EN_CURSO'}, 'aceptada']]);
    assert.equal(ui.toasts.at(-1).message, 'Reservé 7 de 7 camas');
    assert.deepEqual(ui.enviando, [true, false]);
  } finally { await ui.close(); }
});

test('Derivación: con camas de menos acepta igual y lo dice en un aviso', async () => {
  const ui = await montarDerivacion(() => response(200, {...ACEPTACION, reservadas: 5, faltantes: 2, mensaje: 'Reservé 5 de 7 · faltan 2 camas'}));
  try {
    await ui.pressButton('Aceptar y reservar camas');
    assert.deepEqual(ui.alerts.at(-1).slice(0, 2), ['Derivación aceptada con camas de menos', 'Reservé 5 de 7 · faltan 2 camas']);
    assert.equal(ui.eventos[0][0], 'aceptada');
  } finally { await ui.close(); }
});

test('Derivación: 409 de estado va al router con el detail; 400 `plazas` queda en la pantalla', async () => {
  let modo = '409';
  const ui = await montarDerivacion(() => (modo === '409'
    ? response(409, {detail: 'La derivación ya la aceptó Juan a las 10:20. Recargá la pantalla para seguir con el ingreso.', estado_actual: 'INGRESO_EN_CURSO'})
    : response(400, {code: 'VALIDACION', detail: 'Sin plazas · rechazá con motivo o liberá camas.', plazas: ['Sin plazas · rechazá con motivo o liberá camas.'], non_field_errors: ['Sin plazas · rechazá con motivo o liberá camas.']})));
  try {
    await ui.pressButton('Aceptar y reservar camas');
    assert.equal(ui.eventos[0][0], 'conflicto');
    assert.deepEqual([ui.eventos[0][1].destino, ui.eventos[0][1].mensaje],
      ['integrantes', 'La derivación ya la aceptó Juan a las 10:20. Recargá la pantalla para seguir con el ingreso.']);
    modo = '400';
    await ui.pressButton('Aceptar y reservar camas');
    assert.ok(ui.labels().includes('Sin plazas · rechazá con motivo o liberá camas.'));
    assert.ok(ui.button('Aceptar y reservar camas'), 'un 400 no deja la acción incierta');
    assert.equal(ui.eventos.length, 1);
  } finally { await ui.close(); }
});

test('Derivación: timeout → «Reintentar aceptar»; el 409 INGRESO_EN_CURSO del reintento es «se hizo» y sigue', async () => {
  let intento = 0;
  const ui = await montarDerivacion(() => { intento += 1; return intento === 1 ? fallaDeRed()
    : response(409, {detail: 'La derivación ya la aceptó Guardia a las 10:20.', estado_actual: 'INGRESO_EN_CURSO'}); });
  try {
    await ui.pressButton('Aceptar y reservar camas');
    assert.ok(ui.labels().includes('No se pudo confirmar si la derivación se aceptó. «Reintentar» la vuelve a mandar: si ya había quedado aceptada, seguís con los integrantes.'));
    assert.equal(ui.button('Rechazar').props.disabled, true, 'con un aceptar incierto no se rechaza');
    await ui.pressButton('Reintentar aceptar');
    assert.deepEqual(ui.eventos, [['aceptada', CASO, 'ya_aceptada']]);
    assert.deepEqual(plano(ui.toasts.at(-1)), {type: 'info', message: 'La derivación ya la aceptó Guardia a las 10:20.'}, 'el detail del servidor dice quién y cuándo');
  } finally { await ui.close(); }
});

test('Derivación: «Rechazar» pide motivo (y qué pasó con «Otro»), confirma y manda; 200 vuelve a buscar', async () => {
  const ui = await montarDerivacion(() => response(200, {caso_estado: 'EN_GESTION'}));
  try {
    await ui.pressButton('Rechazar');
    await ui.pressButton('Confirmar rechazo');
    assert.ok(ui.labels().includes('Elegí el motivo del rechazo.'));
    await ui.press('Motivo: Otro');
    assert.equal(ui.pressables().find(p => p.props.accessibilityLabel === 'Motivo: Otro').props.accessibilityState.checked, true);
    await ui.pressButton('Confirmar rechazo');
    assert.ok(ui.labels().includes('Con el motivo «Otro», contá qué pasó.'));
    assert.equal(posts(ui.calls, 'rechazar').length, 0);
    await ui.escribir('Observación del rechazo', 'Se fueron con familiares');
    await ui.pressButton('Confirmar rechazo');
    const [titulo, mensaje, opciones] = ui.alerts.at(-1);
    assert.equal(titulo, 'Rechazar la derivación');
    assert.match(mensaje, /Motivo: Otro/);
    assert.deepEqual(plano(opciones.map(o => [o.text, o.style])), [['Cancelar', 'cancel'], ['Rechazar', 'destructive']]);
    assert.equal(posts(ui.calls, 'rechazar').length, 0, 'no manda antes de confirmar');
    await ui.aceptarAlerta('Rechazar');
    const [post] = posts(ui.calls, 'rechazar');
    assert.deepEqual(post.body, {motivo: 'OTRO', observacion: 'Se fueron con familiares'});
    assert.deepEqual(ui.eventos, [['rechazada', {resultado: 'rechazada', caso_estado: 'EN_GESTION'}]]);
  } finally { await ui.close(); }
});

test('Derivación: rechazo incierto → «Reintentar rechazo» sin volver a preguntar; 409 EN_GESTION es «se hizo»', async () => {
  let intento = 0;
  const ui = await montarDerivacion(() => { intento += 1; return intento === 1 ? response(502, {detail: 'Bad gateway'})
    : response(409, {detail: 'La derivación ya fue rechazada o el ingreso se canceló. Buscá a la familia de nuevo.', estado_actual: 'EN_GESTION'}); });
  try {
    await ui.pressButton('Rechazar');
    await ui.press('Motivo: No llegó');
    await ui.pressButton('Confirmar rechazo');
    await ui.aceptarAlerta('Rechazar');
    const alertas = ui.alerts.length;
    assert.equal(ui.input('Observación del rechazo').props.editable, false, 'incierto: el rechazo queda fijo');
    assert.equal(ui.button('Volver sin rechazar'), undefined);
    await ui.pressButton('Reintentar rechazo');
    assert.equal(ui.alerts.length, alertas, 'el reintento no vuelve a preguntar');
    const [a, b] = posts(ui.calls, 'rechazar');
    assert.deepEqual(b.body, a.body);
    assert.equal(ui.eventos[0][0], 'rechazada');
    assert.equal(ui.eventos[0][1].resultado, 'ya_rechazada');
    assert.deepEqual(plano(ui.toasts.at(-1)), {type: 'info', message: 'La derivación ya fue rechazada o el ingreso se canceló. Buscá a la familia de nuevo.'},
      'se ve el detail del servidor, no un texto genérico');
  } finally { await ui.close(); }
});

test('Derivación: un segundo toque mientras acepta no manda otro; volver queda en manos del padre (onEnviando)', async () => {
  let soltar;
  const ui = await montarDerivacion(() => new Promise(resolve => { soltar = () => resolve(response(200, ACEPTACION)); }));
  try {
    await renderer.act(async () => { ui.button('Aceptar y reservar camas').props.onPress(); await esperar(5); });
    await renderer.act(async () => { ui.button('Aceptar y reservar camas').props.onPress(); await esperar(5); });
    assert.equal(posts(ui.calls, 'aceptar').length, 1);
    assert.deepEqual(ui.enviando, [true]);
    assert.equal(ui.button('Rechazar').props.disabled, true);
    await renderer.act(async () => { soltar(); await esperar(10); });
    assert.deepEqual(ui.enviando, [true, false]);
    assert.equal(ui.eventos[0][0], 'aceptada');
  } finally { await ui.close(); }
});

test('Derivación: toques sin espera entre medio en «Aceptar» (NetInfo tarda) mandan un solo POST', async () => {
  const ui = await montarDerivacion(() => response(200, ACEPTACION));
  try {
    await renderer.act(async () => { const p = ui.button('Aceptar y reservar camas').props.onPress; p(); p(); await esperar(10); });
    assert.equal(posts(ui.calls, 'aceptar').length, 1);
    assert.equal(ui.eventos.length, 1);
  } finally { await ui.close(); }
  const sinRed = await montarDerivacion(() => response(200, ACEPTACION), {online: false});
  try {
    await sinRed.pressButton('Aceptar y reservar camas');
    sinRed.runtime.setOnline(true);
    await sinRed.pressButton('Aceptar y reservar camas');
    assert.equal(posts(sinRed.calls, 'aceptar').length, 1, 'sin red se libera el toque para el siguiente');
  } finally { await sinRed.close(); }
});

test('Derivación sin red: no manda nada y lo avisa; 404 y 403 SIN_MODULO van al padre', async () => {
  const ui = await montarDerivacion(() => response(200, ACEPTACION), {online: false});
  try {
    assert.ok(ui.labels().includes(SIN_RED));
    await ui.pressButton('Aceptar y reservar camas');
    assert.equal(posts(ui.calls, 'aceptar').length, 0);
    assert.deepEqual(ui.alerts.at(-1).slice(0, 2), ['Sin conexión', SIN_RED]);
  } finally { await ui.close(); }
  const ajena = await montarDerivacion((call) => (call.url.endsWith('/perfil/') ? response(200, {llegadas: false})
    : call.url.endsWith('/aceptar/') ? response(404, {detail: 'No encontrado.'}) : response(403, {detail: 'Sin admitir.', code: 'SIN_MODULO'})));
  try {
    await ajena.pressButton('Aceptar y reservar camas');
    await ajena.pressButton('Rechazar');
    await ajena.press('Motivo: Sin plazas');
    await ajena.pressButton('Confirmar rechazo');
    await ajena.aceptarAlerta('Rechazar');
    assert.deepEqual(ajena.eventos, [['no_encontrado'], ['sin_modulo', 'Sin admitir.']]);
  } finally { await ajena.close(); }
});

// ---- Integrantes ----

async function montarIntegrantes(rutas, {online = true, caso = CASO} = {}) {
  const env = await entorno(rutas);
  env.runtime.setOnline(online);
  const eventos = [];
  const enviando = [];
  const Screen = loadScreen('src/screens/EmergenciaIntegrantesScreen.js', env.mocks);
  const ui = await render(Screen, {caso, onConflicto: c => eventos.push(['conflicto', plano(c)]),
    onNoEncontrado: () => eventos.push(['no_encontrado']), onSinModulo: m => eventos.push(['sin_modulo', m]),
    onProximamente: t => eventos.push(['proximamente', t]), onEnviando: v => enviando.push(v)});
  return {...env, ...ui, eventos, enviando};
}

test('Integrantes: contador, filas (confirmada con cama y ficha incompleta, sin confirmar) y el cierre que corresponde', async () => {
  const ui = await montarIntegrantes(() => response(200, INTEGRANTES));
  try {
    assert.deepEqual(api(ui.calls).map(c => c.url), ['/api/emergencia/casos/184/integrantes/']);
    const labels = ui.labels();
    for (const t of ['Caso 2026-000184', '1 de 2 confirmadas', '1 persona con la ficha incompleta', '1. Benítez, Rosa', 'Confirmada',
      'DNI 30111222 · Cama B-12 (Pabellón B) · Jefe/a de hogar', 'Ficha incompleta', '2. Persona 2', 'Sin confirmar']) {
      assert.ok(labels.includes(t), t);
    }
    assert.equal(fondoDe(ui.tree, 'Ficha incompleta'), '#FFF8F1');
    assert.ok(ui.button('Cerrar con diferencia'));
    assert.ok(!ui.button('Familia alojada'));
    await ui.press('2. Persona 2. Sin confirmar');
    await ui.pressButton('Cerrar con diferencia');
    assert.deepEqual(ui.eventos, [['proximamente', 'Confirmar persona'], ['proximamente', 'Cerrar con diferencia']]);
  } finally { await ui.close(); }
});

test('Integrantes: N de N ofrece «Familia alojada», ninguna «Cancelar ingreso»; «llegaron 8 sobre 7»', async () => {
  let datos = {...INTEGRANTES, confirmadas: 2, total_declarado: 2};
  const ui = await montarIntegrantes(() => response(200, datos));
  try {
    assert.ok(ui.button('Familia alojada'));
  } finally { await ui.close(); }
  datos = {...INTEGRANTES, confirmadas: 0, total_declarado: 8, declaradas_al_relevar: 7};
  const ninguna = await montarIntegrantes(() => response(200, datos));
  try {
    assert.ok(ninguna.button('Cancelar ingreso'));
    assert.ok(ninguna.labels().includes('Llegaron 8 sobre 7 declaradas al relevar'));
  } finally { await ninguna.close(); }
});

test('Integrantes: con la familia alojada es solo lectura (sin agregar ni cierres, filas deshabilitadas)', async () => {
  const ui = await montarIntegrantes(() => response(200, {...INTEGRANTES, caso: {...CASO, estado: 'ALOJADO'}}));
  try {
    assert.ok(ui.labels().includes('Familia alojada: se muestra en modo lectura.'));
    assert.deepEqual(ui.titulos(), []);
    assert.ok(ui.pressables().every(p => p.props.disabled === true));
  } finally { await ui.close(); }
});

test('Integrantes: 409 al cargar va al router; 404 y 403 al padre', async () => {
  const ui = await montarIntegrantes(() => response(409, {detail: 'La mesa canceló la derivación. Si la familia está en la puerta, avisale a la mesa.', estado_actual: 'EN_GESTION'}));
  try {
    assert.deepEqual(ui.eventos.map(e => [e[0], e[1].destino, e[1].mensaje]),
      [['conflicto', 'buscar', 'La mesa canceló la derivación. Si la familia está en la puerta, avisale a la mesa.']]);
  } finally { await ui.close(); }
  const ajena = await montarIntegrantes(() => response(404, {detail: 'No encontrado.'}));
  try { assert.deepEqual(ajena.eventos, [['no_encontrado']]); } finally { await ajena.close(); }
});

test('Integrantes (B1): un 409 del propio GET con CERRADO o ALOJADO no vuelve a integrantes: va a buscar, una sola vez', async () => {
  for (const estado of ['CERRADO', 'ALOJADO', 'INGRESO_EN_CURSO']) {
    const ui = await montarIntegrantes(() => response(409, {detail: `El caso 2026-000184 está ${estado}.`, estado_actual: estado}));
    try {
      await esperar(20);
      assert.deepEqual(ui.eventos.map(e => [e[0], e[1].destino, e[1].estadoActual, e[1].mensaje]),
        [['conflicto', 'buscar', estado, `El caso 2026-000184 está ${estado}.`]], estado);
      assert.equal(api(ui.calls).length, 1);
    } finally { await ui.close(); }
  }
});

test('Integrantes: «Agregar persona» sin resultado sobrevive a salir y re-entrar: ofrece reintentar con el MISMO uuid', async () => {
  let posteos = 0;
  const env = await entorno((call) => {
    if (call.method === 'POST') { posteos += 1; return posteos === 1 ? fallaDeRed() : response(200, {integrante: FILA(3), total_declarado: 3}); }
    return response(200, INTEGRANTES);
  });
  const Screen = loadScreen('src/screens/EmergenciaIntegrantesScreen.js', env.mocks);
  const props = {caso: CASO, onConflicto: () => {}, onNoEncontrado: () => {}, onSinModulo: () => {}, onProximamente: () => {}, onEnviando: () => {}};
  const primera = await render(Screen, props);
  await primera.pressButton('Agregar persona');
  await env.aceptarAlerta('Agregar');
  assert.ok(primera.button('Reintentar agregar persona'));
  await primera.close();
  const segunda = await render(Screen, props);
  try {
    assert.ok(segunda.button('Reintentar agregar persona'), 'botones: ' + segunda.titulos());
    const alertas = env.alerts.length;
    await segunda.pressButton('Reintentar agregar persona');
    assert.equal(env.alerts.length, alertas, 'el reintento no vuelve a preguntar');
    const [a, b] = env.calls.filter(c => c.method === 'POST');
    assert.equal(b.body.uuid_cliente, a.body.uuid_cliente);
    assert.ok(segunda.button('Agregar persona'));
  } finally { await segunda.close(); }
});

test('Integrantes: toques sin espera entre medio en «Agregar» mandan un solo POST', async () => {
  const ui = await montarIntegrantes((call) => (call.method === 'POST' ? response(201, {integrante: FILA(3), total_declarado: 3}) : response(200, INTEGRANTES)));
  try {
    await ui.pressButton('Agregar persona');
    const agregar = ui.alerts.at(-1)[2].find(o => o.text === 'Agregar').onPress;
    await renderer.act(async () => { agregar(); agregar(); await esperar(10); });
    assert.equal(ui.calls.filter(c => c.method === 'POST').length, 1);
  } finally { await ui.close(); }
});

test('Integrantes sin red: no hay lectura guardada; avisa y deja reintentar', async () => {
  const ui = await montarIntegrantes(() => response(200, INTEGRANTES), {online: false});
  try {
    assert.ok(ui.labels().includes(SIN_RED));
    assert.equal(api(ui.calls).length, 0);
    assert.ok(!ui.labels().includes('1 de 2 confirmadas'));
    ui.runtime.setOnline(true);
    await ui.pressButton('Reintentar');
    assert.ok(ui.labels().includes('1 de 2 confirmadas'));
  } finally { await ui.close(); }
});

test('Integrantes: «Agregar persona» confirma, manda con uuid y recarga; el reintento tras un corte usa el MISMO uuid', async () => {
  let posteos = 0;
  const ui = await montarIntegrantes((call) => {
    if (call.method === 'POST') { posteos += 1; return posteos === 1 ? fallaDeRed() : response(201, {integrante: FILA(3), total_declarado: 3}); }
    return response(200, posteos >= 2 ? {...INTEGRANTES, integrantes: [CONFIRMADA, FILA(2), FILA(3)], total_declarado: 3} : INTEGRANTES);
  });
  try {
    await ui.pressButton('Agregar persona');
    assert.equal(ui.alerts.at(-1)[0], 'Agregar persona');
    assert.match(ui.alerts.at(-1)[1], /persona 3/);
    await ui.aceptarAlerta('Agregar');
    assert.ok(ui.labels().includes('No se pudo confirmar si se sumó la persona. «Reintentar» manda el mismo pedido y no la suma dos veces.'));
    const alertas = ui.alerts.length;
    await ui.pressButton('Reintentar agregar persona');
    assert.equal(ui.alerts.length, alertas, 'el reintento no vuelve a preguntar');
    const [a, b] = ui.calls.filter(c => c.method === 'POST');
    assert.equal(b.body.uuid_cliente, a.body.uuid_cliente);
    assert.ok(ui.labels().includes('1 de 3 confirmadas'), 'recarga tras sumar');
    assert.equal(ui.toasts.at(-1).message, 'Se sumó la persona 3 a la familia.');
    assert.deepEqual(ui.enviando, [true, false, true, false]);
    await ui.pressButton('Agregar persona');
    await ui.aceptarAlerta('Agregar');
    const tercero = ui.calls.filter(c => c.method === 'POST')[2];
    assert.notEqual(tercero.body.uuid_cliente, a.body.uuid_cliente, 'la siguiente persona es otro pedido');
  } finally { await ui.close(); }
});

// ---- EmergenciaApp: el recorrido y el router por estado_actual ----

async function montarApp({integrantes = null} = {}) {
  const pantallas = {};
  const alerts = [];
  const toasts = [];
  const capturar = nombre => props => { pantallas[nombre] = props; return null; };
  const mocks = {
    react: React, 'react-native': native,
    '../context/AuthContext': {useAuth: () => ({user: {nombre: 'Ana'}, logout() {}})},
    '../context/ThemeContext': {useTheme: () => ({theme, typography})},
    '../context/ToastContext': {useToast: () => ({showAlert: (...a) => alerts.push(a), showToast: t => toasts.push(t)})},
    '../components/Banner': {__esModule: true, default: 'Banner'},
    '../components/CustomButton': {__esModule: true, default: 'CustomButton'},
    '../components/SettingsPanel': {__esModule: true, default: 'SettingsPanel'},
    '../screens/EmergenciaInicioScreen': {__esModule: true, default: capturar('inicio')},
    '../screens/EmergenciaMisEnviosScreen': {__esModule: true, default: capturar('envios')},
    '../screens/EmergenciaFormulario1Screen': {__esModule: true, default: capturar('formulario')},
    '../screens/EmergenciaMisDispositivosScreen': {__esModule: true, default: capturar('dispositivos')},
    '../screens/EmergenciaEntregasScreen': {__esModule: true, default: capturar('entregas')},
    '../screens/EmergenciaRecibirEntregaScreen': {__esModule: true, default: capturar('recibir')},
    '../screens/EmergenciaLlegadaBuscarScreen': {__esModule: true, default: capturar('buscar')},
    '../screens/EmergenciaDerivacionScreen': {__esModule: true, default: capturar('derivacion')},
    '../screens/EmergenciaIntegrantesScreen': {__esModule: true, default: integrantes
      ? (props) => { pantallas.integrantes = props; return React.createElement(integrantes, props); } : capturar('integrantes')},
    '@react-native-community/netinfo': {__esModule: true, default: {addEventListener: () => () => {}}},
    '../services/emergenciaCola': {syncPendientes: async () => ({}), getPendingCount: async () => 0, getResumenPendientes: async () => ({}),
      reintentar: async () => ({}), getLocalidadesGuardadas: async () => ({localidades: []}), getBorradorEnCurso: async () => null, descartar: async () => true},
    '../utils/emergencia': {avisoDeSalida: () => null},
  };
  const App = loadScreen('src/navigation/EmergenciaApp.js', mocks);
  let tree;
  await renderer.act(async () => { tree = renderer.create(React.createElement(App, {})); });
  const banner = () => tree.root.findByType('Banner');
  const hacer = async (fn) => renderer.act(async () => { fn(); await esperar(2); });
  return {pantallas, alerts, toasts, banner, hacer, titulo: () => banner().props.title, atras: () => hacer(() => banner().props.onBackPress()),
    vista: () => ['dispositivos', 'buscar', 'derivacion', 'integrantes'].find(n => tree.root.findAll(x => x.type === mocks[`../screens/${{dispositivos: 'EmergenciaMisDispositivosScreen', buscar: 'EmergenciaLlegadaBuscarScreen', derivacion: 'EmergenciaDerivacionScreen', integrantes: 'EmergenciaIntegrantesScreen'}[n]}`].default).length),
    close: () => renderer.act(async () => tree.unmount())};
}

test('EmergenciaApp M2: «Llegada de familias» -> dispositivos (llegadas) -> buscar -> derivación -> integrantes, y volver', async () => {
  const ui = await montarApp();
  try {
    await ui.hacer(() => ui.pantallas.inicio.onAbrir({clave: 'llegadas', titulo: 'Llegada de familias'}));
    assert.equal(ui.titulo(), 'Llegada de familias');
    assert.equal(ui.pantallas.dispositivos.modo, 'llegadas');
    await ui.hacer(() => ui.pantallas.dispositivos.onElegir({id: 7, nombre: 'Club Sarmiento'}, {unico: false}));
    assert.equal(ui.titulo(), 'Club Sarmiento');
    assert.equal(ui.pantallas.buscar.dispositivo.id, 7);
    await ui.hacer(() => ui.pantallas.buscar.onDerivacion({dni: '30111222', derivacion: {id: 55, caso: CASO}}));
    assert.equal(ui.titulo(), 'Derivación');
    assert.equal(ui.pantallas.derivacion.busqueda.derivacion.id, 55);
    await ui.atras();
    assert.equal(ui.vista(), 'buscar');
    assert.equal(ui.pantallas.buscar.dniInicial, '30111222', 'volver conserva el DNI');
    assert.equal(ui.pantallas.buscar.autoBuscar, false);
    await ui.hacer(() => ui.pantallas.buscar.onDerivacion({dni: '30111222', derivacion: {id: 55, caso: CASO}}));
    await ui.hacer(() => ui.pantallas.derivacion.onAceptada({...CASO, estado: 'INGRESO_EN_CURSO'}));
    assert.equal(ui.titulo(), 'Integrantes');
    assert.equal(ui.pantallas.integrantes.caso.id, 184);
    await ui.atras();
    assert.equal(ui.vista(), 'buscar');
    // La espera del 429 queda en el padre: al re-entrar a buscar, sigue.
    await ui.hacer(() => ui.pantallas.buscar.onEspera(123456789));
    await ui.atras();
    assert.equal(ui.vista(), 'dispositivos');
    await ui.hacer(() => ui.pantallas.dispositivos.onElegir({id: 7, nombre: 'Club Sarmiento'}, {unico: false}));
    assert.equal(ui.pantallas.buscar.esperaHasta, 123456789);
    await ui.atras();
    await ui.atras();
    assert.equal(ui.titulo(), 'Hola, Ana');
    // Con un solo dispositivo, volver desde buscar va al inicio.
    await ui.hacer(() => ui.pantallas.inicio.onAbrir({clave: 'llegadas', titulo: 'Llegada de familias'}));
    await ui.hacer(() => ui.pantallas.dispositivos.onElegir({id: 9, nombre: 'Escuela 12'}, {unico: true}));
    await ui.atras();
    assert.equal(ui.titulo(), 'Hola, Ana');
  } finally { await ui.close(); }
});

test('EmergenciaApp M2: el router de §13.1 recarga la pantalla de cada estado_actual y muestra el detail', async () => {
  const ui = await montarApp();
  const alDerivacion = async () => {
    await ui.hacer(() => ui.pantallas.buscar.onDerivacion({dni: '30111222', derivacion: {id: 55, caso: CASO}}));
    assert.equal(ui.vista(), 'derivacion');
  };
  try {
    await ui.hacer(() => ui.pantallas.inicio.onAbrir({clave: 'llegadas', titulo: 'Llegada de familias'}));
    await ui.hacer(() => ui.pantallas.dispositivos.onElegir({id: 7, nombre: 'Club Sarmiento'}, {unico: false}));
    await alDerivacion();
    await ui.hacer(() => ui.pantallas.derivacion.onConflicto({tipo: 'conflicto', destino: 'integrantes', estadoActual: 'INGRESO_EN_CURSO', mensaje: 'Ya la aceptó Juan.'}));
    assert.equal(ui.vista(), 'integrantes');
    assert.equal(ui.pantallas.integrantes.caso.id, 184);
    assert.deepEqual(ui.alerts.at(-1).slice(0, 2), ['El caso cambió', 'Ya la aceptó Juan.']);
    // Un 409 ALOJADO posterior (p. ej. al agregar una persona) sobre esa pantalla recargada abre integrantes
    // de nuevo, en lectura: el bucle lo corta la pantalla de integrantes, no el router.
    const antes = ui.pantallas.integrantes;
    await ui.hacer(() => ui.pantallas.integrantes.onConflicto({tipo: 'conflicto', destino: 'integrantes', estadoActual: 'ALOJADO', mensaje: 'Ya figura alojada.'}));
    assert.equal(ui.vista(), 'integrantes');
    assert.notEqual(ui.pantallas.integrantes, antes);
    await ui.hacer(() => ui.pantallas.integrantes.onConflicto({tipo: 'conflicto', destino: 'integrantes', estadoActual: 'ALOJADO', mensaje: 'Ya figura alojada.'}));
    assert.equal(ui.vista(), 'integrantes');
    // DERIVADO: vuelve a buscar sola con el DNI.
    await alDerivacion();
    await ui.hacer(() => ui.pantallas.derivacion.onAceptada(CASO));
    await ui.hacer(() => ui.pantallas.integrantes.onConflicto({tipo: 'conflicto', destino: 'derivacion', estadoActual: 'DERIVADO', mensaje: 'Buscá de nuevo.'}));
    assert.equal(ui.vista(), 'buscar');
    assert.deepEqual([ui.pantallas.buscar.dniInicial, ui.pantallas.buscar.autoBuscar], ['30111222', true]);
    // EN_GESTION: a buscar, con el DNI pero sin buscar sola.
    await alDerivacion();
    await ui.hacer(() => ui.pantallas.derivacion.onConflicto({tipo: 'conflicto', destino: 'buscar', estadoActual: 'EN_GESTION', mensaje: 'La mesa canceló.'}));
    assert.equal(ui.vista(), 'buscar');
    assert.deepEqual([ui.pantallas.buscar.dniInicial, ui.pantallas.buscar.autoBuscar], ['30111222', false]);
    // Rechazada: a buscar limpia. 404: a mis dispositivos sin entrar directo. 403: al inicio.
    await alDerivacion();
    await ui.hacer(() => ui.pantallas.derivacion.onRechazada({resultado: 'rechazada'}));
    assert.deepEqual([ui.vista(), ui.pantallas.buscar.dniInicial], ['buscar', '']);
    await ui.hacer(() => ui.pantallas.buscar.onNoEncontrado());
    assert.equal(ui.vista(), 'dispositivos');
    assert.equal(ui.pantallas.dispositivos.entrarDirecto, false);
    assert.equal(ui.toasts.at(-1).type, 'warning');
    await ui.hacer(() => ui.pantallas.dispositivos.onSinModulo('El usuario no admite familias.'));
    assert.equal(ui.titulo(), 'Hola, Ana');
    assert.deepEqual(ui.alerts.at(-1).slice(0, 2), ['Sin permiso', 'El usuario no admite familias.']);
  } finally { await ui.close(); }
});

test('EmergenciaApp M2: mientras se acepta o se agrega una persona no hay flecha de volver; próximamente avisa', async () => {
  const ui = await montarApp();
  try {
    await ui.hacer(() => ui.pantallas.inicio.onAbrir({clave: 'llegadas', titulo: 'Llegada de familias'}));
    await ui.hacer(() => ui.pantallas.dispositivos.onElegir({id: 7, nombre: 'Club'}, {unico: false}));
    await ui.hacer(() => ui.pantallas.buscar.onDerivacion({dni: '30111222', derivacion: {id: 55, caso: CASO}}));
    await ui.hacer(() => ui.pantallas.derivacion.onEnviando(true));
    assert.equal(ui.banner().props.showBackButton, false);
    await ui.atras();
    assert.equal(ui.vista(), 'derivacion', 'volver no hace nada mientras se manda');
    await ui.hacer(() => ui.pantallas.derivacion.onAceptada(CASO));
    assert.equal(ui.banner().props.showBackButton, true);
    await ui.hacer(() => ui.pantallas.integrantes.onEnviando(true));
    assert.equal(ui.banner().props.showBackButton, false);
    await ui.hacer(() => ui.pantallas.integrantes.onEnviando(false));
    await ui.hacer(() => ui.pantallas.integrantes.onProximamente('Familia alojada'));
    assert.deepEqual(ui.alerts.at(-1).slice(0, 2), ['Próximamente', '«Familia alojada» va a estar disponible en una próxima versión de la app.']);
  } finally { await ui.close(); }
});

test('EmergenciaApp M2 (B1): con la pantalla real, un caso CERRADO sin ingreso aceptado termina en buscar con un solo GET', async () => {
  for (const estado of ['CERRADO', 'ALOJADO']) {
    const env = await entorno(() => response(409, {detail: `El caso está ${estado}.`, estado_actual: estado}));
    const Real = loadScreen('src/screens/EmergenciaIntegrantesScreen.js', env.mocks);
    const ui = await montarApp({integrantes: Real});
    try {
      await ui.hacer(() => ui.pantallas.inicio.onAbrir({clave: 'llegadas', titulo: 'Llegada de familias'}));
      await ui.hacer(() => ui.pantallas.dispositivos.onElegir({id: 7, nombre: 'Club'}, {unico: false}));
      await ui.hacer(() => ui.pantallas.buscar.onDerivacion({dni: '30111222', derivacion: {id: 55, caso: CASO}}));
      await ui.hacer(() => ui.pantallas.derivacion.onConflicto({tipo: 'conflicto', destino: 'integrantes', estadoActual: estado, mensaje: `El caso está ${estado}.`}));
      await renderer.act(async () => { await esperar(60); });
      assert.equal(ui.vista(), 'buscar', estado);
      assert.equal(env.calls.filter(c => c.url.endsWith('/integrantes/')).length, 1, `${estado}: sin bucle`);
    } finally { await ui.close(); }
  }
});

test('Integrantes: el reenvío de un alta que ya había llegado no dice «Se sumó»: avisa que esa persona ya estaba', async () => {
  let posteos = 0;
  const env = await entorno((call) => {
    if (call.method === 'POST') { posteos += 1; return posteos === 1 ? fallaDeRed() : response(200, {integrante: FILA(3), total_declarado: 3}); }
    // El alta incierta llegó: la lista ya trae a la persona 3.
    return response(200, posteos ? {...INTEGRANTES, integrantes: [CONFIRMADA, FILA(2), FILA(3)], total_declarado: 3} : INTEGRANTES);
  });
  const Screen = loadScreen('src/screens/EmergenciaIntegrantesScreen.js', env.mocks);
  const props = {caso: CASO, onConflicto: () => {}, onNoEncontrado: () => {}, onSinModulo: () => {}, onProximamente: () => {}, onEnviando: () => {}};
  const primera = await render(Screen, props);
  await primera.pressButton('Agregar persona');
  await env.aceptarAlerta('Agregar');
  await primera.close();
  const segunda = await render(Screen, props);
  try {
    assert.ok(segunda.labels().includes('1 de 3 confirmadas'));
    await segunda.pressButton('Reintentar agregar persona');
    assert.deepEqual(plano(env.toasts.at(-1)), {type: 'info',
      message: 'La persona 3 ya se había sumado (envío anterior). Si llegó otra más, tocá «Agregar persona» de nuevo.'});
    assert.ok(segunda.button('Agregar persona'));
  } finally { await segunda.close(); }
});

test('Integrantes: con el caso alojado o cerrado se olvida el «Agregar persona» pendiente', async () => {
  let estado = 'INGRESO_EN_CURSO';
  const env = await entorno((call) => (call.method === 'POST' ? fallaDeRed() : response(200, {...INTEGRANTES, caso: {...CASO, estado}})));
  const Screen = loadScreen('src/screens/EmergenciaIntegrantesScreen.js', env.mocks);
  const props = {caso: CASO, onConflicto: () => {}, onNoEncontrado: () => {}, onSinModulo: () => {}, onProximamente: () => {}, onEnviando: () => {}};
  const primera = await render(Screen, props);
  await primera.pressButton('Agregar persona');
  await env.aceptarAlerta('Agregar');
  await primera.close();
  const sesion = await env.llegadas.abrirSesion();
  assert.ok(await env.llegadas.agregarPendiente(sesion, 184));
  estado = 'ALOJADO';
  const segunda = await render(Screen, props);
  try {
    await renderer.act(async () => { await esperar(20); });
    assert.equal(await env.llegadas.agregarPendiente(sesion, 184), null);
  } finally { await segunda.close(); }
});
