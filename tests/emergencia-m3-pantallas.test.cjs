// Pantallas de M3 · Recepción de kits: mis dispositivos, entregas por recibir y la recepción. La
// lógica (services/emergenciaKits) y la API (services/emergenciaApi) son las reales, sobre el fetch
// falso del runtime: lo que se prueba acá llega hasta el multipart.
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

function loadScreen(relative, mocks) {
  const filename = path.join(root, relative);
  const {code} = transformSync(fs.readFileSync(filename, 'utf8'), {
    filename, babelrc: false, configFile: false,
    plugins: ['@babel/plugin-transform-react-jsx', '@babel/plugin-transform-modules-commonjs']});
  const module = {exports: {}};
  const context = vm.createContext({console, setTimeout, clearTimeout, Date, setInterval: () => 0, clearInterval: () => {}});
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
    assert.ok(nodo, 'Missing pressable ' + label);
    await renderer.act(async () => { await nodo.props.onPress(); await esperar(5); });
  };
  const button = title => tree.root.findAllByType('CustomButton').find(node => node.props.title === title);
  const pressButton = async (title) => {
    const found = button(title);
    assert.ok(found, 'Missing CustomButton ' + title + ' — hay: ' + tree.root.findAllByType('CustomButton').map(b => b.props.title));
    await renderer.act(async () => { await found.props.onPress(); await esperar(5); });
  };
  const input = label => tree.root.findAllByType('TextInput').find(node => node.props.accessibilityLabel === label);
  const escribir = async (label, valor) => {
    const found = input(label);
    assert.ok(found, 'Missing input ' + label);
    await renderer.act(async () => { found.props.onChangeText(valor); });
  };
  return {tree, labels, pressables, press, button, pressButton, input, escribir,
    close: async () => renderer.act(async () => tree.unmount())};
}

const ENTREGA = {id: 31, numero: '2026-K-000031', estado: 'EN_CAMINO', despachada_en: '2026-11-12T10:00:00-03:00',
  recibida_en: null, observacion_mesa: 'Entregar a la directora.', observacion_dispositivo: '',
  lineas: [{item: 12, nombre: 'Colchón', unidad: 'unidad', enviada: 10, recibida: null},
    {item: 14, nombre: 'Kit alimentario', unidad: 'kit', enviada: 3, recibida: null}]};
const PREPARADA = {id: 32, numero: '2026-K-000032', estado: 'PREPARADA', despachada_en: null, recibida_en: null,
  observacion_mesa: '', observacion_dispositivo: '', lineas: [{item: 12, nombre: 'Colchón', unidad: 'unidad', enviada: 4, recibida: null}]};

// Runtime con sesión y un router de fetch. `rutas(call)` contesta los pedidos de la API.
async function entorno(rutas) {
  const runtime = await setup();
  runtime.setFetch(async () => response(200, {token: 'tok', user_id: 7, username: 'guardia', modulos: ['emergencia']}));
  await runtime.api.loginBecas({username: 'guardia', password: 'x'});
  const calls = [];
  runtime.setFetch(async (url, init = {}) => {
    const call = {url: String(url).replace('https://example.test', ''), method: init.method || 'GET', init};
    calls.push(call);
    return rutas(call, calls);
  });
  const toasts = [];
  const alerts = [];
  const kits = runtime.load('./emergenciaKits');
  const mocks = {
    react: React, 'react-native': native, '@expo/vector-icons': {Ionicons: 'Ionicons'},
    '../context/ThemeContext': {useTheme: () => ({theme, typography})},
    '../context/ToastContext': {useToast: () => ({showToast: value => toasts.push(value), showAlert: (...args) => alerts.push(args)})},
    '../theme/statusBadges': loadPure('src/theme/statusBadges.js'),
    '../theme': loadPure('src/theme/tokens.js'),
    '../components/CustomButton': {__esModule: true, default: 'CustomButton'},
    '../components/FormInput': {__esModule: true, default: native.TextInput},
    '../utils/teclado': {keyboardDismissModeFor: () => 'on-drag'},
    '../utils/emergencia': runtime.load('../utils/emergencia'),
    '../utils/dates': runtime.dates,
    '../services/emergenciaApi': runtime.load('./emergenciaApi'),
    '../services/emergenciaKits': kits,
    '../services/sinModulo': runtime.load('./sinModulo'),
  };
  return {runtime, calls, toasts, alerts, kits, mocks};
}
const uuidDe = call => call.init.body.fields.find(([nombre]) => nombre === 'uuid_cliente')[1];
const camposDe = call => call.init.body.fields.map(([nombre, valor]) => [nombre, typeof valor === 'string' ? valor : {...valor}]);
// El texto de estado va sobre su propio fondo de statusTones (contraste en tema oscuro).
const fondoDe = (tree, texto) => {
  const nodo = tree.root.findAllByType('Text').find(n => text(n) === texto);
  assert.ok(nodo, 'Falta ' + texto);
  const estilos = [].concat(nodo.parent.props.style || []).flat();
  return estilos.find(e => e && e.backgroundColor)?.backgroundColor;
};
const posts = calls => calls.filter(c => c.method === 'POST' && c.url.endsWith('/recibir/'));

// ---- Mis dispositivos ----

async function montarDispositivos(rutas) {
  const env = await entorno(rutas);
  const elegidos = [];
  const sinModulo = [];
  const Screen = loadScreen('src/screens/EmergenciaMisDispositivosScreen.js', env.mocks);
  const ui = await render(Screen, {onElegir: (d, o) => elegidos.push([plano(d), plano(o)]), onSinModulo: m => sinModulo.push(m)});
  return {...env, ...ui, elegidos, sinModulo, Screen};
}

