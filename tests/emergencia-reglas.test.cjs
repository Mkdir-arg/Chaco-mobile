// utils/emergencia.js: reglas de cliente del Formulario 1 (contrato-app-emergencia §6), errores
// del 400 VALIDACION, textos por `code` y buscador de localidades.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {setup} = require('./helpers/mobile-runtime.cjs');

let reglas;
const cargar = async () => { reglas = reglas || (await setup()).load('../utils/emergencia'); return reglas; };
const plano = (valor) => JSON.parse(JSON.stringify(valor));
const VALIDO = {traslado: 'BOMBEROS', dni: '30111222', nombre: 'Rosa', apellido: 'Benitez', adultos_f: 1, direccion: 'Calle 1'};

test('un caso mínimo válido no tiene errores', async () => {
  const r = await cargar();
  assert.deepEqual(plano(r.validarCaso({...r.datosIniciales(), ...VALIDO})), {});
});

test('traslado obligatorio, de la lista, y «OTRA» exige texto de hasta 120', async () => {
  const r = await cargar();
  assert.ok(r.validarCaso({...VALIDO, traslado: ''}).traslado);
  assert.ok(r.validarCaso({...VALIDO, traslado: 'BARCO'}).traslado);
  assert.deepEqual(plano(r.TRASLADOS.map((t) => t.valor)), ['BOMBEROS', 'EJERCITO', 'DEFENSA_CIVIL', 'POLICIA', 'MUNICIPIO', 'AUTOEVACUADO', 'OTRA']);
  assert.ok(r.validarCaso({...VALIDO, traslado: 'OTRA'}).traslado_otro);
  assert.ok(r.validarCaso({...VALIDO, traslado: 'OTRA', traslado_otro: '   '}).traslado_otro);
  assert.equal(r.validarCaso({...VALIDO, traslado: 'OTRA', traslado_otro: 'x'.repeat(120)}).traslado_otro, undefined);
  assert.ok(r.validarCaso({...VALIDO, traslado: 'OTRA', traslado_otro: 'x'.repeat(121)}).traslado_otro);
  // Con otro traslado, el texto no se manda.
  assert.equal(r.datosDelCaso({...VALIDO, traslado_otro: 'viejo'}).traslado_otro, '');
});

test('DNI de 7 u 8 números; nombre y apellido salvo persona confirmada', async () => {
  const r = await cargar();
  assert.equal(r.validarCaso({...VALIDO, dni: '1234567'}).dni, undefined);
  assert.equal(r.validarCaso({...VALIDO, dni: '30.111.222'}).dni, undefined);
  assert.ok(r.validarCaso({...VALIDO, dni: '123456'}).dni);
  assert.ok(r.validarCaso({...VALIDO, dni: '123456789'}).dni);
  const sinNombre = {...VALIDO, nombre: '', apellido: ' '};
  assert.ok(r.validarCaso(sinNombre).nombre && r.validarCaso(sinNombre).apellido);
  for (const estado of ['no_encontrada', 'sin_red', 'error', 'fallecida']) {
    assert.ok(r.validarCaso({...sinNombre, consulta: {estado}}).nombre, estado);
  }
  const conSexo = {...sinNombre, dni: '30.111.222', sexo: 'f'};
  for (const estado of ['encontrada', 'escaneado']) {
    assert.equal(r.validarCaso({...conSexo, consulta: {estado, dni: '30111222', sexo: 'F'}}).nombre, undefined, estado);
    // La confirmación es de un DNI y un sexo: con otros (o sin decir de quién) no vale.
    assert.ok(r.validarCaso({...conSexo, consulta: {estado}}).nombre, `${estado} sin dni`);
    assert.ok(r.validarCaso({...conSexo, consulta: {estado, dni: '30111223', sexo: 'F'}}).nombre, `${estado} otro dni`);
    assert.ok(r.validarCaso({...conSexo, consulta: {estado, dni: '30111222', sexo: 'M'}}).nombre, `${estado} otro sexo`);
  }
  assert.equal(r.personaConfirmada({estado: 'encontrada', dni: '30111222', sexo: 'F'}, {dni: '30111222', sexo: 'F'}), true);
  assert.equal(r.personaConfirmada({estado: 'encontrada', dni: '30111222', sexo: 'F'}, {dni: '30111223', sexo: 'F'}), false);
  assert.equal(r.personaConfirmada({estado: 'encontrada', dni: '30111222', sexo: 'F'}), false);
  assert.equal(r.ETIQUETAS.fotos, 'Fotos');
  assert.deepEqual(plano(Object.keys(r.validarConsulta({dni: '30111222', sexo: 'f'}))), []);
  assert.deepEqual(plano(Object.keys(r.validarConsulta({dni: '30', sexo: 'X'}))), ['dni', 'sexo']);
});

