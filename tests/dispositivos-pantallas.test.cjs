// Pantallas del módulo Dispositivos (lista, detalle y completar) con el servicio mockeado.
// Los componentes de ../components/formulario/ se cargan de verdad, como en pantallas-contrato.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const React = require('react');
const renderer = require('react-test-renderer');
const {transformSync} = require('@babel/core');
const {setup} = require('./helpers/mobile-runtime.cjs');
global.IS_REACT_ACT_ENVIRONMENT = true;

const root = path.join(__dirname, '..');
const native = Object.fromEntries(['View', 'Text', 'ScrollView', 'TouchableOpacity', 'ActivityIndicator', 'Image', 'Pressable',
  'Modal', 'TextInput', 'KeyboardAvoidingView', 'FlatList', 'RefreshControl'].map(name => [name, name]));
Object.assign(native, {Platform: {OS: 'web'}, StyleSheet: {create: value => value, absoluteFillObject: {}}, Linking: {openURL: async () => {}}});
const theme = {colors: new Proxy({}, {get: () => '#5059BC'})};
const typography = {bold: 'Manrope', medium: 'Manrope', semibold: 'Manrope', regular: 'Manrope'};
const text = node => node.children.map(value => typeof value === 'string' ? value : typeof value === 'number' ? String(value) : text(value)).join('');

function loadPure(relative) {
  const {code} = transformSync(fs.readFileSync(path.join(root, relative), 'utf8'), {
    babelrc: false, configFile: false, plugins: ['@babel/plugin-transform-modules-commonjs']});
  const module = {exports: {}};
  vm.runInNewContext('(function(module,exports){' + code + '\n})', {})(module, module.exports);
  return module.exports;
}

function loadScreen(relative, mocks) {
  const filename = path.join(root, relative);
  const context = vm.createContext({console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, Date});
  const screensDir = path.dirname(filename);
  const resolve = (dir, name) => {
    const key = name.startsWith('.') ? path.relative(screensDir, path.join(dir, name)).split(path.sep).join('/') : name;
    if (key.startsWith('../components/formulario/')) return load(path.join(screensDir, key + '.js'));
    assert.ok(mocks[key], 'Missing screen mock: ' + key); return mocks[key];
  };
  const load = (file) => {
    const {code} = transformSync(fs.readFileSync(file, 'utf8'), {
      filename: file, babelrc: false, configFile: false,
      plugins: ['@babel/plugin-transform-react-jsx', '@babel/plugin-transform-modules-commonjs']});
    const module = {exports: {}};
    vm.runInContext('(function(require,module,exports){' + code + '\n})', context)(
      name => resolve(path.dirname(file), name), module, module.exports);
    return module.exports;
  };
  return load(filename).default;
}

async function render(Screen, props) {
  let tree;
  await renderer.act(async () => {tree = renderer.create(React.createElement(Screen, props));});
  const labels = () => tree.root.findAllByType('Text').map(text);
  const press = async (label, type = 'Pressable') => {
    const button = tree.root.findAllByType(type).find(node => node.findAllByType('Text').some(child => text(child) === label));
    assert.ok(button, 'Missing button ' + label);
    await renderer.act(async () => {await button.props.onPress();});
  };
  const button = title => tree.root.findAllByType('CustomButton').find(node => node.props.title === title);
  const pressButton = async title => {
    const found = button(title);
    assert.ok(found, 'Missing CustomButton ' + title);
    await renderer.act(async () => {await found.props.onPress();});
  };
  return {tree, labels, press, button, pressButton, close: async () => renderer.act(async () => tree.unmount())};
}