test('Mis dispositivos: lista solo los que reciben kits y elegir uno entra a sus entregas', async () => {
  const ui = await montarDispositivos(() => response(200, [
    {id: 7, nombre: 'Club Sarmiento', admite: true, recibe_kits: true, entregas_pendientes: 2},
    {id: 9, nombre: 'Escuela 12', admite: true, recibe_kits: false, entregas_pendientes: 0},
    {id: 11, nombre: 'Parroquia', admite: false, recibe_kits: true, entregas_pendientes: 1}]));
  try {
    assert.deepEqual(ui.calls.map(c => c.url), ['/api/emergencia/mis-dispositivos/']);
    const botones = ui.pressables().map(p => p.props.accessibilityLabel);
    assert.deepEqual(botones, ['Club Sarmiento, 2 entregas por recibir', 'Parroquia, 1 entrega por recibir']);
    assert.ok(!ui.labels().includes('Escuela 12'));
    assert.deepEqual(ui.elegidos, [], 'con más de uno no entra solo');
    await ui.press('Parroquia, 1 entrega por recibir');
    assert.deepEqual(ui.elegidos, [[{id: 11, nombre: 'Parroquia', entregas_pendientes: 1}, {unico: false}]]);
  } finally { await ui.close(); }
});

test('Mis dispositivos: con uno solo entra directo; sin ninguno lo dice', async () => {
  const uno = await montarDispositivos(() => response(200, [
    {id: 7, nombre: 'Club Sarmiento', admite: false, recibe_kits: true, entregas_pendientes: 0},
    {id: 9, nombre: 'Escuela 12', admite: true, recibe_kits: false, entregas_pendientes: 0}]));
  try {
    assert.deepEqual(uno.elegidos, [[{id: 7, nombre: 'Club Sarmiento', entregas_pendientes: 0}, {unico: true}]]);
  } finally { await uno.close(); }
  const ninguno = await montarDispositivos(() => response(200, [{id: 9, nombre: 'Escuela 12', admite: true, recibe_kits: false}]));
  try {
    assert.ok(ninguno.labels().includes('No recibís kits en ningún dispositivo. Pedí que te sumen al equipo de un dispositivo con un rol que reciba kits.'));
    assert.deepEqual(ninguno.elegidos, []);
  } finally { await ninguno.close(); }
});

test('Mis dispositivos: sin red avisa y deja reintentar; 403 SIN_MODULO avisa al módulo', async () => {
  let red = false;
  const ui = await montarDispositivos(() => (red ? response(200, [{id: 7, nombre: 'Club', recibe_kits: true, entregas_pendientes: 3},
    {id: 8, nombre: 'Otro', recibe_kits: true}]) : Promise.reject(new TypeError('Load failed'))));
  try {
    assert.ok(ui.labels().includes('Sin conexión: no se pudo traer tus dispositivos. La recepción de kits necesita señal.'));
    red = true;
    await ui.pressButton('Reintentar');
    assert.equal(ui.pressables().length, 2);
  } finally { await ui.close(); }
  const sin = await montarDispositivos((call) => (call.url.endsWith('/perfil/') ? response(200, {relevar: true, kits: false})
    : response(403, {detail: 'El usuario no recibe kits.', code: 'SIN_MODULO'})));
  try {
    assert.deepEqual(sin.sinModulo, ['El usuario no recibe kits.']);
  } finally { await sin.close(); }
});

// ---- Entregas ----

async function montarEntregas(rutas, {antes} = {}) {
  const env = await entorno(rutas);
  if (antes) await antes(env);
  const abiertas = [];
  const noEncontrado = [];
  const Screen = loadScreen('src/screens/EmergenciaEntregasScreen.js', env.mocks);
  const ui = await render(Screen, {dispositivo: {id: 7, nombre: 'Club Sarmiento'}, onAbrir: e => abiertas.push(plano(e)),
    onNoEncontrado: () => noEncontrado.push(true), onSinModulo: () => {}});
  return {...env, ...ui, abiertas, noEncontrado};
}

test('Entregas: pide las pendientes y muestra número, salida y resumen de ítems; abrir pasa la entrega', async () => {
  const ui = await montarEntregas(() => response(200, [ENTREGA, PREPARADA]));
  try {
    assert.deepEqual(ui.calls.map(c => c.url), ['/api/emergencia/dispositivos/7/entregas/?pendientes=1']);
    const labels = ui.labels();
    for (const esperado of ['Entrega 2026-K-000031', 'En camino', 'Despachada el 12/11/2026 10:00', '10 × Colchón · 3 × Kit alimentario',
      'Mesa: Entregar a la directora.', 'Entrega 2026-K-000032', 'Preparada', 'Sin marca de salida', '4 × Colchón']) {
      assert.ok(labels.includes(esperado), esperado);
    }
    assert.ok(!labels.includes('Recepción sin terminar'));
    await ui.press('Entrega 2026-K-000031, En camino. Despachada el 12/11/2026 10:00. 10 × Colchón · 3 × Kit alimentario');
    assert.equal(ui.abiertas[0].id, 31);
    assert.deepEqual(ui.abiertas[0].lineas.map(l => [l.item, l.enviada]), [[12, 10], [14, 3]]);
  } finally { await ui.close(); }
});