test('fecha de nacimiento opcional pero real', async () => {
  const r = await cargar();
  assert.equal(r.validarCaso({...VALIDO, fecha_nacimiento: ''}).fecha_nacimiento, undefined);
  assert.equal(r.validarCaso({...VALIDO, fecha_nacimiento: '29/02/2024'}).fecha_nacimiento, undefined);
  assert.equal(r.validarCaso({...VALIDO, fecha_nacimiento: '1984-03-02'}).fecha_nacimiento, undefined);
  assert.ok(r.validarCaso({...VALIDO, fecha_nacimiento: '29/02/2023'}).fecha_nacimiento);
  assert.ok(r.validarCaso({...VALIDO, fecha_nacimiento: 'ayer'}).fecha_nacimiento);
});

test('contadores ≥ 0 con suma ≥ 1 (en `total`) y los topes de asistencia', async () => {
  const r = await cargar();
  const base = {...VALIDO, adultos_f: 0};
  assert.ok(r.validarCaso(base).total);
  assert.equal(r.validarCaso({...base, mayores_m: 1}).total, undefined);
  assert.ok(r.validarCaso({...base, adultos_f: -3}).total, 'un negativo cuenta 0');
  assert.equal(r.aCantidad('3'), 3); assert.equal(r.aCantidad(-1), 0); assert.equal(r.aCantidad('x'), 0); assert.equal(r.aCantidad(2.7), 2);
  const familia = {...VALIDO, adultos_f: 1, menores_m: 1, mayores_f: 1};
  assert.equal(r.totalDeclarado(familia), 3);
  assert.equal(r.validarCaso({...familia, dependientes: 3}).dependientes, undefined);
  assert.ok(r.validarCaso({...familia, dependientes: 4}).dependientes);
  assert.equal(r.validarCaso({...familia, mayores_dependientes: 1}).mayores_dependientes, undefined);
  assert.ok(r.validarCaso({...familia, mayores_dependientes: 2}).mayores_dependientes);
  assert.equal(r.validarCaso({...familia, lactantes: 1}).lactantes, undefined);
  assert.ok(r.validarCaso({...familia, lactantes: 2}).lactantes);
});

test('dirección obligatoria hasta 240 y GPS en rango', async () => {
  const r = await cargar();
  assert.ok(r.validarCaso({...VALIDO, direccion: '  '}).direccion);
  assert.equal(r.validarCaso({...VALIDO, direccion: 'x'.repeat(240)}).direccion, undefined);
  assert.ok(r.validarCaso({...VALIDO, direccion: 'x'.repeat(241)}).direccion);
  assert.equal(r.validarCaso({...VALIDO, latitud: -27.4, longitud: -58.9}).latitud, undefined);
  assert.ok(r.validarCaso({...VALIDO, latitud: -91, longitud: -58.9}).latitud);
  assert.ok(r.validarCaso({...VALIDO, latitud: -27, longitud: 181}).latitud);
});

