// Detectores de avisos (etapa A). Cada uno recibe un contexto
//   { db, owner, ahora(), pedir(ruta), hayRed() }
// y devuelve los avisos que acaba de crear. Ninguno propaga un error: un fallo aquí no
// puede cortar ni demorar la sincronización ni el refresco que los llaman.
import { crearAviso, guardarEstado, leerEstado } from './avisos';
import { GRACE_EXPIRED, INVALID_SUBMISSION, REJECTED_ATTACHMENTS } from './formularioSync';
import { dateKey, formatDate, parseAssignmentDate } from '../utils/dates';

const HORA_MS = 60 * 60 * 1000;
const DIA_MS = 24 * HORA_MS;
export const SEGUIR_VENCIDOS_MS = 30 * DIA_MS;
export const ANTIGUEDAD_COLA_MS = 2 * HORA_MS;
export const REPETIR_ANTIGUEDAD_MS = DIA_MS;
export const CODIGOS_REQUIEREN_ATENCION = [GRACE_EXPIRED, INVALID_SUBMISSION, REJECTED_ATTACHMENTS];

const reloj = (ctx) => (typeof ctx.ahora === 'function' ? ctx.ahora() : Date.now());

const aislado = (nombre, tarea) => async (...args) => {
  try {
    return await tarea(...args);
  } catch (error) {
    console.warn('[AVISOS][ERROR]', nombre, error?.message);
    return [];
  }
};

const unir = (partes) => partes.filter((parte) => parte != null && String(parte).trim() !== '').join(' · ');
const esRelevamientoRemoto = (item) => item?.id != null && !String(item.id).startsWith('local_rel_')
  && (item.backend == null || item.backend === 'django_becas');
const numeroDe = (item) => String(item?.numero ?? item?.id);

export const rutaFormularios = (relevamientoId) => `/api/becas/relevamientos/${relevamientoId}/formularios/`;

// ---------------------------------------------------------------- aviso 2: relevamiento nuevo
export const detectarRelevamientosNuevos = aislado('relevamientos', async (ctx, records) => {
  const { db, owner } = ctx;
  if (!owner) return [];
  const listado = (records || []).filter(esRelevamientoRemoto);
  const lineaDeBase = (await leerEstado(db, owner, 'base_relevamientos')) === '1';
  const filas = await db.getAllAsync('SELECT * FROM avisos_relevamientos_vistos WHERE owner = ?', owner);
  const vistos = new Map(filas.map((fila) => [String(fila.relevamiento_id), fila]));
  const creados = [];
  for (const item of listado) {
    const id = String(item.id);
    const numero = numeroDe(item);
    const fechaHasta = item.fecha_hasta || null;
    const previo = vistos.get(id);
    if (previo) {
      if (previo.fecha_hasta !== fechaHasta || previo.numero !== numero) {
        await db.runAsync(
          'UPDATE avisos_relevamientos_vistos SET fecha_hasta = ?, numero = ? WHERE owner = ? AND relevamiento_id = ?',
          fechaHasta, numero, owner, id
        );
      }
      continue;
    }
    if (lineaDeBase) {
      const vence = dateKey(fechaHasta) ? `vence el ${formatDate(fechaHasta).slice(0, 5)}` : '';
      const aviso = {
        tipo: 'relevamiento_nuevo',
        clave: `rel:${id}`,
        relevamiento_id: id,
        titulo: `Te asignaron el relevamiento N° ${numero}`,
        texto: unir([item.titulo || item.nombre, vence]),
      };
      if (await crearAviso(db, owner, aviso, reloj(ctx))) creados.push(aviso);
    }
    await db.runAsync(
      'INSERT OR IGNORE INTO avisos_relevamientos_vistos (owner, relevamiento_id, fecha_hasta, numero) VALUES (?, ?, ?, ?)',
      owner, id, fechaHasta, numero
    );
  }
  if (!lineaDeBase) await guardarEstado(db, owner, 'base_relevamientos', '1');
  return creados;
});

// ---------------------------------------------------------------- aviso 1: caso rechazado
const relevamientosASeguir = async (ctx, records) => {
  const { db, owner } = ctx;
  const filas = await db.getAllAsync('SELECT * FROM avisos_relevamientos_vistos WHERE owner = ?', owner);
  const dejados = new Set(filas.filter((fila) => Number(fila.seguido) === 0).map((fila) => String(fila.relevamiento_id)));
  const seguir = new Map();
  for (const item of (records || []).filter(esRelevamientoRemoto)) {
    if (!dejados.has(String(item.id))) seguir.set(String(item.id), numeroDe(item));
  }
  for (const fila of filas) {
    const id = String(fila.relevamiento_id);
    if (dejados.has(id) || seguir.has(id)) continue;
    const hasta = parseAssignmentDate(fila.fecha_hasta, { endOfDay: true });
    if (hasta && reloj(ctx) - hasta.getTime() <= SEGUIR_VENCIDOS_MS) seguir.set(id, fila.numero || id);
  }
  return seguir;
};

