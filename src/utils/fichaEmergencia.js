// La ficha individual de Emergencia (Formulario 2, contrato-app-emergencia §13.11), sin React ni red.
// Es la copia para la app de `ESQUEMA_FICHA` (programas/services/emergencia_ficha.py): el back es la
// regla autoritativa; esto solo ayuda a cargar bien antes de mandar. Las claves de los errores son el
// nombre plano del campo, las mismas que devuelve el 400 VALIDACION (§13.8).
//
// La pantalla trabaja con la ficha **aplanada** ({campo: valor}): los nombres de campo no se repiten
// entre secciones, y el «sin datos» de una sección es `<seccion>_sin_datos`. Al mandar se vuelve a
// armar anidada, con solo lo respondido (una pregunta sin responder no se manda; `false` sí).
import { cleanDigits, isValidDni } from '../utils/dni';

export const FICHA_VERSION = 1;
export const EDAD_SIN_ADULTO_RESPONSABLE = 16;

export const PARENTESCOS = [
  { valor: 'JEFE', titulo: 'Jefe/a de hogar' },
  { valor: 'CONYUGE', titulo: 'Cónyuge/pareja' },
  { valor: 'HIJO', titulo: 'Hijo/a' },
  { valor: 'OTRO', titulo: 'Otro' },
];

// Ciudadano.Genero del legajo.
export const SEXOS_FICHA = [
  { valor: 'F', titulo: 'Femenino' },
  { valor: 'M', titulo: 'Masculino' },
  { valor: 'X', titulo: 'No binario' },
];

export const NIVELES_EDUCATIVOS = [
  { valor: 'SIN_INSTRUCCION', titulo: 'Sin instrucción' },
  { valor: 'INICIAL', titulo: 'Inicial' },
  { valor: 'PRIMARIO', titulo: 'Primario' },
  { valor: 'SECUNDARIO', titulo: 'Secundario' },
  { valor: 'TERCIARIO', titulo: 'Terciario' },
  { valor: 'UNIVERSITARIO', titulo: 'Universitario' },
];

const BOOLEANO = 'booleano';
const TEXTO = 'texto';
const FECHA = 'fecha';
const OPCION = 'opcion';
const valores = (lista) => lista.map((o) => o.valor);

// Sección → campo → [tipo, parámetro]. El orden es el de la pantalla.
export const ESQUEMA_FICHA = {
  parentesco: {
    parentesco: [OPCION, valores(PARENTESCOS)],
    parentesco_otro: [TEXTO, 80],
  },
  datos_personales: {
    dni: [TEXTO, 12],
    nombre: [TEXTO, 120],
    apellido: [TEXTO, 120],
    sexo: [OPCION, valores(SEXOS_FICHA)],
    fecha_nacimiento: [FECHA, null],
    fecha_nacimiento_aproximada: [BOOLEANO, null],
    telefono: [TEXTO, 40],
    documento_extraviado: [BOOLEANO, null],
  },
  avisos_salud: {
    embarazo: [BOOLEANO, null],
    discapacidad: [BOOLEANO, null],
    electrodependiente: [BOOLEANO, null],
    medicacion_critica: [BOOLEANO, null],
    medicacion_critica_nombre: [TEXTO, 200],
    medicacion_critica_tiene_dosis: [BOOLEANO, null],
    alergias_graves: [BOOLEANO, null],
    alergias_graves_detalle: [TEXTO, 200],
  },
  educacion: {
    nivel_educativo: [OPCION, valores(NIVELES_EDUCATIVOS)],
    escuela: [TEXTO, 200],
    asiste_escuela: [BOOLEANO, null],
  },
  vacunacion: {
    esquema_al_dia: [BOOLEANO, null],
    vacunacion_observacion: [TEXTO, 500],
  },
  salud: {
    obra_social: [TEXTO, 120],
    enfermedades_cronicas: [TEXTO, 500],
    medicacion_habitual: [TEXTO, 500],
  },
  trabajo: {
    ocupacion: [TEXTO, 200],
    ingresos: [TEXTO, 200],
  },
  observaciones: {
    observaciones: [TEXTO, 1000],
    mascotas: [BOOLEANO, null],
    adulto_responsable: [TEXTO, 200],
  },
};

export const SECCIONES_MINIMAS = ['parentesco', 'datos_personales', 'avisos_salud'];
export const SECCIONES_OPCIONALES = ['educacion', 'vacunacion', 'salud', 'trabajo', 'observaciones'];

