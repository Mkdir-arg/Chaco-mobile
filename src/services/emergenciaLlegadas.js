import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import { getBecasToken, getStoredBecasUser } from './becasApi';
import {
  aceptarDerivacion, agregarIntegrante, buscarFamilia, completarFichaIntegrante, confirmarIntegrante, errorObsoleto,
  esConflictoDeEstado, esUuidEnUso, getIntegrante, getIntegrantes, getPlazas, rechazarDerivacion,
} from './emergenciaApi';
import { esSinModulo } from './sinModulo';
import { erroresDelServidor } from '../utils/emergencia';
import { cleanDigits, isValidDni } from '../utils/dni';
import { CAMPOS_FICHA, SECCIONES_OPCIONALES, fichaDesdePlano } from '../utils/fichaEmergencia';
import { hayConexion } from './emergenciaKits';
import { PREFIJO_BORRADOR_FICHA, VIDA_BORRADOR_MS, enOrdenGuardado } from './emergenciaLimpieza';

// La red, como M3: en web `navigator.onLine`, en nativo NetInfo.
export { escucharRed, hayConexion } from './emergenciaKits';

// M2 · Llegada de familias (contrato-app-emergencia §13.1 a §13.8): buscar a la familia por DNI,
// aceptar o rechazar la derivación, los integrantes y «agregar persona» (parte 1), y una persona con
// su ficha, el mapa de camas y «confirmar persona» (parte 2). Va SIN cola y sin
// lectura guardada: aceptar, confirmar y alojar trabajan sobre camas compartidas con toda la red
// (RU-3). Sin red la pantalla se bloquea con un aviso.
//
// El estado del recorrido es el del caso en el servidor, no el del teléfono: ante un 409 la app
// recarga la pantalla que corresponde a `estado_actual` (destinoPorEstado). El 409 de M2 no trae
// `code`; se distingue por `estado_actual`.

// ---- Textos ----
export const TEXTO_SIN_RED = 'Sin conexión: no podés buscar familias ni reservar camas. La llegada de familias necesita señal; probá cuando vuelva la red.';
export const TEXTO_ESPERAR = 'Hiciste muchas búsquedas seguidas. Esperá a que termine la cuenta para volver a buscar.';
export const TEXTO_ESPERAR_ACCION = 'El servidor pidió esperar antes de volver a intentar.';
export const TEXTO_REINTENTAR_LECTURA = 'No se pudo hablar con el servidor. Probá de nuevo.';
export const TEXTO_ACEPTAR_INCIERTO = 'No se pudo confirmar si la derivación se aceptó. «Reintentar» la vuelve a mandar: si ya había quedado aceptada, seguís con los integrantes.';
export const TEXTO_RECHAZAR_INCIERTO = 'No se pudo confirmar si el rechazo llegó. «Reintentar» lo vuelve a mandar: si ya había llegado, el caso figura de vuelta en la mesa.';
export const TEXTO_AGREGAR_INCIERTO = 'No se pudo confirmar si se sumó la persona. «Reintentar» manda el mismo pedido y no la suma dos veces.';
export const TEXTO_NO_ENCONTRADO = 'Esto ya no está disponible para vos. Se vuelve a cargar la lista de tus dispositivos.';
export const TEXTO_SESION = 'La sesión venció: volvé a entrar.';
export const TEXTO_ACEPTADA_ANTES = 'La derivación ya figura aceptada: seguís con los integrantes.';
export const TEXTO_RECHAZADA_ANTES = 'La derivación ya no está pendiente: el caso figura de vuelta en la mesa.';
export const TEXTO_UUID_EN_USO = 'Este pedido no se puede mandar: su identificador ya se usó en otro caso. Volvé a cargar los integrantes.';
export const DNI_INVALIDO = 'Ingresá un DNI válido de 7 u 8 dígitos, sin puntos.';
export const FALTA_MOTIVO = 'Elegí el motivo del rechazo.';
export const FALTA_OBSERVACION = 'Con el motivo «Otro», contá qué pasó.';
export const MAX_OBSERVACION = 500;

// Por defecto: una lectura no espera más de 20 s, una acción 30 s. Mutable solo para los tests.
export const LIMITES = { lecturaMs: 20000, accionMs: 30000 };

// §13.4, en el orden de la tabla.
export const MOTIVOS_RECHAZO = [
  { valor: 'SIN_PLAZAS', titulo: 'Sin plazas' },
  { valor: 'NO_CUMPLE_PERFIL', titulo: 'No cumple perfil' },
  { valor: 'NO_LLEGO', titulo: 'No llegó' },
  { valor: 'OTRO', titulo: 'Otro' },
];

// ---- Normalización ----
const entero = (valor) => {
  const numero = Number(valor);
  return Number.isInteger(numero) && numero >= 0 ? numero : 0;
};
const textoPlano = (valor) => (typeof valor === 'string' ? valor : '');

// §9: solo los dispositivos donde el usuario admite familias (`admite: true`).
export const dispositivosQueAdmiten = (lista) => (Array.isArray(lista) ? lista : [])
  .filter((item) => item && item.id != null && item.admite === true)
  .map((item) => ({
    id: item.id,
    nombre: textoPlano(item.nombre) || `Dispositivo ${item.id}`,
    plazas_libres: entero(item.plazas_libres),
    derivaciones_pendientes: entero(item.derivaciones_pendientes),
  }));

export const normalizarCaso = (caso) => {
  if (!caso || typeof caso !== 'object' || caso.id == null) return null;
  return {
    id: caso.id,
    numero: textoPlano(caso.numero) || String(caso.id),
    estado: textoPlano(caso.estado),
    prioridad: textoPlano(caso.prioridad),
    total_declarado: entero(caso.total_declarado),
  };
};