test('Entregas: marca la recepción sin terminar; vacía lo dice; 404 vuelve a mis dispositivos', async () => {
  const ui = await montarEntregas(() => response(200, [ENTREGA]), {
    antes: async ({kits}) => { await kits.abrirRecepcion(kits.normalizarEntrega(ENTREGA), 7); }});
  try {
    assert.ok(ui.labels().includes('Recepción sin terminar'));
  } finally { await ui.close(); }
  const vacia = await montarEntregas(() => response(200, []));
  try {
    assert.ok(vacia.labels().includes('No hay entregas por recibir en este dispositivo.'));
  } finally { await vacia.close(); }
  const ajena = await montarEntregas(() => response(404, {detail: 'No encontrado.'}));
  try {
    assert.deepEqual(ajena.noEncontrado, [true]);
  } finally { await ajena.close(); }
});

// ---- Recibir ----

const REMITO_SELECTOR = {uri: 'file:///cache/remito.heic', fileName: 'IMG_1.HEIC'};

async function montarRecibir(rutas, {online = true, entrega = ENTREGA, antes, jpeg} = {}) {
  const env = await entorno(rutas);
  env.runtime.setOnline(online);
  if (antes) await antes(env);
  const conversiones = [];
  const liberadas = [];
  const terminados = [];
  const sinModulo = [];
  const borrados = [];
  const olvidados = [];
  const enviando = [];
  Object.assign(env.mocks, {
    'expo-file-system/legacy': {deleteAsync: async (uri) => { borrados.push(uri); }},
    '../services/webAttachments': {forgetWebFile: (uri) => { olvidados.push(uri); return true; }},
    '../services/imagePicker': {
      requestCameraPermissionsAsync: async () => ({granted: true}),
      launchCameraAsync: async () => ({canceled: false, assets: [REMITO_SELECTOR]}),
      launchImageLibraryAsync: async () => ({canceled: false, assets: [REMITO_SELECTOR]}),
    },
    '../utils/jpeg': {
      aJpeg: jpeg || (async (asset) => { conversiones.push(asset); return {uri: `file:///cache/ImageManipulator/remito-${conversiones.length}.jpg`, fileName: `remito-${conversiones.length}.jpg`, mimeType: 'image/jpeg', fileSize: 4096}; }),
      liberarJpeg: (asset) => { if (asset) liberadas.push(asset.uri); return !!asset; },
    },
  });
  const Screen = loadScreen('src/screens/EmergenciaRecibirEntregaScreen.js', env.mocks);
  const normalizada = env.kits.normalizarEntrega(entrega);
  const ui = await render(Screen, {entrega: normalizada, dispositivoId: 7, onTerminar: (m, d) => terminados.push([m, plano(d)]),
    onSinModulo: m => sinModulo.push(m), onEnviando: v => enviando.push(v)});
  const sacarRemito = async () => {
    await ui.pressButton('Sacar foto del remito');
    const [titulo, , opciones] = env.alerts.at(-1);
    assert.equal(titulo, 'Foto del remito');
    await renderer.act(async () => { await opciones.find(o => o.text === 'Cámara').onPress(); await esperar(5); });
  };
  const aceptarAlerta = async (texto) => {
    const opcion = env.alerts.at(-1)[2].find(o => o.text === texto);
    assert.ok(opcion, 'Falta la opción ' + texto);
    await renderer.act(async () => { await opcion.onPress(); await esperar(5); });
  };
  return {...env, ...ui, conversiones, liberadas, terminados, sinModulo, borrados, olvidados, enviando, sacarRemito, aceptarAlerta, entrega: normalizada};
}
const ok = (estado = 'RECIBIDA', diferencias = []) => () => response(200, {estado, diferencias});

test('Recibir: precarga lo enviado, sin diferencias manda el multipart exacto de §12 y termina', async () => {
  const ui = await montarRecibir(ok());
  try {
    assert.equal(ui.input('Cantidad recibida de Colchón').props.value, '10');
    assert.equal(ui.input('Cantidad recibida de Kit alimentario').props.value, '3');
    assert.equal(ui.input('Cantidad recibida de Colchón').props.keyboardType, 'number-pad');
    assert.ok(ui.labels().includes('Enviado: 10 unidad'));
    assert.ok(ui.labels().includes('Coincide con lo enviado.'));
    assert.equal(fondoDe(ui.tree, 'Coincide con lo enviado.'), '#ECFDF5');
    await ui.sacarRemito();
    assert.deepEqual(ui.conversiones.map(a => a.uri), ['file:///cache/remito.heic'], 'la foto pasa por aJpeg');
    await ui.escribir('Observación', 'Llegó mojado un colchón');
    await ui.pressButton('Recibir');
    const [post] = posts(ui.calls);
    assert.ok(post, 'sin diferencias no pregunta');
    assert.equal(post.url, '/api/emergencia/entregas/31/recibir/');
    assert.match(uuidDe(post), /^[0-9a-f-]{36}$/);
    assert.deepEqual(camposDe(post), [['uuid_cliente', uuidDe(post)], ['cantidades[12]', '10'], ['cantidades[14]', '3'],
      ['observacion', 'Llegó mojado un colchón'], ['remito', {uri: 'file:///cache/ImageManipulator/remito-1.jpg', name: 'remito-1.jpg', type: 'image/jpeg'}]]);
    assert.deepEqual(ui.terminados, [['recibida', {estado: 'RECIBIDA', diferencias: [], distintas: []}]]);
    assert.equal(ui.toasts.at(-1).message, 'Entrega 2026-K-000031 recibida completa.');
    assert.deepEqual(ui.liberadas, ['file:///cache/ImageManipulator/remito-1.jpg'], 'el JPEG enviado se suelta');
    assert.deepEqual(ui.borrados, ['file:///cache/ImageManipulator/remito-1.jpg'], 'y en nativo se borra el temporal');
    assert.deepEqual(ui.enviando, [true, false], 'avisa al padre mientras manda');
  } finally { await ui.close(); }
});

