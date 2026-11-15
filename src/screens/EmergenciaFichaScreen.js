import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable, ActivityIndicator, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import TextInput from '../components/FormInput';
import FechaInput from '../components/FechaInput';
import CustomButton from '../components/CustomButton';
import { useTheme } from '../context/ThemeContext';
import { useToast } from '../context/ToastContext';
import {
  TEXTO_SIN_RED, abrirSesion, borrarBorradorFicha, camasElegibles, cargarCamas, cargarPersona, clasificarErrorLlegada,
  completarFicha, confirmarPendiente, confirmarPersona, escucharRed, estadoDeCama, estadoDeIntegrante, guardarBorradorFicha,
  hayConexion, leerBorradorFicha, olvidarConfirmarPendiente, revisarCama, buscarCama, esSoloLectura,
} from '../services/emergenciaLlegadas';
import {
  MAXIMOS, NIVELES_EDUCATIVOS, PARENTESCOS, PREGUNTAS_CRITICAS, ROTULOS_SECCION, SECCIONES_OPCIONALES, SEXOS_FICHA,
  esMenor, fichaAPlano, listaDeErroresFicha, seccionesCambiadas, seccionesIncompletas, validarCompletar, validarConfirmacion,
} from '../utils/fichaEmergencia';
import { cleanDigits } from '../utils/dni';
import { statusTones } from '../theme/statusBadges';
import { keyboardDismissModeFor } from '../utils/teclado';
import { fontSizes, radii } from '../theme';

const AUTOGUARDADO_MS = 500;
export const TEXTO_BORRADOR = 'Recuperamos lo que habías cargado de esta persona y todavía no se mandó.';
export const TEXTO_SIN_CAMAS = 'No queda ninguna cama libre ni guardada para esta familia. Liberá una o cerrá el ingreso con diferencia.';
export const TEXTO_LEGAJO = 'Si la persona ya tiene legajo, alcanza con el DNI: el sistema completa nombre, apellido, sexo y fecha.';
export const TEXTO_CERRADO = 'El caso está cerrado: la ficha se muestra en modo lectura.';

// Qué secciones 4 a 8 se dibujan y con qué campos (el orden de §13.11).
const CAMPOS_OPCIONALES = {
  educacion: [['nivel_educativo', 'opciones', NIVELES_EDUCATIVOS], ['escuela', 'texto', 'Escuela'], ['asiste_escuela', 'siNo', 'Asiste a la escuela']],
  vacunacion: [['esquema_al_dia', 'siNo', 'Esquema de vacunación al día'], ['vacunacion_observacion', 'area', 'Observación de vacunación']],
  salud: [['obra_social', 'texto', 'Obra social'], ['enfermedades_cronicas', 'area', 'Enfermedades crónicas'], ['medicacion_habitual', 'area', 'Medicación habitual']],
  trabajo: [['ocupacion', 'texto', 'Ocupación'], ['ingresos', 'texto', 'Ingresos']],
  observaciones: [['observaciones', 'area', 'Observaciones'], ['mascotas', 'siNo', 'Mascotas'], ['adulto_responsable', 'texto', 'Adulto responsable']],
};