async function baseMocks() {
  const runtime = await setup();
  const toasts = [];
  return {runtime, toasts, mocks: {
    react: React, 'react-native': native, '@expo/vector-icons': {Ionicons: 'Ionicons'},
    '../context/ThemeContext': {useTheme: () => ({theme, typography})},
    '../context/ToastContext': {useToast: () => ({showToast: value => toasts.push(value), showAlert: (...args) => toasts.push(args)})},
    '../context/AuthContext': {useAuth: () => ({user: {id: 7}})},
    '../theme/statusBadges': loadPure('src/theme/statusBadges.js'),
    '../utils/dispositivos': loadPure('src/utils/dispositivos.js'),
    '../utils/dates': runtime.dates,
    '../theme': loadPure('src/theme/tokens.js'),
    '../components/CustomButton': {__esModule: true, default: 'CustomButton'},
  }};
}

const edificio = (nombre, extra = {}) => ({id: 1, codigo: 'ED-' + nombre, nombre, calle: 'Calle', numero: '123', localidad: 'Resistencia', provincia: 'Chaco', ...extra});
const inspeccion = (id, nombre, extra = {}) => ({id, edificio: edificio(nombre), estado: 'ASIGNADA', fecha_vencimiento: '2026-12-01', vencida: false, envio: null, ...extra});

const FORMULARIO = {version: 10, definicion: {version: 10, items: [{tipo: 'grupo', clave: 'g1', titulo: 'Estado del edificio', canal: 'ambos', items: [
  {tipo_item: 'campo', clave: 'cp-techo', texto: 'Estado del techo', tipo: 'SELECTOR', opciones: ['Bueno', 'Malo'], obligatorio: true},
  {tipo_item: 'campo', clave: 'cp-banios', texto: 'Cantidad de baños', tipo: 'INT', opciones: [], obligatorio: true},
  {tipo_item: 'campo', clave: 'cp-dano', texto: 'Detalle del daño', tipo: 'STRING', opciones: [], obligatorio: true,
    condicion: {modo: 'todas', reglas: [{fuente: 'cp-techo', op: 'es', valor: 'Malo'}]}},
]}]}};

// ---- Lista ----

async function mountLista(items) {
  const {mocks} = await baseMocks();
  Object.assign(mocks, {
    '@react-native-community/netinfo': {__esModule: true, default: {fetch: async () => ({isConnected: true, isInternetReachable: true})}},
    '../services/dispositivosService': {getInspecciones: async () => items},
  });
  const Screen = loadScreen('src/screens/DispositivosListaScreen.js', mocks);
  return render(Screen, {onAbrir() {}});
}

test('Lista: separa pendientes (por vencimiento), vencidos y enviados / en cola', async () => {
  const ui = await mountLista([
    inspeccion(1, 'Escuela A', {fecha_vencimiento: '2026-12-01'}),
    inspeccion(2, 'Escuela B', {fecha_vencimiento: '2026-11-01'}),
    inspeccion(3, 'Escuela C', {vencida: true, fecha_vencimiento: '2026-01-01'}),
    inspeccion(4, 'Escuela D', {envio: {op_id: 'x', estado: 'enviado'}}),
    inspeccion(5, 'Escuela E', {envio: {op_id: 'y', estado: 'error', permanente: true, code: 'REASIGNADA'}}),
    inspeccion(6, 'Escuela F', {vencida: true, envio: {op_id: 'z', estado: 'en_cola'}}),
  ]);
  try {
    const labels = ui.labels();
    const at = value => labels.indexOf(value);
    assert.ok(at('Pendientes') >= 0 && at('Vencidos') > at('Pendientes') && at('Enviados / en cola') > at('Vencidos'));
    // Pendientes por vencimiento ascendente: B (nov) antes que A (dic).
    assert.ok(at('Escuela B') > at('Pendientes') && at('Escuela B') < at('Escuela A') && at('Escuela A') < at('Vencidos'));
    assert.ok(at('Escuela C') > at('Vencidos') && at('Escuela C') < at('Enviados / en cola'));
    for (const nombre of ['Escuela D', 'Escuela E', 'Escuela F']) assert.ok(at(nombre) > at('Enviados / en cola'), nombre);
    assert.ok(labels.includes('Enviado') && labels.includes('Enviando') && labels.includes('Con error'));
    assert.ok(labels.includes('Este relevamiento se reasignó a otra persona; lo cargado queda en el teléfono.'));
  } finally {await ui.close();}
});

