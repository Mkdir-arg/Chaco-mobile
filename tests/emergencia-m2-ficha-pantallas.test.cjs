// Pantallas de M2 · Llegada de familias, parte 2: una persona con su ficha (Formulario 2), el mapa de
// camas y «confirmar persona» (EmergenciaFichaScreen), más el tramo nuevo del router de EmergenciaApp.
// La lógica (services/emergenciaLlegadas, utils/fichaEmergencia) y la API (services/emergenciaApi) son
// las reales, sobre el fetch falso del runtime: lo que se prueba acá llega hasta el pedido HTTP.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const React = require('react');
const renderer = require('react-test-renderer');
const {transformSync} = require('@babel/core');
const {setup, response} = require('./helpers/mobile-runtime.cjs');

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
const PLAZA = (id, codigo, estado, extra = {}) => ({id, codigo, nombre: `${codigo} (Pabellón ${codigo[0]})`, estado,
  elegible: ['LIBRE', 'RESERVADA_FAMILIA'].includes(estado), texto: '', tono: '', detalle: '', ...extra});
const MAPA = {caso: 184, sectores: [
  {sector: {id: 3, nombre: 'Pabellón A', perfil: 'Familias'}, total: 3, libres: 1, reservadas_familia: 2,
    plazas: [PLAZA(40, 'A-00', 'OCUPADA'), PLAZA(41, 'A-01', 'RESERVADA_FAMILIA'), PLAZA(42, 'A-02', 'LIBRE'), PLAZA(43, 'A-03', 'RESERVADA_FAMILIA')]},
  {sector: {id: 4, nombre: 'Pabellón B', perfil: ''}, total: 2, libres: 0, reservadas_familia: 0,
    plazas: [PLAZA(50, 'B-01', 'FUERA_SERVICIO', {detalle: 'Colchón roto'}), PLAZA(52, 'B-03', 'RESERVADA')]},
]};
// La A-01 la tomó otra guardia.
const MAPA_SIN_A01 = {...MAPA, sectores: [{...MAPA.sectores[0], plazas: MAPA.sectores[0].plazas.map(p => (p.id === 41 ? PLAZA(41, 'A-01', 'OCUPADA') : p))}, MAPA.sectores[1]]};
const SIN_CONFIRMAR = {n: 2, estado: 'SIN_CONFIRMAR', ficha_completa: false, persona: null, plaza: null, parentesco: '', confirmada_en: null,
  egresado_en: null, ficha: {}, secciones_incompletas: ['Educación', 'Vacunación', 'Salud y medicación', 'Trabajo', 'Observaciones, mascotas y adulto responsable']};
const FICHA_GUARDADA = {version: 1, parentesco: {parentesco: 'HIJO'},
  datos_personales: {dni: '45111222', nombre: 'Juan', apellido: 'Benítez', sexo: 'M', fecha_nacimiento: '2012-03-10'},
  avisos_salud: {embarazo: false, discapacidad: false, electrodependiente: false, medicacion_critica: false, alergias_graves: false},
  educacion: {}, vacunacion: {sin_datos: true}, salud: {}, trabajo: {}, observaciones: {adulto_responsable: 'Rosa Benítez'}};
const CONFIRMADA = {n: 2, estado: 'CONFIRMADA', ficha_completa: false, persona: {id: 90, nombre: 'Benítez, Juan', dni: '45111222'},
  plaza: {id: 41, codigo: 'A-01', nombre: 'A-01 (Pabellón A)'}, parentesco: 'Hijo/a', confirmada_en: '2026-11-12T10:20:00-03:00', egresado_en: null,
  ficha: FICHA_GUARDADA, secciones_incompletas: ['Educación', 'Salud y medicación', 'Trabajo']};
const FILA_CONFIRMADA = (plaza = {id: 41, codigo: 'A-01', nombre: 'A-01 (Pabellón A)'}) => ({...CONFIRMADA, plaza, ficha: undefined, secciones_incompletas: undefined});
const CONFIRMACION = (plaza) => ({integrante: FILA_CONFIRMADA(plaza), confirmadas: 2, total_declarado: 3, reserva_liberada: false});
const fallaDeRed = () => Promise.reject(new TypeError('Load failed'));
const nunca = () => new Promise(() => {});
const SIN_RED = 'Sin conexión: no podés buscar familias ni reservar camas. La llegada de familias necesita señal; probá cuando vuelva la red.';
const api = calls => calls.filter(c => c.url.startsWith('/api/emergencia/') && !c.url.endsWith('/perfil/'));
const confirmaciones = calls => calls.filter(c => c.method === 'POST' && c.url.endsWith('/confirmar/'));
const fondoDe = (tree, texto) => {
  const nodo = tree.root.findAllByType('Text').find(n => text(n) === texto);
  assert.ok(nodo, 'Falta ' + texto);
  const estilos = [].concat(nodo.parent.props.style || []).flat();
  return estilos.find(e => e && e.backgroundColor)?.backgroundColor;
};