// M2-4 · Una persona de la familia (§13.6 a §13.8, §13.11). Dos modos, según el servidor:
// - **Confirmar** (persona sin confirmar, ingreso en curso): el mínimo del Formulario 2 (parentesco,
//   datos personales, las cinco preguntas de salud, el adulto responsable de un menor de 16), la cama
//   del mapa (§13.7; se propone una guardada para la familia) y, si se quiere, las secciones 4 a 8.
//   «Confirmar persona» es idempotente por `uuid_cliente`, guardado por persona hasta saber el resultado.
// - **Completar** (persona confirmada, ingreso en curso o familia alojada): las secciones 4 a 8, con
//   «sin datos». El PATCH manda solo las secciones que cambiaron. Con el caso cerrado, solo lectura.
// Con conexión: sin red no se carga ni se manda nada. Lo tipeado se guarda como borrador local.
// - `caso`: { id, numero, estado } (el de los integrantes). `n`: la persona. `dispositivo`: { id }.
// - `onTerminar(resultado)`: confirmada o guardada → el padre vuelve a los integrantes (recarga).
// - `onConflicto(clasificacion)`: 409 → el padre recarga por `estado_actual` (§13.1).
// - `onNoEncontrado()`: 404 (la persona o el caso ya no). `onSinModulo(mensaje)`: 403.
// - `onEnviando(bool)`: hay un envío en curso (el padre oculta «volver»).
// `recarga` cambia con el botón de sincronizar del Banner: vuelve a pedir el mapa de camas.
export default function EmergenciaFichaScreen({
  caso, n, dispositivo, recarga = 0, onTerminar, onConflicto, onNoEncontrado, onSinModulo, onEnviando,
}) {
  const { theme, typography } = useTheme();
  const { showAlert, showToast } = useToast();
  const [sesion, setSesion] = useState(null);
  const [persona, setPersona] = useState(null);
  const [plano, setPlano] = useState(null);
  const [plazaId, setPlazaId] = useState(null);
  const [mapa, setMapa] = useState(null);
  const [cargandoMapa, setCargandoMapa] = useState(false);
  const [errorMapa, setErrorMapa] = useState(null);
  const [eligiendoCama, setEligiendoCama] = useState(false);
  const [verOpcionales, setVerOpcionales] = useState(false);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState(null);
  const [sinRed, setSinRed] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [falla, setFalla] = useState(null);
  const [incierto, setIncierto] = useState(false);
  const [intentado, setIntentado] = useState(false);
  const [erroresServidor, setErroresServidor] = useState({});
  const montado = useRef(true);
  const sesionRef = useRef(null);
  const personaRef = useRef(null);
  personaRef.current = persona;
  const enviandoRef = useRef(false);
  const terminado = useRef(false);
  const tocado = useRef(false);
  const ultimo = useRef(null);
  const pedidoMapa = useRef(0);
  const recargaInicial = useRef(recarga);
  const casoId = caso?.id;

  const modo = persona ? (persona.estado === 'SIN_CONFIRMAR' ? 'confirmar' : 'completar') : null;
  // Sin confirmar con la familia ya alojada o cerrada no se puede confirmar; confirmada con el caso
  // cerrado no se puede completar (el back contesta 409): las dos son solo lectura.
  const lectura = caso?.estado === 'CERRADO' || (modo === 'confirmar' && esSoloLectura(caso));

  const rutear = (c) => {
    if (c.tipo === 'conflicto') {
      onConflicto?.(c);
      return true;
    }
    if (c.tipo === 'no_encontrado') {
      onNoEncontrado?.();
      return true;
    }
    if (c.tipo === 'sin_modulo') {
      onSinModulo?.(c.mensaje);
      return true;
    }
    return false;
  };

  // El mapa (§13.7). `elegida`: la cama a conservar si sigue sirviendo; si no, se propone otra.
  const pedirMapa = async (elegida, { avisar = false } = {}) => {
    const base = sesionRef.current;
    if (!base || !dispositivo?.id) return;
    const numero = ++pedidoMapa.current;
    setCargandoMapa(true);
    setErrorMapa(null);
    try {
      const nuevo = await cargarCamas(base, dispositivo.id, casoId);
      if (!montado.current || numero !== pedidoMapa.current) return;
      setMapa(nuevo);
      const revisada = revisarCama(nuevo, elegida);
      setPlazaId(revisada.plaza?.id ?? null);
      if (avisar && revisada.cambio) {
        const antes = revisada.anterior?.nombre || 'La cama elegida';
        showToast({ type: 'warning', message: revisada.plaza
          ? `${antes} ya no se puede elegir. Te propusimos ${revisada.plaza.nombre}: revisala y confirmá de nuevo.`
          : `${antes} ya no se puede elegir. Elegí otra del mapa.` });
      }
    } catch (e) {
      if (!montado.current || numero !== pedidoMapa.current) return;
      const c = e?.clasificacion || clasificarErrorLlegada(e);
      if (c.tipo === 'obsoleto' || rutear(c)) return;
      if (c.tipo === 'sin_red') setSinRed(true);
      setErrorMapa(c);
    } finally {
      if (montado.current && numero === pedidoMapa.current) setCargandoMapa(false);
    }
  };

  const cargar = async () => {
    const base = sesionRef.current;
    if (!base) return;
    setCargando(true);
    setError(null);
    try {
      const leida = await cargarPersona(base, casoId, n);
      if (!montado.current) return;
      const modoLeido = leida.estado === 'SIN_CONFIRMAR' ? 'confirmar' : 'completar';
      let borrador = null;
      if (modoLeido === 'completar') {
        // Ya está confirmada: un «Confirmar persona» que quedó sin resultado no tiene a qué volver.
        olvidarConfirmarPendiente(base, casoId, n).catch(() => {});
        setIncierto(false);
      } else {
        setIncierto(!!await confirmarPendiente(base, casoId, n).catch(() => null));
      }
      if (!(caso?.estado === 'CERRADO' || (modoLeido === 'confirmar' && esSoloLectura(caso)))) {
        borrador = await leerBorradorFicha(base, casoId, n, modoLeido).catch(() => null);
      }
      if (!montado.current) return;
      setPersona(leida);
      setPlano(borrador?.plano || fichaAPlano(leida.ficha));
      setSinRed(false);
      if (borrador) {
        tocado.current = true;
        showToast({ type: 'info', message: TEXTO_BORRADOR });
      }
      if (modoLeido === 'confirmar' && !esSoloLectura(caso)) pedirMapa(borrador?.plazaId ?? null);
    } catch (e) {
      if (!montado.current) return;
      const c = e?.clasificacion || clasificarErrorLlegada(e);
      if (c.tipo === 'obsoleto' || rutear(c)) return;
      if (c.tipo === 'sin_red') {
        setSinRed(true);
        return;
      }
      setError(c);
    } finally {
      if (montado.current) setCargando(false);
    }
  };

  useEffect(() => {
    montado.current = true;
    (async () => {
      try {
        const abierta = await abrirSesion();
        if (!montado.current) return;
        sesionRef.current = abierta;
        setSesion(abierta);
        await cargar();
      } catch (e) {
        if (montado.current) {
          setError({ tipo: 'rechazo', mensaje: e?.message || 'No hay sesión iniciada.' });
          setCargando(false);
        }
      }
    })();
    const dejarDeEscuchar = escucharRed((hay) => {
      if (!montado.current) return;
      setSinRed(!hay);
      if (hay && !personaRef.current && sesionRef.current) cargar();
    });
    return () => {
      montado.current = false;
      dejarDeEscuchar();
    };
  }, [casoId, n]);
  useEffect(() => {
    if (recarga !== recargaInicial.current && modo === 'confirmar' && !lectura) pedirMapa(plazaId);
  }, [recarga]);

  // Borrador: lo tipeado se guarda medio segundo después del último cambio, y al salir de la pantalla.
  useEffect(() => {
    if (!plano || !modo || !tocado.current || terminado.current || lectura || !sesionRef.current) return undefined;
    ultimo.current = { sesion: sesionRef.current, modo, plano, plazaId };
    const timer = setTimeout(() => guardarBorradorFicha(sesionRef.current, casoId, n, { modo, plano, plazaId }).catch(() => {}), AUTOGUARDADO_MS);
    return () => clearTimeout(timer);
  }, [plano, plazaId]);
  useEffect(() => () => {
    const pendiente = ultimo.current;
    if (!terminado.current && pendiente) {
      guardarBorradorFicha(pendiente.sesion, casoId, n, { modo: pendiente.modo, plano: pendiente.plano, plazaId: pendiente.plazaId }).catch(() => {});
    }
  }, []);

  const cambiar = (cambios) => {
    if (lectura || enviandoRef.current) return;
    tocado.current = true;
    setPlano((prev) => ({ ...prev, ...cambios }));
    setErroresServidor((prev) => {
      const claves = Object.keys(cambios);
      if (!claves.some((clave) => prev[clave])) return prev;
      const next = { ...prev };
      claves.forEach((clave) => { delete next[clave]; });
      return next;
    });
  };
  const elegirCama = (plaza) => {
    if (lectura || enviandoRef.current || !plaza?.elegible) return;
    tocado.current = true;
    setPlazaId(plaza.id);
    setErroresServidor((prev) => {
      if (!prev.plaza) return prev;
      const { plaza: _p, ...resto } = prev;
      return resto;
    });
  };

  const avisarEnviando = (valor) => {
    try {
      onEnviando?.(valor);
    } catch {
      // Solo informa.
    }
  };

  const terminar = async (resultado) => {
    terminado.current = true;
    ultimo.current = null;
    await borrarBorradorFicha(sesionRef.current, casoId, n).catch(() => {});
    onTerminar?.(resultado);
  };

  // Lo común a confirmar y guardar: un solo envío a la vez (el candado va antes de mirar la red), el
  // aviso al padre y los errores.
  const enviar = async (hacer, { alValidar } = {}) => {
    if (enviandoRef.current || !sesionRef.current) return;
    enviandoRef.current = true;
    if (!await hayConexion()) {
      enviandoRef.current = false;
      if (!montado.current) return;
      setSinRed(true);
      showAlert('Sin conexión', TEXTO_SIN_RED, [{ text: 'Entendido' }]);
      return;
    }
    if (montado.current) {
      setSinRed(false);
      setEnviando(true);
      setFalla(null);
    }
    avisarEnviando(true);
    try {
      await hacer();
    } catch (e) {
      const c = e?.clasificacion || clasificarErrorLlegada(e);
      if (c.tipo === 'obsoleto') return;
      if (['conflicto', 'no_encontrado'].includes(c.tipo)) {
        // El caso o la persona ya no están como para esto: lo tipeado ya no tiene adónde ir.
        terminado.current = true;
        ultimo.current = null;
        await borrarBorradorFicha(sesionRef.current, casoId, n).catch(() => {});
      }
      if (rutear(c)) return;
      if (!montado.current) {
        showToast({ type: 'warning', message: c.mensaje });
        return;
      }
      if (modo === 'confirmar') setIncierto(!!await confirmarPendiente(sesionRef.current, casoId, n).catch(() => null));
      else setIncierto(c.tipo === 'reintentable');
      if (c.tipo === 'sin_red') {
        setSinRed(true);
        showAlert('Sin conexión', TEXTO_SIN_RED, [{ text: 'Entendido' }]);
        return;
      }
      if (c.tipo === 'validacion') {
        setErroresServidor(c.errores || {});
        setIntentado(true);
        showToast({ type: 'warning', message: 'El servidor rechazó algunos datos. Corregí lo marcado y volvé a mandar.' });
        alValidar?.(c.errores || {});
        return;
      }
      setFalla(c);
    } finally {
      enviandoRef.current = false;
      if (montado.current) setEnviando(false);
      avisarEnviando(false);
    }
  };

  const tocarConfirmar = () => {
    if (enviandoRef.current || lectura) return;
    setIntentado(true);
    const locales = validarConfirmacion(plano, { plazaId });
    if (Object.keys(locales).length) {
      const cantidad = Object.keys(locales).length;
      showToast({ type: 'warning', message: `Falta${cantidad === 1 ? '' : 'n'} ${cantidad} dato${cantidad === 1 ? '' : 's'} para poder confirmar.` });
      return;
    }
    enviar(async () => {
      const r = await confirmarPersona(sesionRef.current, casoId, n, { plano, plazaId });
      const cama = r.integrante?.plaza?.nombre || buscarCama(mapa, plazaId)?.nombre || '';
      if (r.otraCama) {
        // El reenvío de un envío anterior que había llegado: lo que vale es lo del servidor.
        showAlert('La persona ya estaba confirmada', `Un envío anterior ya la había confirmado en la cama ${r.otraCama.nombre || r.otraCama.codigo}, no en la que elegiste ahora. Quedó así; la cama se cambia desde el mapa del backoffice.`, [{ text: 'Entendido' }]);
      } else {
        showToast({ type: 'success', message: `Persona ${n} confirmada${cama ? ` en la cama ${cama}` : ''} · ${r.confirmadas} de ${r.total_declarado}.` });
      }
      if (r.reserva_liberada) showToast({ type: 'info', message: 'Entró en una cama libre: se devolvió una cama guardada para la familia que ya sobraba.' });
      await terminar({ tipo: 'confirmada', ...r });
    }, {
      // 400 `plaza`: otra guardia tomó la cama, o quedó fuera de servicio. Se recarga el mapa.
      alValidar: (errores) => { if (errores.plaza) pedirMapa(plazaId, { avisar: true }); },
    });
  };

  const tocarGuardar = () => {
    if (enviandoRef.current || lectura) return;
    setIntentado(true);
    const locales = validarCompletar(plano);
    if (Object.keys(locales).length) {
      showToast({ type: 'warning', message: 'Hay datos para corregir antes de guardar.' });
      return;
    }
    const secciones = seccionesCambiadas(plano, persona?.ficha);
    if (!secciones.length) {
      showToast({ type: 'info', message: 'No hay cambios para guardar.' });
      return;
    }
    enviar(async () => {
      const r = await completarFicha(sesionRef.current, casoId, n, { plano, secciones });
      showToast(r.ficha_completa
        ? { type: 'success', message: `Ficha de la persona ${n} completa.` }
        : { type: 'success', message: `Ficha guardada. Falta: ${r.secciones_incompletas.join(', ')}.` });
      await terminar({ tipo: 'completada', ...r });
    });
  };

  // ---- Presentación ----
  const tarjeta = [styles.card, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }];
  const tituloSeccion = [styles.titulo, { color: theme.colors.text, fontFamily: typography.bold }];
  const etiqueta = [styles.etiqueta, { color: theme.colors.text, fontFamily: typography.semibold }];
  const ayuda = [styles.ayuda, { color: theme.colors.textMuted, fontFamily: typography.medium }];
  const avisoDe = (tono, texto, icono) => (
    <View accessibilityRole="alert" style={[styles.aviso, { backgroundColor: statusTones[tono].bg, borderColor: statusTones[tono].bd }]}>
      {icono ? <Ionicons name={icono} size={18} color={statusTones[tono].tx} accessible={false} importantForAccessibility="no" /> : null}
      <Text style={[styles.flex, styles.texto, { color: statusTones[tono].tx, fontFamily: typography.semibold }]}>{texto}</Text>
    </View>
  );
  const insignia = (tono, texto, clave) => (
    <View key={clave} style={[styles.insignia, { backgroundColor: statusTones[tono].bg, borderColor: statusTones[tono].bd }]}>
      <Text style={[styles.ayuda, { color: statusTones[tono].tx, fontFamily: typography.semibold }]}>{texto}</Text>
    </View>
  );

  if (cargando && !persona) {
    return (
      <View style={styles.centro}>
        {sinRed ? avisoDe('warning', TEXTO_SIN_RED, 'cloud-offline-outline') : null}
        <ActivityIndicator size="large" color={theme.colors.primary} accessibilityLabel="Cargando la persona" />
      </View>
    );
  }
  if (!persona || !plano) {
    return (
      <ScrollView style={{ flex: 1, backgroundColor: theme.colors.background }} contentContainerStyle={styles.content}>
        {sinRed ? avisoDe('warning', TEXTO_SIN_RED, 'cloud-offline-outline') : null}
        {error ? avisoDe(error.tipo === 'reintentable' ? 'warning' : 'danger', error.mensaje) : null}
        <CustomButton title="Reintentar" variant="secondary" iconLeft="refresh" disabled={!sesion} onPress={cargar} />
      </ScrollView>
    );
  }

  const fijo = lectura || enviando;
  const errores = {
    ...erroresServidor,
    ...(intentado && !lectura ? (modo === 'confirmar' ? validarConfirmacion(plano, { plazaId }) : validarCompletar(plano)) : {}),
  };
  const errorDe = (campo) => errores[campo] || [];
  const errorCampo = (...campos) => campos.flatMap(errorDe).map((mensaje, indice) => (
    <Text key={`${campos.join('-')}:${indice}`} accessibilityLiveRegion="polite" style={[styles.error, { color: theme.colors.danger, fontFamily: typography.medium }]}>{mensaje}</Text>
  ));
  const caja = (campo, extra) => [styles.input, extra, {
    color: theme.colors.text, backgroundColor: theme.colors.surface,
    borderColor: errorDe(campo).length ? theme.colors.danger : theme.colors.border,
  }];

  const opcionesDe = ({ nombre, opciones, campo }) => (
    <View style={styles.opciones} accessibilityRole="radiogroup" accessibilityLabel={nombre}>
      {opciones.map((opcion) => {
        const elegida = plano[campo] === opcion.valor;
        return (
          <Pressable key={opcion.valor} accessibilityRole="radio" accessibilityState={{ selected: elegida, checked: elegida, disabled: fijo }}
            accessibilityLabel={`${nombre}: ${opcion.titulo}`} disabled={fijo}
            onPress={() => cambiar({ [campo]: elegida ? null : opcion.valor })}
            style={[styles.opcion, { borderColor: elegida ? theme.colors.primary : theme.colors.border,
              backgroundColor: elegida ? `${theme.colors.primary}18` : theme.colors.surface }]}>
            <Text style={{ color: elegida ? theme.colors.primary : theme.colors.text, fontFamily: elegida ? typography.bold : typography.medium, fontSize: fontSizes.sm }}>{opcion.titulo}</Text>
          </Pressable>
        );
      })}
    </View>
  );
  // Sí / No: `false` es una respuesta; tocar la elegida la deja sin responder.
  const siNo = (campo, titulo, obligatorio = false) => (
    <View key={campo} style={styles.pregunta}>
      <Text style={etiqueta}>{`${titulo}${obligatorio ? ' *' : ''}`}</Text>
      {opcionesDe({ nombre: titulo, campo, opciones: [{ valor: true, titulo: 'Sí' }, { valor: false, titulo: 'No' }] })}
      {errorCampo(campo)}
    </View>
  );
  const casilla = (campo, titulo) => {
    const marcada = plano[campo] === true;
    return (
      <Pressable key={campo} accessibilityRole="checkbox" accessibilityState={{ checked: marcada, disabled: fijo }} accessibilityLabel={titulo}
        disabled={fijo} onPress={() => cambiar({ [campo]: marcada ? null : true })} style={styles.casilla}>
        <Ionicons name={marcada ? 'checkbox' : 'square-outline'} size={24} color={marcada ? theme.colors.primary : theme.colors.textSoft}
          accessible={false} importantForAccessibility="no" />
        <Text style={[styles.flex, etiqueta]}>{titulo}</Text>
      </Pressable>
    );
  };
  const texto = (campo, titulo, { obligatorio = false, area = false, teclado, placeholder } = {}) => (
    <View key={campo} style={styles.campo}>
      <Text style={etiqueta}>{`${titulo}${obligatorio ? ' *' : ''}`}</Text>
      <TextInput value={plano[campo] ?? ''} editable={!fijo} multiline={area} maxLength={MAXIMOS[campo]}
        keyboardType={teclado} accessibilityLabel={titulo} placeholder={placeholder} placeholderTextColor={theme.colors.textSoft}
        onChangeText={(valor) => cambiar({ [campo]: campo === 'dni' ? cleanDigits(valor).slice(0, 8) : valor })}
        style={caja(campo, area ? styles.areaTexto : null)} />
      {errorCampo(campo)}
    </View>
  );

  const estado = estadoDeIntegrante(persona.estado);
  const menor = esMenor(plano);
  const elegida = buscarCama(mapa, plazaId);
  const elegibles = camasElegibles(mapa);
  const faltan = seccionesIncompletas(plano);
  const listado = listaDeErroresFicha(errores);

  const seccionOpcional = (seccion, indice) => (
    <View key={seccion} style={tarjeta}>
      <Text accessibilityRole="header" style={tituloSeccion}>{`${indice + 4}. ${ROTULOS_SECCION[seccion]}`}</Text>
      {casilla(`${seccion}_sin_datos`, 'Sin datos (pregunté y no hay nada que cargar)')}
      {CAMPOS_OPCIONALES[seccion].map(([campo, tipo, extra]) => {
        // El adulto responsable de un menor se pide arriba, con el mínimo.
        if (campo === 'adulto_responsable' && menor && modo === 'confirmar') return null;
        if (tipo === 'opciones') {
          return (
            <View key={campo} style={styles.campo}>
              <Text style={etiqueta}>Nivel educativo</Text>
              {opcionesDe({ nombre: 'Nivel educativo', campo, opciones: extra })}
              {errorCampo(campo)}
            </View>
          );
        }
        if (tipo === 'siNo') return siNo(campo, extra);
        return texto(campo, extra, { area: tipo === 'area', obligatorio: campo === 'adulto_responsable' && menor });
      })}
    </View>
  );

  const mapaDeCamas = () => (
    <View style={styles.mapa}>
      {(mapa?.sectores || []).map(({ sector, plazas, total, libres, reservadas_familia: reservadas }) => (
        <View key={String(sector.id)} style={styles.sector}>
          <Text accessibilityRole="header" style={etiqueta}>{[sector.nombre, sector.perfil].filter(Boolean).join(' · ')}</Text>
          <Text style={ayuda}>{`${libres === 1 ? '1 libre' : `${libres} libres`} de ${total}${reservadas ? ` · ${reservadas === 1 ? '1 guardada' : `${reservadas} guardadas`} para esta familia` : ''}`}</Text>
          {plazas.length < total ? <Text style={ayuda}>{`Se muestran ${plazas.length} de ${total} camas.`}</Text> : null}
          <View style={styles.opciones} accessibilityRole="radiogroup" accessibilityLabel={`Camas de ${sector.nombre}`}>
            {plazas.map((plaza) => {
              const { titulo, tono } = estadoDeCama(plaza.estado);
              const marcada = String(plaza.id) === String(plazaId);
              const deshabilitada = fijo || !plaza.elegible;
              return (
                <Pressable key={String(plaza.id)} accessibilityRole="radio"
                  accessibilityState={{ selected: marcada, checked: marcada, disabled: deshabilitada }}
                  accessibilityLabel={`Cama ${plaza.codigo}, ${titulo}${plaza.detalle ? `: ${plaza.detalle}` : ''}`}
                  disabled={deshabilitada} onPress={() => elegirCama(plaza)}
                  style={[styles.cama, { backgroundColor: statusTones[tono].bg,
                    borderColor: marcada ? theme.colors.primary : statusTones[tono].bd, borderWidth: marcada ? 2 : 1,
                    opacity: plaza.elegible ? 1 : 0.6 }]}>
                  {marcada ? <Ionicons name="checkmark-circle" size={16} color={theme.colors.primary} accessible={false} importantForAccessibility="no" /> : null}
                  <Text style={{ color: statusTones[tono].tx, fontFamily: marcada ? typography.bold : typography.semibold, fontSize: fontSizes.sm }}>{plaza.codigo}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      ))}
      {mapa && !(mapa.sectores || []).length ? <Text style={ayuda}>El dispositivo no tiene sectores con camas.</Text> : null}
    </View>
  );

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.background }} contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode={keyboardDismissModeFor(Platform.OS === 'ios' ? 'interactive' : 'on-drag')}>
      {sinRed ? avisoDe('warning', TEXTO_SIN_RED, 'cloud-offline-outline') : null}

      <View style={tarjeta}>
        <Text accessibilityRole="header" style={tituloSeccion}>{`Caso ${caso?.numero || ''} · Persona ${n}`.replace('Caso  · ', '')}</Text>
        <View style={styles.fila}>
          {insignia(estado.tono, estado.titulo, 'estado')}
          {modo === 'completar' && faltan.length ? insignia('warning', 'Ficha incompleta', 'incompleta') : null}
          {modo === 'completar' && !faltan.length ? insignia('success', 'Ficha completa', 'completa') : null}
        </View>
        {persona.persona ? <Text style={[styles.texto, { color: theme.colors.text, fontFamily: typography.bold }]}>{persona.persona.nombre}</Text> : null}
        {modo === 'completar' ? (
          <Text style={ayuda}>{[persona.persona?.dni ? `DNI ${persona.persona.dni}` : null,
            persona.plaza ? `Cama ${persona.plaza.nombre || persona.plaza.codigo}` : null, persona.parentesco || null].filter(Boolean).join(' · ')}</Text>
        ) : null}
        {modo === 'completar' && faltan.length ? <Text style={ayuda}>{`Falta: ${faltan.join(', ')}.`}</Text> : null}
        {lectura ? avisoDe('info', caso?.estado === 'CERRADO' ? TEXTO_CERRADO : 'La familia ya no está en ingreso: esta persona no se puede confirmar desde acá.', 'lock-closed-outline') : null}
      </View>

      {modo === 'confirmar' ? (
        <>
          <View style={tarjeta}>
            <Text accessibilityRole="header" style={tituloSeccion}>1. Parentesco</Text>
            <Text style={ayuda}>Con quien responde por la familia.</Text>
            {opcionesDe({ nombre: 'Parentesco', campo: 'parentesco', opciones: PARENTESCOS })}
            {errorCampo('parentesco')}
            {plano.parentesco === 'OTRO' ? texto('parentesco_otro', 'Cuál parentesco', { obligatorio: true }) : null}
          </View>

          <View style={tarjeta}>
            <Text accessibilityRole="header" style={tituloSeccion}>2. Datos personales</Text>
            {texto('dni', 'DNI', { obligatorio: true, teclado: 'number-pad', placeholder: 'Solo números' })}
            <Text style={ayuda}>{TEXTO_LEGAJO}</Text>
            {texto('nombre', 'Nombre')}
            {texto('apellido', 'Apellido')}
            <Text style={etiqueta}>Sexo</Text>
            {opcionesDe({ nombre: 'Sexo', campo: 'sexo', opciones: SEXOS_FICHA })}
            {errorCampo('sexo')}
            <View style={styles.campo}>
              {fijo ? (
                <Text style={[styles.texto, { color: theme.colors.text, fontFamily: typography.medium }]}>{`Fecha de nacimiento: ${plano.fecha_nacimiento || '—'}`}</Text>
              ) : (
                <FechaInput label="Fecha de nacimiento" value={plano.fecha_nacimiento || ''} onSelect={(valor) => cambiar({ fecha_nacimiento: valor })} />
              )}
              {errorCampo('fecha_nacimiento')}
            </View>
            {casilla('fecha_nacimiento_aproximada', 'La fecha es aproximada')}
            {texto('telefono', 'Teléfono', { teclado: 'phone-pad' })}
            {casilla('documento_extraviado', 'Perdió el documento (sabe el número)')}
          </View>

          <View style={tarjeta}>
            <Text accessibilityRole="header" style={tituloSeccion}>3. Avisos críticos de salud</Text>
            <Text style={ayuda}>Las cinco preguntas van respondidas, aunque sea «No».</Text>
            {PREGUNTAS_CRITICAS.map(({ clave, titulo }) => (
              <React.Fragment key={clave}>
                {siNo(clave, titulo, true)}
                {clave === 'medicacion_critica' && plano.medicacion_critica === true ? (
                  <>
                    {texto('medicacion_critica_nombre', 'Qué medicación crítica toma', { obligatorio: true })}
                    {siNo('medicacion_critica_tiene_dosis', 'Tiene dosis de la medicación', true)}
                  </>
                ) : null}
                {clave === 'alergias_graves' && plano.alergias_graves === true ? texto('alergias_graves_detalle', 'Detalle de las alergias') : null}
              </React.Fragment>
            ))}
            {menor ? texto('adulto_responsable', 'Adulto responsable', { obligatorio: true, placeholder: 'Es menor de 16 años' }) : null}
          </View>

          {!lectura ? (
            <View style={tarjeta}>
              <Text accessibilityRole="header" style={tituloSeccion}>Cama *</Text>
              {elegida ? (
                <View style={styles.fila}>
                  <Text style={[styles.flex, styles.texto, { color: theme.colors.text, fontFamily: typography.bold }]}>{elegida.nombre}</Text>
                  {insignia(estadoDeCama(elegida.estado).tono, estadoDeCama(elegida.estado).titulo, 'cama')}
                </View>
              ) : null}
              {!elegida && mapa && elegibles.length ? <Text style={ayuda}>Elegí una cama del mapa.</Text> : null}
              {mapa && !elegibles.length ? avisoDe('danger', TEXTO_SIN_CAMAS, 'bed-outline') : null}
              {errorCampo('plaza')}
              {cargandoMapa ? <ActivityIndicator color={theme.colors.primary} accessibilityLabel="Cargando el mapa de camas" /> : null}
              {errorMapa ? avisoDe(errorMapa.tipo === 'reintentable' || errorMapa.tipo === 'sin_red' ? 'warning' : 'danger', errorMapa.mensaje) : null}
              {mapa && eligiendoCama ? mapaDeCamas() : null}
              <View style={styles.fila}>
                {mapa && elegibles.length ? (
                  <CustomButton title={eligiendoCama ? 'Listo' : (elegida ? 'Cambiar cama' : 'Elegir cama')} variant="secondary"
                    iconLeft={eligiendoCama ? 'checkmark' : 'bed-outline'} disabled={enviando} onPress={() => setEligiendoCama((v) => !v)} />
                ) : null}
                <CustomButton title="Recargar camas" variant="tertiary" iconLeft="refresh" disabled={enviando || cargandoMapa || !sesion}
                  onPress={() => pedirMapa(plazaId, { avisar: true })} />
              </View>
            </View>
          ) : null}

          {!lectura ? (
            <CustomButton title={verOpcionales ? 'Ocultar el resto de la ficha' : 'Cargar ahora el resto de la ficha (opcional)'} variant="tertiary"
              iconLeft={verOpcionales ? 'chevron-up' : 'chevron-down'} onPress={() => setVerOpcionales((v) => !v)} />
          ) : null}
          {verOpcionales ? SECCIONES_OPCIONALES.map(seccionOpcional) : null}
        </>
      ) : (
        <>
          <Text style={ayuda}>Las secciones 1 a 3 (parentesco, datos personales y avisos de salud) se cargaron al confirmar y no se cambian acá.</Text>
          {SECCIONES_OPCIONALES.map(seccionOpcional)}
        </>
      )}

      {listado.length ? (
        <View accessibilityRole="alert" style={[styles.card, { backgroundColor: statusTones.danger.bg, borderColor: statusTones.danger.bd }]}>
          <Text style={[styles.titulo, { color: statusTones.danger.tx, fontFamily: typography.bold }]}>Para corregir</Text>
          {listado.map(({ campo, etiqueta: nombre, texto: mensaje }) => (
            <Text key={`${campo}:${mensaje}`} style={[styles.texto, { color: statusTones.danger.tx, fontFamily: typography.medium }]}>{nombre ? `• ${nombre}: ${mensaje}` : `• ${mensaje}`}</Text>
          ))}
        </View>
      ) : null}
      {falla ? avisoDe(falla.tipo === 'reintentable' ? 'warning' : 'danger', falla.mensaje) : null}

      {!lectura && modo === 'confirmar' ? (
        <CustomButton title={incierto ? 'Reintentar confirmar' : 'Confirmar persona'} size="L"
          iconLeft={incierto ? 'refresh' : 'checkmark-done-outline'} loading={enviando} disabled={enviando || !sesion} onPress={tocarConfirmar} />
      ) : null}
      {!lectura && modo === 'completar' ? (
        <CustomButton title={incierto ? 'Reintentar guardar' : 'Guardar ficha'} size="L"
          iconLeft={incierto ? 'refresh' : 'save-outline'} loading={enviando} disabled={enviando || !sesion} onPress={tocarGuardar} />
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 40, gap: 12 },
  centro: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  card: { borderWidth: 1, borderRadius: radii.xl, padding: 14, gap: 8 },
  titulo: { fontSize: fontSizes.base },
  etiqueta: { fontSize: fontSizes.sm },
  ayuda: { fontSize: fontSizes.xs },
  texto: { fontSize: fontSizes.sm },
  error: { fontSize: fontSizes.xs },
  flex: { flex: 1 },
  fila: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  campo: { gap: 4 },
  pregunta: { gap: 4 },
  input: { minHeight: 46, borderWidth: 1, borderRadius: radii.lg, paddingHorizontal: 12, paddingVertical: 10, fontSize: fontSizes.sm },
  areaTexto: { minHeight: 96, textAlignVertical: 'top' },
  opciones: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  opcion: { minHeight: 44, paddingHorizontal: 14, borderWidth: 1, borderRadius: radii.lg, alignItems: 'center', justifyContent: 'center' },
  casilla: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44 },
  mapa: { gap: 12 },
  sector: { gap: 6 },
  cama: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 44, minWidth: 64, paddingHorizontal: 10, borderRadius: radii.lg, justifyContent: 'center' },
  aviso: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: radii.lg, padding: 10 },
  insignia: { alignSelf: 'flex-start', borderWidth: 1, borderRadius: radii.full, paddingHorizontal: 10, paddingVertical: 3 },
});
