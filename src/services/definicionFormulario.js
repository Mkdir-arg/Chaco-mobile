import { aplicar, estaVacio } from './condiciones';
import { dateKey } from '../utils/dates';

export const usaConstructor = definition => Array.isArray(definition?.items);
const enApp = item => item?.activo !== false && (!item?.canal || ['app', 'ambos'].includes(item.canal));
export const esIdentidad = field => field.origen === 'legajo'
  && ['dni', 'nombre', 'apellido', 'fecha_nacimiento', 'genero'].includes(field.vinculo);

export const normalizarCampo = field => ({
  ...field,
  id: field.clave,
  original_id: field.id,
  scope: field.clave.startsWith('pg-') ? 'globales' : field.clave.startsWith('rn-') ? 'requisitos' : 'propios',
  etiqueta: field.texto || field.clave,
  requerido: Boolean(field.obligatorio),
});

export const gruposDelDiseno = definition => (definition?.items || [])
  .filter(enApp)
  .map((group, index) => ({
    ...group,
    stepId: index + 2,
    items: (group.items || []).filter(enApp).map(item => item.tipo === 'texto' ? item : normalizarCampo(item)),
  }));

export const camposDelDiseno = definition => gruposDelDiseno(definition)
  .flatMap(group => group.items.filter(item => item.tipo !== 'texto'));

export const fechaRespuesta = value => {
  if (!value) return '';
  const text = String(value).trim();
  const parts = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
  return parts ? parts[3] + '-' + parts[2] + '-' + parts[1] : text;
};

const identityFields = { dni: 'dni_numero', genero: 'dni_sexo', nombre: 'nombres', apellido: 'apellido', fecha_nacimiento: 'fecha_nacimiento' };
const contactFields = { telefono: 'celular', email: 'email_contacto' };

export const vinculoDelCampo = field => {
  if (field.origen === 'persona_vinculada') return { form: 'apoderado', key: field.vinculo === 'genero' ? 'sexo' : field.vinculo };
  if (field.origen === 'legajo') {
    if (identityFields[field.vinculo]) return { form: 'identidad', key: identityFields[field.vinculo] };
    if (contactFields[field.vinculo]) return { form: 'contacto', key: contactFields[field.vinculo] };
  }
  return null;
};

export const valorDelCampo = (field, state) => {
  const bound = vinculoDelCampo(field);
  return bound ? state[bound.form]?.[bound.key] ?? '' : state.valores?.[field.id] ?? '';
};

// The array order is the order of ItemDiseno, not the catalogue's orden.
export const evaluarDiseno = (definition, state, capturedAt) => {
  const groups = gruposDelDiseno(definition);
  const fields = groups.flatMap(group => group.items.filter(item => item.tipo !== 'texto'));
  const answers = Object.fromEntries(fields.map(field => [field.clave,
    field.tipo === 'DATE' ? fechaRespuesta(valorDelCampo(field, state)) : valorDelCampo(field, state)]));
  const flat = groups.flatMap(group => [{ ...group, tipo: 'grupo', padre: null },
    ...group.items.map(item => ({ ...item, tipo: item.tipo === 'texto' ? 'texto' : 'campo', padre: group.clave }))]);
  // The server removes rules whose source is not served on this channel.
  const keys = new Set(flat.filter(item => item.tipo === 'campo').map(item => item.clave));
  flat.forEach(item => {
    if (item.condicion) item.condicion = { ...item.condicion, reglas: (item.condicion.reglas || []).filter(rule => keys.has(rule.fuente)) };
  });
  const day = dateKey(capturedAt || new Date());
  const result = aplicar(flat, answers, new Date(day + 'T12:00:00'));
  const visibleGroups = groups.filter(group => result.visibles.has(group.clave))
    .map(group => ({ ...group, items: group.items.filter(item => result.visibles.has(item.clave)) }))
    .filter(group => group.items.length);
  return { ...result, grupos: visibleGroups, campos: fields.filter(field => result.visibles.has(field.clave)) };
};

export const faltantesDelDiseno = (fields, answers) => fields.filter(field => {
  const value = answers[field.clave];
  if (field.tipo === 'ARCHIVO') return field.requerido && !value?.uri && !value?.dataUri && !value?.archivo_adjunto;
  if (estaVacio(value)) return field.requerido;
  if (field.tipo === 'INT') return !/^-?\d+$/.test(String(value).trim());
  if (field.tipo === 'DATE') {
    const text = fechaRespuesta(value);
    const parsed = new Date(text + 'T12:00:00Z');
    return !/^\d{4}-\d{2}-\d{2}$/.test(text) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text;
  }
  return false;
}).map(field => field.etiqueta);

export const columnasLegacy = (fields, answers) => {
  const columns = {};
  for (const field of fields) {
    const bound = vinculoDelCampo(field);
    if (bound?.form === 'contacto') columns[bound.key] = answers[field.clave] ?? '';
    if (bound?.form === 'apoderado') {
      const key = 'apoderado_' + (bound.key === 'sexo' ? 'genero' : bound.key);
      columns[key] = answers[field.clave] ?? '';
    }
  }
  return columns;
};

export const datosDelDiseno = (definition, design) => ({
  celular: '', email_contacto: '', apoderado_nombre: '', apoderado_apellido: '',
  apoderado_dni: '', apoderado_genero: '', apoderado_fecha_nacimiento: null,
  ...columnasLegacy(design.campos, design.efectivas),
  ...(definition.acepta_respuestas === true ? { respuestas: design.efectivas } : {}),
});