// `persona`: lo que contesta el GET de la persona; `confirmar(call, n)`: el POST; `mapa(n)`: el GET de camas.
function rutasDe({persona = SIN_CONFIRMAR, confirmar = () => response(201, CONFIRMACION()), mapa = () => MAPA, completar} = {}) {
  let posts = 0;
  let mapas = 0;
  return (call) => {
    if (call.url.includes('/plazas/')) { mapas += 1; const m = mapa(mapas); return typeof m?.then === 'function' || m?.status ? m : response(200, m); }
    if (call.method === 'POST' && call.url.endsWith('/confirmar/')) { posts += 1; return confirmar(call, posts); }
    if (call.method === 'PATCH') return completar ? completar(call) : response(200, {ficha_completa: false, secciones_incompletas: ['Trabajo']});
    if (call.url.endsWith('/integrantes/2/')) return typeof persona === 'function' ? persona(call) : response(200, persona);
    return response(404, {detail: 'No encontrado.'});
  };
}

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
    '../utils/fichaEmergencia': runtime.load('../utils/fichaEmergencia'),
    '../services/emergenciaLlegadas': llegadas,
  };
  return {runtime, calls, toasts, alerts, llegadas, mocks};
}

async function montarFicha(rutas, {online = true, caso = CASO, antes, env: previo} = {}) {
  const env = previo || await entorno(rutas);
  env.runtime.setOnline(online);
  if (antes) await antes(env);
  const eventos = [];
  const enviando = [];
  const Screen = loadScreen('src/screens/EmergenciaFichaScreen.js', env.mocks);
  const ui = await render(Screen, {caso, n: 2, dispositivo: {id: 9, nombre: 'Escuela 12'},
    onTerminar: r => eventos.push(['terminar', plano(r)]), onConflicto: c => eventos.push(['conflicto', plano(c)]),
    onNoEncontrado: () => eventos.push(['no_encontrado']), onSinModulo: m => eventos.push(['sin_modulo', m]),
    onEnviando: v => enviando.push(v)});
  await renderer.act(async () => { await esperar(10); });
  const fecha = async (valor) => renderer.act(async () => { ui.tree.root.findByType('FechaInput').props.onSelect(valor); });
  const llenarMinimo = async ({fechaNacimiento = '10/03/1990'} = {}) => {
    await ui.press('Parentesco: Hijo/a');
    await ui.escribir('DNI', '45.111.222');
    await ui.escribir('Nombre', 'Juan');
    await ui.escribir('Apellido', 'Benítez');
    await ui.press('Sexo: Masculino');
    await fecha(fechaNacimiento);
    for (const p of ['Embarazo', 'Discapacidad', 'Electrodependiente', 'Medicación crítica', 'Alergias graves']) await ui.press(`${p}: No`);
  };
  return {...env, ...ui, eventos, enviando, fecha, llenarMinimo};
}

// ---- Confirmar ----

test('Ficha (confirmar): el mínimo, la cama propuesta (la primera guardada para la familia) y el mapa con cada estado', async () => {
  const ui = await montarFicha(rutasDe());
  try {
    assert.deepEqual(api(ui.calls).map(c => c.url), ['/api/emergencia/casos/184/integrantes/2/', '/api/emergencia/dispositivos/9/plazas/?caso=184']);
    const labels = ui.labels();
    for (const t of ['Caso 2026-000184 · Persona 2', 'Sin confirmar', '1. Parentesco', '2. Datos personales', '3. Avisos críticos de salud',
      'Cama *', 'A-01 (Pabellón A)', 'Reservada para esta familia']) assert.ok(labels.includes(t), t);
    assert.equal(fondoDe(ui.tree, 'Reservada para esta familia'), '#FFF8F1', 'insignia con fondo de statusTones');
    assert.ok(!labels.includes('4. Educación'), 'el resto de la ficha va plegado');
    await ui.pressButton('Cambiar cama');
    const camas = ui.pressables().filter(p => p.props.accessibilityLabel?.startsWith('Cama '));
    assert.deepEqual(camas.map(p => [p.props.accessibilityLabel, p.props.disabled, p.props.accessibilityState.selected]), [
      ['Cama A-00, Ocupada', true, false], ['Cama A-01, Reservada para esta familia', false, true], ['Cama A-02, Libre', false, false],
      ['Cama A-03, Reservada para esta familia', false, false], ['Cama B-01, Fuera de servicio: Colchón roto', true, false],
      ['Cama B-03, Reservada para otra persona', true, false]]);
    assert.ok(ui.labels().includes('1 libre de 3 · 2 guardadas para esta familia'));
    await ui.press('Cama A-02, Libre');
    assert.ok(ui.labels().includes('A-02 (Pabellón A)'));
    await ui.pressButton('Cargar ahora el resto de la ficha (opcional)');
    for (const t of ['4. Educación', '5. Vacunación', '6. Salud y medicación', '7. Trabajo', '8. Observaciones, mascotas y adulto responsable']) {
      assert.ok(ui.labels().includes(t), t);
    }
  } finally { await ui.close(); }
});