test('Recibir: valida cada línea (vacía, negativa, decimal) y el remito antes de mandar nada', async () => {
  const ui = await montarRecibir(ok());
  try {
    await ui.escribir('Cantidad recibida de Colchón', '');
    await ui.escribir('Cantidad recibida de Kit alimentario', '-1');
    await ui.pressButton('Recibir');
    assert.equal(posts(ui.calls).length, 0);
    const labels = ui.labels();
    assert.ok(labels.includes('Falta la cantidad: poné 0 si no llegó nada.'));
    assert.ok(labels.includes('Tiene que ser un número entero, 0 o más.'));
    assert.ok(labels.includes('Falta la foto del remito.'));
    assert.equal(ui.input('Cantidad recibida de Colchón').props.style.find(s => s && s.borderColor).borderColor, '#D00000');
    await ui.escribir('Cantidad recibida de Kit alimentario', '2.5');
    assert.ok(ui.labels().includes('Tiene que ser un número entero, 0 o más.'));
    await ui.escribir('Cantidad recibida de Colchón', '10');
    await ui.escribir('Cantidad recibida de Kit alimentario', '3');
    assert.ok(!ui.labels().includes('Tiene que ser un número entero, 0 o más.'));
    assert.ok(ui.labels().includes('Falta la foto del remito.'));
  } finally { await ui.close(); }
});

test('Recibir: muestra la diferencia por línea y pide confirmar; «Revisar» no manda, «Recibir igual» sí (0 incluido)', async () => {
  const ui = await montarRecibir(ok('RECIBIDA_CON_DIFERENCIAS', [{item: 12, enviada: 10, recibida: 8}, {item: 14, enviada: 3, recibida: 0}]));
  try {
    await ui.escribir('Cantidad recibida de Colchón', '8');
    await ui.escribir('Cantidad recibida de Kit alimentario', '0');
    const labels = ui.labels();
    assert.ok(labels.includes('Faltan 2'));
    assert.ok(labels.includes('Faltan 3'));
    assert.equal(fondoDe(ui.tree, 'Faltan 2'), '#FFF8F1');
    assert.ok(labels.includes('Diferencias con lo enviado:\nColchón: llegaron 8 de 10 (faltan 2)\nKit alimentario: llegaron 0 de 3 (faltan 3)'));
    await ui.sacarRemito();
    await ui.pressButton('Recibir');
    const [titulo, mensaje, opciones] = ui.alerts.at(-1);
    assert.equal(titulo, 'Recibir con diferencias');
    assert.match(mensaje, /Colchón: llegaron 8 de 10 \(faltan 2\)/);
    assert.deepEqual(plano(opciones.map(o => o.text)), ['Revisar', 'Recibir igual']);
    assert.equal(posts(ui.calls).length, 0, 'no manda antes de confirmar');
    await ui.aceptarAlerta('Recibir igual');
    const [post] = posts(ui.calls);
    assert.deepEqual(camposDe(post).slice(1, 3), [['cantidades[12]', '8'], ['cantidades[14]', '0']]);
    assert.equal(ui.terminados[0][0], 'recibida');
    const [tituloFin, mensajeFin] = ui.alerts.at(-1);
    assert.equal(tituloFin, 'Recibida con diferencias');
    assert.match(mensajeFin, /Kit alimentario: llegaron 0 de 3 \(faltan 3\)/);
  } finally { await ui.close(); }
  const sobra = await montarRecibir(ok());
  try {
    await sobra.escribir('Cantidad recibida de Colchón', '12');
    assert.ok(sobra.labels().includes('Sobran 2'), 'llegar de más también es diferencia');
  } finally { await sobra.close(); }
});

test('Recibir sin red: se bloquea con aviso claro y no manda nada', async () => {
  const ui = await montarRecibir(ok(), {online: false});
  try {
    const aviso = 'Sin conexión: la recepción necesita señal y no se guarda para enviar después. Probá cuando vuelva la red; lo cargado queda en esta pantalla.';
    assert.ok(ui.labels().includes(aviso), 'el aviso se ve al abrir');
    await ui.sacarRemito();
    await ui.escribir('Cantidad recibida de Colchón', '9');
    await ui.pressButton('Recibir');
    assert.equal(posts(ui.calls).length, 0);
    // Sin red se avisa antes de pedir confirmar diferencias: no se confirma algo que no puede salir.
    assert.deepEqual(ui.alerts.at(-1).slice(0, 2), ['Sin conexión', aviso]);
    assert.ok(!ui.alerts.some(([titulo]) => titulo === 'Recibir con diferencias'));
    assert.deepEqual(ui.terminados, []);
    ui.runtime.setOnline(true);
    await ui.pressButton('Recibir');
    await ui.aceptarAlerta('Recibir igual');
    assert.equal(posts(ui.calls).length, 1, 'con red vuelve a andar');
  } finally { await ui.close(); }
});

test('Recibir: tras un error de red queda fija y «Reintentar» manda el MISMO uuid', async () => {
  let intento = 0;
  const ui = await montarRecibir(() => { intento += 1; return intento === 1 ? Promise.reject(new TypeError('Load failed')) : ok()(); });
  try {
    await ui.escribir('Cantidad recibida de Colchón', '9');
    await ui.sacarRemito();
    await ui.pressButton('Recibir');
    await ui.aceptarAlerta('Recibir igual');
    assert.deepEqual(ui.terminados, []);
    assert.ok(ui.labels().includes('No se pudo confirmar si la recepción llegó. Tocá «Reintentar»: se manda la misma recepción y no se duplica.'));
    assert.equal(ui.input('Cantidad recibida de Colchón').props.editable, false, 'las cantidades quedan fijas');
    assert.equal(ui.input('Observación').props.editable, false);
    await ui.escribir('Cantidad recibida de Colchón', '1');
    assert.equal(ui.input('Cantidad recibida de Colchón').props.value, '9');
    await ui.pressButton('Reintentar');
    const [primero, segundo] = posts(ui.calls);
    assert.equal(uuidDe(segundo), uuidDe(primero));
    assert.deepEqual(camposDe(segundo).slice(1, 3), [['cantidades[12]', '9'], ['cantidades[14]', '3']]);
    assert.equal(ui.terminados[0][0], 'recibida');
  } finally { await ui.close(); }
});

