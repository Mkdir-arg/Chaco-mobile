import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import * as Crypto from 'expo-crypto';
import { Platform } from 'react-native';
import { getBecasToken, getStoredBecasUser } from './becasApi';
import { esConflictoDeEstado, esUuidEnUso, getEntrega, recibirEntrega } from './emergenciaApi';
import { timeoutDelEnvio } from './emergenciaCola';
import { esSinModulo } from './sinModulo';
import { erroresDelServidor } from '../utils/emergencia';

// M3 · Recepción de kits (contrato-app-emergencia §9 a §12). Va SIN cola: la recepción necesita
// conexión (la mesa espera la respuesta). Lo único que se guarda en el teléfono es la recepción
// abierta de cada entrega —su `uuid_cliente`, las cantidades y la observación, nunca la foto—
// para que un cierre accidental no cambie el identificador: el reintento con el mismo uuid es
// idempotente (§12), uno nuevo sobre una entrega ya recibida da 409.

// ---- Textos ----
export const TEXTO_SIN_RED = 'Sin conexión: la recepción necesita señal y no se guarda para enviar después. Probá cuando vuelva la red; lo cargado queda en esta pantalla.';
export const TEXTO_REINTENTAR = 'No se pudo confirmar si la recepción llegó. Tocá «Reintentar»: se manda la misma recepción y no se duplica.';
export const TEXTO_ESPERAR = 'El servidor pidió esperar antes de volver a intentar.';
export const TEXTO_UUID_EN_USO = 'Este intento de recepción no se puede mandar: su identificador ya se usó en otra recepción. Descartá este intento para empezar uno nuevo con lo cargado.';
export const TEXTO_NO_ENCONTRADA = 'Esta entrega ya no está disponible para vos. Se vuelve a cargar la lista de tus dispositivos.';
export const TEXTO_REMITO_PESADO = 'La foto del remito es demasiado pesada para enviarla: sacala de nuevo o elegí otra.';
export const TEXTO_VALIDACION = 'El servidor rechazó algunos datos. Corregí lo marcado y volvé a tocar «Recibir».';
export const TEXTO_REGISTRADA = 'La recepción de esta entrega ya figura registrada.';
export const TEXTO_SIN_CONFIRMAR = 'No se pudo confirmar qué pasó con una recepción que habías mandado: revisala desde el backoffice o consultá con la mesa.';
export const TEXTO_SESION = 'La sesión venció: volvé a entrar. La recepción queda abierta con el mismo identificador.';
export const FALTA_CANTIDAD = 'Falta la cantidad: poné 0 si no llegó nada.';
export const CANTIDAD_INVALIDA = 'Tiene que ser un número entero, 0 o más.';
export const FALTA_REMITO = 'Falta la foto del remito.';
export const MAX_DIGITOS_CANTIDAD = 6;
export const MAX_OBSERVACION = 1000;

// ---- Entregas ----
const ESTADOS_ENTREGA = {
  PREPARADA: ['Preparada', 'gray'],
  EN_CAMINO: ['En camino', 'info'],
  RECIBIDA: ['Recibida', 'success'],
  RECIBIDA_CON_DIFERENCIAS: ['Recibida con diferencias', 'warning'],
  CANCELADA: ['Cancelada', 'danger'],
};
export const estadoDeEntrega = (estado) => {
  const valor = String(estado || '').toUpperCase();
  const [titulo, tono] = ESTADOS_ENTREGA[valor] || [valor ? valor.replaceAll('_', ' ').toLowerCase() : 'Sin estado', 'gray'];
  return { titulo, tono };
};

const entero = (valor) => {
  const numero = Number(valor);
  return Number.isInteger(numero) && numero >= 0 ? numero : 0;
};
const textoPlano = (valor) => (typeof valor === 'string' ? valor : '');

// §9: solo los dispositivos donde el usuario recibe kits (`recibe_kits: true`).
export const dispositivosConKits = (lista) => (Array.isArray(lista) ? lista : [])
  .filter((item) => item && item.id != null && item.recibe_kits === true)
  .map((item) => ({ id: item.id, nombre: textoPlano(item.nombre) || `Dispositivo ${item.id}`, entregas_pendientes: entero(item.entregas_pendientes) }));

