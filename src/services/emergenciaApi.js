// Llamadas a /api/emergencia/ que usan M1 (ingreso de familias), M2 (llegada de familias) y M3
// (recepción de kits). El
// contrato es docs/internal/contrato-app-emergencia.md de Chaco-Back; los nombres de campos son
// los de ahí, sin traducir. El perfil vive en emergenciaPerfil.js.
//
// Todas pasan el 403 SIN_MODULO por verificarSinModulo: en Emergencia ese código también
// significa «falta un permiso parcial», así que se vuelve a pedir el perfil antes de sacar el
// módulo. El resultado ('quitado', 'actualizado' o 'sin_verificar') queda en
// `error.verificacionSinModulo`, y el error sale igual.
import { becasRequest, uploadMultipart } from './becasApi';
import { verificarSinModulo } from './emergenciaPerfil';
import { consultarIdentidad } from './identityLookup';
import { normalizeDateText } from '../utils/dni';
import { nombreJpg } from './webImages';

export const BASE = '/api/emergencia/';
export const RUTAS = {
  indice: BASE,
  personasConsultar: `${BASE}personas/consultar/`,
  localidades: `${BASE}localidades/`,
  casos: `${BASE}casos/`,
  casosMios: `${BASE}casos/mios/`,
  misDispositivos: `${BASE}mis-dispositivos/`,
  entregasDispositivo: (id) => `${BASE}dispositivos/${encodeURIComponent(id)}/entregas/`,
  entrega: (id) => `${BASE}entregas/${encodeURIComponent(id)}/`,
  recibirEntrega: (id) => `${BASE}entregas/${encodeURIComponent(id)}/recibir/`,
  buscarFamilia: (id, dni) => `${BASE}dispositivos/${encodeURIComponent(id)}/buscar/?dni=${encodeURIComponent(dni)}`,
  aceptarDerivacion: (id) => `${BASE}derivaciones/${encodeURIComponent(id)}/aceptar/`,
  rechazarDerivacion: (id) => `${BASE}derivaciones/${encodeURIComponent(id)}/rechazar/`,
  integrantes: (id) => `${BASE}casos/${encodeURIComponent(id)}/integrantes/`,
  integrante: (id, n) => `${BASE}casos/${encodeURIComponent(id)}/integrantes/${encodeURIComponent(n)}/`,
  confirmarIntegrante: (id, n) => `${BASE}casos/${encodeURIComponent(id)}/integrantes/${encodeURIComponent(n)}/confirmar/`,
  plazas: (id, caso) => `${BASE}dispositivos/${encodeURIComponent(id)}/plazas/?caso=${encodeURIComponent(caso)}`,
  alojar: (id) => `${BASE}casos/${encodeURIComponent(id)}/alojar/`,
  cerrarDiferencia: (id) => `${BASE}casos/${encodeURIComponent(id)}/cerrar-diferencia/`,
  cancelarIngreso: (id) => `${BASE}casos/${encodeURIComponent(id)}/cancelar-ingreso/`,
  ingresoDirecto: (id) => `${BASE}dispositivos/${encodeURIComponent(id)}/ingreso-directo/`,
  avisarMesa: (id) => `${BASE}dispositivos/${encodeURIComponent(id)}/avisar-mesa/`,
};

// §4: Emergencia no tiene padrones; consulta solo Base de Personas.
export const ORIGENES_IDENTIDAD = ['personas'];

// §6, en el orden de la tabla. Cualquier otra clave se ignora en el back (`total` y `prioridad`
// los calcula el servidor): acá no se mandan.
export const CAMPOS_CASO = [
  'uuid_cliente', 'relevado_en', 'traslado', 'traslado_otro', 'dni', 'nombre', 'apellido',
  'fecha_nacimiento', 'telefono', 'documento_extraviado',
  'menores_f', 'menores_m', 'adultos_f', 'adultos_m', 'mayores_f', 'mayores_m',
  'dependientes', 'mayores_dependientes', 'lactantes',
  'embarazo', 'electrodependiente', 'medicacion_critica', 'mascotas',
  'direccion', 'localidad', 'latitud', 'longitud', 'precision_m', 'observaciones',
];
export const FOTOS_CASO = ['foto_vivienda', 'foto_acceso'];

const conVerificacion = async (pedido) => {
  try {
    return await pedido();
  } catch (error) {
    const verificacion = await verificarSinModulo(error);
    if (verificacion) error.verificacionSinModulo = verificacion;
    throw error;
  }
};