export const ROTULOS_SECCION = {
  parentesco: 'Parentesco',
  datos_personales: 'Datos personales',
  avisos_salud: 'Avisos críticos de salud',
  educacion: 'Educación',
  vacunacion: 'Vacunación',
  salud: 'Salud y medicación',
  trabajo: 'Trabajo',
  observaciones: 'Observaciones, mascotas y adulto responsable',
};

// Las cinco preguntas que tienen que estar respondidas (RN-3.6), aunque sea «no».
export const PREGUNTAS_CRITICAS = [
  { clave: 'embarazo', titulo: 'Embarazo', rotulo: 'embarazo' },
  { clave: 'discapacidad', titulo: 'Discapacidad', rotulo: 'discapacidad' },
  { clave: 'electrodependiente', titulo: 'Electrodependiente', rotulo: 'electrodependencia' },
  { clave: 'medicacion_critica', titulo: 'Medicación crítica', rotulo: 'medicación crítica' },
  { clave: 'alergias_graves', titulo: 'Alergias graves', rotulo: 'alergias graves' },
];

// Para mostrar un error con un nombre que la guardia entienda.
export const ETIQUETAS_FICHA = {
  parentesco: 'Parentesco',
  parentesco_otro: 'Cuál parentesco',
  dni: 'DNI',
  nombre: 'Nombre',
  apellido: 'Apellido',
  sexo: 'Sexo',
  fecha_nacimiento: 'Fecha de nacimiento',
  fecha_nacimiento_aproximada: 'Fecha aproximada',
  telefono: 'Teléfono',
  documento_extraviado: 'Documento extraviado',
  medicacion_critica_nombre: 'Qué medicación crítica',
  medicacion_critica_tiene_dosis: 'Tiene dosis',
  alergias_graves_detalle: 'Detalle de alergias',
  nivel_educativo: 'Nivel educativo',
  escuela: 'Escuela',
  asiste_escuela: 'Asiste a la escuela',
  esquema_al_dia: 'Esquema de vacunación al día',
  vacunacion_observacion: 'Observación de vacunación',
  obra_social: 'Obra social',
  enfermedades_cronicas: 'Enfermedades crónicas',
  medicacion_habitual: 'Medicación habitual',
  ocupacion: 'Ocupación',
  ingresos: 'Ingresos',
  observaciones: 'Observaciones',
  mascotas: 'Mascotas',
  adulto_responsable: 'Adulto responsable',
  plaza: 'Cama',
  orden: 'Persona',
  ...Object.fromEntries(PREGUNTAS_CRITICAS.map(({ clave, titulo }) => [clave, titulo])),
  ...Object.fromEntries(SECCIONES_OPCIONALES.map((s) => [`${s}_sin_datos`, `${ROTULOS_SECCION[s]} · sin datos`])),
};

// Todos los nombres planos de la ficha (los errores del 400 que van a un campo de la pantalla).
export const CAMPOS_FICHA = Object.values(ESQUEMA_FICHA).flatMap((campos) => Object.keys(campos));

export const tipoDe = (campo) => {
  for (const campos of Object.values(ESQUEMA_FICHA)) if (campos[campo]) return campos[campo];
  return null;
};

export const MAXIMOS = Object.fromEntries(Object.values(ESQUEMA_FICHA)
  .flatMap((campos) => Object.entries(campos).filter(([, [tipo]]) => tipo === TEXTO).map(([campo, [, max]]) => [campo, max])));

// ---- Fechas ----
const dos = (n) => String(n).padStart(2, '0');
const diaReal = (anio, mes, dia) => {
  const fecha = new Date(anio, mes - 1, dia);
  return fecha.getFullYear() === anio && fecha.getMonth() === mes - 1 && fecha.getDate() === dia;
};
// DD/MM/AAAA o AAAA-MM-DD → AAAA-MM-DD, o null si no es una fecha que exista.
export const fechaIso = (valor) => {
  const texto = String(valor ?? '').trim();
  const iso = texto.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const local = iso ? null : texto.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  const [anio, mes, dia] = iso ? [iso[1], iso[2], iso[3]] : local ? [local[3], local[2], local[1]] : [];
  if (!anio || !diaReal(Number(anio), Number(mes), Number(dia))) return null;
  return `${anio}-${dos(mes)}-${dos(dia)}`;
};
// AAAA-MM-DD → DD/MM/AAAA (lo que muestra FechaInput). Lo que no se entiende queda igual.
export const fechaLocal = (valor) => {
  const iso = fechaIso(valor);
  if (!iso) return valor ? String(valor) : '';
  const [anio, mes, dia] = iso.split('-');
  return `${dia}/${mes}/${anio}`;
};
// Años cumplidos a `hoy`, o null sin fecha válida.
export const edadEnAnios = (valor, hoy = new Date()) => {
  const iso = fechaIso(valor);
  if (!iso) return null;
  const [anio, mes, dia] = iso.split('-').map(Number);
  let edad = hoy.getFullYear() - anio;
  if (hoy.getMonth() + 1 < mes || (hoy.getMonth() + 1 === mes && hoy.getDate() < dia)) edad -= 1;
  return edad;
};
export const esMenor = (plano, hoy = new Date()) => {
  const edad = edadEnAnios(plano?.fecha_nacimiento, hoy);
  return edad != null && edad >= 0 && edad < EDAD_SIN_ADULTO_RESPONSABLE;
};