// §10/§11 → lo que usan las pantallas. Una línea sin `item` no se puede recibir: se descarta.
export const normalizarEntrega = (entrega) => {
  if (!entrega || typeof entrega !== 'object' || entrega.id == null) return null;
  const lineas = (Array.isArray(entrega.lineas) ? entrega.lineas : [])
    .filter((linea) => linea && linea.item != null)
    .map((linea) => ({
      item: linea.item,
      nombre: textoPlano(linea.nombre) || `Ítem ${linea.item}`,
      unidad: textoPlano(linea.unidad),
      enviada: entero(linea.enviada),
      recibida: linea.recibida == null ? null : entero(linea.recibida),
    }));
  return {
    id: entrega.id,
    numero: textoPlano(entrega.numero) || String(entrega.id),
    estado: textoPlano(entrega.estado),
    despachada_en: entrega.despachada_en || null,
    observacion_mesa: textoPlano(entrega.observacion_mesa).trim(),
    lineas,
  };
};

export const normalizarEntregas = (lista) => (Array.isArray(lista) ? lista : []).map(normalizarEntrega).filter(Boolean);

// «10 × Colchón · 3 × Kit alimentario».
export const resumenDeItems = (entrega) => {
  const lineas = entrega?.lineas || [];
  return lineas.length ? lineas.map((linea) => `${linea.enviada} × ${linea.nombre}`).join(' · ') : 'Sin ítems';
};

// ---- Cantidades ----
// Lo que se precarga: lo enviado, como texto para el input.
export const cantidadesIniciales = (entrega) => Object.fromEntries((entrega?.lineas || [])
  .map((linea) => [String(linea.item), String(linea.enviada)]));

// Mensaje de error de una cantidad tipeada, o null si es un entero ≥ 0.
export const errorDeCantidad = (texto) => {
  const valor = String(texto ?? '').trim();
  if (!valor) return FALTA_CANTIDAD;
  if (!/^\d+$/.test(valor) || valor.length > MAX_DIGITOS_CANTIDAD) return CANTIDAD_INVALIDA;
  return null;
};

// { <item>: texto } → { <item>: número }, una por línea de la entrega (también las 0). Tira si
// alguna no es válida: se llama después de validarRecepcion.
export const armarCantidades = (entrega, textos = {}) => Object.fromEntries((entrega?.lineas || []).map((linea) => {
  const clave = String(linea.item);
  if (errorDeCantidad(textos[clave])) throw new Error(`Cantidad inválida para ${linea.nombre}.`);
  return [clave, Number(String(textos[clave]).trim())];
}));

// Las líneas donde lo tipeado (válido) no coincide con lo enviado. Llegar de más también es
// diferencia (§12).
export const diferenciasDe = (entrega, textos = {}) => (entrega?.lineas || []).flatMap((linea) => {
  const texto = textos[String(linea.item)];
  if (errorDeCantidad(texto)) return [];
  const recibida = Number(String(texto).trim());
  return recibida === linea.enviada ? [] : [{ ...linea, recibida, diferencia: recibida - linea.enviada }];
});

// «Colchón: llegaron 8 de 10 (faltan 2)».
export const textoDeDiferencia = ({ nombre, enviada, recibida }) => {
  const resto = recibida - enviada;
  const detalle = resto < 0 ? `faltan ${-resto}` : `sobran ${resto}`;
  return `${nombre}: llegaron ${recibida} de ${enviada} (${detalle})`;
};

// Validación de cliente antes de mandar. { lineas: { <item>: mensaje }, remito: [..] }. Con un
// intento `incierto` el remito no hace falta: el reenvío con el mismo uuid no se vuelve a validar
// (§12, «ni siquiera hace falta el remito»).
export const validarRecepcion = ({ entrega, cantidades = {}, remito = null, incierto = false } = {}) => {
  const errores = {};
  const lineas = {};
  (entrega?.lineas || []).forEach((linea) => {
    const mensaje = errorDeCantidad(cantidades[String(linea.item)]);
    if (mensaje) lineas[String(linea.item)] = [mensaje];
  });
  if (Object.keys(lineas).length) errores.lineas = lineas;
  if (!incierto && !remito?.uri && !remito?.file) errores.remito = [FALTA_REMITO];
  return errores;
};

