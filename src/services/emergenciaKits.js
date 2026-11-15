import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import * as Crypto from 'expo-crypto';
import { Platform } from 'react-native';
import { getBecasToken, getStoredBecasUser } from './becasApi';
import { esConflictoDeEstado, esUuidEnUso, recibirEntrega } from './emergenciaApi';
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

// Validación de cliente antes de mandar. { lineas: { <item>: mensaje }, remito: [..] }.
export const validarRecepcion = ({ entrega, cantidades = {}, remito = null } = {}) => {
  const errores = {};
  const lineas = {};
  (entrega?.lineas || []).forEach((linea) => {
    const mensaje = errorDeCantidad(cantidades[String(linea.item)]);
    if (mensaje) lineas[String(linea.item)] = [mensaje];
  });
  if (Object.keys(lineas).length) errores.lineas = lineas;
  if (!remito?.uri && !remito?.file) errores.remito = [FALTA_REMITO];
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
// { <entregaId>: { uuid_cliente, dispositivo, cantidades, observacion, bloqueada } }. `bloqueada`:
// ya salió un pedido con ese uuid cuya respuesta no llegó; las cantidades no se cambian hasta
// saber si llegó (un reintento con el mismo uuid devuelve lo de la primera vez).
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
const modificar = (owner, cambio) => enOrden(async () => {
  const todas = await leerTodas(owner);
  const resultado = cambio(todas);
  await escribirTodas(owner, todas);
  return resultado;
});

const ownerActual = async () => {
  const user = await getStoredBecasUser();
  return user?.id != null ? String(user.id) : null;
};

const crearError = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });

// Abre (o recupera) la recepción de una entrega: fija el usuario y el token de esta pantalla y el
// uuid_cliente, que se guarda en el acto. Devuelve { owner, token, uuid_cliente, cantidades,
// observacion, bloqueada, recuperada }.
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
      todas[id] = { ...previa, cantidades, dispositivo: previa.dispositivo ?? dispositivoId };
      return { owner, token, uuid_cliente: previa.uuid_cliente, cantidades, observacion: textoPlano(previa.observacion),
        bloqueada: previa.bloqueada === true, recuperada: true };
    }
    todas[id] = { uuid_cliente: crearUuid(), dispositivo: dispositivoId, cantidades: iniciales, observacion: '', bloqueada: false };
    return { owner, token, uuid_cliente: todas[id].uuid_cliente, cantidades: iniciales, observacion: '', bloqueada: false, recuperada: false };
  });
};

// Guarda lo tipeado. No toca una recepción ya cerrada ni cambia su uuid.
export const guardarRecepcion = (owner, entregaId, { cantidades, observacion } = {}) => modificar(owner, (todas) => {
  const actual = todas[String(entregaId)];
  if (!actual || actual.bloqueada) return false;
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

// Descartar el intento: uuid nuevo, sin bloqueo, con lo cargado. Devuelve el uuid nuevo.
export const descartarIntento = (owner, entregaId) => modificar(owner, (todas) => {
  const actual = todas[String(entregaId)] || {};
  const uuid = crearUuid();
  todas[String(entregaId)] = { ...actual, uuid_cliente: uuid, bloqueada: false };
  return uuid;
});

// Al traer las pendientes de un dispositivo: se olvidan las recepciones abiertas de ese
// dispositivo cuya entrega ya no está pendiente (la recibió otro, la canceló la mesa). Devuelve los
// ids de las que siguen abiertas.
export const recepcionesAbiertas = async (dispositivoId, idsPendientes = []) => {
  const owner = await ownerActual();
  if (!owner) return [];
  const vigentes = new Set(idsPendientes.map(String));
  return modificar(owner, (todas) => {
    Object.entries(todas).forEach(([id, recepcion]) => {
      if (String(recepcion?.dispositivo) === String(dispositivoId) && !vigentes.has(id)) delete todas[id];
    });
    return Object.keys(todas).filter((id) => vigentes.has(id));
  });
};

const bytesDe = (asset) => Number(asset?.fileSize || asset?.size || asset?.file?.size) || 0;

// §12. Valida, mira la red, marca la recepción como bloqueada (desde acá el pedido puede llegar),
// manda con el uuid y el token de la recepción y la cierra con 200/201. Un error sale con
// `clasificacion` (clasificarErrorRecepcion); 400 y 413 la desbloquean (el back no escribió nada),
// 409 de estado y 404 la cierran.
export const enviarRecepcion = async ({ entrega, recepcion, cantidades = {}, remito = null, observacion = '' }) => {
  const errores = validarRecepcion({ entrega, cantidades, remito });
  if (hayErroresRecepcion(errores)) {
    throw crearError('VALIDACION_LOCAL', 'Hay datos para corregir.', { clasificacion: { tipo: 'validacion', mensaje: 'Corregí lo marcado.', errores } });
  }
  if (!await hayConexion()) {
    throw crearError('SIN_RED', TEXTO_SIN_RED, { clasificacion: { tipo: 'sin_red', mensaje: TEXTO_SIN_RED } });
  }
  const { owner, token, uuid_cliente: uuid } = recepcion;
  const numeros = armarCantidades(entrega, cantidades);
  const nota = String(observacion || '').trim();
  await modificar(owner, (todas) => {
    const actual = todas[String(entrega.id)] || {};
    todas[String(entrega.id)] = { ...actual, uuid_cliente: uuid, cantidades: { ...cantidades }, observacion: String(observacion || ''), bloqueada: true };
  });
  try {
    const respuesta = await recibirEntrega(entrega.id, { uuid_cliente: uuid, cantidades: numeros, remito, observacion: nota },
      { timeoutMs: timeoutDelEnvio(bytesDe(remito)), token });
    await cerrarRecepcion(owner, entrega.id);
    return resultadoDeRecepcion(respuesta, entrega);
  } catch (error) {
    const clasificacion = clasificarErrorRecepcion(error);
    if (['validacion', 'pesada', 'sin_modulo'].includes(clasificacion.tipo)) {
      await modificar(owner, (todas) => {
        if (todas[String(entrega.id)]) todas[String(entrega.id)].bloqueada = false;
      });
    } else if (['conflicto', 'no_encontrada'].includes(clasificacion.tipo)) {
      await cerrarRecepcion(owner, entrega.id);
    }
    error.clasificacion = clasificacion;
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