test('Ficha (confirmar): sin el mínimo no manda nada y marca cada campo; completo manda la ficha anidada con la cama y vuelve', async () => {
  const ui = await montarFicha(rutasDe());
  try {
    await ui.pressButton('Confirmar persona');
    assert.equal(confirmaciones(ui.calls).length, 0);
    assert.match(ui.toasts.at(-1).message, /^Faltan 7 datos/);
    const labels = ui.labels();
    for (const t of ['• Parentesco: Falta: parentesco con quien responde por la familia.', '• Embarazo: Falta: avisos de salud · respondé sí o no a embarazo.',
      '• DNI: Sin un número de DNI válido (7 u 8 dígitos) no se puede confirmar a la persona con cama.']) assert.ok(labels.includes(t), t);
    await ui.llenarMinimo();
    await ui.press('Medicación crítica: Sí');
    await ui.pressButton('Confirmar persona');
    assert.equal(confirmaciones(ui.calls).length, 0, 'con medicación crítica pide cuál y la dosis');
    await ui.escribir('Qué medicación crítica toma', 'Insulina');
    await ui.press('Tiene dosis de la medicación: Sí');
    await ui.pressButton('Cargar ahora el resto de la ficha (opcional)');
    await ui.press('Nivel educativo: Secundario');
    await ui.press('Sin datos (pregunté y no hay nada que cargar)');
    await ui.pressButton('Confirmar persona');
    const [post] = confirmaciones(ui.calls);
    assert.equal(post.url, '/api/emergencia/casos/184/integrantes/2/confirmar/');
    assert.equal(post.body.plaza_id, 41);
    assert.deepEqual(post.body.ficha.parentesco, {parentesco: 'HIJO'});
    assert.deepEqual(post.body.ficha.datos_personales, {dni: '45111222', nombre: 'Juan', apellido: 'Benítez', sexo: 'M', fecha_nacimiento: '1990-03-10'});
    assert.deepEqual(post.body.ficha.avisos_salud, {embarazo: false, discapacidad: false, electrodependiente: false, medicacion_critica: true,
      medicacion_critica_nombre: 'Insulina', medicacion_critica_tiene_dosis: true, alergias_graves: false});
    assert.deepEqual(post.body.ficha.educacion, {sin_datos: true, nivel_educativo: 'SECUNDARIO'});
    assert.deepEqual(ui.eventos.map(e => [e[0], e[1].tipo, e[1].confirmadas]), [['terminar', 'confirmada', 2]]);
    assert.equal(ui.toasts.at(-1).message, 'Persona 2 confirmada en la cama A-01 (Pabellón A) · 2 de 3.');
    assert.deepEqual(ui.enviando, [true, false]);
    const sesion = await ui.llegadas.abrirSesion();
    assert.equal(await ui.llegadas.leerBorradorFicha(sesion, 184, 2, 'confirmar'), null, 'confirmada: el borrador se borra');
    assert.equal(await ui.llegadas.confirmarPendiente(sesion, 184, 2), null);
  } finally { await ui.close(); }
});

test('Ficha (confirmar): un menor de 16 pide el adulto responsable con el mínimo', async () => {
  const ui = await montarFicha(rutasDe());
  try {
    await ui.llenarMinimo({fechaNacimiento: '10/03/2015'});
    assert.ok(ui.input('Adulto responsable'), 'aparece con el mínimo');
    await ui.pressButton('Confirmar persona');
    assert.equal(confirmaciones(ui.calls).length, 0);
    assert.ok(ui.labels().includes('• Adulto responsable: Es menor de 16 años: indicá el adulto responsable.'));
    await ui.escribir('Adulto responsable', 'Rosa Benítez');
    await ui.pressButton('Confirmar persona');
    assert.deepEqual(confirmaciones(ui.calls)[0].body.ficha.observaciones, {adulto_responsable: 'Rosa Benítez'});
  } finally { await ui.close(); }
});