const GRUPO = [
  ['menores_f', 'Menores (F)'], ['menores_m', 'Menores (M)'], ['adultos_f', 'Adultos (F)'], ['adultos_m', 'Adultos (M)'],
  ['mayores_f', 'Mayores (F)'], ['mayores_m', 'Mayores (M)'],
];
const ASISTENCIA = [['dependientes', 'Dependientes'], ['mayores_dependientes', 'Mayores dependientes'], ['lactantes', 'Lactantes']];
const NECESIDADES = {
  embarazo: 'Embarazo',
  electrodependiente: 'Electrodependiente',
  medicacion_critica: 'Medicación crítica',
  mascotas: 'Mascotas',
};

const normalizarDerivacion = (derivacion) => {
  if (!derivacion || typeof derivacion !== 'object' || derivacion.id == null) return null;
  const responsable = derivacion.responsable && typeof derivacion.responsable === 'object' ? derivacion.responsable : {};
  const grupo = derivacion.grupo && typeof derivacion.grupo === 'object' ? derivacion.grupo : {};
  return {
    id: derivacion.id,
    estado: textoPlano(derivacion.estado),
    plazas_pedidas: entero(derivacion.plazas_pedidas),
    vence_en: derivacion.vence_en || null,
    vencida: derivacion.vencida === true,
    derivada_en: derivacion.derivada_en || null,
    derivada_por: textoPlano(derivacion.derivada_por),
    caso: normalizarCaso(derivacion.caso),
    responsable: {
      nombre: textoPlano(responsable.nombre),
      apellido: textoPlano(responsable.apellido),
      dni: textoPlano(responsable.dni),
    },
    grupo: Object.fromEntries([...GRUPO, ...ASISTENCIA].map(([clave]) => [clave, entero(grupo[clave])])),
    necesidades: (Array.isArray(derivacion.necesidades) ? derivacion.necesidades : []).filter((n) => typeof n === 'string'),
    telefono: textoPlano(derivacion.telefono),
    observaciones: textoPlano(derivacion.observaciones).trim(),
  };
};

// §13.2 → { resultado, dni, plazas_libres, mensaje, derivacion, alojada_aca, alojada_en, alojada_desde }.
export const normalizarBusqueda = (payload) => {
  const datos = payload && typeof payload === 'object' ? payload : {};
  return {
    resultado: textoPlano(datos.resultado),
    dni: textoPlano(datos.dni),
    plazas_libres: entero(datos.plazas_libres),
    mensaje: textoPlano(datos.mensaje).trim(),
    derivacion: normalizarDerivacion(datos.derivacion),
    alojada_aca: typeof datos.alojada_aca === 'boolean' ? datos.alojada_aca : null,
    alojada_en: textoPlano(datos.alojada_en),
    alojada_desde: datos.alojada_desde || null,
  };
};

// Qué pantalla sigue a una búsqueda (§13.2): 'derivacion' (PENDIENTE: aceptar o rechazar),
// 'integrantes' (ACEPTADA), 'sin_derivacion' o 'alojada'. Un resultado que no se entiende es
// 'desconocido' (se muestra el mensaje y nada más).
export const pasoDeBusqueda = (busqueda) => {
  if (busqueda?.resultado === 'DERIVACION' && busqueda.derivacion) {
    if (busqueda.derivacion.estado === 'ACEPTADA' && busqueda.derivacion.caso) return 'integrantes';
    if (busqueda.derivacion.estado === 'PENDIENTE') return 'derivacion';
  }
  if (busqueda?.resultado === 'SIN_DERIVACION') return 'sin_derivacion';
  if (busqueda?.resultado === 'ALOJADA') return 'alojada';
  return 'desconocido';
};

// «Rosa Benítez · DNI 30111222».
export const nombreDelResponsable = ({ nombre = '', apellido = '', dni = '' } = {}) => {
  const quien = [nombre, apellido].filter(Boolean).join(' ').trim() || 'Responsable sin nombre';
  return dni ? `${quien} · DNI ${dni}` : quien;
};

// «Menores (F): 2 · Menores (M): 3 · Adultos (F): 1 …», solo lo que no es 0.
export const resumenDelGrupo = (grupo = {}) => {
  const partes = GRUPO.filter(([clave]) => grupo[clave] > 0).map(([clave, titulo]) => `${titulo}: ${grupo[clave]}`);
  return partes.length ? partes.join(' · ') : 'Sin detalle de personas';
};
export const resumenDeAsistencia = (grupo = {}) => ASISTENCIA
  .filter(([clave]) => grupo[clave] > 0).map(([clave, titulo]) => `${titulo}: ${grupo[clave]}`).join(' · ');

export const tituloDeNecesidad = (clave) => NECESIDADES[clave] || String(clave || '').replaceAll('_', ' ');

const ESTADOS_INTEGRANTE = {
  SIN_CONFIRMAR: ['Sin confirmar', 'gray'],
  CONFIRMADA: ['Confirmada', 'success'],
  EGRESADA: ['Egresada', 'info'],
};
export const estadoDeIntegrante = (estado) => {
  const valor = String(estado || '').toUpperCase();
  const [titulo, tono] = ESTADOS_INTEGRANTE[valor] || [valor ? valor.replaceAll('_', ' ').toLowerCase() : 'Sin estado', 'gray'];
  return { titulo, tono };
};