test('Recibir: 429 con Retry-After deshabilita «Reintentar» con la cuenta regresiva', async () => {
  const ui = await montarRecibir(() => response(429, {detail: 'Despacio'}, {'Retry-After': '30'}));
  try {
    await ui.sacarRemito();
    await ui.pressButton('Recibir');
    const boton = ui.button('Reintentar en 30 s');
    assert.ok(boton, 'botones: ' + ui.tree.root.findAllByType('CustomButton').map(b => b.props.title));
    assert.equal(boton.props.disabled, true);
    assert.ok(ui.labels().includes('El servidor pidió esperar antes de volver a intentar.'));
  } finally { await ui.close(); }
});

test('Recibir: 409 con estado_actual muestra el detail y vuelve a las entregas', async () => {
  const detail = 'Entrega 2026-K-000031 cancelada por la mesa a las 15:02. Ya no se puede recibir.';
  const ui = await montarRecibir(() => response(409, {detail, estado_actual: 'CANCELADA'}));
  try {
    await ui.sacarRemito();
    await ui.pressButton('Recibir');
    assert.deepEqual(ui.alerts.at(-1).slice(0, 2), ['La entrega ya no se puede recibir', detail]);
    assert.equal(ui.terminados[0][0], 'conflicto');
    assert.equal(ui.terminados[0][1].estadoActual, 'CANCELADA');
  } finally { await ui.close(); }
});

test('Recibir: 409 UUID_EN_USO solo deja seguir descartando el intento, con un uuid nuevo', async () => {
  let intento = 0;
  const ui = await montarRecibir(() => { intento += 1; return intento === 1
    ? response(409, {detail: 'Ese identificador de envío ya se usó en otra recepción.', code: 'UUID_EN_USO'}) : ok()(); });
  try {
    await ui.sacarRemito();
    await ui.pressButton('Recibir');
    assert.ok(ui.labels().some(l => l.startsWith('Este intento de recepción no se puede mandar')));
    assert.equal(ui.button('Recibir'), undefined);
    assert.equal(ui.button('Reintentar'), undefined, 'no se reintenta con ese uuid');
    await ui.pressButton('Descartar este intento');
    assert.equal(ui.alerts.at(-1)[0], 'Descartar este intento');
    await ui.aceptarAlerta('Descartar intento');
    assert.equal(ui.input('Cantidad recibida de Colchón').props.editable, true);
    await ui.pressButton('Recibir');
    const [primero, segundo] = posts(ui.calls);
    assert.notEqual(uuidDe(segundo), uuidDe(primero));
    assert.equal(ui.terminados[0][0], 'recibida');
  } finally { await ui.close(); }
});

test('Recibir: 400 VALIDACION marca la línea y el remito; se corrige y sale con el MISMO uuid', async () => {
  let intento = 0;
  const ui = await montarRecibir(() => { intento += 1; return intento === 1
    ? response(400, {'cantidades[14]': ['Falta la cantidad de Kit alimentario.'], remito: ['No es JPEG.'], detail: 'x', non_field_errors: ['x'], code: 'VALIDACION'})
    : ok()(); });
  try {
    await ui.sacarRemito();
    await ui.pressButton('Recibir');
    const labels = ui.labels();
    assert.ok(labels.includes('Falta la cantidad de Kit alimentario.'));
    assert.ok(labels.includes('No es JPEG.'));
    assert.ok(labels.includes('El servidor rechazó algunos datos. Corregí lo marcado y volvé a tocar «Recibir».'));
    assert.equal(ui.input('Cantidad recibida de Kit alimentario').props.editable, true, '400: no se escribió nada, se puede corregir');
    await ui.escribir('Cantidad recibida de Kit alimentario', '3');
    assert.ok(!ui.labels().includes('Falta la cantidad de Kit alimentario.'));
    await ui.pressButton('Cambiar');
    await ui.aceptarAlerta('Cámara');
    assert.ok(!ui.labels().includes('No es JPEG.'));
    assert.deepEqual(ui.liberadas, ['file:///cache/ImageManipulator/remito-1.jpg'], 'la foto reemplazada se suelta');
    await ui.pressButton('Recibir');
    const [primero, segundo] = posts(ui.calls);
    assert.equal(uuidDe(segundo), uuidDe(primero));
  } finally { await ui.close(); }
});

test('Recibir: 413 pide otra foto del remito', async () => {
  const ui = await montarRecibir(() => response(413, {detail: 'Request Entity Too Large'}));
  try {
    await ui.sacarRemito();
    await ui.pressButton('Recibir');
    assert.ok(ui.labels().includes('La foto del remito es demasiado pesada para enviarla: sacala de nuevo o elegí otra.'));
    assert.equal(ui.button('Recibir').props.disabled, false);
  } finally { await ui.close(); }
});