// ---- Detalle ----

async function mountDetalle(detalle, extra = {}) {
  const {mocks} = await baseMocks();
  const calls = {reintentos: 0};
  Object.assign(mocks, {
    '../services/dispositivosService': {
      getInspeccion: async () => detalle,
      reintentarFallidas: async () => { calls.reintentos += 1; return {synced: 0, failed: 0}; },
    },
    ...extra,
  });
  const Screen = loadScreen('src/screens/DispositivoDetalleScreen.js', mocks);
  const ui = await render(Screen, {inspeccionId: detalle.id, onCompletar() {}});
  return {...ui, calls};
}

test('Detalle: un 409 REASIGNADA muestra el texto claro, sin reintentar', async () => {
  const ui = await mountDetalle(inspeccion(1, 'Escuela A', {
    envio: {op_id: 'x', estado: 'error', permanente: true, descartada: true, code: 'REASIGNADA', detail: 'El relevamiento se reasignó a otro agente.'}}));
  try {
    assert.ok(ui.labels().includes('Este relevamiento se reasignó a otra persona; lo cargado queda en el teléfono.'));
    assert.equal(ui.button('Reintentar envío'), undefined);
    assert.ok(ui.labels().includes('Escuela A') && ui.labels().some(label => /Calle 123, Resistencia, Chaco/.test(label)));
  } finally {await ui.close();}
});

test('Detalle: un 400 muestra cada clave con la etiqueta del campo y permite reintentar y completar', async () => {
  const ui = await mountDetalle(inspeccion(1, 'Escuela A', {
    formulario: FORMULARIO,
    envio: {op_id: 'x', estado: 'error', permanente: true, descartada: false, code: 'DATOS_INVALIDOS',
      claves: {'cp-techo': 'Elegí una de las opciones del formulario.', 'cp-zzz': 'Campo viejo.'}}}));
  try {
    const labels = ui.labels();
    assert.ok(labels.includes('Estado del techo: Elegí una de las opciones del formulario.'));
    assert.ok(labels.includes('cp-zzz: Campo viejo.'));
    assert.ok(ui.button('Completar relevamiento'));
    await ui.pressButton('Reintentar envío');
    assert.equal(ui.calls.reintentos, 1);
  } finally {await ui.close();}
});

test('Detalle: con envío pendiente no se ofrece completar; con coordenadas hay link al mapa', async () => {
  const pendiente = await mountDetalle(inspeccion(1, 'Escuela A', {envio: {op_id: 'x', estado: 'pendiente'}}));
  try {assert.equal(pendiente.button('Completar relevamiento'), undefined);} finally {await pendiente.close();}
  const libre = await mountDetalle(inspeccion(2, 'Escuela B', {edificio: edificio('Escuela B', {latitud: -27.45, longitud: -58.98})}));
  try {
    assert.ok(libre.button('Completar relevamiento'));
    assert.ok(libre.labels().includes('Ver en el mapa'));
  } finally {await libre.close();}
});

// ---- Completar ----