const normalizarIntegrante = (fila) => {
  if (!fila || typeof fila !== 'object' || fila.n == null) return null;
  const persona = fila.persona && typeof fila.persona === 'object' ? fila.persona : null;
  const plaza = fila.plaza && typeof fila.plaza === 'object' ? fila.plaza : null;
  return {
    n: entero(fila.n),
    estado: textoPlano(fila.estado),
    ficha_completa: fila.ficha_completa === true,
    persona: persona ? { id: persona.id ?? null, nombre: textoPlano(persona.nombre), dni: textoPlano(persona.dni) } : null,
    plaza: plaza ? { id: plaza.id ?? null, codigo: textoPlano(plaza.codigo), nombre: textoPlano(plaza.nombre) } : null,
    parentesco: textoPlano(fila.parentesco),
    confirmada_en: fila.confirmada_en || null,
    egresado_en: fila.egresado_en || null,
  };
};

// §13.5 (también el cuerpo de aceptar, §13.3, que trae `integrantes`).
export const normalizarIntegrantes = (payload) => {
  const datos = payload && typeof payload === 'object' ? payload : {};
  const integrantes = (Array.isArray(datos.integrantes) ? datos.integrantes : []).map(normalizarIntegrante).filter(Boolean)
    .sort((a, b) => a.n - b.n);
  const caso = normalizarCaso(datos.caso);
  const total = datos.total_declarado != null ? entero(datos.total_declarado) : (caso?.total_declarado ?? integrantes.length);
  return {
    caso,
    integrantes,
    confirmadas: datos.confirmadas != null ? entero(datos.confirmadas) : integrantes.filter((i) => i.estado !== 'SIN_CONFIRMAR').length,
    total_declarado: total,
    declaradas_al_relevar: datos.declaradas_al_relevar != null ? entero(datos.declaradas_al_relevar) : total,
    con_ficha_incompleta: entero(datos.con_ficha_incompleta),
  };
};

// ¿La familia ya está alojada o el caso cerrado? M2-3 se muestra en modo lectura (§13.1).
export const ESTADOS_LECTURA = ['ALOJADO', 'CERRADO'];
export const esSoloLectura = (caso) => ESTADOS_LECTURA.includes(caso?.estado);

// Qué cierre ofrece M2-3 según el contador (§13.5): 'alojar' (N de N), 'diferencia' (algunas),
// 'cancelar' (ninguna). null en modo lectura.
export const cierreDisponible = ({ caso, confirmadas, total_declarado: total } = {}) => {
  if (!caso || esSoloLectura(caso)) return null;
  if (total > 0 && confirmadas >= total) return 'alojar';
  if (confirmadas > 0) return 'diferencia';
  return 'cancelar';
};

// «1 de 7 confirmadas».
export const textoDelContador = ({ confirmadas = 0, total_declarado: total = 0 } = {}) => `${confirmadas} de ${total} confirmadas`;
// «Llegaron 8 sobre 7 declaradas», o null si no creció.
export const textoDeCrecimiento = ({ total_declarado: total = 0, declaradas_al_relevar: declaradas = 0 } = {}) => (
  total > declaradas ? `Llegaron ${total} sobre ${declaradas} declaradas al relevar` : null);

// ---- Router de recarga por `estado_actual` (§13.1) ----
// - 'derivacion': DERIVADO, la derivación sigue pendiente → se vuelve a buscar por el DNI (trae la
//   derivación vigente, que puede ser otra).
// - 'integrantes': INGRESO_EN_CURSO, o ALOJADO/CERRADO en modo lectura.
// - 'buscar': EN_GESTION, NUEVO o cualquier otro → el caso volvió a la mesa; buscar de nuevo.
export const destinoPorEstado = (estado) => {
  const valor = String(estado || '').toUpperCase();
  if (valor === 'DERIVADO') return 'derivacion';
  if (valor === 'INGRESO_EN_CURSO' || ESTADOS_LECTURA.includes(valor)) return 'integrantes';
  return 'buscar';
};

// ---- Validación de cliente ----
export const validarDni = (texto) => (isValidDni(texto) ? null : DNI_INVALIDO);

export const validarRechazo = ({ motivo, observacion } = {}) => {
  const errores = {};
  if (!MOTIVOS_RECHAZO.some((m) => m.valor === motivo)) errores.motivo = [FALTA_MOTIVO];
  if (motivo === 'OTRO' && !String(observacion || '').trim()) errores.observacion = [FALTA_OBSERVACION];
  return errores;
};

// ---- Errores ----
const detalleDe = (error) => {
  const detail = error?.payload && typeof error.payload === 'object' ? error.payload.detail : null;
  return typeof detail === 'string' && detail.trim() ? detail.trim() : null;
};

// 400 VALIDACION → { <campo>: [..], generales: [..] }. `non_field_errors` y lo que no es un campo de
// la pantalla van a `generales`.
export const erroresDeLlegada = (payload, campos = []) => {
  const errores = {};
  Object.entries(erroresDelServidor(payload)).forEach(([clave, mensajes]) => {
    if (campos.includes(clave)) errores[clave] = mensajes;
    else errores.generales = [...(errores.generales || []), ...mensajes];
  });
  return errores;
};