test('datosDelCaso: claves del §6, enteros, booleanos y la ubicación junta', async () => {
  const r = await cargar();
  const caso = plano(r.datosDelCaso({...r.datosIniciales(), ...VALIDO, dni: '30.111.222', sexo: 'F', consulta: {estado: 'encontrada'},
    localidad_nombre: 'Barranqueras', localidad: 12, menores_m: '2', embarazo: true, latitud: -27.4, longitud: null}));
  assert.equal(caso.dni, '30111222'); assert.equal(caso.menores_m, 2); assert.equal(caso.embarazo, true);
  assert.equal(caso.mascotas, false); assert.equal(caso.localidad, 12);
  for (const fuera of ['sexo', 'consulta', 'localidad_nombre', 'latitud', 'longitud', 'precision_m', 'total']) assert.ok(!(fuera in caso), fuera);
  const conGps = r.datosDelCaso({...VALIDO, latitud: -27.4, longitud: -58.9, precision_m: 10});
  assert.equal(conGps.latitud, -27.4); assert.equal(conGps.precision_m, 10);
});

test('erroresDelServidor: una clave por campo, sin detail ni code; non_field_errors solo si no hay otra', async () => {
  const r = await cargar();
  assert.deepEqual(plano(r.erroresDelServidor({total: ['Cargá al menos una persona.'], direccion: ['Escribí la dirección.'],
    detail: 'Cargá al menos una persona.', non_field_errors: ['a', 'b'], code: 'VALIDACION'})),
  {total: ['Cargá al menos una persona.'], direccion: ['Escribí la dirección.']});
  assert.deepEqual(plano(r.erroresDelServidor({detail: 'Algo', non_field_errors: ['Algo'], code: 'VALIDACION'})), {non_field_errors: ['Algo']});
  assert.deepEqual(plano(r.erroresDelServidor({detail: 'Solo detalle'})), {non_field_errors: ['Solo detalle']});
  assert.deepEqual(plano(r.erroresDelServidor(null)), {});
  assert.deepEqual(plano(r.listaDeErrores({total: ['x']})), [{campo: 'total', etiqueta: 'Personas', texto: 'x'}]);
});

test('textos por code y estados del caso', async () => {
  const r = await cargar();
  assert.match(r.textoDeCode('UUID_EN_USO'), /No se reintenta/);
  assert.match(r.textoDeCode('SIN_MODULO'), /agente territorial/);
  assert.equal(r.textoDeCode('OTRO', 'Detalle del back'), 'Detalle del back');
  assert.equal(r.textoDeCode('OTRO'), 'No se pudo enviar.');
  assert.deepEqual(plano(r.estadoDelCaso('INGRESO_EN_CURSO')), {titulo: 'Ingreso en curso', tono: 'warning'});
  assert.deepEqual(plano(r.estadoDelCaso('raro_nuevo')), {titulo: 'raro nuevo', tono: 'gray'});
});

test('filtrarLocalidades: sin acentos, primero las que empiezan con lo escrito, con tope', async () => {
  const r = await cargar();
  const lista = [{id: 1, nombre: 'Resistencia'}, {id: 2, nombre: 'Barranqueras'}, {id: 3, nombre: 'Colonia Benítez'},
    {id: 4, nombre: 'Benítez'}, {id: 5, nombre: 'Puerto Bermejo'}];
  assert.deepEqual(plano(r.filtrarLocalidades(lista, 'benit').map((l) => l.id)), [4, 3]);
  assert.deepEqual(plano(r.filtrarLocalidades(lista, 'BÉNIT').map((l) => l.id)), [4, 3]);
  assert.deepEqual(r.filtrarLocalidades(lista, '').length, 0);
  assert.equal(r.filtrarLocalidades(lista, 'e', 2).length, 2);
  assert.equal(r.resumenDeFamilia({...VALIDO, menores_f: 2}), 'Benitez, Rosa · DNI 30111222 · 3 personas');
});