test('Ficha (confirmar): cama tomada por otra guardia (400 `plaza`) → se recarga el mapa, se propone otra y no se manda sola', async () => {
  const ui = await montarFicha(rutasDe({
    mapa: n => (n === 1 ? MAPA : MAPA_SIN_A01),
    confirmar: (call, n) => (n === 1 ? response(400, {code: 'VALIDACION', detail: 'x', plaza: ['La cama A-01 (Pabellón A) ya está ocupada · elegí otra.']})
      : response(201, CONFIRMACION({id: 43, codigo: 'A-03', nombre: 'A-03 (Pabellón A)'}))),
  }));
  try {
    await ui.llenarMinimo();
    await ui.pressButton('Confirmar persona');
    await renderer.act(async () => { await esperar(10); });
    assert.equal(ui.calls.filter(c => c.url.includes('/plazas/')).length, 2, 'recargó el mapa');
    assert.ok(ui.labels().includes('La cama A-01 (Pabellón A) ya está ocupada · elegí otra.'), 'el error del back queda en la cama');
    assert.ok(ui.labels().includes('A-03 (Pabellón A)'), 'propone la otra guardada para la familia');
    assert.equal(ui.toasts.at(-1).message, 'A-01 (Pabellón A) ya no se puede elegir. Te propusimos A-03 (Pabellón A): revisala y confirmá de nuevo.');
    assert.equal(confirmaciones(ui.calls).length, 1, 'no reintenta sola');
    assert.ok(ui.button('Confirmar persona'), 'el 400 destraba: no es «Reintentar»');
    await ui.pressButton('Confirmar persona');
    const [a, b] = confirmaciones(ui.calls);
    assert.equal(b.body.plaza_id, 43);
    assert.notEqual(b.body.uuid_cliente, a.body.uuid_cliente, 'el 400 no confirmó a nadie: el siguiente es otro pedido');
    assert.equal(ui.eventos.at(-1)[0], 'terminar');
  } finally { await ui.close(); }
});

test('Ficha (confirmar): 400 VALIDACION por campo (nombre, dni) se muestra en su campo; `orden` va a «Para corregir»', async () => {
  const ui = await montarFicha(rutasDe({confirmar: () => response(400, {code: 'VALIDACION', detail: 'x', nombre: ['Falta: el nombre.'],
    dni: ['Benítez, Juan figura alojado en otro dispositivo de la red. Pedí a la coordinación del Programa Dispositivos que registre el egreso (clave 12) o cerrá el ingreso con diferencia.'],
    orden: ['Esa persona no es de esta familia. Recargá la lista.']})}));
  try {
    await ui.llenarMinimo();
    await ui.pressButton('Confirmar persona');
    const labels = ui.labels();
    assert.ok(labels.includes('Falta: el nombre.'));
    assert.ok(labels.includes('• Nombre: Falta: el nombre.'));
    assert.ok(labels.some(t => t.startsWith('• DNI: Benítez, Juan figura alojado en otro dispositivo')));
    assert.ok(labels.includes('• Esa persona no es de esta familia. Recargá la lista.'));
    await ui.escribir('Nombre', 'Juan Carlos');
    assert.ok(!ui.labels().includes('Falta: el nombre.'), 'al corregir el campo se va su error del servidor');
    assert.deepEqual(ui.eventos, []);
  } finally { await ui.close(); }
});

test('Ficha (confirmar): un corte deja «Reintentar confirmar» con el MISMO uuid, también al salir y volver; el reenvío con otra cama lo avisa', async () => {
  const env = await entorno(rutasDe({confirmar: (call, n) => (n === 1 ? fallaDeRed() : response(200, CONFIRMACION()))}));
  const primera = await montarFicha(null, {env});
  await primera.llenarMinimo();
  await primera.pressButton('Cambiar cama');
  await primera.press('Cama A-02, Libre');
  await primera.pressButton('Confirmar persona');
  assert.ok(primera.labels().includes('No se pudo saber si la persona quedó confirmada. «Reintentar confirmar» manda el mismo pedido: si ya había llegado, no la confirma dos veces ni toma otra cama.'));
  assert.ok(primera.button('Reintentar confirmar'));
  await primera.close();
  const segunda = await montarFicha(null, {env});
  try {
    assert.ok(segunda.button('Reintentar confirmar'), 'el pendiente sobrevive a salir: ' + segunda.titulos());
    assert.ok(env.toasts.some(t => t.message === 'Recuperamos lo que habías cargado de esta persona y todavía no se mandó.'));
    assert.equal(segunda.input('DNI').props.value, '45111222', 'el borrador trae lo tipeado');
    assert.ok(segunda.labels().includes('A-02 (Pabellón A)'), 'y la cama elegida');
    await segunda.pressButton('Reintentar confirmar');
    const [a, b] = confirmaciones(env.calls);
    assert.equal(b.body.uuid_cliente, a.body.uuid_cliente);
    // El primero había llegado con la A-01 (otra guardia no; el servidor dice la A-01): se avisa.
    assert.deepEqual(env.alerts.at(-1).slice(0, 2), ['La persona ya estaba confirmada',
      'Un envío anterior ya la había confirmado en la cama A-01 (Pabellón A), no en la que elegiste ahora. Quedó así; la cama se cambia desde el mapa del backoffice.']);
    assert.equal(segunda.eventos.at(-1)[0], 'terminar');
  } finally { await segunda.close(); }
});