// Por status y `code` (nunca por el texto). `tipo`:
// - obsoleto: el pedido era de otra sesión (se ignora).
// - sin_red: no salió (no hay conexión).
// - sesion: 401.  - sin_modulo: 403 SIN_MODULO (emergenciaApi ya pasó por verificarSinModulo).
// - conflicto: 409 con estado_actual → `destino` (destinoPorEstado) y `detail`.
// - uuid_en_uso: 409 UUID_EN_USO (agregar persona).
// - no_encontrado: 404 → recargar «mis dispositivos».
// - validacion: 400 VALIDACION → `errores` por campo (`campos`) y generales.
// - espera: 429 → `espera` en ms (Retry-After), o null.
// - reintentable: red, timeout, 5xx, página HTML del WAF → el pedido pudo haber llegado.
// - rechazo: cualquier otro.
export const clasificarErrorLlegada = (error, { campos = [] } = {}) => {
  const status = Number(error?.status || 0);
  const detalle = detalleDe(error);
  if (error?.obsoleto) return { tipo: 'obsoleto', mensaje: error.message };
  if (error?.code === 'SIN_RED') return { tipo: 'sin_red', mensaje: TEXTO_SIN_RED };
  if (status === 401) return { tipo: 'sesion', mensaje: TEXTO_SESION };
  if (esSinModulo(error)) {
    return { tipo: 'sin_modulo', mensaje: detalle || 'Tu usuario no admite familias en ningún dispositivo.', verificacion: error?.verificacionSinModulo ?? null };
  }
  if (esUuidEnUso(error)) return { tipo: 'uuid_en_uso', mensaje: TEXTO_UUID_EN_USO };
  if (esConflictoDeEstado(error)) {
    const estadoActual = error.payload.estado_actual;
    return { tipo: 'conflicto', mensaje: detalle || 'El caso cambió. Se recarga la pantalla.', estadoActual, destino: destinoPorEstado(estadoActual) };
  }
  if (status === 404 && !error?.unexpectedHtml) return { tipo: 'no_encontrado', mensaje: TEXTO_NO_ENCONTRADO };
  if (status === 400 && !error?.unexpectedHtml && error?.payload?.code === 'VALIDACION') {
    const errores = erroresDeLlegada(error.payload, campos);
    return { tipo: 'validacion', mensaje: detalle || 'El servidor rechazó el pedido.', errores: Object.keys(errores).length ? errores : { generales: [detalle || 'El servidor rechazó el pedido.'] } };
  }
  if (status === 429 && !error?.unexpectedHtml) {
    return { tipo: 'espera', mensaje: TEXTO_ESPERAR_ACCION, espera: Number(error?.retryAfter) > 0 ? Number(error.retryAfter) : null };
  }
  if (error?.network === true || error?.unexpectedHtml === true || !status || status >= 500 || status === 408 || status === 429) {
    return { tipo: 'reintentable', mensaje: TEXTO_REINTENTAR_LECTURA, espera: Number(error?.retryAfter) > 0 ? Number(error.retryAfter) : null };
  }
  return { tipo: 'rechazo', mensaje: detalle || error?.message || 'El servidor rechazó el pedido.' };
};

// ---- Sesión ----
// Cada pantalla abre su sesión al montarse: el usuario y el token de ese momento. Todo lo que pide
// sale con ese token, y una respuesta que llega con otra sesión ya abierta se descarta (`obsoleto`).
const crearError = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });
export const abrirSesion = async () => {
  const [user, token] = await Promise.all([getStoredBecasUser(), getBecasToken()]);
  if (user?.id == null || !token) throw crearError('SIN_SESION', 'No hay sesión iniciada.');
  return { owner: String(user.id), token };
};
const sigueLaSesion = async (sesion) => (await getBecasToken()) === sesion.token;

// Corre `pedido(opciones)` con el token y el tiempo máximo de la sesión, y descarta la respuesta (o el
// error) si la sesión cambió mientras tanto. Un error sale con `clasificacion`.
const conSesion = async (sesion, pedido, { timeoutMs, campos = [], exigeRed = true } = {}) => {
  if (!sesion?.token) throw Object.assign(errorObsoleto(), { clasificacion: { tipo: 'obsoleto', mensaje: 'Sin sesión.' } });
  if (exigeRed && !await hayConexion()) {
    throw crearError('SIN_RED', TEXTO_SIN_RED, { clasificacion: { tipo: 'sin_red', mensaje: TEXTO_SIN_RED } });
  }
  // Si ya entró otra persona, no sale nada: una acción de la sesión anterior no se manda (ni con su
  // propio token). Después de la respuesta se vuelve a mirar (una sesión que cambió en el medio).
  if (!await sigueLaSesion(sesion)) throw Object.assign(errorObsoleto(), { clasificacion: { tipo: 'obsoleto', mensaje: 'La sesión cambió.' } });
  let respuesta;
  try {
    respuesta = await pedido({ token: sesion.token, timeoutMs });
  } catch (error) {
    const obsoleto = error?.obsoleto || !await sigueLaSesion(sesion);
    const clasificacion = obsoleto ? { tipo: 'obsoleto', mensaje: 'La sesión cambió.' } : clasificarErrorLlegada(error, { campos });
    error.clasificacion = clasificacion;
    throw error;
  }
  if (!await sigueLaSesion(sesion)) throw Object.assign(errorObsoleto(), { clasificacion: { tipo: 'obsoleto', mensaje: 'La sesión cambió.' } });
  return respuesta;
};

// ---- Acciones ----
// §13.2. Valida el DNI antes de pedir nada (un 400 `dni` igual se muestra en el campo).
export const buscar = async (sesion, dispositivoId, dni) => {
  const limpio = cleanDigits(dni);
  if (validarDni(limpio)) {
    throw crearError('VALIDACION_LOCAL', DNI_INVALIDO, { clasificacion: { tipo: 'validacion', mensaje: DNI_INVALIDO, errores: { dni: [DNI_INVALIDO] } } });
  }
  try {
    const payload = await conSesion(sesion, (op) => buscarFamilia(dispositivoId, limpio, op), { timeoutMs: LIMITES.lecturaMs, campos: ['dni'] });
    return normalizarBusqueda(payload);
  } catch (error) {
    // El 429 de acá es el tope de búsquedas por DNI (§13.2): se dice con ese texto.
    if (error.clasificacion?.tipo === 'espera') error.clasificacion.mensaje = TEXTO_ESPERAR;
    throw error;
  }
};