export const hayErroresRecepcion = (errores) => !!errores && Object.keys(errores).length > 0;

// ---- Errores del servidor ----
// Un 400 VALIDACION (§12) → { lineas: { <item>: [..] }, cantidades, remito, observacion, generales }.
// `cantidades[<id>]`, si el back llega a mandarla por línea, va a esa línea; `cantidades` sola
// (el mensaje dice qué ítem) se muestra junto a las cantidades.
export const erroresDeRecepcion = (payload) => {
  const planos = erroresDelServidor(payload);
  const errores = {};
  Object.entries(planos).forEach(([clave, mensajes]) => {
    const linea = clave.match(/^cantidades\[(.+)\]$/);
    if (linea) {
      errores.lineas = { ...(errores.lineas || {}), [linea[1]]: mensajes };
    } else if (['cantidades', 'remito', 'observacion'].includes(clave)) {
      errores[clave] = mensajes;
    } else {
      errores.generales = [...(errores.generales || []), ...mensajes];
    }
  });
  return errores;
};

const esFallaTransitoria = (error) => {
  const status = Number(error?.status || 0);
  return error?.network === true || error?.unexpectedHtml === true || !status
    || status >= 500 || status === 408 || status === 429;
};

const detalleDe = (error) => {
  const detail = error?.payload && typeof error.payload === 'object' ? error.payload.detail : null;
  return typeof detail === 'string' && detail.trim() ? detail.trim() : null;
};

// Por status y `code` (nunca por el texto). `tipo`:
// - reintentable: red, timeout, 5xx, 429, WAF → mismo uuid; `espera` en ms si vino Retry-After.
// - conflicto: 409 con estado_actual → mostrar `detail` y recargar las entregas.
// - uuid_en_uso: 409 UUID_EN_USO → solo descartando el intento (uuid nuevo).
// - no_encontrada: 404 → recargar «mis dispositivos».
// - sin_modulo: 403 SIN_MODULO (emergenciaApi ya pasó por verificarSinModulo).
// - validacion: 400 → errores por campo/línea, mismo uuid.
// - pesada: 413 → la foto del remito.
// - sesion: 401.  - rechazo: cualquier otro.
export const clasificarErrorRecepcion = (error) => {
  const status = Number(error?.status || 0);
  const detalle = detalleDe(error);
  if (error?.code === 'SIN_RED') return { tipo: 'sin_red', mensaje: TEXTO_SIN_RED };
  if (status === 401) return { tipo: 'sesion', mensaje: TEXTO_SESION };
  if (esSinModulo(error)) {
    return { tipo: 'sin_modulo', mensaje: detalle || 'Tu usuario no recibe kits en ningún dispositivo.', verificacion: error?.verificacionSinModulo ?? null };
  }
  if (esUuidEnUso(error)) return { tipo: 'uuid_en_uso', mensaje: TEXTO_UUID_EN_USO };
  if (esConflictoDeEstado(error)) {
    return { tipo: 'conflicto', mensaje: detalle || 'La entrega ya no se puede recibir.', estadoActual: error.payload.estado_actual };
  }
  if (status === 404 && !error?.unexpectedHtml) return { tipo: 'no_encontrada', mensaje: TEXTO_NO_ENCONTRADA };
  if (status === 400 && !error?.unexpectedHtml) {
    const errores = erroresDeRecepcion(error?.payload);
    return { tipo: 'validacion', mensaje: TEXTO_VALIDACION, errores: hayErroresRecepcion(errores) ? errores : { generales: [detalle || TEXTO_VALIDACION] } };
  }
  if (status === 413) return { tipo: 'pesada', mensaje: TEXTO_REMITO_PESADO, errores: { remito: [TEXTO_REMITO_PESADO] } };
  if (esFallaTransitoria(error)) {
    const espera = Number(error?.retryAfter) > 0 ? Number(error.retryAfter) : null;
    return { tipo: 'reintentable', mensaje: status === 429 ? TEXTO_ESPERAR : TEXTO_REINTENTAR, espera };
  }
  return { tipo: 'rechazo', mensaje: detalle || error?.message || 'El servidor rechazó la recepción.' };
};