test('Ficha (confirmar): 409 (otra guardia la confirmó) va al router y borra el borrador; 404 y 403 al padre', async () => {
  const ui = await montarFicha(rutasDe({confirmar: () => response(409, {detail: 'La persona 2 ya fue confirmada. Recargá la lista.', estado_actual: 'INGRESO_EN_CURSO'})}));
  try {
    await ui.llenarMinimo();
    await renderer.act(async () => { await esperar(600); });
    const sesion = await ui.llegadas.abrirSesion();
    assert.ok(await ui.llegadas.leerBorradorFicha(sesion, 184, 2, 'confirmar'), 'lo tipeado se guarda');
    await ui.pressButton('Confirmar persona');
    assert.deepEqual(ui.eventos.map(e => [e[0], e[1].destino, e[1].mensaje]), [['conflicto', 'integrantes', 'La persona 2 ya fue confirmada. Recargá la lista.']]);
    assert.equal(await ui.llegadas.leerBorradorFicha(sesion, 184, 2, 'confirmar'), null);
    assert.equal(await ui.llegadas.confirmarPendiente(sesion, 184, 2), null);
  } finally { await ui.close(); }
  const ajena = await montarFicha(rutasDe({persona: () => response(404, {detail: 'No encontrado.'})}));
  try { assert.deepEqual(ajena.eventos, [['no_encontrado']]); } finally { await ajena.close(); }
  const sinPermiso = await montarFicha(rutasDe({confirmar: (call) => response(403, {detail: 'El usuario no admite familias en ningún dispositivo.', code: 'SIN_MODULO'})}));
  try {
    await sinPermiso.llenarMinimo();
    await sinPermiso.pressButton('Confirmar persona');
    assert.deepEqual(sinPermiso.eventos, [['sin_modulo', 'El usuario no admite familias en ningún dispositivo.']]);
  } finally { await sinPermiso.close(); }
});

test('Ficha (confirmar): 429, 5xx y página del WAF se muestran y dejan reintentar con el mismo uuid', async () => {
  for (const [respuesta, texto] of [
    [() => response(429, {detail: 'x'}, {'Retry-After': '30'}), 'El servidor pidió esperar antes de volver a intentar.'],
    [() => response(503, {detail: 'x'}), 'No se pudo saber si la persona quedó confirmada. «Reintentar confirmar» manda el mismo pedido: si ya había llegado, no la confirma dos veces ni toma otra cama.'],
    [() => ({status: 403, ok: false, headers: {get: n => (n.toLowerCase() === 'content-type' ? 'text/html' : null)}, text: async () => '<html>WAF</html>'}),
      'No se pudo saber si la persona quedó confirmada. «Reintentar confirmar» manda el mismo pedido: si ya había llegado, no la confirma dos veces ni toma otra cama.'],
  ]) {
    const ui = await montarFicha(rutasDe({confirmar: (call, n) => (n === 1 ? respuesta() : response(201, CONFIRMACION()))}));
    try {
      await ui.llenarMinimo();
      await ui.pressButton('Confirmar persona');
      assert.ok(ui.labels().includes(texto), texto);
      await ui.pressButton('Reintentar confirmar');
      const [a, b] = confirmaciones(ui.calls);
      assert.equal(b.body.uuid_cliente, a.body.uuid_cliente);
    } finally { await ui.close(); }
  }
});

test('Ficha (confirmar): toques sin espera entre medio mandan un solo POST; volver queda en manos del padre (onEnviando)', async () => {
  const ui = await montarFicha(rutasDe({confirmar: () => nunca()}));
  try {
    await ui.llenarMinimo();
    const confirmar = ui.button('Confirmar persona').props.onPress;
    await renderer.act(async () => { confirmar(); confirmar(); await esperar(10); });
    assert.equal(confirmaciones(ui.calls).length, 1);
    assert.deepEqual(ui.enviando, [true]);
    assert.equal(ui.button('Confirmar persona').props.disabled, true);
    assert.ok(ui.pressables().filter(p => p.props.accessibilityRole === 'radio').every(p => p.props.disabled), 'mientras manda no se cambia nada');
  } finally { await ui.close(); }
});