async function mountCompletar(detalle, options = {}) {
  const {mocks, toasts, runtime} = await baseMocks();
  const calls = {enviados: [], borrados: 0, guardados: 0, terminados: 0};
  Object.assign(mocks, {
    '../components/FormInput': {__esModule: true, default: native.TextInput, FormInputContainer: native.View},
    '../components/FechaInput': {__esModule: true, default: 'FechaInput'},
    '../services/definicionFormulario': runtime.definition,
    '../services/imagePicker': {}, '../services/documentPicker': {},
    'expo-web-browser': {openBrowserAsync: async () => {}},
    '../utils/teclado': {keyboardDismissModeFor: () => 'on-drag'},
    '../services/dispositivosBorrador': {
      leerBorrador: async () => options.borrador || null,
      guardarBorrador: async () => { calls.guardados += 1; },
      borrarBorrador: async () => { calls.borrados += 1; },
      copiarParaBorrador: async item => item,
      borrarArchivoDelBorrador: async () => {},
    },
    '../services/dispositivosService': {
      getInspeccion: async () => detalle,
      enviarResultado: async (id, datos) => { calls.enviados.push([id, datos]); return {success: true, envio: {estado: 'enviado'}}; },
    },
  });
  const Screen = loadScreen('src/screens/DispositivoCompletarScreen.js', mocks);
  const ui = await render(Screen, {inspeccionId: detalle.id, onTerminar() { calls.terminados += 1; }});
  const escribir = async (label, valor) => {
    const input = ui.tree.root.findAllByType('TextInput').find(node => node.props.accessibilityLabel === label);
    assert.ok(input, 'Missing input ' + label);
    await renderer.act(async () => {input.props.onChangeText(valor);});
  };
  return {...ui, calls, toasts, escribir};
}

test('Completar: no envía sin criticidad ni con obligatorios vacíos, y muestra qué falta', async () => {
  const ui = await mountCompletar(inspeccion(1, 'Escuela A', {formulario: FORMULARIO}));
  try {
    await ui.pressButton('Confirmar y enviar');
    assert.equal(ui.calls.enviados.length, 0);
    const labels = ui.labels();
    assert.ok(labels.includes('Falta completar'));
    assert.ok(labels.some(label => label.startsWith('• Criticidad')));
    assert.ok(labels.includes('• Estado del techo: Este campo es obligatorio.'));
    assert.ok(labels.includes('• Cantidad de baños: Este campo es obligatorio.'));
    // El campo condicionado a «Malo» está oculto y no se exige.
    assert.equal(labels.some(label => label.includes('Detalle del daño')), false);

    await ui.press('Media');
    await ui.pressButton('Confirmar y enviar');
    assert.equal(ui.calls.enviados.length, 0);
    assert.equal(ui.labels().some(label => label.startsWith('• Criticidad')), false);
    assert.ok(ui.labels().includes('• Estado del techo: Este campo es obligatorio.'));
  } finally {await ui.close();}
});

test('Completar: el envío lleva las respuestas del formulario, la versión y borra el borrador', async () => {
  const ui = await mountCompletar(inspeccion(1, 'Escuela A', {formulario: FORMULARIO}));
  try {
    await ui.press('Alta');
    await ui.press('Malo');
    // Con «Malo» aparece y se exige el detalle del daño.
    await ui.pressButton('Confirmar y enviar');
    assert.equal(ui.calls.enviados.length, 0);
    assert.ok(ui.labels().includes('• Detalle del daño: Este campo es obligatorio.'));
    await ui.escribir('Cantidad de baños', '3');
    await ui.escribir('Detalle del daño', 'Filtración');
    await ui.escribir('Observaciones', 'Humedad');
    await ui.pressButton('Confirmar y enviar');
    assert.equal(ui.calls.enviados.length, 1);
    const [id, datos] = ui.calls.enviados[0];
    assert.equal(id, 1);
    assert.equal(datos.criticidad, 'ALTA');
    assert.equal(datos.observaciones, 'Humedad');
    assert.equal(datos.versionCapturada, 10);
    assert.deepEqual(JSON.parse(JSON.stringify(datos.respuestas)), {'cp-techo': 'Malo', 'cp-banios': 3, 'cp-dano': 'Filtración'});
    assert.deepEqual(JSON.parse(JSON.stringify(datos.archivos)), {});
    assert.equal(ui.calls.borrados, 1);
    assert.equal(ui.calls.terminados, 1);
    assert.ok(ui.toasts.some(value => value && value.type === 'success'));
  } finally {await ui.close();}
});