test('Recibir: 404 vuelve a mis dispositivos; 403 SIN_MODULO avisa al módulo', async () => {
  const ui = await montarRecibir(() => response(404, {detail: 'No encontrado.'}));
  try {
    await ui.sacarRemito();
    await ui.pressButton('Recibir');
    assert.equal(ui.terminados[0][0], 'no_encontrada');
    assert.equal(ui.alerts.at(-1)[0], 'Entrega no disponible');
  } finally { await ui.close(); }
  const sin = await montarRecibir((call) => (call.url.endsWith('/perfil/') ? response(200, {relevar: true, kits: false})
    : response(403, {detail: 'El usuario no recibe kits en ningún dispositivo.', code: 'SIN_MODULO'})));
  try {
    await sin.sacarRemito();
    await sin.pressButton('Recibir');
    assert.deepEqual(sin.sinModulo, ['El usuario no recibe kits en ningún dispositivo.']);
    assert.deepEqual(sin.terminados, []);
  } finally { await sin.close(); }
});

test('Recibir: al volver a abrir recupera el uuid y lo tipeado (no la foto); al cerrar suelta el JPEG', async () => {
  let uuidPrevio = null;
  const ui = await montarRecibir(ok(), {antes: async ({kits}) => {
    const r = await kits.abrirRecepcion(kits.normalizarEntrega(ENTREGA), 7);
    uuidPrevio = r.uuid_cliente;
    await kits.guardarRecepcion(r.owner, 31, {cantidades: {12: '7', 14: '3'}, observacion: 'Faltó uno'});
  }});
  try {
    assert.equal(ui.input('Cantidad recibida de Colchón').props.value, '7');
    assert.equal(ui.input('Observación').props.value, 'Faltó uno');
    assert.equal(ui.toasts.at(-1).message, 'Recuperamos la recepción que habías empezado. Volvé a sacar la foto del remito.');
    assert.ok(ui.button('Sacar foto del remito'));
    await ui.sacarRemito();
  } finally { await ui.close(); }
  assert.deepEqual(ui.liberadas, ['file:///cache/ImageManipulator/remito-1.jpg']);
  const otra = await montarRecibir(ok(), {antes: async ({kits}) => {
    const r = await kits.abrirRecepcion(kits.normalizarEntrega(ENTREGA), 7);
    uuidPrevio = r.uuid_cliente;
  }});
  try {
    await otra.sacarRemito();
    await otra.pressButton('Recibir');
    assert.equal(uuidDe(posts(otra.calls)[0]), uuidPrevio, 'el uuid de la recepción abierta antes');
  } finally { await otra.close(); }
});

test('Recibir: un segundo toque mientras se manda no hace nada', async () => {
  let soltar;
  const ui = await montarRecibir(() => new Promise((resolve) => { soltar = () => resolve(ok()()); }));
  try {
    await ui.sacarRemito();
    const boton = ui.button('Recibir');
    await renderer.act(async () => { boton.props.onPress(); boton.props.onPress(); await esperar(5); });
    assert.equal(posts(ui.calls).length, 1);
    await renderer.act(async () => { soltar(); await esperar(5); });
    assert.equal(ui.terminados.length, 1);
  } finally { await ui.close(); }
});

// ---- Revisión: intento incierto, volver durante el envío, fotos ----

const fallaDeRed = () => Promise.reject(new TypeError('Load failed'));

test('Recibir incierto: nada se cambia (ni la foto), no hay «Descartar» ni ante un rechazo, y 413 no lo destraba', async () => {
  const respuestas = [fallaDeRed, () => response(418, {detail: 'Tetera.'}), () => response(413, {detail: 'Too large'}), ok()];
  const ui = await montarRecibir((call, todas) => respuestas[posts(todas).length - 1]());
  try {
    await ui.sacarRemito();
    await ui.pressButton('Recibir');
    assert.ok(ui.labels().some(l => l.startsWith('Ya mandaste esta recepción y no se pudo confirmar si llegó. Nada se puede cambiar: «Reintentar» manda la misma (no hace falta volver a sacar la foto) y no se duplica.')));
    assert.equal(ui.button('Cambiar').props.disabled, true, 'la foto tampoco se cambia');
    assert.equal(ui.pressables().find(p => p.props.accessibilityLabel === 'Quitar foto del remito').props.disabled, true);
    await ui.pressButton('Reintentar');
    assert.ok(ui.labels().includes('Tetera.'));
    assert.equal(ui.button('Descartar este intento'), undefined, 'tras un rechazo con intento incierto no se descarta');
    await ui.pressButton('Reintentar');
    assert.ok(ui.labels().includes('La foto del remito es demasiado pesada para enviarla: sacala de nuevo o elegí otra.'));
    assert.equal(ui.input('Cantidad recibida de Colchón').props.editable, false, '413 no prueba nada del primer pedido');
    assert.ok(ui.button('Reintentar'));
    await ui.pressButton('Reintentar');
    const enviados = posts(ui.calls);
    assert.equal(new Set(enviados.map(uuidDe)).size, 1);
    assert.equal(ui.terminados[0][0], 'recibida');
  } finally { await ui.close(); }
});

