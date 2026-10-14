import { becasRequest } from './becasApi';

export const DECEASED_MESSAGE = 'La persona figura como fallecida en la Base de Personas';
export const identityKey = (dni, sexo) => `${String(dni || '').replace(/\D/g, '')}:${String(sexo || '').trim().toUpperCase()}`;
export const isValidatedIdentity = origin => ['padron', 'personas', 'scan'].includes(origin);

export async function consultarIdentidad({dni, sexo, relevamiento}) {
  const payload = await becasRequest('/api/becas/personas/consultar/', {
    method: 'POST', body: {dni, sexo, relevamiento},
  });
  if (!payload?.success || !['padron', 'personas'].includes(payload.origen)) {
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