const crearUuid = () => String(Crypto.randomUUID()).toLowerCase();

// ¿Sigue incierta la acción después de este error? Un transitorio (red, timeout, 5xx, WAF) la deja
// incierta: el pedido pudo haber llegado. Una respuesta del back sobre el estado (400, 409, 404) dice
// en qué quedó y la destraba. Lo demás (sin red, 401, 403, 429, otro rechazo) no dice nada del pedido
// anterior: queda como estaba.
const PRUEBAN_ESTADO = ['validacion', 'conflicto', 'no_encontrado'];
const sigueIncierto = (tipo, previo) => tipo === 'reintentable' || (previo && !PRUEBAN_ESTADO.includes(tipo));

// §13.3. Aceptar NO es idempotente. `incierto`: un intento anterior de esta pantalla salió sin que se
// supiera si llegó. Devuelve:
// - { resultado: 'aceptada', caso, reservadas, faltantes, mensaje, integrantes } con el 200;
// - { resultado: 'ya_aceptada', caso: { id }, mensaje } con un 409 INGRESO_EN_CURSO tras un intento
//   incierto: el primero llegó (o otra guardia la aceptó): es lo mismo que el 200, se sigue a los
//   integrantes.
// Cualquier otro error sale con `clasificacion`; los transitorios con `incierto: true`.
export const aceptar = async (sesion, derivacion, { incierto = false } = {}) => {
  try {
    const payload = await conSesion(sesion, (op) => aceptarDerivacion(derivacion.id, { uuid_cliente: crearUuid() }, op),
      { timeoutMs: LIMITES.accionMs, campos: ['plazas'] });
    const datos = normalizarIntegrantes(payload);
    return {
      resultado: 'aceptada',
      caso: datos.caso || derivacion.caso,
      reservadas: entero(payload?.reservadas),
      faltantes: entero(payload?.faltantes),
      mensaje: textoPlano(payload?.mensaje).trim(),
      integrantes: datos,
    };
  } catch (error) {
    const c = error.clasificacion;
    if (incierto && c?.tipo === 'conflicto' && c.estadoActual === 'INGRESO_EN_CURSO') {
      return { resultado: 'ya_aceptada', caso: derivacion.caso, mensaje: TEXTO_ACEPTADA_ANTES, detalle: c.mensaje };
    }
    if (c?.tipo === 'reintentable') c.mensaje = TEXTO_ACEPTAR_INCIERTO;
    error.incierto = sigueIncierto(c?.tipo, incierto);
    throw error;
  }
};

// §13.4. Rechazar tampoco es idempotente: tras un intento incierto, el 409 con el caso de vuelta en la
// mesa (EN_GESTION o NUEVO) es «se hizo». Devuelve { resultado: 'rechazada' | 'ya_rechazada', caso_estado }.
export const rechazar = async (sesion, derivacion, { motivo, observacion } = {}, { incierto = false } = {}) => {
  const errores = validarRechazo({ motivo, observacion });
  if (Object.keys(errores).length) {
    throw crearError('VALIDACION_LOCAL', 'Hay datos para corregir.', { clasificacion: { tipo: 'validacion', mensaje: 'Corregí lo marcado.', errores } });
  }
  try {
    const payload = await conSesion(sesion, (op) => rechazarDerivacion(derivacion.id, { motivo, observacion }, op),
      { timeoutMs: LIMITES.accionMs, campos: ['motivo', 'observacion'] });
    return { resultado: 'rechazada', caso_estado: textoPlano(payload?.caso_estado) || 'EN_GESTION' };
  } catch (error) {
    const c = error.clasificacion;
    if (incierto && c?.tipo === 'conflicto' && c.destino === 'buscar') {
      return { resultado: 'ya_rechazada', caso_estado: c.estadoActual, mensaje: TEXTO_RECHAZADA_ANTES, detalle: c.mensaje };
    }
    if (c?.tipo === 'reintentable') c.mensaje = TEXTO_RECHAZAR_INCIERTO;
    error.incierto = sigueIncierto(c?.tipo, incierto);
    throw error;
  }
};

// §13.5.
export const cargarIntegrantes = async (sesion, casoId) => normalizarIntegrantes(
  await conSesion(sesion, (op) => getIntegrantes(casoId, op), { timeoutMs: LIMITES.lecturaMs }));

// «Agregar persona» (§13.5): idempotente por `uuid_cliente`. El uuid nace al mandar y se guarda en
// AsyncStorage (por usuario y caso) hasta saber el resultado, como la recepción abierta de M3: volver,
// re-entrar, la recarga del router o cerrar la app no lo cambian, y el reintento con el mismo uuid
// devuelve la misma fila (no suma una persona fantasma).
// - Se olvida con 2xx y con las respuestas que dicen en qué quedó: 400 VALIDACION, 404 y 409.
// - Se conserva con red, timeout, 5xx, página del WAF, 429, 403 y 401: el pedido pudo haber llegado.
const CLAVE_AGREGAR = 'emergencia_llegadas_agregar';
const claveAgregar = (owner) => `${CLAVE_AGREGAR}:${owner}`;
let colaAgregar = Promise.resolve();
const enOrdenAgregar = (tarea) => {
  const resultado = colaAgregar.then(tarea, tarea);
  colaAgregar = resultado.catch(() => {});
  return resultado;
};
const leerAgregar = async (owner) => {
  try {
    const crudo = await AsyncStorage.getItem(claveAgregar(owner));
    const valor = crudo ? JSON.parse(crudo) : {};
    return valor && typeof valor === 'object' && !Array.isArray(valor) ? valor : {};
  } catch {
    return {};
  }
};
const modificarAgregar = (owner, cambio) => enOrdenAgregar(async () => {
  const todas = await leerAgregar(owner);
  const resultado = cambio(todas);
  if (Object.keys(todas).length) await AsyncStorage.setItem(claveAgregar(owner), JSON.stringify(todas));
  else await AsyncStorage.removeItem(claveAgregar(owner));
  return resultado;
});