// ---- Plano ↔ anidado ----
const vacio = (valor) => valor === null || valor === undefined || (typeof valor === 'string' && valor.trim() === '');

// La ficha guardada (§13.6, anidada, con `version`) → {campo: valor} para la pantalla. La fecha va
// como DD/MM/AAAA; los booleanos quedan true/false (sin responder: ausente).
export const fichaAPlano = (ficha) => {
  const plano = {};
  Object.entries(ESQUEMA_FICHA).forEach(([seccion, campos]) => {
    const datos = ficha && typeof ficha[seccion] === 'object' && ficha[seccion] ? ficha[seccion] : {};
    Object.entries(campos).forEach(([campo, [tipo]]) => {
      const valor = datos[campo];
      if (vacio(valor)) return;
      if (tipo === BOOLEANO) {
        if (typeof valor === 'boolean') plano[campo] = valor;
      } else if (tipo === FECHA) plano[campo] = fechaLocal(valor);
      else plano[campo] = String(valor);
    });
    if (SECCIONES_OPCIONALES.includes(seccion) && datos.sin_datos === true) plano[`${seccion}_sin_datos`] = true;
  });
  return plano;
};

// Los campos que solo valen si otra respuesta los abre: oculto, un valor viejo no viaja (y la pantalla
// lo limpia al cambiar la respuesta, `limpiarCondicionales`).
export const CONDICIONALES = {
  parentesco_otro: (plano) => plano?.parentesco === 'OTRO',
  medicacion_critica_nombre: (plano) => plano?.medicacion_critica === true,
  medicacion_critica_tiene_dosis: (plano) => plano?.medicacion_critica === true,
  alergias_graves_detalle: (plano) => plano?.alergias_graves === true,
};
const aplica = (campo, plano) => !CONDICIONALES[campo] || CONDICIONALES[campo](plano);
export const limpiarCondicionales = (plano) => {
  const limpio = { ...plano };
  Object.keys(CONDICIONALES).forEach((campo) => { if (!aplica(campo, limpio)) delete limpio[campo]; });
  return limpio;
};

// Una sección del plano → su objeto anidado, con solo lo respondido. Los textos van sin espacios
// exteriores, la fecha en AAAA-MM-DD (una que no se entiende va tal cual: el back la marca), el DNI
// con solo los dígitos.
export const seccionDesdePlano = (plano, seccion) => {
  const armada = {};
  if (SECCIONES_OPCIONALES.includes(seccion) && plano?.[`${seccion}_sin_datos`] === true) armada.sin_datos = true;
  Object.entries(ESQUEMA_FICHA[seccion] || {}).forEach(([campo, [tipo]]) => {
    const valor = plano?.[campo];
    if (!aplica(campo, plano)) return;
    if (tipo === BOOLEANO) {
      if (typeof valor === 'boolean') armada[campo] = valor;
      return;
    }
    if (vacio(valor)) return;
    if (tipo === FECHA) armada[campo] = fechaIso(valor) || String(valor).trim();
    else if (campo === 'dni') armada[campo] = cleanDigits(valor) || String(valor).trim();
    else armada[campo] = String(valor).trim();
  });
  return armada;
};

// La ficha anidada de las secciones pedidas (todas por defecto). No lleva `version`: la pone el back.
export const fichaDesdePlano = (plano, secciones = Object.keys(ESQUEMA_FICHA)) => Object.fromEntries(
  secciones.map((seccion) => [seccion, seccionDesdePlano(plano, seccion)]));

const igualJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// Las secciones 4 a 8 que cambiaron respecto de la ficha guardada: el PATCH manda solo esas, así no
// pisa lo que otra guardia cargó en otra sección mientras tanto (cada sección que viene reemplaza).
export const seccionesCambiadas = (plano, guardada) => {
  const base = fichaAPlano(guardada);
  return SECCIONES_OPCIONALES.filter((seccion) => !igualJson(seccionDesdePlano(plano, seccion), seccionDesdePlano(base, seccion)));
};

// ---- Borrador de «completar» (secciones 4 a 8) ----
// El borrador guarda SOLO las secciones que la guardia tocó y cómo estaban en el servidor cuando
// empezó (`base`), no el plano entero: al recuperarlo se ponen esas secciones sobre la ficha que el
// servidor tiene AHORA, así una sección que otra guardia guardó en el medio y acá no se tocó no
// «cambia» ni se manda (el back reemplaza la sección entera).
export const borradorDeCompletar = (plano, fichaBase) => {
  const base = fichaAPlano(fichaBase);
  const tocadas = seccionesCambiadas(plano, fichaBase);
  return {
    secciones: Object.fromEntries(tocadas.map((s) => [s, seccionDesdePlano(plano, s)])),
    base: Object.fromEntries(tocadas.map((s) => [s, seccionDesdePlano(base, s)])),
  };
};

// El plano con las secciones dadas ({seccion: anidada}) en lugar de las suyas.
export const ponerSecciones = (plano, secciones = {}) => {
  const nuevo = { ...plano };
  Object.entries(secciones).forEach(([seccion, datos]) => {
    if (!SECCIONES_OPCIONALES.includes(seccion)) return;
    Object.keys(ESQUEMA_FICHA[seccion]).forEach((campo) => { delete nuevo[campo]; });
    delete nuevo[`${seccion}_sin_datos`];
    Object.assign(nuevo, fichaAPlano({ [seccion]: datos || {} }));
  });
  return nuevo;
};

// Lo tocado (`borrador`: { secciones, base }) sobre la ficha del servidor de ahora. Una sección que el
// servidor cambió desde la base es un conflicto: NO se pone (queda la del servidor) y se devuelve en
// `conflictos` con lo que había tocado la guardia, para que elija. Devuelve { plano, conflictos }.
export const recuperarSobre = (servidor, borrador) => {
  const actual = fichaAPlano(servidor);
  const libres = {};
  const conflictos = {};
  Object.entries(borrador?.secciones || {}).forEach(([seccion, datos]) => {
    if (!SECCIONES_OPCIONALES.includes(seccion)) return;
    const hoy = seccionDesdePlano(actual, seccion);
    const base = borrador?.base?.[seccion] || {};
    if (igualJson(hoy, datos)) return;
    if (igualJson(hoy, base)) libres[seccion] = datos;
    else conflictos[seccion] = datos;
  });
  return { plano: ponerSecciones(actual, libres), conflictos };
};

// Rótulos de las secciones 4 a 8 sin ningún dato ni «sin datos», en orden (`secciones_incompletas`).
export const seccionesIncompletas = (plano) => SECCIONES_OPCIONALES
  .filter((seccion) => !Object.keys(seccionDesdePlano(plano, seccion)).length)
  .map((seccion) => ROTULOS_SECCION[seccion]);

// ---- Validación ----
export const TEXTOS_FICHA = {
  parentesco: 'Falta: parentesco con quien responde por la familia.',
  parentesco_otro: 'Con el parentesco «Otro», indicá cuál.',
  dni: 'Sin un número de DNI válido (7 u 8 dígitos) no se puede confirmar a la persona con cama.',
  pregunta: (rotulo) => `Falta: avisos de salud · respondé sí o no a ${rotulo}.`,
  medicacion_critica_nombre: 'Falta: avisos de salud · qué medicación crítica toma.',
  medicacion_critica_tiene_dosis: 'Falta: avisos de salud · si tiene dosis de la medicación.',
  adulto_responsable: `Es menor de ${EDAD_SIN_ADULTO_RESPONSABLE} años: indicá el adulto responsable.`,
  fecha: 'La fecha no es válida: tiene que ser DD/MM/AAAA.',
  futura: 'La fecha de nacimiento no puede ser futura.',
  opcion: 'Elegí una opción de la lista.',
  largo: (max) => `No puede tener más de ${max} caracteres.`,
  plaza: 'Elegí una cama del mapa.',
};