const presente = (valor) => valor !== null && valor !== undefined && !(typeof valor === 'string' && valor.trim() === '');

// Un asset ya convertido con aJpeg → el archivo del multipart. El back exige extensión .jpg/.jpeg.
export const archivoJpeg = (campo, asset) => {
  if (!asset?.uri && !asset?.file) return null;
  const nombre = String(asset.fileName || asset.name || '');
  return {
    campo,
    uri: asset.uri,
    nombre: /\.jpe?g$/i.test(nombre) ? nombre : nombreJpg(nombre || campo),
    tipo: 'image/jpeg',
    webData: asset.file,
  };
};

const dos = (n) => String(n).padStart(2, '0');

export const ERROR_FECHA_INVALIDA = 'FECHA_INVALIDA';

const errorFecha = (campo, valor) => Object.assign(
  new Error(campo === 'relevado_en'
    ? 'La hora del relevamiento no es válida.'
    : 'La fecha de nacimiento no es válida: tiene que ser DD/MM/AAAA.'),
  { code: ERROR_FECHA_INVALIDA, campo, valor });

// Sin instanceof: un Date de otro realm (iframe, vm) también cuenta.
const esDate = (valor) => Object.prototype.toString.call(valor) === '[object Date]';
const esFechaValida = (fecha) => esDate(fecha) && !Number.isNaN(fecha.getTime());

// `Date` → ISO 8601 con el offset local del teléfono (2026-11-14T10:20:30-03:00); un texto se
// manda tal cual (se supone ya ISO con zona). §6 «Hora del relevamiento».
export const relevadoEnIso = (valor) => {
  if (!esDate(valor)) return valor;
  if (!esFechaValida(valor)) throw errorFecha('relevado_en', valor);
  const minutos = -valor.getTimezoneOffset();
  const signo = minutos >= 0 ? '+' : '-';
  const offset = `${signo}${dos(Math.floor(Math.abs(minutos) / 60))}:${dos(Math.abs(minutos) % 60)}`;
  return `${valor.getFullYear()}-${dos(valor.getMonth() + 1)}-${dos(valor.getDate())}T${dos(valor.getHours())}:`
    + `${dos(valor.getMinutes())}:${dos(valor.getSeconds())}${offset}`;
};

const diaReal = (anio, mes, dia) => {
  const fecha = new Date(anio, mes - 1, dia);
  return fecha.getFullYear() === anio && fecha.getMonth() === mes - 1 && fecha.getDate() === dia;
};

// §6 pide `AAAA-MM-DD`. Acepta `Date` (fecha local), `AAAA-MM-DD` y lo que entiende
// normalizeDateText (la pantalla guarda DD/MM/AAAA). Una fecha que no existe o no se entiende
// es un error FECHA_INVALIDA antes de mandar nada: el alta mínima no puede quedar con otra fecha.
export const fechaNacimientoIso = (valor) => {
  if (esDate(valor)) {
    if (!esFechaValida(valor)) throw errorFecha('fecha_nacimiento', valor);
    return `${valor.getFullYear()}-${dos(valor.getMonth() + 1)}-${dos(valor.getDate())}`;
  }
  const texto = String(valor).trim();
  const iso = texto.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const local = iso ? null : normalizeDateText(texto).match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  const [anio, mes, dia] = iso ? [iso[1], iso[2], iso[3]] : local ? [local[3], local[2], local[1]] : [];
  if (!anio || !diaReal(Number(anio), Number(mes), Number(dia))) throw errorFecha('fecha_nacimiento', valor);
  return `${anio}-${mes}-${dia}`;
};

const exigirUuid = (uuid) => {
  if (!presente(uuid)) throw new Error('Falta uuid_cliente: se genera al abrir el formulario.');
};

export const getIndice = () => conVerificacion(() => becasRequest(RUTAS.indice));

export const getLocalidades = () => conVerificacion(() => becasRequest(RUTAS.localidades));

// §4. Mismo cuerpo y códigos que la consulta de Becas (identityFailure sirve igual).
export const consultarPersona = ({ dni, sexo }) => conVerificacion(() => consultarIdentidad(
  { dni, sexo }, { ruta: RUTAS.personasConsultar, origenes: ORIGENES_IDENTIDAD }));