const textoRechazo = (formulario) => {
  const persona = [formulario.ciudadano_apellido, formulario.ciudadano_nombre]
    .filter((parte) => parte && String(parte).trim()).join(', ');
  const dni = formulario.ciudadano_dni ? `(DNI ${formulario.ciudadano_dni})` : '';
  const motivo = formulario.motivo_rechazo ? `Motivo: ${formulario.motivo_rechazo}` : '';
  return unir([[persona, dni].filter(Boolean).join(' '), motivo]);
};

export const detectarRechazos = aislado('rechazos', async (ctx, records) => {
  const { db, owner } = ctx;
  if (!owner) return [];
  if (!(await ctx.hayRed())) return [];
  const seguir = await relevamientosASeguir(ctx, records);
  const conocidas = new Set((await db.getAllAsync(
    'SELECT formulario_id FROM avisos_rechazos_conocidos WHERE owner = ?', owner
  )).map((fila) => String(fila.formulario_id)));
  const creados = [];
  // De a uno: nunca una ráfaga de consultas en paralelo.
  for (const [relevamientoId, numero] of seguir) {
    let respuesta;
    try {
      respuesta = await ctx.pedir(rutaFormularios(relevamientoId));
    } catch (error) {
      const status = Number(error?.status || 0);
      if (status === 404) {
        await db.runAsync(
          `INSERT INTO avisos_relevamientos_vistos (owner, relevamiento_id, numero, seguido) VALUES (?, ?, ?, 0)
           ON CONFLICT(owner, relevamiento_id) DO UPDATE SET seguido = 0`,
          owner, relevamientoId, String(numero)
        );
        continue;
      }
      if (status === 401 || status === 403) break;
      continue; // red o 5xx: se reintenta en la próxima pasada
    }
    const formularios = Array.isArray(respuesta) ? respuesta : (respuesta?.results || respuesta?.data || []);
    const rechazados = formularios.filter((item) => String(item?.estado || '').toUpperCase() === 'RECHAZADO' && item?.id != null);
    const claveBase = `base_rechazos:${relevamientoId}`;
    const lineaDeBase = (await leerEstado(db, owner, claveBase)) === '1';
    for (const formulario of rechazados) {
      const id = String(formulario.id);
      if (conocidas.has(id)) continue;
      if (lineaDeBase) {
        const aviso = {
          tipo: 'caso_rechazado',
          clave: `rech:${id}`,
          relevamiento_id: relevamientoId,
          formulario_id: id,
          titulo: `Rechazaron un caso del relevamiento N° ${numero}`,
          texto: textoRechazo(formulario),
        };
        if (await crearAviso(db, owner, aviso, reloj(ctx))) creados.push(aviso);
      }
      await db.runAsync(
        'INSERT OR IGNORE INTO avisos_rechazos_conocidos (owner, formulario_id, relevamiento_id) VALUES (?, ?, ?)',
        owner, id, relevamientoId
      );
      conocidas.add(id);
    }
    if (!lineaDeBase) await guardarEstado(db, owner, claveBase, '1');
  }
  return creados;
});

// ---------------------------------------------------------------- aviso 4: cargas sin subir
export const detectarCola = aislado('cola', async (ctx, operaciones) => {
  const { db, owner } = ctx;
  if (!owner) return [];
  const creados = [];
  const ahora = reloj(ctx);
  for (const operacion of operaciones || []) {
    if (operacion.status !== 'FAILED_PERMANENT' || !CODIGOS_REQUIEREN_ATENCION.includes(operacion.last_error_code)) continue;
    const aviso = {
      tipo: 'carga_atencion',
      clave: `cola:${operacion.local_id}`,
      relevamiento_id: operacion.payload?.relevamiento_id,
      titulo: 'Una carga necesita tu atención',
      texto: operacion.last_error || '',
    };
    if (await crearAviso(db, owner, aviso, ahora)) creados.push(aviso);
  }
  const pendientes = (operaciones || []).filter((operacion) => operacion.status === 'PENDING' && operacion.type === 'insert_relevamiento');
  const activo = (await leerEstado(db, owner, 'antiguedad_activa')) === '1';
  if (!pendientes.length) {
    if (activo) await guardarEstado(db, owner, 'antiguedad_activa', '0');
    return creados;
  }
  const masVieja = pendientes.reduce((primera, actual) =>
    (Date.parse(actual.created_at) < Date.parse(primera.created_at) ? actual : primera));
  if (!(ahora - Date.parse(masVieja.created_at) > ANTIGUEDAD_COLA_MS)) return creados;
  const ultimo = Number(await leerEstado(db, owner, 'antiguedad_ultimo_aviso') || 0);
  if (activo && ahora - ultimo < REPETIR_ANTIGUEDAD_MS) return creados;
  const total = pendientes.length;
  const aviso = {
    tipo: 'cargas_sin_subir',
    clave: `cola:antiguedad:${ahora}`,
    relevamiento_id: masVieja.payload?.relevamiento_id,
    titulo: `Tenés ${total} ${total === 1 ? 'carga' : 'cargas'} sin subir`,
    texto: 'Revisá la conexión o sincronizá desde el detalle del relevamiento.',
  };
  if (await crearAviso(db, owner, aviso, ahora)) creados.push(aviso);
  await guardarEstado(db, owner, 'antiguedad_activa', '1');
  await guardarEstado(db, owner, 'antiguedad_ultimo_aviso', ahora);
  return creados;
});