// ---- Red ----
// Como la cola de M1: en web manda `navigator.onLine` (el estado guardado de NetInfo web puede
// seguir diciendo «sin internet»); en nativo, NetInfo.
export const hayConexion = async () => {
  if (Platform.OS === 'web' && typeof navigator !== 'undefined' && typeof navigator?.onLine === 'boolean') {
    return navigator.onLine;
  }
  try {
    const state = await NetInfo.fetch();
    return !!state?.isConnected && state?.isInternetReachable !== false;
  } catch {
    return false;
  }
};

// `alCambiar(hayRed)` cada vez que cambia la red. Devuelve la función para dejar de escuchar.
export const escucharRed = (alCambiar) => {
  if (Platform.OS === 'web') {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return () => {};
    const enLinea = () => alCambiar(true);
    const sinLinea = () => alCambiar(false);
    window.addEventListener('online', enLinea);
    window.addEventListener('offline', sinLinea);
    return () => {
      window.removeEventListener('online', enLinea);
      window.removeEventListener('offline', sinLinea);
    };
  }
  if (typeof NetInfo?.addEventListener !== 'function') return () => {};
  const desuscribir = NetInfo.addEventListener((state) => alCambiar(!!state?.isConnected && state?.isInternetReachable !== false));
  return typeof desuscribir === 'function' ? desuscribir : () => {};
};

// ---- Recepción abierta (AsyncStorage, por usuario) ----
// { <entregaId>: { uuid_cliente, dispositivo, numero, cantidades, observacion, incierto, uuid_en_uso,
// descartado } }.
// - `incierto`: salió al menos un pedido con este uuid sin respuesta que diga si se escribió. Mientras
//   tanto nada se cambia (cantidades, observación ni foto) y solo se reintenta con el mismo uuid: el
//   back devuelve lo del primer pedido e ignora el cuerpo nuevo.
// - `uuid_en_uso`: 409 UUID_EN_USO; solo se sigue descartando el intento (uuid nuevo).
// - `descartado`: ya se descartó un intento; un 409 RECIBIDA* puede ser el propio.
const CLAVE_RECEPCIONES = 'emergencia_kits_recepciones';
const claveDe = (owner) => `${CLAVE_RECEPCIONES}:${owner}`;
const crearUuid = () => String(Crypto.randomUUID()).toLowerCase();

let colaEscrituras = Promise.resolve();
const enOrden = (tarea) => {
  const resultado = colaEscrituras.then(tarea, tarea);
  colaEscrituras = resultado.catch(() => {});
  return resultado;
};

const leerTodas = async (owner) => {
  try {
    const crudo = await AsyncStorage.getItem(claveDe(owner));
    const valor = crudo ? JSON.parse(crudo) : {};
    return valor && typeof valor === 'object' && !Array.isArray(valor) ? valor : {};
  } catch {
    return {};
  }
};
const escribirTodas = async (owner, todas) => {
  if (Object.keys(todas).length) await AsyncStorage.setItem(claveDe(owner), JSON.stringify(todas));
  else await AsyncStorage.removeItem(claveDe(owner));
};
// Lee, aplica `cambio` y escribe solo si algo cambió: una pestaña que no cambia nada no pisa lo que
// escribió otra.
const modificar = (owner, cambio) => enOrden(async () => {
  const todas = await leerTodas(owner);
  const antes = JSON.stringify(todas);
  const resultado = await cambio(todas);
  if (JSON.stringify(todas) !== antes) await escribirTodas(owner, todas);
  return resultado;
});

const ownerActual = async () => {
  const user = await getStoredBecasUser();
  return user?.id != null ? String(user.id) : null;
};

const crearError = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });

const estadoDe = (guardada) => ({
  incierto: guardada?.incierto === true,
  uuidEnUso: guardada?.uuid_en_uso === true,
  descartado: guardada?.descartado === true,
});