// §6. `datos` con las claves de CAMPOS_CASO (las demás no se mandan); `fotos` con
// `foto_vivienda` y `foto_acceso` como assets de aJpeg, opcionales. Latitud y longitud van
// juntas: si falta una, no se manda ninguna. `relevado_en` y `fecha_nacimiento` se normalizan
// (relevadoEnIso, fechaNacimientoIso). 201 creado o 200 ya existía, mismo cuerpo.
// `token`: el de la sesión dueña del envío (la cola lo fija al empezar la pasada).
export const enviarCaso = async (datos = {}, fotos = {}, { timeoutMs, token } = {}) => {
  exigirUuid(datos.uuid_cliente);
  const fields = {};
  CAMPOS_CASO.forEach((campo) => {
    if (presente(datos[campo])) fields[campo] = datos[campo];
  });
  if (presente(fields.relevado_en)) fields.relevado_en = relevadoEnIso(fields.relevado_en);
  if (presente(fields.fecha_nacimiento)) fields.fecha_nacimiento = fechaNacimientoIso(fields.fecha_nacimiento);
  if (!presente(fields.latitud) || !presente(fields.longitud)) {
    delete fields.latitud;
    delete fields.longitud;
  }
  const files = FOTOS_CASO.map((campo) => archivoJpeg(campo, fotos[campo])).filter(Boolean);
  return conVerificacion(() => uploadMultipart(RUTAS.casos, { fields, files, timeoutMs, token }));
};

export const getMisCasos = () => conVerificacion(() => becasRequest(RUTAS.casosMios));

export const getMisDispositivos = () => conVerificacion(() => becasRequest(RUTAS.misDispositivos));

// §10. Con `pendientes`, las que esperan recepción (la lista de M3-1).
export const getEntregasDispositivo = (dispositivoId, { pendientes = false } = {}) => conVerificacion(
  () => becasRequest(`${RUTAS.entregasDispositivo(dispositivoId)}${pendientes ? '?pendientes=1' : ''}`));

export const getEntrega = (entregaId) => conVerificacion(() => becasRequest(RUTAS.entrega(entregaId)));

// §12. `cantidades` es { <id del ítem>: cantidad }, una por línea aunque sea 0; va como
// `cantidades[<id>]`. `remito` es el asset de aJpeg. Requiere conexión: no se encola.
// `token`: el de la sesión con la que se abrió la recepción (no se relee).
export const recibirEntrega = async (entregaId, { uuid_cliente, cantidades = {}, remito, observacion } = {}, { timeoutMs, token } = {}) => {
  exigirUuid(uuid_cliente);
  const fields = { uuid_cliente };
  Object.entries(cantidades || {}).forEach(([item, cantidad]) => {
    if (presente(cantidad)) fields[`cantidades[${item}]`] = cantidad;
  });
  if (presente(observacion)) fields.observacion = observacion;
  const files = [archivoJpeg('remito', remito)].filter(Boolean);
  return conVerificacion(() => uploadMultipart(RUTAS.recibirEntrega(entregaId), { fields, files, timeoutMs, token }));
};

// ---- M2 · Llegada de familias (§13.1 a §13.10) ----
// Todo M2 es JSON y con conexión. Acá:
// - `token` es el de la sesión con la que se abrió la pantalla: becasRequest lo usa tal cual (no relee
//   la sesión), así un pedido de la persona anterior nunca sale con el token de la siguiente, y su 401
//   invalida solo si ese token sigue vigente. La respuesta que llega con otra sesión ya abierta la
//   descarta emergenciaLlegadas (`obsoleto`).
// - `timeoutMs` aborta el fetch y sale con un error `network` + `timeout` (lo hace becasRequest);
//   sin él rige el límite por defecto de becasRequest.
export const errorObsoleto = () => Object.assign(new Error('La sesión cambió: este pedido era de otra sesión.'), { obsoleto: true });

const pedirJson = async (path, { method = 'GET', body, token = null, timeoutMs = null } = {}) => becasRequest(path, {
  method,
  ...(body !== undefined ? { body } : {}),
  ...(token ? { token } : {}),
  ...(Number(timeoutMs) > 0 ? { timeoutMs: Number(timeoutMs) } : {}),
});

// §13.2. `dni`: solo dígitos (el back normaliza igual). 429 trae `retryAfter`.
export const buscarFamilia = (dispositivoId, dni, opciones = {}) => conVerificacion(
  () => pedirJson(RUTAS.buscarFamilia(dispositivoId, dni), opciones));