const agregar = (errores, campo, mensaje) => { errores[campo] = [...(errores[campo] || []), mensaje]; };

// Tipo y largo de los campos de las secciones pedidas (lo que el back rechaza «por campo»).
const validarTipos = (plano, secciones, errores, hoy) => {
  secciones.forEach((seccion) => Object.entries(ESQUEMA_FICHA[seccion]).forEach(([campo, [tipo, parametro]]) => {
    const valor = plano?.[campo];
    if (tipo === BOOLEANO || vacio(valor) || !aplica(campo, plano)) return;
    if (tipo === FECHA) {
      const iso = fechaIso(valor);
      if (!iso) agregar(errores, campo, TEXTOS_FICHA.fecha);
      else if ((edadEnAnios(iso, hoy) ?? 0) < 0) agregar(errores, campo, TEXTOS_FICHA.futura);
    } else if (tipo === OPCION) {
      if (!parametro.includes(String(valor).trim())) agregar(errores, campo, TEXTOS_FICHA.opcion);
    } else if (String(valor).trim().length > parametro) {
      agregar(errores, campo, TEXTOS_FICHA.largo(parametro));
    }
  }));
};

// Lo que se puede saber antes de mandar «Confirmar persona» (§13.8). Bloquea lo que el back exige
// siempre: parentesco (con cuál si es «Otro»), un DNI de 7 u 8 dígitos, las cinco preguntas de salud
// respondidas (con el nombre y la dosis si hay medicación crítica), el adulto responsable si la fecha
// cargada dice menor de 16, la cama, y los tipos y largos. Nombre, apellido, sexo y fecha NO bloquean
// acá: si la persona ya tiene legajo el back los completa con el DNI; si no, los marca él (400 por campo).
export const validarConfirmacion = (plano = {}, { plazaId = null, hoy = new Date() } = {}) => {
  const errores = {};
  if (!plano.parentesco) agregar(errores, 'parentesco', TEXTOS_FICHA.parentesco);
  else if (plano.parentesco === 'OTRO' && vacio(plano.parentesco_otro)) agregar(errores, 'parentesco_otro', TEXTOS_FICHA.parentesco_otro);
  if (!isValidDni(plano.dni)) agregar(errores, 'dni', TEXTOS_FICHA.dni);
  PREGUNTAS_CRITICAS.forEach(({ clave, rotulo }) => {
    if (typeof plano[clave] !== 'boolean') agregar(errores, clave, TEXTOS_FICHA.pregunta(rotulo));
  });
  if (plano.medicacion_critica === true) {
    if (vacio(plano.medicacion_critica_nombre)) agregar(errores, 'medicacion_critica_nombre', TEXTOS_FICHA.medicacion_critica_nombre);
    if (typeof plano.medicacion_critica_tiene_dosis !== 'boolean') {
      agregar(errores, 'medicacion_critica_tiene_dosis', TEXTOS_FICHA.medicacion_critica_tiene_dosis);
    }
  }
  if (esMenor(plano, hoy) && vacio(plano.adulto_responsable)) agregar(errores, 'adulto_responsable', TEXTOS_FICHA.adulto_responsable);
  validarTipos(plano, Object.keys(ESQUEMA_FICHA), errores, hoy);
  if (plazaId == null || plazaId === '') agregar(errores, 'plaza', TEXTOS_FICHA.plaza);
  return errores;
};

// Lo que se puede saber antes de guardar las secciones 4 a 8 (§13.6): tipos y largos, y que un menor
// de 16 no quede sin adulto responsable (el back vuelve a validar el mínimo con la ficha completa).
export const validarCompletar = (plano = {}, { hoy = new Date() } = {}) => {
  const errores = {};
  validarTipos(plano, SECCIONES_OPCIONALES, errores, hoy);
  if (esMenor(plano, hoy) && vacio(plano.adulto_responsable)) agregar(errores, 'adulto_responsable', TEXTOS_FICHA.adulto_responsable);
  return errores;
};

// Errores → lista para mostrar, con la etiqueta del campo adelante.
export const listaDeErroresFicha = (errores = {}) => Object.entries(errores || {})
  .flatMap(([campo, mensajes]) => (Array.isArray(mensajes) ? mensajes : [mensajes])
    .map((mensaje) => ({ campo, etiqueta: campo === 'generales' ? '' : (ETIQUETAS_FICHA[campo] || campo), texto: String(mensaje) })));