// El uuid de un «Agregar persona» sin resultado en este caso, o null.
export const agregarPendiente = async (sesion, casoId) => {
  if (!sesion?.owner) return null;
  const todas = await enOrdenAgregar(() => leerAgregar(sesion.owner));
  return typeof todas[String(casoId)] === 'string' ? todas[String(casoId)] : null;
};

// Se olvida el pendiente de un caso que ya no admite altas (la familia alojada o el caso cerrado).
export const olvidarAgregarPendiente = async (sesion, casoId) => {
  if (!sesion?.owner) return;
  await modificarAgregar(sesion.owner, (todas) => { delete todas[String(casoId)]; });
};

const RESUELVEN_AGREGAR = ['validacion', 'no_encontrado', 'conflicto', 'uuid_en_uso'];

export const agregarPersona = async (sesion, casoId) => {
  const id = String(casoId);
  const uuid = await modificarAgregar(sesion.owner, (todas) => {
    if (typeof todas[id] !== 'string') todas[id] = crearUuid();
    return todas[id];
  });
  const olvidar = () => modificarAgregar(sesion.owner, (todas) => { if (todas[id] === uuid) delete todas[id]; });
  try {
    const payload = await conSesion(sesion, (op) => agregarIntegrante(casoId, { uuid_cliente: uuid }, op),
      { timeoutMs: LIMITES.accionMs });
    await olvidar();
    return { integrante: normalizarIntegrante(payload?.integrante), total_declarado: entero(payload?.total_declarado), uuid };
  } catch (error) {
    const tipo = error.clasificacion?.tipo;
    if (RESUELVEN_AGREGAR.includes(tipo)) await olvidar();
    if (tipo === 'reintentable') error.clasificacion.mensaje = TEXTO_AGREGAR_INCIERTO;
    error.uuid = uuid;
    throw error;
  }
};

// ---- Parte 2: una persona y su ficha (§13.6), el mapa de camas (§13.7) y confirmar (§13.8) ----

export const TEXTO_CONFIRMAR_INCIERTO = 'No se pudo saber si la persona quedó confirmada. «Reintentar confirmar» manda el mismo pedido: si ya había llegado, no la confirma dos veces ni toma otra cama.';
export const TEXTO_FICHA_INCIERTA = 'No se pudo saber si la ficha se guardó. «Reintentar» manda lo mismo: guardarla dos veces no cambia nada.';
export const TEXTO_PERSONA_NO_ENCONTRADA = 'Esa persona ya no está en la familia, o el caso ya no es de tu dispositivo. Se vuelven a cargar los integrantes.';

// La fila de §13.6: la de §13.5 más `ficha` (el Formulario 2 guardado, `{}` sin confirmar) y
// `secciones_incompletas`.
export const normalizarPersona = (payload) => {
  const fila = normalizarIntegrante(payload);
  if (!fila) return null;
  const ficha = payload.ficha && typeof payload.ficha === 'object' && !Array.isArray(payload.ficha) ? payload.ficha : {};
  return {
    ...fila,
    ficha,
    secciones_incompletas: (Array.isArray(payload.secciones_incompletas) ? payload.secciones_incompletas : [])
      .filter((s) => typeof s === 'string'),
  };
};

// §13.7. La app mira solo `elegible` para dejar elegir; `estado` da el texto propio.
const ESTADOS_CAMA = {
  RESERVADA_FAMILIA: ['Reservada para esta familia', 'warning'],
  LIBRE: ['Libre', 'success'],
  OCUPADA: ['Ocupada', 'gray'],
  FUERA_SERVICIO: ['Fuera de servicio', 'danger'],
  RESERVADA: ['Reservada para otra persona', 'gray'],
};
export const estadoDeCama = (estado) => {
  const [titulo, tono] = ESTADOS_CAMA[String(estado || '').toUpperCase()] || ['No disponible', 'gray'];
  return { titulo, tono };
};

export const normalizarMapa = (payload) => {
  const datos = payload && typeof payload === 'object' ? payload : {};
  const sectores = (Array.isArray(datos.sectores) ? datos.sectores : []).map((item) => {
    if (!item || typeof item !== 'object' || !item.sector || item.sector.id == null) return null;
    const plazas = (Array.isArray(item.plazas) ? item.plazas : []).filter((p) => p && p.id != null).map((p) => ({
      id: p.id,
      codigo: textoPlano(p.codigo) || String(p.id),
      nombre: textoPlano(p.nombre) || textoPlano(p.codigo) || `Cama ${p.id}`,
      estado: textoPlano(p.estado),
      elegible: p.elegible === true,
      detalle: textoPlano(p.detalle).trim(),
    }));
    return {
      sector: { id: item.sector.id, nombre: textoPlano(item.sector.nombre) || `Sector ${item.sector.id}`, perfil: textoPlano(item.sector.perfil) },
      plazas,
      total: item.total != null ? entero(item.total) : plazas.length,
      libres: entero(item.libres),
      reservadas_familia: entero(item.reservadas_familia),
    };
  }).filter(Boolean);
  return { caso: datos.caso ?? null, sectores };
};

export const camasElegibles = (mapa) => (mapa?.sectores || []).flatMap((s) => s.plazas.filter((p) => p.elegible));
export const buscarCama = (mapa, id) => (id == null ? null
  : (mapa?.sectores || []).flatMap((s) => s.plazas).find((p) => String(p.id) === String(id)) || null);