// Abre (o recupera) la recepción de una entrega: fija el usuario y el token de esta pantalla y el
// uuid_cliente, que se guarda en el acto. Devuelve { owner, token, uuid_cliente, dispositivo, numero,
// cantidades, observacion, incierto, uuidEnUso, descartado, recuperada }.
export const abrirRecepcion = async (entrega, dispositivoId = null) => {
  const [owner, token] = await Promise.all([ownerActual(), getBecasToken()]);
  if (!owner || !token) throw crearError('SIN_SESION', 'No hay sesión iniciada.');
  const id = String(entrega.id);
  const iniciales = cantidadesIniciales(entrega);
  return modificar(owner, (todas) => {
    const previa = todas[id];
    if (previa?.uuid_cliente) {
      const cantidades = Object.fromEntries(Object.keys(iniciales)
        .map((item) => [item, typeof previa.cantidades?.[item] === 'string' ? previa.cantidades[item] : iniciales[item]]));
      todas[id] = { ...previa, cantidades, dispositivo: previa.dispositivo ?? dispositivoId, numero: previa.numero || entrega.numero };
      return { owner, token, uuid_cliente: previa.uuid_cliente, dispositivo: todas[id].dispositivo, numero: todas[id].numero,
        cantidades, observacion: textoPlano(previa.observacion), ...estadoDe(previa), recuperada: true };
    }
    todas[id] = { uuid_cliente: crearUuid(), dispositivo: dispositivoId, numero: entrega.numero, cantidades: iniciales, observacion: '' };
    return { owner, token, uuid_cliente: todas[id].uuid_cliente, dispositivo: dispositivoId, numero: entrega.numero,
      cantidades: iniciales, observacion: '', ...estadoDe(null), recuperada: false };
  });
};

// Guarda lo tipeado. No crea una recepción que no existe, ni toca una incierta o con uuid en uso.
export const guardarRecepcion = (owner, entregaId, { cantidades, observacion } = {}) => modificar(owner, (todas) => {
  const actual = todas[String(entregaId)];
  if (!actual || actual.incierto || actual.uuid_en_uso) return false;
  todas[String(entregaId)] = {
    ...actual,
    ...(cantidades ? { cantidades: { ...cantidades } } : {}),
    ...(typeof observacion === 'string' ? { observacion } : {}),
  };
  return true;
});

export const cerrarRecepcion = (owner, entregaId) => modificar(owner, (todas) => {
  delete todas[String(entregaId)];
  return true;
});

// Descartar el intento: solo después de un 409 UUID_EN_USO (ese uuid no escribió nada en esta
// entrega). uuid nuevo, con lo cargado. `recepcion` aporta dispositivo y número si la entrada ya no
// estaba. Devuelve el uuid nuevo, o null si no se puede descartar (intento incierto).
export const descartarIntento = (recepcion, entregaId) => modificar(recepcion.owner, (todas) => {
  const actual = todas[String(entregaId)];
  if (actual?.incierto) return null;
  const uuid = crearUuid();
  todas[String(entregaId)] = {
    ...(actual || {}),
    dispositivo: actual?.dispositivo ?? recepcion.dispositivo ?? null,
    numero: actual?.numero || recepcion.numero,
    uuid_cliente: uuid,
    uuid_en_uso: false,
    incierto: false,
    descartado: true,
  };
  return uuid;
});

const ESTADOS_RECIBIDA = ['RECIBIDA', 'RECIBIDA_CON_DIFERENCIAS'];

// «Colchón: 8 de 10 · Kit alimentario: 3 de 3», con lo que el back registró (§11, lineas[].recibida).
export const textoDeRegistrada = (entrega) => (entrega?.lineas || [])
  .map((linea) => `${linea.nombre}: ${linea.recibida == null ? '¿?' : linea.recibida} de ${linea.enviada}`).join('\n');

// §11 para decir qué quedó registrado. null si no se pudo consultar.
const consultarRegistrada = async (entregaId) => {
  try {
    return normalizarEntrega(await getEntrega(entregaId));
  } catch {
    return null;
  }
};