test('Ficha sin red: no hay lectura guardada; se bloquea con aviso y no pide nada; con red se carga', async () => {
  const ui = await montarFicha(rutasDe(), {online: false});
  try {
    assert.ok(ui.labels().includes(SIN_RED));
    assert.equal(api(ui.calls).length, 0);
    ui.runtime.setOnline(true);
    await ui.pressButton('Reintentar');
    assert.ok(ui.labels().includes('1. Parentesco'));
    ui.runtime.setOnline(false);
    await ui.llenarMinimo();
    await ui.pressButton('Confirmar persona');
    assert.equal(confirmaciones(ui.calls).length, 0);
    assert.deepEqual(ui.alerts.at(-1).slice(0, 2), ['Sin conexión', SIN_RED]);
    const sesion = await ui.llegadas.abrirSesion();
    assert.equal(await ui.llegadas.confirmarPendiente(sesion, 184, 2), null, 'sin red no queda un pendiente');
  } finally { await ui.close(); }
});

test('Ficha: sin camas elegibles lo dice y no deja confirmar; con la familia ya alojada, una sin confirmar es solo lectura', async () => {
  const sinCamas = {caso: 184, sectores: [{...MAPA.sectores[1]}]};
  const ui = await montarFicha(rutasDe({mapa: () => sinCamas}));
  try {
    assert.ok(ui.labels().includes('No queda ninguna cama libre ni guardada para esta familia. Liberá una o cerrá el ingreso con diferencia.'));
    await ui.llenarMinimo();
    await ui.pressButton('Confirmar persona');
    assert.equal(confirmaciones(ui.calls).length, 0);
    assert.ok(ui.labels().includes('• Cama: Elegí una cama del mapa.'));
  } finally { await ui.close(); }
  const alojada = await montarFicha(rutasDe(), {caso: {...CASO, estado: 'ALOJADO'}});
  try {
    assert.deepEqual(alojada.titulos(), []);
    assert.equal(alojada.calls.filter(c => c.url.includes('/plazas/')).length, 0);
  } finally { await alojada.close(); }
});

test('Ficha: la respuesta que llega después de salir no navega ni rompe; la de otra sesión se descarta', async () => {
  let soltar;
  const ui = await montarFicha(rutasDe({persona: () => new Promise((resolve) => { soltar = () => resolve(response(200, SIN_CONFIRMAR)); })}));
  await ui.close();
  await renderer.act(async () => { soltar(); await esperar(10); });
  assert.deepEqual(ui.eventos, []);
  let runtime;
  const otra = await montarFicha(rutasDe({persona: async () => {
    // Entra otra persona mientras el GET está en vuelo.
    runtime.setFetch(async () => response(200, {token: 'tok-2', user_id: 8, username: 'otra', modulos: ['emergencia']}));
    await runtime.api.loginBecas({username: 'otra', password: 'x'});
    return response(200, SIN_CONFIRMAR);
  }}), {antes: async (env) => { runtime = env.runtime; }});
  try {
    assert.ok(!otra.labels().includes('1. Parentesco'), 'no se muestra lo que llegó para otra sesión');
    assert.deepEqual(otra.eventos, []);
  } finally { await otra.close(); }
});

// ---- Completar ----

test('Ficha (completar): una confirmada muestra lo que falta y guarda solo las secciones que cambiaron (PATCH)', async () => {
  const ui = await montarFicha(rutasDe({persona: CONFIRMADA}));
  try {
    const labels = ui.labels();
    for (const t of ['Confirmada', 'Ficha incompleta', 'Benítez, Juan', 'DNI 45111222 · Cama A-01 (Pabellón A) · Hijo/a',
      'Falta: Educación, Salud y medicación, Trabajo.', '4. Educación', '8. Observaciones, mascotas y adulto responsable']) assert.ok(labels.includes(t), t);
    assert.equal(ui.calls.filter(c => c.url.includes('/plazas/')).length, 0, 'sin mapa');
    assert.equal(ui.input('Adulto responsable').props.value, 'Rosa Benítez', 'precarga la ficha guardada');
    await ui.pressButton('Guardar ficha');
    assert.equal(ui.calls.filter(c => c.method === 'PATCH').length, 0);
    assert.equal(ui.toasts.at(-1).message, 'No hay cambios para guardar.');
    await ui.press('Nivel educativo: Primario');
    await ui.escribir('Escuela', 'N.° 12');
    await ui.escribir('Ocupación', 'Estudiante');
    await ui.pressButton('Guardar ficha');
    const [patch] = ui.calls.filter(c => c.method === 'PATCH');
    assert.equal(patch.url, '/api/emergencia/casos/184/integrantes/2/');
    assert.deepEqual(patch.body, {ficha: {educacion: {nivel_educativo: 'PRIMARIO', escuela: 'N.° 12'}, trabajo: {ocupacion: 'Estudiante'}}});
    assert.equal(ui.toasts.at(-1).message, 'Ficha guardada. Falta: Trabajo.');
    assert.deepEqual(ui.eventos.map(e => [e[0], e[1].tipo]), [['terminar', 'completada']]);
  } finally { await ui.close(); }
});