test('Completar: lo oculto por condición no se manda aunque se hubiera escrito', async () => {
  const ui = await mountCompletar(inspeccion(1, 'Escuela A', {formulario: FORMULARIO}));
  try {
    await ui.press('Baja');
    await ui.press('Malo');
    await ui.escribir('Detalle del daño', 'Filtración');
    await ui.press('Bueno');
    await ui.escribir('Cantidad de baños', '2');
    await ui.pressButton('Confirmar y enviar');
    const [, datos] = ui.calls.enviados[0];
    assert.deepEqual(JSON.parse(JSON.stringify(datos.respuestas)), {'cp-techo': 'Bueno', 'cp-banios': 2});
  } finally {await ui.close();}
});

test('Completar: sin formulario no hay campos y solo se exige la criticidad', async () => {
  const ui = await mountCompletar(inspeccion(1, 'Escuela A', {formulario: null}));
  try {
    assert.equal(ui.labels().some(label => label.includes('Estado del edificio') || label.includes('Estado del techo')), false);
    assert.deepEqual(ui.tree.root.findAllByType('TextInput').map(node => node.props.accessibilityLabel), ['Observaciones']);
    await ui.pressButton('Confirmar y enviar');
    assert.equal(ui.calls.enviados.length, 0);
    await ui.press('Media');
    await ui.pressButton('Confirmar y enviar');
    assert.equal(ui.calls.enviados.length, 1);
    const [, datos] = ui.calls.enviados[0];
    assert.equal(datos.criticidad, 'MEDIA');
    assert.equal('respuestas' in datos, false);
    assert.equal('versionCapturada' in datos, false);
  } finally {await ui.close();}
});

test('Completar: restaura el borrador guardado', async () => {
  const borrador = {criticidad: 'BAJA', observaciones: 'Sin novedades', valores: {'cp-techo': 'Bueno', 'cp-banios': '4'}, fotos: []};
  const ui = await mountCompletar(inspeccion(1, 'Escuela A', {formulario: FORMULARIO}), {borrador});
  try {
    await ui.pressButton('Confirmar y enviar');
    const [, datos] = ui.calls.enviados[0];
    assert.equal(datos.criticidad, 'BAJA');
    assert.equal(datos.observaciones, 'Sin novedades');
    assert.deepEqual(JSON.parse(JSON.stringify(datos.respuestas)), {'cp-techo': 'Bueno', 'cp-banios': 4});
  } finally {await ui.close();}
});

test('Utilidades: validación de fotos, dirección y mapa', () => {
  const {prepararAsset, direccionDe, mapaUrl} = loadPure('src/utils/dispositivos.js');
  assert.equal(prepararAsset({uri: 'blob:x', fileName: 'a.JPG', size: 100}).mimeType, 'image/jpeg');
  assert.equal(prepararAsset({uri: 'blob:x', mimeType: 'image/png'}).fileName.endsWith('.png'), true);
  assert.throws(() => prepararAsset({uri: 'x', fileName: 'a.heic'}), /JPG, PNG o WEBP/);
  assert.doesNotThrow(() => prepararAsset({uri: 'x', fileName: 'a.heic'}, {tipo: 'adjunto'}));
  assert.throws(() => prepararAsset({uri: 'x', fileName: 'a.pdf'}), /JPG, PNG o WEBP/);
  assert.throws(() => prepararAsset({uri: 'x', fileName: 'a.jpg', size: 6 * 1024 * 1024}), /5 MB/);
  assert.equal(direccionDe(edificio('X', {piso_departamento: '2B', codigo_postal: '3500'})), 'Calle 123 (2B), Resistencia, Chaco, CP 3500');
  assert.equal(mapaUrl({latitud: null, longitud: null}), null);
  assert.match(mapaUrl({latitud: -27.4, longitud: -58.9}), /query=-27\.4%2C-58\.9$/);
});