// §13.3. `uuid_cliente` no se guarda en el back: aceptar NO es idempotente (un reintento da 409 con
// `estado_actual: INGRESO_EN_CURSO`).
export const aceptarDerivacion = (derivacionId, { uuid_cliente } = {}, opciones = {}) => conVerificacion(
  () => pedirJson(RUTAS.aceptarDerivacion(derivacionId), { ...opciones, method: 'POST', body: presente(uuid_cliente) ? { uuid_cliente } : {} }));

// §13.4. `observacion` va solo si hay (obligatoria con `OTRO`, la valida el back).
export const rechazarDerivacion = (derivacionId, { motivo, observacion } = {}, opciones = {}) => {
  const body = { motivo };
  if (presente(observacion)) body.observacion = String(observacion).trim();
  return conVerificacion(() => pedirJson(RUTAS.rechazarDerivacion(derivacionId), { ...opciones, method: 'POST', body }));
};

// §13.5.
export const getIntegrantes = (casoId, opciones = {}) => conVerificacion(() => pedirJson(RUTAS.integrantes(casoId), opciones));

// §13.5 «Agregar persona»: idempotente por `uuid_cliente` (201 la primera vez, 200 el reenvío).
export const agregarIntegrante = (casoId, { uuid_cliente } = {}, opciones = {}) => {
  exigirUuid(uuid_cliente);
  return conVerificacion(() => pedirJson(RUTAS.integrantes(casoId), { ...opciones, method: 'POST', body: { uuid_cliente } }));
};

// §13.6: una persona con su ficha guardada (`ficha`, `secciones_incompletas`). 404 si `n` no es de la familia.
export const getIntegrante = (casoId, n, opciones = {}) => conVerificacion(() => pedirJson(RUTAS.integrante(casoId, n), opciones));

// §13.6 «Completar la ficha»: PATCH con las secciones 4 a 8 que se cargan; cada una que viene reemplaza a
// la guardada. Repetirlo deja lo mismo (no necesita uuid).
export const completarFichaIntegrante = (casoId, n, { ficha } = {}, opciones = {}) => conVerificacion(
  () => pedirJson(RUTAS.integrante(casoId, n), { ...opciones, method: 'PATCH', body: { ficha: ficha || {} } }));

// §13.7: el mapa de camas del dispositivo para elegir la de una persona del caso.
export const getPlazas = (dispositivoId, casoId, opciones = {}) => conVerificacion(
  () => pedirJson(RUTAS.plazas(dispositivoId, casoId), opciones));

// §13.8 «Confirmar persona»: idempotente por `uuid_cliente` (201 la primera vez, 200 el reenvío con la
// misma fila). `ficha` anidada (§13.11) y `plaza_id`, los tres obligatorios.
export const confirmarIntegrante = (casoId, n, { uuid_cliente, ficha, plaza_id } = {}, opciones = {}) => {
  exigirUuid(uuid_cliente);
  return conVerificacion(() => pedirJson(RUTAS.confirmarIntegrante(casoId, n),
    { ...opciones, method: 'POST', body: { uuid_cliente, plaza_id, ficha: ficha || {} } }));
};

// ---- M2 parte 3: cerrar el ingreso (§13.9) y sin derivación (§13.10) ----

// Cambio 477: los tres cierres aceptan `derivacion`, opcional: el `derivacion.id` que trajo integrantes
// (§13.5). Con él, el back responde 409 (sin escribir) si el ingreso ya es otro. Solo viaja un entero ≥ 1
// (otra cosa sería un 400 `derivacion`); sin él el cierre sale como antes (el back viejo lo ignora).
export const idDeDerivacion = (valor) => {
  if (valor === null || valor === undefined || valor === '' || typeof valor === 'boolean') return null;
  const n = Number(valor);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
};
const conDerivacion = (body, derivacion) => {
  const id = idDeDerivacion(derivacion);
  if (id !== null) body.derivacion = id;
  return body;
};