test('Ficha (completar): sacar el adulto responsable de un menor no se manda; 400 por campo; corte → «Reintentar guardar»', async () => {
  let patches = 0;
  const ui = await montarFicha(rutasDe({persona: CONFIRMADA, completar: () => {
    patches += 1;
    if (patches === 1) return response(400, {code: 'VALIDACION', detail: 'x', obra_social: ['No puede tener más de 120 caracteres.']});
    if (patches === 2) return fallaDeRed();
    return response(200, {ficha_completa: true, secciones_incompletas: []});
  }}));
  try {
    await ui.escribir('Adulto responsable', '');
    await ui.pressButton('Guardar ficha');
    assert.equal(patches, 0);
    assert.ok(ui.labels().includes('• Adulto responsable: Es menor de 16 años: indicá el adulto responsable.'));
    await ui.escribir('Adulto responsable', 'Rosa Benítez');
    await ui.escribir('Obra social', 'PAMI');
    await ui.pressButton('Guardar ficha');
    assert.ok(ui.labels().includes('No puede tener más de 120 caracteres.'));
    await ui.escribir('Obra social', 'Incluir Salud');
    await ui.pressButton('Guardar ficha');
    assert.ok(ui.labels().includes('No se pudo saber si la ficha se guardó. «Reintentar» manda lo mismo: guardarla dos veces no cambia nada.'));
    await ui.pressButton('Reintentar guardar');
    const [, b, c] = ui.calls.filter(x => x.method === 'PATCH');
    assert.deepEqual(c.body, b.body, 'el reintento manda lo mismo');
    assert.deepEqual(c.body, {ficha: {salud: {obra_social: 'Incluir Salud'}}});
    assert.equal(ui.toasts.at(-1).message, 'Ficha de la persona 2 completa.');
  } finally { await ui.close(); }
});

test('Ficha (completar): 409 (el caso se cerró) va al router; con el caso cerrado es solo lectura', async () => {
  const ui = await montarFicha(rutasDe({persona: CONFIRMADA, completar: () => response(409, {detail: 'El caso ya está cerrado.', estado_actual: 'CERRADO'})}));
  try {
    await ui.escribir('Ocupación', 'Albañil');
    await ui.pressButton('Guardar ficha');
    assert.deepEqual(ui.eventos.map(e => [e[0], e[1].destino, e[1].estadoActual]), [['conflicto', 'integrantes', 'CERRADO']]);
  } finally { await ui.close(); }
  const cerrado = await montarFicha(rutasDe({persona: CONFIRMADA}), {caso: {...CASO, estado: 'CERRADO'}});
  try {
    assert.ok(cerrado.labels().includes('El caso está cerrado: la ficha se muestra en modo lectura.'));
    assert.deepEqual(cerrado.titulos(), []);
    assert.equal(cerrado.input('Ocupación').props.editable, false);
  } finally { await cerrado.close(); }
});

test('Ficha (completar): con la familia alojada se puede completar; un pendiente de confirmar de esa persona se olvida', async () => {
  const env = await entorno(rutasDe({persona: CONFIRMADA}));
  const sesion = await env.llegadas.abrirSesion();
  env.runtime.setFetch(async () => fallaDeRed());
  await env.llegadas.confirmarPersona(sesion, 184, 2, {plano: {}, plazaId: 41}).catch(() => {});
  assert.ok(await env.llegadas.confirmarPendiente(sesion, 184, 2));
  env.runtime.setFetch(async (url, init = {}) => {
    const call = {url: String(url).replace('https://example.test', ''), method: init.method || 'GET', init,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body};
    env.calls.push(call);
    return rutasDe({persona: CONFIRMADA})(call);
  });
  const ui = await montarFicha(null, {env, caso: {...CASO, estado: 'ALOJADO'}});
  try {
    assert.ok(ui.button('Guardar ficha'));
    assert.equal(await env.llegadas.confirmarPendiente(sesion, 184, 2), null);
  } finally { await ui.close(); }
});

// ---- EmergenciaApp: el tramo integrantes -> persona ----