// Al traer las pendientes de un dispositivo: las recepciones abiertas de ese dispositivo cuya
// entrega ya no está pendiente se olvidan. Si era una incierta (se mandó y no se supo qué pasó),
// antes se consulta §11 y se avisa: registrada (con lo que quedó), cancelada o sin confirmar; sin
// red se conserva para otra vez. Devuelve { abiertas: [ids], avisos: [textos] }.
export const recepcionesAbiertas = async (dispositivoId, idsPendientes = []) => {
  const owner = await ownerActual();
  if (!owner) return { abiertas: [], avisos: [] };
  const vigentes = new Set(idsPendientes.map(String));
  const todas = await enOrden(() => leerTodas(owner));
  const avisos = [];
  const borrar = [];
  for (const [id, recepcion] of Object.entries(todas)) {
    if (String(recepcion?.dispositivo) !== String(dispositivoId) || vigentes.has(id)) continue;
    if (!recepcion?.incierto) {
      borrar.push(id);
      continue;
    }
    let entrega = null;
    try {
      entrega = normalizarEntrega(await getEntrega(id));
    } catch (error) {
      const clasificacion = clasificarErrorRecepcion(error);
      if (clasificacion.tipo === 'reintentable' || clasificacion.tipo === 'sesion') continue;
    }
    const nombre = `Entrega ${recepcion.numero || entrega?.numero || id}`;
    if (entrega && ESTADOS_RECIBIDA.includes(entrega.estado)) {
      avisos.push(`${nombre}: ${TEXTO_REGISTRADA}\n${textoDeRegistrada(entrega)}`);
    } else if (entrega?.estado === 'CANCELADA') {
      avisos.push(`${nombre}: la mesa la canceló; tu recepción no quedó registrada.`);
    } else {
      avisos.push(`${nombre}: ${TEXTO_SIN_CONFIRMAR}`);
    }
    borrar.push(id);
  }
  await modificar(owner, (actuales) => { borrar.forEach((id) => { delete actuales[id]; }); });
  return { abiertas: Object.keys(todas).filter((id) => vigentes.has(id) && !borrar.includes(id)), avisos };
};

const bytesDe = (asset) => Number(asset?.fileSize || asset?.size || asset?.file?.size) || 0;

// Lo que quedó registrado por línea según el 200 (las que no vienen en `diferencias` llegaron
// completas) contra lo que se mandó: si no coincide (el back devolvió el primer envío), se dice.
const cantidadesDistintas = (entrega, enviadas, respuesta) => {
  const porItem = new Map((Array.isArray(respuesta?.diferencias) ? respuesta.diferencias : [])
    .map((dif) => [String(dif?.item), entero(dif?.recibida)]));
  return (entrega?.lineas || []).flatMap((linea) => {
    const clave = String(linea.item);
    const registrada = porItem.has(clave) ? porItem.get(clave) : linea.enviada;
    return registrada === enviadas[clave] ? [] : [{ item: linea.item, nombre: linea.nombre, mandada: enviadas[clave], registrada }];
  });
};

