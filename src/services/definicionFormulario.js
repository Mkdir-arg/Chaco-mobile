import { aplicar, estaVacio } from './condiciones';
import { dateKey } from '../utils/dates';

// Solo con items cargados: un back que manda `items: []` (diseño sin armar) cae al
// camino legacy (globales/requisitos) en vez de dejar el formulario vacío.
export const usaConstructor = definition => Array.isArray(definition?.items) && definition.items.length > 0;

// Contrato de cupo: el back manda `cupo_completo`/`cupo_disponible` (null si es viejo).
// `sinEnviar` son las cargas locales que todavía no descontaron del cupo del back.
// Un detalle guardado por la versión anterior trae `cupo_disponible: 0` y
// `cupo_completo: false` aunque el back no mandara esas claves; el back nuevo, sin
// disponible, manda `cupo_completo: true`. Un disponible <= 0 sin eso no es confiable.
export const cupoDisponibleConfiable = (detail) => {
  const disponible = detail?.cupo_disponible;
  if (typeof disponible !== 'number' || !Number.isFinite(disponible)) return null;
  return disponible <= 0 && detail?.cupo_completo !== true ? null : disponible;
};

export const cupoCompleto = (detail, formulariosCount = 0, sinEnviar = 0) => {
  const cupoMaximo = Number(detail?.cupo_maximo || 0);
  const disponible = cupoDisponibleConfiable(detail);
  return detail?.cupo_completo === true
    || (cupoMaximo > 0 && disponible != null && disponible - sinEnviar <= 0)
    // Piso: el disponible del detalle se lee una vez y queda viejo al sincronizar las
    // cargas locales; el cálculo de siempre nunca deja cargar de más.
    || (cupoMaximo > 0 && formulariosCount >= cupoMaximo);
};

// Reabrir solo desde FINALIZADO y con la ventana todavía abierta (hora corregida).
export const puedeReabrir = (detail, ahora = new Date()) => {
  if (String(detail?.estado || '').toUpperCase() !== 'FINALIZADO') return false;
  const hasta = detail?.fecha_hasta ? new Date(detail.fecha_hasta) : null;
  return !!hasta && !Number.isNaN(hasta.getTime()) && hasta.getTime() > ahora.getTime();
};

// DNI duplicado: `avisar` deja seguir con este aviso (RECHAZADO o BAJA).
export const avisoDuplicado = estado => 'Este DNI tiene un caso '
  + (String(estado || '').toUpperCase() === 'BAJA' ? 'dado de baja' : 'rechazado')
  + ' en este relevamiento. Podés seguir; el back lo marca para revisión.';

// personas/consultar solo acepta F/M: con X se va directo a carga manual.
export const consultaPadronPermitida = sexo => ['F', 'M'].includes(String(sexo || '').toUpperCase());

export const sinGpsObservado = (definition, payload) => definition?.requiere_gps === true
  && !(String(payload?.gps_lat ?? '').trim() && String(payload?.gps_lng ?? '').trim());
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
  // A source missing from the definition evaluates as empty, exactly like
  // condiciones.py. Sources outside the channel are the server's job (BEC-04):
  // serializar nulls the whole condition before it reaches the app.
  const day = dateKey(capturedAt || new Date());
  const result = aplicar(flat, answers, new Date(day + 'T12:00:00'));
  const visibleGroups = groups.filter(group => result.visibles.has(group.clave))
    .map(group => ({ ...group, items: group.items.filter(item => result.visibles.has(item.clave)) }))
    .filter(group => group.items.length);
  return { ...result, grupos: visibleGroups, campos: fields.filter(field => result.visibles.has(field.clave)) };
};

export const esCampoEmail = field => ['email', 'email_contacto'].includes(field.vinculo)
  || String(field.tipo || '').toUpperCase() === 'EMAIL';

export const errorDelCampo = (field, value) => {
  const tipo = String(field.tipo || '').toUpperCase();
  if (tipo === 'ARCHIVO') return field.requerido && !value?.uri && !value?.dataUri && !value?.archivo_adjunto
    ? 'Adjuntá un archivo.' : '';
  if (estaVacio(value)) return field.requerido ? 'Este campo es obligatorio.' : '';
  if (esCampoEmail(field) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value).trim())) {
    return 'Ingresá un correo electrónico válido, por ejemplo nombre@dominio.com.';
  }
  if (['INT', 'NUMERO'].includes(tipo) && !/^-?\d+$/.test(String(value).trim())) {
    return 'Ingresá un número entero, sin letras ni decimales.';
  }
  if (['DATE', 'FECHA'].includes(tipo)) {
    const text = fechaRespuesta(value);
    const parsed = new Date(text + 'T12:00:00Z');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
      return 'Ingresá una fecha válida.';
    }
  }
  return '';
};

export const faltantesDelDiseno = (fields, answers) => fields
  .filter(field => errorDelCampo(field, answers[field.clave])).map(field => field.etiqueta);

export const problemasDelDiseno = (fields, answers) => fields.flatMap(field => {
  const error = errorDelCampo(field, answers[field.clave]);
  return error ? [`${field.etiqueta}: ${error}`] : [];
});

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