async function montarApp() {
  const pantallas = {};
  const alerts = [];
  const toasts = [];
  const montajes = {};
  const capturar = nombre => (props) => {
    pantallas[nombre] = props;
    React.useEffect(() => { montajes[nombre] = (montajes[nombre] || 0) + 1; }, []);
    return null;
  };
  const mocks = {
    react: React, 'react-native': native,
    '../context/AuthContext': {useAuth: () => ({user: {nombre: 'Ana'}, logout() {}})},
    '../context/ThemeContext': {useTheme: () => ({theme, typography})},
    '../context/ToastContext': {useToast: () => ({showAlert: (...a) => alerts.push(a), showToast: t => toasts.push(t)})},
    '../components/Banner': {__esModule: true, default: 'Banner'},
    '../components/CustomButton': {__esModule: true, default: 'CustomButton'},
    '../components/SettingsPanel': {__esModule: true, default: 'SettingsPanel'},
    ...Object.fromEntries(['Inicio', 'MisEnvios', 'Formulario1', 'MisDispositivos', 'Entregas', 'RecibirEntrega', 'LlegadaBuscar', 'Derivacion',
      'Integrantes', 'Ficha'].map(n => [`../screens/Emergencia${n}Screen`, {__esModule: true, default: capturar(n)}])),
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
  const montada = nombre => tree.root.findAll(x => x.type === mocks[`../screens/Emergencia${nombre}Screen`].default).length > 0;
  return {pantallas, alerts, toasts, banner, hacer, montada, titulo: () => banner().props.title, atras: () => hacer(() => banner().props.onBackPress()),
    montajes,
    close: () => renderer.act(async () => tree.unmount())};
}

test('EmergenciaApp M2: integrantes -> persona (título «Persona N», con caso y dispositivo) -> volver, terminar, 404 y 409', async () => {
  const ui = await montarApp();
  try {
    await ui.hacer(() => ui.pantallas.Inicio.onAbrir({clave: 'llegadas', titulo: 'Llegada de familias'}));
    await ui.hacer(() => ui.pantallas.MisDispositivos.onElegir({id: 9, nombre: 'Escuela 12'}, {unico: false}));
    await ui.hacer(() => ui.pantallas.LlegadaBuscar.onIntegrantes({id: 184, numero: '2026-000184'}, '30111222'));
    await ui.hacer(() => ui.pantallas.Integrantes.onAbrirPersona({n: 2}, CASO));
    assert.ok(ui.montada('Ficha'));
    assert.equal(ui.titulo(), 'Persona 2');
    assert.deepEqual([ui.pantallas.Ficha.n, ui.pantallas.Ficha.caso.estado, ui.pantallas.Ficha.dispositivo.id], [2, 'INGRESO_EN_CURSO', 9]);
    // Mientras confirma no se vuelve.
    await ui.hacer(() => ui.pantallas.Ficha.onEnviando(true));
    assert.equal(ui.banner().props.showBackButton, false);
    await ui.atras();
    assert.ok(ui.montada('Ficha'));
    await ui.hacer(() => ui.pantallas.Ficha.onEnviando(false));
    const antes = ui.montajes.Integrantes;
    await ui.atras();
    assert.ok(ui.montada('Integrantes'), 'volver va a los integrantes');
    assert.equal(ui.pantallas.Integrantes.caso.id, 184);
    // Confirmada: a los integrantes, montados de nuevo (recargan) y con la flecha de vuelta.
    await ui.hacer(() => ui.pantallas.Integrantes.onAbrirPersona({n: 2}, CASO));
    await ui.hacer(() => ui.pantallas.Ficha.onEnviando(true));
    await ui.hacer(() => ui.pantallas.Ficha.onTerminar({tipo: 'confirmada'}));
    assert.ok(ui.montada('Integrantes'));
    assert.equal(ui.montajes.Integrantes, antes + 2, 'cada vuelta monta los integrantes de nuevo (recargan)');
    assert.equal(ui.banner().props.showBackButton, true);
    // 404 de la persona: a los integrantes con aviso (si el caso ya no es suyo, su propio 404 sigue a «mis dispositivos»).
    await ui.hacer(() => ui.pantallas.Integrantes.onAbrirPersona({n: 5}, CASO));
    await ui.hacer(() => ui.pantallas.Ficha.onNoEncontrado());
    assert.ok(ui.montada('Integrantes'));
    assert.equal(ui.toasts.at(-1).message, 'Esa persona ya no está en la familia, o el caso ya no es de tu dispositivo. Se vuelven a cargar los integrantes.');
    // 409: el router de §13.1.
    await ui.hacer(() => ui.pantallas.Integrantes.onAbrirPersona({n: 2}, CASO));
    await ui.hacer(() => ui.pantallas.Ficha.onConflicto({tipo: 'conflicto', destino: 'integrantes', estadoActual: 'INGRESO_EN_CURSO', mensaje: 'La persona 2 ya fue confirmada.'}));
    assert.ok(ui.montada('Integrantes'));
    assert.deepEqual(ui.alerts.at(-1).slice(0, 2), ['El caso cambió', 'La persona 2 ya fue confirmada.']);
    await ui.hacer(() => ui.pantallas.Integrantes.onAbrirPersona({n: 2}, CASO));
    await ui.hacer(() => ui.pantallas.Ficha.onConflicto({tipo: 'conflicto', destino: 'buscar', estadoActual: 'EN_GESTION', mensaje: 'La mesa canceló.'}));
    assert.ok(ui.montada('LlegadaBuscar'));
    assert.equal(ui.pantallas.LlegadaBuscar.dniInicial, '30111222');
  } finally { await ui.close(); }
});