// §12. Valida, mira la red, marca la recepción como incierta (desde acá el pedido puede llegar),
// manda con el uuid y el token de la recepción y la cierra con 200/201. Un error sale con
// `clasificacion` (clasificarErrorRecepcion) y `recepcion` ({ incierto, uuidEnUso, descartado }):
// - 400: el back respondió y no escribió nada → deja de ser incierta.
// - 413 y 403: no prueban nada sobre un pedido anterior → queda como estaba antes de este.
// - 409 UUID_EN_USO: ese uuid no escribió nada acá → solo se descarta.
// - 409 de estado y 404 la cierran; con un 409 RECIBIDA* después de un intento incierto o
//   descartado se consulta §11 por si la recepción registrada es la propia.
// - red, timeout, 5xx, 429, 401, otros: incierta.
export const enviarRecepcion = async ({ entrega, recepcion, cantidades = {}, remito = null, observacion = '' }) => {
  const id = String(entrega.id);
  const { owner, token, uuid_cliente: uuid } = recepcion;
  const guardada = (await enOrden(() => leerTodas(owner)))[id];
  const previo = estadoDe(guardada);
  const errores = validarRecepcion({ entrega, cantidades, remito, incierto: previo.incierto });
  if (hayErroresRecepcion(errores)) {
    throw crearError('VALIDACION_LOCAL', 'Hay datos para corregir.', { clasificacion: { tipo: 'validacion', mensaje: 'Corregí lo marcado.', errores }, recepcion: previo });
  }
  if (previo.uuidEnUso) {
    throw crearError('UUID_EN_USO', TEXTO_UUID_EN_USO, { clasificacion: { tipo: 'uuid_en_uso', mensaje: TEXTO_UUID_EN_USO }, recepcion: previo });
  }
  if (!await hayConexion()) {
    throw crearError('SIN_RED', TEXTO_SIN_RED, { clasificacion: { tipo: 'sin_red', mensaje: TEXTO_SIN_RED }, recepcion: previo });
  }
  const numeros = armarCantidades(entrega, cantidades);
  const nota = String(observacion || '').trim();
  await modificar(owner, (todas) => {
    const actual = todas[id] || {};
    todas[id] = {
      ...actual,
      dispositivo: actual.dispositivo ?? recepcion.dispositivo ?? null,
      numero: actual.numero || entrega.numero,
      uuid_cliente: uuid,
      cantidades: { ...cantidades },
      observacion: String(observacion || ''),
      incierto: true,
    };
  });
  // Solo actualiza si la entrada sigue ahí (otra pestaña o la lista pudo cerrarla).
  const marcar = (cambios) => modificar(owner, (todas) => {
    if (todas[id]) Object.assign(todas[id], cambios);
  });
  try {
    const respuesta = await recibirEntrega(entrega.id, { uuid_cliente: uuid, cantidades: numeros, remito, observacion: nota },
      { timeoutMs: timeoutDelEnvio(bytesDe(remito)), token });
    await cerrarRecepcion(owner, entrega.id);
    return { ...resultadoDeRecepcion(respuesta, entrega), distintas: cantidadesDistintas(entrega, numeros, respuesta) };
  } catch (error) {
    const clasificacion = clasificarErrorRecepcion(error);
    let estado = { ...previo, incierto: true };
    if (clasificacion.tipo === 'validacion') {
      estado = { ...previo, incierto: false };
    } else if (['pesada', 'sin_modulo', 'sesion'].includes(clasificacion.tipo)) {
      estado = previo;
    } else if (clasificacion.tipo === 'uuid_en_uso') {
      estado = { ...previo, incierto: false, uuidEnUso: true };
    } else if (['conflicto', 'no_encontrada'].includes(clasificacion.tipo)) {
      if (clasificacion.tipo === 'conflicto' && ESTADOS_RECIBIDA.includes(clasificacion.estadoActual)
        && (previo.incierto || previo.descartado)) {
        const registrada = await consultarRegistrada(entrega.id);
        if (registrada) {
          clasificacion.registrada = registrada;
          clasificacion.mensaje = `${TEXTO_REGISTRADA} Puede ser la que mandaste antes; quedó así:\n${textoDeRegistrada(registrada)}`;
        }
      }
      await cerrarRecepcion(owner, entrega.id);
      error.clasificacion = clasificacion;
      error.recepcion = { ...previo, incierto: false };
      throw error;
    }
    await marcar({ incierto: estado.incierto, uuid_en_uso: estado.uuidEnUso });
    error.clasificacion = clasificacion;
    error.recepcion = estado;
    throw error;
  }
};

// 200 de §12 → { estado, diferencias: [{ item, nombre, unidad, enviada, recibida }] }, con el nombre
// sacado de las líneas.
export const resultadoDeRecepcion = (respuesta, entrega) => {
  const porItem = new Map((entrega?.lineas || []).map((linea) => [String(linea.item), linea]));
  const diferencias = (Array.isArray(respuesta?.diferencias) ? respuesta.diferencias : []).map((dif) => {
    const linea = porItem.get(String(dif?.item));
    return { item: dif?.item, nombre: linea?.nombre || `Ítem ${dif?.item}`, unidad: linea?.unidad || '', enviada: entero(dif?.enviada), recibida: entero(dif?.recibida) };
  });
  const estado = textoPlano(respuesta?.estado) || (diferencias.length ? 'RECIBIDA_CON_DIFERENCIAS' : 'RECIBIDA');
  return { estado, diferencias };
};

// «Colchón: mandaste 9, quedó 8».
export const textoDeDistinta = ({ nombre, mandada, registrada }) => `${nombre}: mandaste ${mandada}, quedó ${registrada}`;