test('Recibir incierto recuperado: el reintento sale sin foto (§12 no la pide con el mismo uuid)', async () => {
  let uuid = null;
  const ui = await montarRecibir(ok(), {antes: async ({kits, runtime}) => {
    const entrega = kits.normalizarEntrega(ENTREGA);
    const r = await kits.abrirRecepcion(entrega, 7);
    uuid = r.uuid_cliente;
    const previo = runtime.load('./emergenciaKits');
    runtime.setFetch(fallaDeRed);
    await previo.enviarRecepcion({entrega, recepcion: r, cantidades: {12: '9', 14: '3'}, remito: {uri: 'file:///r.jpg', fileName: 'r.jpg'}}).catch(() => {});
    runtime.setFetch(async (url, init = {}) => {
      // La verificación automática (§11) no consigue respuesta: sigue incierta.
      if ((init.method || 'GET') === 'GET') return fallaDeRed();
      return response(200, {estado: 'RECIBIDA_CON_DIFERENCIAS', diferencias: [{item: 12, enviada: 10, recibida: 9}]});
    });
  }});
  try {
    assert.equal(ui.button('Reintentar').props.disabled, false);
    assert.equal(ui.input('Cantidad recibida de Colchón').props.value, '9');
    assert.ok(!ui.toasts.some(t => t.message.startsWith('Recuperamos')), 'no pide sacar la foto otra vez');
    await ui.pressButton('Reintentar');
    assert.ok(!ui.labels().includes('Falta la foto del remito.'));
    assert.equal(ui.terminados[0][0], 'recibida');
    assert.ok(uuid);
  } finally { await ui.close(); }
});

test('Recibir: 409 RECIBIDA después de un intento incierto consulta la entrega y dice qué quedó registrado', async () => {
  const respuestas = [fallaDeRed, () => response(409, {detail: 'Entrega 2026-K-000031 ya la recibió Ana a las 15:02.', estado_actual: 'RECIBIDA_CON_DIFERENCIAS'})];
  const ui = await montarRecibir((call, todas) => {
    if (call.method === 'GET') return response(200, {...ENTREGA, estado: 'RECIBIDA_CON_DIFERENCIAS',
      lineas: ENTREGA.lineas.map(l => ({...l, recibida: l.item === 12 ? 9 : 3}))});
    return respuestas[posts(todas).length - 1]();
  });
  try {
    await ui.escribir('Cantidad recibida de Colchón', '9');
    await ui.sacarRemito();
    await ui.pressButton('Recibir');
    await ui.aceptarAlerta('Recibir igual');
    await ui.pressButton('Reintentar');
    assert.ok(ui.calls.some(c => c.method === 'GET' && c.url === '/api/emergencia/entregas/31/'), 'consulta §11');
    const [titulo, mensaje] = ui.alerts.at(-1);
    assert.equal(titulo, 'La recepción ya figura registrada');
    assert.match(mensaje, /Colchón: 9 de 10\nKit alimentario: 3 de 3/);
    assert.equal(ui.terminados[0][0], 'conflicto');
  } finally { await ui.close(); }
});

test('Recibir: si el 200 trae otras cantidades que las mandadas, lo dice', async () => {
  const ui = await montarRecibir(() => response(200, {estado: 'RECIBIDA', diferencias: []}));
  try {
    await ui.escribir('Cantidad recibida de Colchón', '8');
    await ui.sacarRemito();
    await ui.pressButton('Recibir');
    await ui.aceptarAlerta('Recibir igual');
    const [titulo, mensaje] = ui.alerts.at(-1);
    assert.equal(titulo, 'Quedó registrada con otras cantidades');
    assert.match(mensaje, /Colchón: mandaste 8, quedó 10/);
  } finally { await ui.close(); }
});

test('Recibir: quitar la foto limpia el error del servidor sobre el remito; los mensajes repetidos no chocan', async () => {
  const ui = await montarRecibir(() => response(400, {remito: ['No es JPEG.', 'No es JPEG.'], 'cantidades[12]': ['Mal.', 'Mal.'], code: 'VALIDACION'}));
  const avisosReact = [];
  const original = console.error;
  console.error = (...args) => { avisosReact.push(args.map(String).join(' ')); };
  try {
    await ui.sacarRemito();
    await ui.pressButton('Recibir');
    assert.equal(ui.labels().filter(l => l === 'No es JPEG.').length, 2);
    assert.equal(ui.labels().filter(l => l === 'Mal.').length, 2);
    assert.ok(!avisosReact.some(a => /same key/.test(a)), avisosReact.join('\n'));
    await ui.press('Quitar foto del remito');
    assert.ok(!ui.labels().includes('No es JPEG.'));
  } finally { console.error = original; await ui.close(); }
});

test('Recibir web: el File del selector se suelta siempre, también si ya era un JPEG que entra', async () => {
  plataforma.OS = 'web';
  try {
    const ui = await montarRecibir(ok(), {jpeg: async (asset) => ({...asset, file: {size: 10}, mimeType: 'image/jpeg', fileSize: 10})});
    try {
      await ui.sacarRemito();
      assert.deepEqual(ui.olvidados, ['file:///cache/remito.heic']);
      await ui.pressButton('Recibir');
      assert.deepEqual(ui.borrados, [], 'en web no hay temporales de ImageManipulator');
    } finally { await ui.close(); }
  } finally { plataforma.OS = 'android'; }
});

test('Entregas: una recepción incierta cuya entrega ya no está pendiente se consulta y se avisa, no se borra en silencio', async () => {
  const ui = await montarEntregas((call) => {
    if (call.url === '/api/emergencia/entregas/31/') {
      return response(200, {...ENTREGA, estado: 'RECIBIDA', lineas: ENTREGA.lineas.map(l => ({...l, recibida: l.enviada}))});
    }
    if (call.url.endsWith('/recibir/')) return Promise.reject(new TypeError('Load failed'));
    return response(200, [PREPARADA]);
  }, {antes: async ({kits}) => {
    const entrega = kits.normalizarEntrega(ENTREGA);
    const r = await kits.abrirRecepcion(entrega, 7);
    await kits.enviarRecepcion({entrega, recepcion: r, cantidades: {12: '10', 14: '3'}, remito: {uri: 'file:///r.jpg'}}).catch(() => {});
  }});
  try {
    const aviso = ui.labels().find(l => l.startsWith('Entrega 2026-K-000031: La recepción de esta entrega ya figura registrada.'));
    assert.ok(aviso, ui.labels().join(' | '));
    assert.match(aviso, /Colchón: 10 de 10/);
  } finally { await ui.close(); }
});

