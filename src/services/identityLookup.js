import { becasRequest } from './becasApi';

export const DECEASED_MESSAGE = 'La persona figura como fallecida en la Base de Personas';
export const identityKey = (dni, sexo) => `${String(dni || '').replace(/\D/g, '')}:${String(sexo || '').trim().toUpperCase()}`;
export const isValidatedIdentity = origin => ['padron', 'personas', 'scan'].includes(origin);

export const RUTA_CONSULTA_BECAS = '/api/becas/personas/consultar/';
export const ORIGENES_BECAS = ['padron', 'personas'];

// `ruta` y `origenes` (las fuentes que se aceptan como válidas) son de Becas por defecto.
// Emergencia usa su propia ruta, que consulta solo Base de Personas (ver emergenciaApi).
export async function consultarIdentidad({dni, sexo, relevamiento}, {ruta = RUTA_CONSULTA_BECAS, origenes = ORIGENES_BECAS} = {}) {
  const payload = await becasRequest(ruta, {
    method: 'POST', body: {dni, sexo, relevamiento},
  });
  if (!payload?.success || !origenes.includes(payload.origen)) {
    throw new Error(payload?.error || 'La consulta no devolvió una fuente de identidad válida.');
  }
  return payload;
}

export function identityFailure(error) {
  if (error?.status === 404 && error?.payload?.fallecido === true) {
    return {blocked: true, message: DECEASED_MESSAGE};
  }
  if (error?.status === 429) {
    return {blocked: false, message: 'Alcanzaste el tope de consultas de identidad por hora; seguí con carga manual'};
  }
  return {blocked: false, message: error?.message || 'No se pudo consultar Base de Personas.'};
}