// La cama que se propone (§13.7): la primera guardada para esta familia, en el orden del mapa (sectores
// por nombre, camas por código). Sin ninguna (la persona se agregó, o ya se usaron todas), ninguna: la
// guardia elige una libre.
export const camaPorDefecto = (mapa) => (mapa?.sectores || []).flatMap((s) => s.plazas)
  .find((p) => p.elegible && p.estado === 'RESERVADA_FAMILIA') || null;

// ¿Sigue sirviendo la cama elegida con este mapa? Si no, la que se propone en su lugar (o null).
export const revisarCama = (mapa, plazaId) => {
  const actual = buscarCama(mapa, plazaId);
  if (actual?.elegible) return { plaza: actual, cambio: false };
  return { plaza: camaPorDefecto(mapa), cambio: plazaId != null, anterior: actual };
};

// §13.6.
export const cargarPersona = async (sesion, casoId, n) => {
  const persona = normalizarPersona(await conSesion(sesion, (op) => getIntegrante(casoId, n, op), { timeoutMs: LIMITES.lecturaMs }));
  if (!persona) {
    throw crearError('RESPUESTA', 'El servidor no devolvió a la persona.', { clasificacion: { tipo: 'rechazo', mensaje: 'El servidor no devolvió a la persona. Probá de nuevo.' } });
  }
  return persona;
};

// §13.7.
export const cargarCamas = async (sesion, dispositivoId, casoId) => normalizarMapa(
  await conSesion(sesion, (op) => getPlazas(dispositivoId, casoId, op), { timeoutMs: LIMITES.lecturaMs }));

// Los campos del 400 de confirmar y completar que van a un campo de la pantalla: los de la ficha (con
// su nombre plano), `plaza`, y el «sin datos» de cada sección. `orden` y lo demás van a generales.
const CAMPOS_PERSONA = [...CAMPOS_FICHA, 'plaza', ...SECCIONES_OPCIONALES.map((s) => `${s}_sin_datos`)];

// «Confirmar persona» (§13.8): idempotente por `uuid_cliente`. Como «Agregar persona», el uuid nace al
// mandar y se guarda en AsyncStorage por usuario, caso y persona hasta saber el resultado: volver,
// re-entrar, la recarga del router o cerrar la app no lo cambian, y el reintento con el mismo uuid
// devuelve la misma fila (no confirma dos veces ni toma otra cama, aunque se haya elegido otra).
// - Se olvida con 2xx y con las respuestas que dicen en qué quedó: 400 VALIDACION (la persona no se
//   confirmó: el reenvío con el mismo uuid habría dado 200), 404 y 409 (otra guardia la confirmó, o el
//   caso ya no está en curso).
// - Se conserva con red, timeout, 5xx, página del WAF, 429, 403 y 401: el pedido pudo haber llegado.
const CLAVE_CONFIRMAR = 'emergencia_llegadas_confirmar';
const claveConfirmar = (owner) => `${CLAVE_CONFIRMAR}:${owner}`;
const idPersona = (casoId, n) => `${casoId}:${n}`;
const leerMapa = async (clave) => {
  try {
    const crudo = await AsyncStorage.getItem(clave);
    const valor = crudo ? JSON.parse(crudo) : {};
    return valor && typeof valor === 'object' && !Array.isArray(valor) ? valor : {};
  } catch {
    return {};
  }
};
const modificarMapa = (clave, cambio) => enOrdenGuardado(async () => {
  const todas = await leerMapa(clave);
  const resultado = cambio(todas);
  if (Object.keys(todas).length) await AsyncStorage.setItem(clave, JSON.stringify(todas));
  else await AsyncStorage.removeItem(clave);
  return resultado;
});

// El uuid de un «Confirmar persona» sin resultado para esa persona, o null.
export const confirmarPendiente = async (sesion, casoId, n) => {
  if (!sesion?.owner) return null;
  const todas = await enOrdenGuardado(() => leerMapa(claveConfirmar(sesion.owner)));
  const uuid = todas[idPersona(casoId, n)];
  return typeof uuid === 'string' ? uuid : null;
};

// Se olvida cuando el servidor ya muestra a la persona confirmada (el pendiente ya no tiene a qué volver).
export const olvidarConfirmarPendiente = async (sesion, casoId, n) => {
  if (!sesion?.owner) return;
  await modificarMapa(claveConfirmar(sesion.owner), (todas) => { delete todas[idPersona(casoId, n)]; });
};

const RESUELVEN_CONFIRMAR = ['validacion', 'no_encontrado', 'conflicto', 'uuid_en_uso'];