test('Mis dispositivos: con `entrarDirecto={false}` (vuelta por 404) no entra solo aunque haya uno', async () => {
  const env = await entorno(() => response(200, [{id: 7, nombre: 'Club', recibe_kits: true, entregas_pendientes: 1}]));
  const elegidos = [];
  const Screen = loadScreen('src/screens/EmergenciaMisDispositivosScreen.js', env.mocks);
  const ui = await render(Screen, {onElegir: (d) => elegidos.push(d), onSinModulo: () => {}, entrarDirecto: false});
  try {
    assert.deepEqual(elegidos, []);
    assert.equal(ui.pressables().length, 1);
  } finally { await ui.close(); }
});

// ---- Segunda revisión: «Verificar si llegó» ----

test('Recibir: un rechazo fijo (405) deja la recepción incierta; «Verificar si llegó» con la entrega pendiente la destraba con el MISMO uuid', async () => {
  const respuestas = [fallaDeRed, () => response(405, {detail: 'Método no permitido.'}), ok()];
  const ui = await montarRecibir((call, todas) => (call.method === 'GET'
    ? response(200, ENTREGA) : respuestas[posts(todas).length - 1]()));
  try {
    await ui.sacarRemito();
    await ui.pressButton('Recibir');
    await ui.pressButton('Reintentar');
    assert.ok(ui.labels().includes('Método no permitido.'));
    assert.equal(ui.input('Cantidad recibida de Colchón').props.editable, false);
    await ui.pressButton('Verificar si llegó');
    assert.ok(ui.calls.some(c => c.method === 'GET' && c.url === '/api/emergencia/entregas/31/'));
    assert.equal(ui.input('Cantidad recibida de Colchón').props.editable, true, 'destrabada: se puede corregir');
    assert.equal(ui.button('Verificar si llegó'), undefined);
    assert.ok(ui.button('Recibir'));
    await ui.escribir('Cantidad recibida de Colchón', '10');
    await ui.pressButton('Recibir');
    const enviados = posts(ui.calls);
    assert.equal(enviados.length, 3);
    assert.equal(new Set(enviados.map(uuidDe)).size, 1, 'mismo uuid');
    assert.ok(camposDe(enviados[2]).some(([n]) => n === 'remito'), 'destrabada, vuelve a mandar la foto');
    assert.ok(!camposDe(enviados[1]).some(([n]) => n === 'remito'), 'el reenvío incierto va sin foto');
    assert.equal(ui.terminados[0][0], 'recibida');
  } finally { await ui.close(); }
});

test('Recibir: «Verificar si llegó» con la entrega ya recibida muestra lo registrado y vuelve a las entregas', async () => {
  const ui = await montarRecibir((call) => (call.method === 'GET'
    ? response(200, {...ENTREGA, estado: 'RECIBIDA', lineas: ENTREGA.lineas.map(l => ({...l, recibida: l.enviada}))})
    : Promise.reject(new TypeError('Load failed'))));
  try {
    await ui.sacarRemito();
    await ui.pressButton('Recibir');
    await ui.pressButton('Verificar si llegó');
    const [titulo, mensaje] = ui.alerts.at(-1);
    assert.equal(titulo, 'La recepción ya figura registrada');
    assert.match(mensaje, /Colchón: 10 de 10/);
    assert.equal(ui.terminados[0][0], 'conflicto');
  } finally { await ui.close(); }
});

test('Recibir: «Verificar si llegó» sin respuesta deja todo como estaba y lo dice', async () => {
  const ui = await montarRecibir(() => Promise.reject(new TypeError('Load failed')));
  try {
    await ui.sacarRemito();
    await ui.pressButton('Recibir');
    await ui.pressButton('Verificar si llegó');
    assert.equal(ui.toasts.at(-1).type, 'warning');
    assert.equal(ui.input('Cantidad recibida de Colchón').props.editable, false);
    assert.deepEqual(ui.terminados, []);
  } finally { await ui.close(); }
});

test('Recibir: una incierta recuperada se verifica sola al abrir; con la entrega pendiente queda editable', async () => {
  const ui = await montarRecibir((call) => (call.method === 'GET' ? response(200, ENTREGA) : ok()()), {antes: async ({kits, runtime, calls}) => {
    const entrega = kits.normalizarEntrega(ENTREGA);
    const r = await kits.abrirRecepcion(entrega, 7);
    runtime.setFetch(async () => { throw new TypeError('Load failed'); });
    await kits.enviarRecepcion({entrega, recepcion: r, cantidades: {12: '9', 14: '3'}, remito: {uri: 'file:///r.jpg'}}).catch(() => {});
    assert.equal((await kits.abrirRecepcion(entrega, 7)).incierto, true);
    runtime.setFetch(async (url, init = {}) => {
      const call = {url: String(url).replace('https://example.test', ''), method: init.method || 'GET', init};
      calls.push(call);
      return call.method === 'GET' ? response(200, ENTREGA) : ok()();
    });
  }});
  try {
    await renderer.act(async () => { await esperar(10); });
    assert.equal(ui.input('Cantidad recibida de Colchón').props.editable, true);
    assert.equal(ui.input('Cantidad recibida de Colchón').props.value, '9');
    assert.ok(ui.calls.some(c => c.method === 'GET'));
  } finally { await ui.close(); }
});
