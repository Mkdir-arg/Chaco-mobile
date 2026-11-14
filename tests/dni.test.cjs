// utils/dni.js: el parser del código del DNI que salió de RelevamientoDetailScreen, con los
// formatos que ya leía (PDF417 del DNI argentino, QR, JSON, parámetros, token firmado, texto).
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {setup} = require('./helpers/mobile-runtime.cjs');

let dni;
const cargar = async () => { dni ??= (await setup()).load('../utils/dni'); return dni; };
const plano = (valor) => JSON.parse(JSON.stringify(valor));

test('PDF417 del DNI argentino (tramite@apellido@nombres@sexo@dni@ejemplar@nacimiento@emision)', async () => {
  const {parseDniCode} = await cargar();
  const raw = '00612345678@BENITEZ@ROSA MARIA@F@30111222@B@02/03/1984@15/06/2016@200';
  assert.deepEqual(plano(parseDniCode(raw, 'PDF417')), {
    dni_tramite: '00612345678', apellido: 'BENITEZ', nombres: 'ROSA MARIA', dni_sexo: 'F',
    dni_numero: '30111222', ejemplar: 'B', fecha_nacimiento: '02/03/1984', fecha_emision: '15/06/2016',
  });
  // Sin el tipo de código, lo reconoce por la forma.
  assert.equal(parseDniCode(raw, '').dni_numero, '30111222');
  assert.equal(parseDniCode(raw, 'org.iso.PDF417').apellido, 'BENITEZ');
});

test('PDF417 con DNI de 7 dígitos, sexo M y partes con + o %20', async () => {
  const {parseDniCode} = await cargar();
  const resultado = parseDniCode('00498765432@GOMEZ@JUAN+CARLOS@M@9876543@A@1960-11-05@20140101', 'pdf417');
  assert.equal(resultado.dni_numero, '9876543');
  assert.equal(resultado.nombres, 'JUAN CARLOS');
  assert.equal(resultado.dni_sexo, 'M');
  assert.equal(resultado.fecha_nacimiento, '05/11/1960');
  assert.equal(resultado.fecha_emision, '01/01/2014');
});

test('QR (tramite@apellido@nombres@dni@ejemplar@nacimiento@emision@...)', async () => {
  const {parseDniCode} = await cargar();
  assert.deepEqual(plano(parseDniCode('00612345678@BENITEZ@ROSA@30111222@B@02/03/1984@15/06/2016@x', 'QR_CODE')), {
    dni_tramite: '00612345678', apellido: 'BENITEZ', nombres: 'ROSA', dni_numero: '30111222', ejemplar: 'B',
    fecha_nacimiento: '02/03/1984', fecha_emision: '15/06/2016',
  });
});

test('JSON, parámetros de URL y token firmado', async () => {
  const {parseDniCode} = await cargar();
  assert.deepEqual(plano(parseDniCode(JSON.stringify({persona: {numeroDocumento: '30.111.222', sexo: 'Femenino', apellido: 'Benitez', nombre: 'Rosa', fechaNacimiento: '1984-03-02'}}))), {
    dni_numero: '30111222', dni_sexo: 'F', apellido: 'Benitez', nombres: 'Rosa', fecha_nacimiento: '02/03/1984',
  });
  assert.deepEqual(plano(parseDniCode('https://dni.test/v?dni=30111222&sexo=M&apellido=Gomez&nombre=Juan%20Carlos')), {
    dni_numero: '30111222', dni_sexo: 'M', apellido: 'Gomez', nombres: 'Juan Carlos',
  });
  const payload = Buffer.from(JSON.stringify({dni: '30111222', apellido: 'PEREZ', nombres: 'ANA', sexo: 'F', id_tramite: '00612345678'})).toString('base64url');
  assert.deepEqual(plano(parseDniCode(`https://x.test/?t=h.${payload}.s`)), {
    dni_numero: '30111222', dni_sexo: 'F', dni_tramite: '00612345678', apellido: 'PEREZ', nombres: 'ANA',
  });
});

test('separado por |, texto libre y vacío', async () => {
  const {parseDniCode} = await cargar();
  const pipe = parseDniCode('A|PEREZ|ANA|F|30111222|02/03/1984', '');
  assert.equal(pipe.dni_numero, '30111222'); assert.equal(pipe.dni_sexo, 'F'); assert.equal(pipe.apellido, 'PEREZ');
  assert.deepEqual(plano(parseDniCode('documento 30111222 leído')), {dni_numero: '30111222'});
  assert.deepEqual(plano(parseDniCode('sin numero')), {dni_numero: ''});
  assert.deepEqual(plano(parseDniCode('')), {});
  assert.deepEqual(plano(parseDniCode(null)), {});
});

test('helpers: dígitos, DNI válido, sexo y fechas', async () => {
  const {cleanDigits, isValidDni, normalizeSex, normalizeDateText} = await cargar();
  assert.equal(cleanDigits('30.111.222'), '30111222');
  assert.equal(isValidDni('30.111.222'), true); assert.equal(isValidDni('123456'), false); assert.equal(isValidDni('123456789'), false);
  assert.deepEqual(['1', '2', '3', 'masculino', 'FEM', 'x', 'otro'].map(normalizeSex), ['M', 'F', 'X', 'M', 'F', 'X', '']);
  assert.equal(normalizeDateText('1984-03-02'), '02/03/1984');
  assert.equal(normalizeDateText('19840302'), '02/03/1984');
  assert.equal(normalizeDateText('02031984'), '02/03/1984');
  assert.equal(normalizeDateText('1970-01-01'), '');
});

test('RelevamientoDetailScreen usa el parser de utils/dni y ya no tiene el suyo', () => {
  const fuente = fs.readFileSync(path.join(__dirname, '..', 'src/screens/RelevamientoDetailScreen.js'), 'utf8');
  assert.match(fuente, /import \{[^}]*\bparseDniCode\b[^}]*\} from '\.\.\/utils\/dni';/);
  assert.doesNotMatch(fuente, /const parseDniCode\s*=/);
  assert.doesNotMatch(fuente, /const (normalizeSex|cleanDigits|normalizeDateText|isValidDni)\s*=/);
});