// `plano`: la ficha aplanada de la pantalla (utils/fichaEmergencia); se manda anidada, con las ocho
// secciones (las 4 a 8 solo con lo que se haya cargado). Devuelve
// { integrante, confirmadas, total_declarado, reserva_liberada, uuid, otraCama } — `otraCama` es la
// cama con la que el servidor dice que quedó, si no es la elegida (el reenvío de un envío anterior que
// había llegado con otra): la pantalla lo avisa.
export const confirmarPersona = async (sesion, casoId, n, { plano, plazaId } = {}) => {
  const id = idPersona(casoId, n);
  const clave = claveConfirmar(sesion.owner);
  let nuevo = false;
  const uuid = await modificarMapa(clave, (todas) => {
    if (typeof todas[id] !== 'string') {
      todas[id] = crearUuid();
      nuevo = true;
    }
    return todas[id];
  });
  const olvidar = () => modificarMapa(clave, (todas) => { if (todas[id] === uuid) delete todas[id]; });
  try {
    const payload = await conSesion(sesion, (op) => confirmarIntegrante(casoId, n,
      { uuid_cliente: uuid, plaza_id: plazaId, ficha: fichaDesdePlano(plano) }, op),
    { timeoutMs: LIMITES.accionMs, campos: CAMPOS_PERSONA });
    await olvidar();
    const integrante = normalizarIntegrante(payload?.integrante);
    const otraCama = integrante?.plaza && String(integrante.plaza.id) !== String(plazaId) ? integrante.plaza : null;
    return {
      integrante,
      confirmadas: entero(payload?.confirmadas),
      total_declarado: entero(payload?.total_declarado),
      reserva_liberada: payload?.reserva_liberada === true,
      uuid,
      otraCama,
    };
  } catch (error) {
    const tipo = error.clasificacion?.tipo;
    // Sin red no salió nada: un uuid recién nacido no queda como pendiente (uno de antes, sí).
    if (RESUELVEN_CONFIRMAR.includes(tipo) || (tipo === 'sin_red' && nuevo)) await olvidar();
    if (tipo === 'reintentable') error.clasificacion.mensaje = TEXTO_CONFIRMAR_INCIERTO;
    error.uuid = uuid;
    throw error;
  }
};

// «Completar la ficha» (§13.6): las secciones 4 a 8 de `secciones` (las que cambiaron). Es un reemplazo
// por sección: repetirlo deja lo mismo, así que tras un corte se reintenta igual, sin uuid.
// Devuelve { ficha_completa, secciones_incompletas }.
export const completarFicha = async (sesion, casoId, n, { plano, secciones = SECCIONES_OPCIONALES } = {}) => {
  const validas = secciones.filter((s) => SECCIONES_OPCIONALES.includes(s));
  try {
    const payload = await conSesion(sesion, (op) => completarFichaIntegrante(casoId, n, { ficha: fichaDesdePlano(plano, validas) }, op),
      { timeoutMs: LIMITES.accionMs, campos: CAMPOS_PERSONA });
    return {
      ficha_completa: payload?.ficha_completa === true,
      secciones_incompletas: (Array.isArray(payload?.secciones_incompletas) ? payload.secciones_incompletas : []).filter((s) => typeof s === 'string'),
    };
  } catch (error) {
    if (error.clasificacion?.tipo === 'reintentable') error.clasificacion.mensaje = TEXTO_FICHA_INCIERTA;
    throw error;
  }
};

// ---- Borrador de la ficha en curso ----
// La ficha es larga y la familia está en la puerta: lo tipeado se guarda en el teléfono (AsyncStorage,
// por usuario, caso y persona) para no perderlo si la guardia vuelve atrás, el router recarga por un
// 409 o se cierra la app. NO es una lectura guardada (sin red la pantalla igual se bloquea) ni una
// cola: solo lo que la guardia escribió y todavía no se mandó con éxito. Se borra al confirmar o
// guardar, cuando el servidor dice que ya no aplica (404, 409, 403, la persona ya confirmada para un
// borrador de confirmación), con el logout y al abrir el módulo con otro usuario
// (`emergenciaLimpieza`), y vence a las 48 h.
// - 'confirmar': el plano entero y la cama (la persona no tiene ficha en el servidor que pisar).
// - 'completar': SOLO las secciones tocadas y su `base` (utils/fichaEmergencia `borradorDeCompletar`):
//   al recuperarlas se ponen sobre la ficha de ahora del servidor (`recuperarSobre`).
const claveBorrador = (owner) => `${PREFIJO_BORRADOR_FICHA}${owner}`;
export { VIDA_BORRADOR_MS };

const vigente = (borrador, modo) => !!borrador && typeof borrador === 'object' && borrador.modo === modo
  && Date.now() - Number(borrador.guardado_en || 0) < VIDA_BORRADOR_MS
  && (modo === 'confirmar' ? !!borrador.plano && typeof borrador.plano === 'object'
    : !!borrador.secciones && typeof borrador.secciones === 'object');

export const guardarBorradorFicha = async (sesion, casoId, n, { modo, plano, plazaId = null, secciones, base }) => {
  if (!sesion?.owner) return;
  await modificarMapa(claveBorrador(sesion.owner), (todas) => {
    Object.keys(todas).forEach((k) => { if (!(Date.now() - Number(todas[k]?.guardado_en || 0) < VIDA_BORRADOR_MS)) delete todas[k]; });
    const id = idPersona(casoId, n);
    if (modo === 'completar') {
      // Nada tocado respecto de la ficha del servidor: no hay borrador.
      if (!secciones || !Object.keys(secciones).length) delete todas[id];
      else todas[id] = { modo, secciones, base: base || {}, guardado_en: Date.now() };
    } else {
      todas[id] = { modo, plano, plaza_id: plazaId, guardado_en: Date.now() };
    }
  });
};

// El borrador de esa persona si es del mismo modo y no venció; si no, null (y el que no sirve se borra).
// 'confirmar' → { plano, plazaId }; 'completar' → { secciones, base }.
export const leerBorradorFicha = async (sesion, casoId, n, modo) => {
  if (!sesion?.owner) return null;
  const id = idPersona(casoId, n);
  return modificarMapa(claveBorrador(sesion.owner), (todas) => {
    const borrador = todas[id];
    if (!vigente(borrador, modo)) {
      delete todas[id];
      return null;
    }
    return modo === 'confirmar' ? { plano: borrador.plano, plazaId: borrador.plaza_id ?? null }
      : { secciones: borrador.secciones, base: borrador.base || {} };
  });
};

export const borrarBorradorFicha = async (sesion, casoId, n) => {
  if (!sesion?.owner) return;
  await modificarMapa(claveBorrador(sesion.owner), (todas) => { delete todas[idPersona(casoId, n)]; });
};