// §13.9 «Familia alojada» (N de N). Los cinco campos son opcionales; `tarjeta_numero` va con la tarjeta
// entregada. NO es idempotente: el reintento de un envío que llegó da 409 ALOJADO (o CERRADO).
export const alojarFamilia = (casoId, {
  sector = null, aula = '', tarjeta_entregada = false, tarjeta_numero = '', encargado = '', derivacion = null,
} = {}, opciones = {}) => {
  const body = { tarjeta_entregada: tarjeta_entregada === true };
  if (presente(sector)) body.sector = Number(sector);
  if (presente(aula)) body.aula = String(aula).trim();
  if (body.tarjeta_entregada && presente(tarjeta_numero)) body.tarjeta_numero = String(tarjeta_numero).trim();
  if (presente(encargado)) body.encargado = String(encargado).trim();
  conDerivacion(body, derivacion);
  return conVerificacion(() => pedirJson(RUTAS.alojar(casoId), { ...opciones, method: 'POST', body }));
};

// §13.9 «Cerrar con diferencia» (RN-3.9): `motivo` del catálogo; `observacion` obligatoria con OTRO.
// NO es idempotente.
export const cerrarConDiferencia = (casoId, { motivo, observacion, derivacion = null } = {}, opciones = {}) => {
  const body = { motivo };
  if (presente(observacion)) body.observacion = String(observacion).trim();
  conDerivacion(body, derivacion);
  return conVerificacion(() => pedirJson(RUTAS.cerrarDiferencia(casoId), { ...opciones, method: 'POST', body }));
};

// §13.9 «Cancelar el ingreso»: `motivo` texto obligatorio. NO es idempotente: el reintento de uno que
// llegó da 409 con el caso de vuelta en la mesa (EN_GESTION o NUEVO).
export const cancelarIngreso = (casoId, { motivo, derivacion = null } = {}, opciones = {}) => conVerificacion(
  () => pedirJson(RUTAS.cancelarIngreso(casoId), {
    ...opciones, method: 'POST', body: conDerivacion({ motivo: String(motivo ?? '').trim() }, derivacion),
  }));

// §13.10: el Formulario 1 de §6 en la puerta, sin `relevado_en` (vale la hora del servidor) y sin fotos ni
// GPS. Va como JSON (la vista acepta JSON además de multipart: sin archivos no hace falta). Lo vacío no
// se manda; `fecha_nacimiento` se normaliza a AAAA-MM-DD (FECHA_INVALIDA antes de mandar).
export const CAMPOS_PUERTA = CAMPOS_CASO.filter((campo) => !['relevado_en', 'latitud', 'longitud', 'precision_m'].includes(campo));
export const cuerpoDeLaPuerta = (datos = {}) => {
  exigirUuid(datos.uuid_cliente);
  const body = {};
  CAMPOS_PUERTA.forEach((campo) => {
    if (presente(datos[campo])) body[campo] = datos[campo];
  });
  if (presente(body.fecha_nacimiento)) body.fecha_nacimiento = fechaNacimientoIso(body.fecha_nacimiento);
  return body;
};

// §13.10 «Ingresar igual»: idempotente por `uuid_cliente` (201 el caso nuevo con el ingreso en curso, 200
// el reenvío con el mismo caso y lo que reservó la primera vez). 400 `plazas`: no hay camas libres.
export const ingresoDirecto = (dispositivoId, datos = {}, opciones = {}) => {
  const body = cuerpoDeLaPuerta(datos);
  return conVerificacion(() => pedirJson(RUTAS.ingresoDirecto(dispositivoId), { ...opciones, method: 'POST', body }));
};

// §13.10 «Avisar a la mesa»: el mismo cuerpo; crea el caso NUEVO «En la puerta de …». Idempotente igual.
export const avisarALaMesa = (dispositivoId, datos = {}, opciones = {}) => {
  const body = cuerpoDeLaPuerta(datos);
  return conVerificacion(() => pedirJson(RUTAS.avisarMesa(dispositivoId), { ...opciones, method: 'POST', body }));
};

const es409 = (error) => Number(error?.status) === 409 && !error?.unexpectedHtml;

// 409 con `estado_actual` (§2, §12, §13): otra guardia, la mesa o el backoffice ya cambió el
// estado. Se muestra `detail` y se recarga según `estado_actual`.
export const esConflictoDeEstado = (error) => es409(error)
  && typeof error?.payload?.estado_actual === 'string' && error.payload.estado_actual !== '';

// 409 `UUID_EN_USO`: ese uuid_cliente ya es de otro caso u otra recepción. No se reintenta con él.
export const esUuidEnUso = (error) => es409(error) && error?.payload?.code === 'UUID_EN_USO';
