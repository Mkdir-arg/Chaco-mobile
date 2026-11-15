import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable, ActivityIndicator, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import TextInput from '../components/FormInput';
import FechaInput from '../components/FechaInput';
import CustomButton from '../components/CustomButton';
import { useTheme } from '../context/ThemeContext';
import { useToast } from '../context/ToastContext';
import {
  TEXTO_SIN_RED, abrirSesion, clasificarErrorLlegada, datosDeLaPuerta, enviarPuerta, escucharRed, hayConexion,
  puertaPendiente, reintentarPuertaSinDatos, validarPuerta,
} from '../services/emergenciaLlegadas';
import { cleanDigits } from '../utils/dni';
import {
  ASISTENCIA, AVISOS, CANTIDADES, MAX_DIRECCION, MAX_TRASLADO_OTRO, TRASLADOS, aCantidad, listaDeErrores, totalDeclarado,
} from '../utils/emergencia';
import { statusTones } from '../theme/statusBadges';
import { keyboardDismissModeFor } from '../utils/teclado';
import { fontSizes, radii } from '../theme';

export const TEXTO_UUID_EN_USO_PUERTA = 'Este envío no se pudo mandar: su identificador ya se usó en otro caso. Volvé a tocar el botón: sale con uno nuevo.';
export const TEXTO_SIN_DATOS = 'Hay un envío de esta familia sin resultado, pero lo cargado ya se borró del teléfono (se cerró la sesión o pasaron 48 h). «Reintentar» manda solo su identificador: si había llegado, se recupera el caso; si no, vas a tener que cargar los datos de nuevo.';
export const TEXTO_DNI_FIJO = 'Es el DNI que buscaste. Para otra persona, volvé y buscá de nuevo.';
const ESTADOS_TRAS_INGRESO = {
  ALOJADO: 'la familia ya figura alojada',
  CERRADO: 'el caso ya está cerrado',
  EN_GESTION: 'el caso volvió a la mesa',
  NUEVO: 'el caso volvió a la mesa',
};
export const TEXTO_SIN_CAMAS = 'No hay camas libres para ingresar a la familia: avisale a la mesa para que la derive a otro lado.';

const ACCIONES = {
  ingresar: {
    titulo: 'Ingresar igual',
    icono: 'enter-outline',
    ayuda: (camas) => `La familia entra sin pasar por la mesa: se crea el caso con el ingreso en curso y se reservan hasta ${camas === 1 ? '1 cama libre' : `${camas} camas libres`}. Después se confirma a cada persona.`,
    pregunta: (total) => `Se crea el caso de ${total === 1 ? '1 persona' : `${total} personas`} con el ingreso en curso y se reservan las camas libres que alcancen. No se puede deshacer desde la app.`,
  },
  avisar: {
    titulo: 'Avisar a la mesa',
    icono: 'megaphone-outline',
    ayuda: () => 'La mesa recibe el caso con la marca «En la puerta»: lo deriva a donde haya lugar y después buscás a la familia de nuevo.',
    pregunta: (total, dispositivo) => `Se crea el caso de ${total === 1 ? '1 persona' : `${total} personas`} en la mesa con la marca «En la puerta de ${dispositivo}». No se puede deshacer desde la app.`,
  },
};

// M2-6 · La familia llegó sin derivación (§13.10): el Formulario 1 en la puerta (sin hora, fotos ni GPS;
// la dirección es opcional: vale la del dispositivo) y «Ingresar igual» (solo con camas libres) o
// «Avisar a la mesa». Con conexión: sin red no se manda nada (M2 no se encola en la app).
// Los dos son idempotentes por `uuid_cliente`: un envío sin resultado (red, timeout, 5xx, WAF, 429) queda
// guardado con lo tipeado y, al volver a esta familia, solo se ofrece reintentar ESE envío con el mismo
// uuid (el formulario queda fijo: si ya había llegado, el servidor devuelve el mismo caso).
// - `onIngresado(caso, resultado)`: 201/200 de «Ingresar igual» → integrantes.
// - `onAvisado(resultado)`: 201/200 de «Avisar a la mesa» → volver a buscar.
// El DNI es el buscado y no se edita: es la clave del envío pendiente (cambiarlo dejaría el pendiente
// del DNI anterior sin reintentar). Si lo cargado ya se borró del teléfono (logout, 48 h) y queda solo el
// uuid, se ofrece «Reintentar» con el uuid solo; si el servidor dice que no había llegado, se carga de nuevo.
// - `onNoEncontrado()`: 404. `onSinModulo(mensaje)`: 403. `onEnviando(bool)`: hay un envío en curso.
export default function EmergenciaPuertaScreen({
  dispositivo, dni = '', plazasLibres = 0, accion: accionInicial = 'ingresar', mensaje = '',
  onIngresado, onAvisado, onNoEncontrado, onSinModulo, onEnviando,
}) {
  const { theme, typography } = useTheme();
  const { showAlert, showToast } = useToast();
  const [sesion, setSesion] = useState(null);
  const [errorSesion, setErrorSesion] = useState('');
  const [cargando, setCargando] = useState(true);
  const [datos, setDatos] = useState(() => datosDeLaPuerta(dni));
  const [accion, setAccion] = useState(accionInicial === 'avisar' || plazasLibres < 1 ? 'avisar' : 'ingresar');
  const [pendiente, setPendiente] = useState(null);
  const [sinDatos, setSinDatos] = useState(false);
  const [sinCamas, setSinCamas] = useState(plazasLibres < 1);
  const [enviando, setEnviando] = useState(false);
  const [falla, setFalla] = useState(null);
  const [sinRed, setSinRed] = useState(false);
  const [intentado, setIntentado] = useState(false);
  const [erroresServidor, setErroresServidor] = useState({});
  const [esperaHasta, setEsperaHasta] = useState(0);
  const [ahora, setAhora] = useState(Date.now());
  const montado = useRef(true);
  const enviandoRef = useRef(false);
  const sesionRef = useRef(null);

  useEffect(() => {
    montado.current = true;
    (async () => {
      try {
        const abierta = await abrirSesion();
        if (!montado.current) return;
        sesionRef.current = abierta;
        setSesion(abierta);
        // Un envío de esta familia que quedó sin resultado: se recupera tal cual y solo se ofrece reintentarlo.
        const previo = await puertaPendiente(abierta, dispositivo?.id, dni).catch(() => null);
        if (!montado.current || !previo) return;
        setPendiente(previo.accion);
        setAccion(previo.accion);
        if (previo.datos) setDatos({ ...datosDeLaPuerta(dni), ...previo.datos, dni: cleanDigits(dni) });
        else setSinDatos(true);
      } catch (e) {
        if (montado.current) setErrorSesion(e?.message || 'No hay sesión iniciada.');
      } finally {
        if (montado.current) setCargando(false);
      }
    })();
    hayConexion().then((hay) => { if (montado.current) setSinRed(!hay); }).catch(() => {});
    const dejarDeEscuchar = escucharRed((hay) => { if (montado.current) setSinRed(!hay); });
    return () => {
      montado.current = false;
      dejarDeEscuchar();
    };
  }, [dispositivo?.id, dni]);

  const esperando = esperaHasta > ahora;
  useEffect(() => {
    if (!esperando) return undefined;
    const timer = setInterval(() => setAhora(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [esperando]);

  const avisarEnviando = (valor) => {
    try {
      onEnviando?.(valor);
    } catch {
      // Solo informa.
    }
  };

  const fijo = enviando || !!pendiente;
  const cambiar = (cambios) => {
    if (fijo) return;
    setDatos((prev) => ({ ...prev, ...cambios }));
    setErroresServidor((prev) => {
      const claves = Object.keys(cambios);
      const tocaTotal = claves.some((c) => CANTIDADES.some((x) => x.clave === c));
      if (!claves.some((c) => prev[c]) && !(tocaTotal && prev.total)) return prev;
      const next = { ...prev };
      claves.forEach((c) => delete next[c]);
      if (tocaTotal) delete next.total;
      return next;
    });
  };

  const mandar = async (cual) => {
    const base = sesionRef.current;
    if (enviandoRef.current || !base) return;
    // Se toma antes de mirar la red (en nativo NetInfo tarda): dos toques seguidos no pasan los dos.
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
      const r = sinDatos ? await reintentarPuertaSinDatos(base, dispositivo.id, dni)
        : await enviarPuerta(base, dispositivo.id, cual, datos, { dni });
      if (cual === 'ingresar') {
        const numero = r.caso?.numero ? `Caso ${r.caso.numero}` : 'Caso creado';
        const despues = r.caso && r.caso.estado !== 'INGRESO_EN_CURSO' ? ESTADOS_TRAS_INGRESO[r.caso.estado] || `el caso está en ${String(r.caso.estado || 'otro estado').toLowerCase().replaceAll('_', ' ')}` : null;
        if (despues) {
          // El reenvío devuelve el caso como está hoy: puede que ya no siga en curso.
          showToast({ type: 'info', message: `${numero}: el ingreso ya se había hecho y ${despues}.` });
        } else if (r.faltantes > 0) {
          showAlert('Ingreso con camas de menos', `${numero}: se reservaron ${r.reservadas} y faltan ${r.faltantes}. Se puede seguir.`, [{ text: 'Entendido' }]);
        } else {
          showToast({ type: 'success', message: `${numero} · ingreso en curso · ${r.reservadas === 1 ? '1 cama reservada' : `${r.reservadas} camas reservadas`}.` });
        }
        onIngresado?.(r.caso, r);
      } else {
        showAlert('Aviso enviado', `La mesa tiene el caso${r.caso?.numero ? ` ${r.caso.numero}` : ''} con la marca «En la puerta». Cuando lo derive, buscá a la familia de nuevo.`, [{ text: 'Entendido' }]);
        onAvisado?.(r);
      }
    } catch (e) {
      const c = e?.clasificacion || clasificarErrorLlegada(e);
      if (c.tipo === 'obsoleto') return;
      if (c.tipo === 'no_encontrado') {
        onNoEncontrado?.();
        return;
      }
      if (c.tipo === 'sin_modulo') {
        onSinModulo?.(c.mensaje);
        return;
      }
      if (!montado.current) {
        showToast({ type: 'warning', message: c.mensaje });
        return;
      }
      setPendiente(e?.incierto ? cual : null);
      if (e?.reingresar) {
        // Con el uuid solo: el primero no había llegado. Se vuelve al formulario vacío.
        setSinDatos(false);
        setDatos(datosDeLaPuerta(dni));
        setIntentado(false);
        setFalla({ tipo: 'rechazo', mensaje: c.mensaje });
        return;
      }
      if (!e?.incierto) setSinDatos(false);
      if (c.tipo === 'sin_red') {
        setSinRed(true);
        showAlert('Sin conexión', TEXTO_SIN_RED, [{ text: 'Entendido' }]);
        return;
      }
      if (c.tipo === 'uuid_en_uso') {
        setFalla({ tipo: 'rechazo', mensaje: TEXTO_UUID_EN_USO_PUERTA });
        return;
      }
      if (c.tipo === 'validacion') {
        const { plazas, generales, ...campos } = c.errores || {};
        setIntentado(true);
        setErroresServidor(campos);
        if (plazas?.length) {
          // 400 `plazas`: se ocuparon las camas. Queda «Avisar a la mesa» con lo cargado.
          setSinCamas(true);
          setAccion('avisar');
        }
        const generalesYPlazas = [...(plazas || []), ...(generales || [])];
        if (generalesYPlazas.length) setFalla({ tipo: 'rechazo', mensaje: generalesYPlazas.join('\n') });
        else showToast({ type: 'warning', message: 'El servidor rechazó algunos datos. Corregí lo marcado y volvé a mandar.' });
        return;
      }
      if (c.tipo === 'espera' && c.espera) {
        setAhora(Date.now());
        setEsperaHasta(Date.now() + c.espera);
      }
      setFalla(c);
    } finally {
      enviandoRef.current = false;
      if (montado.current) setEnviando(false);
      avisarEnviando(false);
    }
  };

  const tocar = (cual) => {
    if (enviandoRef.current || esperando) return;
    if (sinDatos && pendiente === cual) {
      mandar(cual);
      return;
    }
    setIntentado(true);
    const locales = validarPuerta(datos);
    if (Object.keys(locales).length) {
      const cantidad = Object.keys(locales).length;
      showToast({ type: 'warning', message: `Falta${cantidad === 1 ? '' : 'n'} ${cantidad} dato${cantidad === 1 ? '' : 's'} para poder mandar.` });
      return;
    }
    // El reintento de un envío sin resultado manda lo mismo: no se vuelve a preguntar.
    if (pendiente === cual) {
      mandar(cual);
      return;
    }
    showAlert(ACCIONES[cual].titulo, ACCIONES[cual].pregunta(totalDeclarado(datos), dispositivo?.nombre || 'este dispositivo'), [
      { text: 'Volver', style: 'cancel' },
      { text: ACCIONES[cual].titulo, onPress: () => mandar(cual) },
    ]);
  };

  if (errorSesion) {
    return <View style={styles.centro}><Text style={[styles.texto, { color: theme.colors.text, fontFamily: typography.medium }]}>{errorSesion}</Text></View>;
  }
  if (cargando) {
    return <View style={styles.centro}><ActivityIndicator size="large" color={theme.colors.primary} accessibilityLabel="Abriendo el formulario" /></View>;
  }

  const tarjeta = [styles.card, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }];
  const tituloSeccion = [styles.titulo, { color: theme.colors.text, fontFamily: typography.bold }];
  const etiqueta = [styles.etiqueta, { color: theme.colors.text, fontFamily: typography.semibold }];
  const ayuda = [styles.ayuda, { color: theme.colors.textMuted, fontFamily: typography.medium }];
  const avisoDe = (tono, contenido, icono) => (
    <View accessibilityRole="alert" style={[styles.aviso, { backgroundColor: statusTones[tono].bg, borderColor: statusTones[tono].bd }]}>
      {icono ? <Ionicons name={icono} size={18} color={statusTones[tono].tx} accessible={false} importantForAccessibility="no" /> : null}
      <Text style={[styles.flex, styles.texto, { color: statusTones[tono].tx, fontFamily: typography.semibold }]}>{contenido}</Text>
    </View>
  );
  const errores = { ...(intentado ? validarPuerta(datos) : {}), ...erroresServidor };
  const errorCampo = (campos) => campos.flatMap((campo) => errores[campo] || []).map((m, i) => (
    <Text key={`${campos[0]}:${i}`} accessibilityLiveRegion="polite" style={[styles.error, { color: theme.colors.danger, fontFamily: typography.medium }]}>{m}</Text>
  ));
  const caja = (campos, extra = []) => [styles.input, ...extra, { color: theme.colors.text, backgroundColor: theme.colors.surface,
    borderColor: campos.some((c) => errores[c]?.length) ? theme.colors.danger : theme.colors.border }];
  const contador = ({ clave, titulo }) => {
    const valor = aCantidad(datos[clave]);
    return (
      <View key={clave} style={styles.contador}>
        <Text style={[styles.flex, etiqueta]}>{titulo}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel={`Restar ${titulo}`} disabled={fijo || valor <= 0}
          accessibilityState={{ disabled: fijo || valor <= 0 }} onPress={() => cambiar({ [clave]: Math.max(0, valor - 1) })}
          style={[styles.paso, { borderColor: theme.colors.border, opacity: fijo || valor <= 0 ? 0.4 : 1 }]}>
          <Ionicons name="remove" size={20} color={theme.colors.text} accessible={false} importantForAccessibility="no" />
        </Pressable>
        <Text accessibilityLabel={`${titulo}: ${valor}`} style={[styles.valor, { color: theme.colors.text, fontFamily: typography.bold }]}>{valor}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel={`Sumar ${titulo}`} disabled={fijo} accessibilityState={{ disabled: fijo }}
          onPress={() => cambiar({ [clave]: valor + 1 })} style={[styles.paso, { borderColor: theme.colors.border, opacity: fijo ? 0.4 : 1 }]}>
          <Ionicons name="add" size={20} color={theme.colors.text} accessible={false} importantForAccessibility="no" />
        </Pressable>
      </View>
    );
  };
  const casilla = ({ clave, titulo }) => {
    const marcada = datos[clave] === true;
    return (
      <Pressable key={clave} accessibilityRole="checkbox" accessibilityState={{ checked: marcada, disabled: fijo }} accessibilityLabel={titulo}
        disabled={fijo} onPress={() => cambiar({ [clave]: !marcada })} style={styles.casilla}>
        <Ionicons name={marcada ? 'checkbox' : 'square-outline'} size={24} color={marcada ? theme.colors.primary : theme.colors.textSoft}
          accessible={false} importantForAccessibility="no" />
        <Text style={[styles.flex, etiqueta]}>{titulo}</Text>
      </Pressable>
    );
  };

  const total = totalDeclarado(datos);
  const puedeIngresar = !sinCamas || pendiente === 'ingresar';
  const segundos = Math.max(1, Math.ceil((esperaHasta - ahora) / 1000));
  const listado = intentado ? listaDeErrores(errores) : [];
  const botonDe = (cual, principal) => {
    let titulo = pendiente === cual ? `Reintentar: ${ACCIONES[cual].titulo.toLowerCase()}` : ACCIONES[cual].titulo;
    if (esperando && principal) titulo = `Reintentar en ${segundos} s`;
    return (
      <CustomButton key={cual} title={titulo} size={principal ? 'L' : undefined} variant={principal ? undefined : 'secondary'}
        iconLeft={pendiente === cual ? 'refresh' : ACCIONES[cual].icono} loading={enviando && principal}
        disabled={enviando || !sesion || esperando} onPress={() => tocar(cual)} />
    );
  };
  const otra = accion === 'ingresar' ? 'avisar' : 'ingresar';

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.background }} contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode={keyboardDismissModeFor(Platform.OS === 'ios' ? 'interactive' : 'on-drag')}>
      {sinRed ? avisoDe('warning', TEXTO_SIN_RED, 'cloud-offline-outline') : null}

      <View style={tarjeta}>
        <Text accessibilityRole="header" style={tituloSeccion}>{`Sin derivación · DNI ${cleanDigits(dni)}`}</Text>
        {mensaje ? avisoDe('info', mensaje) : null}
        <Text style={ayuda}>{ACCIONES[accion].ayuda(plazasLibres)}</Text>
        {sinCamas && pendiente !== 'ingresar' ? avisoDe('warning', TEXTO_SIN_CAMAS, 'bed-outline') : null}
        {pendiente && sinDatos ? avisoDe('warning', TEXTO_SIN_DATOS, 'time-outline') : null}
        {pendiente && !sinDatos ? avisoDe('warning', `Hay un envío de esta familia sin resultado: «Reintentar» manda el mismo pedido y no crea otro caso. Lo cargado queda fijo hasta saber el resultado.`, 'time-outline') : null}
      </View>

      {sinDatos ? null : (
        <>
      <View style={tarjeta}>
        <Text accessibilityRole="header" style={tituloSeccion}>1. Traslado y responsable</Text>
        <Text style={etiqueta}>¿Cómo llegó la familia? *</Text>
        <View style={styles.opciones} accessibilityRole="radiogroup" accessibilityLabel="Traslado">
          {TRASLADOS.map((opcion) => {
            const elegida = datos.traslado === opcion.valor;
            return (
              <Pressable key={opcion.valor} accessibilityRole="radio" accessibilityState={{ selected: elegida, checked: elegida, disabled: fijo }}
                accessibilityLabel={`Traslado: ${opcion.titulo}`} disabled={fijo} onPress={() => cambiar({ traslado: opcion.valor })}
                style={[styles.opcion, { borderColor: elegida ? theme.colors.primary : theme.colors.border,
                  backgroundColor: elegida ? `${theme.colors.primary}18` : theme.colors.surface }]}>
                <Text style={{ color: elegida ? theme.colors.primary : theme.colors.text, fontFamily: elegida ? typography.bold : typography.medium, fontSize: fontSizes.sm }}>{opcion.titulo}</Text>
              </Pressable>
            );
          })}
        </View>
        {errorCampo(['traslado'])}
        {datos.traslado === 'OTRA' ? (
          <>
            <TextInput value={datos.traslado_otro} editable={!fijo} onChangeText={(t) => cambiar({ traslado_otro: t })} maxLength={MAX_TRASLADO_OTRO}
              accessibilityLabel="Otro traslado" placeholder="Contá cómo llegó" placeholderTextColor={theme.colors.textSoft} style={caja(['traslado_otro'])} />
            {errorCampo(['traslado_otro'])}
          </>
        ) : null}

        <Text style={[etiqueta, styles.separado]}>DNI del responsable *</Text>
        <TextInput value={cleanDigits(dni)} editable={false} accessibilityLabel="DNI del responsable" accessibilityHint={TEXTO_DNI_FIJO}
          style={caja(['dni'])} />
        <Text style={ayuda}>{TEXTO_DNI_FIJO}</Text>
        {errorCampo(['dni'])}
        <Text style={etiqueta}>Nombre</Text>
        <TextInput value={datos.nombre} editable={!fijo} onChangeText={(t) => cambiar({ nombre: t })} autoCapitalize="words"
          accessibilityLabel="Nombre" placeholderTextColor={theme.colors.textSoft} style={caja(['nombre'])} />
        {errorCampo(['nombre'])}
        <Text style={etiqueta}>Apellido</Text>
        <TextInput value={datos.apellido} editable={!fijo} onChangeText={(t) => cambiar({ apellido: t })} autoCapitalize="words"
          accessibilityLabel="Apellido" placeholderTextColor={theme.colors.textSoft} style={caja(['apellido'])} />
        {errorCampo(['apellido'])}
        <Text style={ayuda}>Si la persona ya está en el legajo alcanza con el DNI; si no, el servidor pide nombre y apellido para darla de alta.</Text>
        <FechaInput label="Fecha de nacimiento" value={datos.fecha_nacimiento} disabled={fijo} onSelect={(t) => cambiar({ fecha_nacimiento: t })} />
        {errorCampo(['fecha_nacimiento'])}
        <Text style={etiqueta}>Teléfono de contacto</Text>
        <TextInput value={datos.telefono} editable={!fijo} onChangeText={(t) => cambiar({ telefono: t })} keyboardType="phone-pad"
          accessibilityLabel="Teléfono de contacto" placeholderTextColor={theme.colors.textSoft} style={caja(['telefono'])} />
        {casilla({ clave: 'documento_extraviado', titulo: 'Perdió el documento (sabe el número)' })}
      </View>

      <View style={tarjeta}>
        <Text accessibilityRole="header" style={tituloSeccion}>2. Personas que ingresan juntas</Text>
        <Text style={ayuda}>El responsable también cuenta.</Text>
        {CANTIDADES.map((c) => contador({ clave: c.clave, titulo: `${c.grupo} · ${c.titulo}` }))}
        <Text accessibilityLiveRegion="polite" style={[etiqueta, styles.separado]}>{`Total: ${total} persona${total === 1 ? '' : 's'}`}</Text>
        {errorCampo(['total', ...CANTIDADES.map((c) => c.clave)])}
      </View>

      <View style={tarjeta}>
        <Text accessibilityRole="header" style={tituloSeccion}>3. Quiénes necesitan asistencia</Text>
        {ASISTENCIA.map((c) => (
          <View key={c.clave}>
            {contador(c)}
            {errorCampo([c.clave])}
          </View>
        ))}
        {AVISOS.map((c) => casilla(c))}
      </View>

      <View style={tarjeta}>
        <Text accessibilityRole="header" style={tituloSeccion}>4. Domicilio y observaciones</Text>
        <Text style={etiqueta}>Dirección o referencia (opcional)</Text>
        <TextInput value={datos.direccion} editable={!fijo} onChangeText={(t) => cambiar({ direccion: t })} maxLength={MAX_DIRECCION}
          accessibilityLabel="Dirección o referencia" placeholder="Vacía: la del dispositivo" placeholderTextColor={theme.colors.textSoft} style={caja(['direccion'])} />
        {errorCampo(['direccion', 'localidad'])}
        <Text style={[etiqueta, styles.separado]}>Observaciones</Text>
        <TextInput value={datos.observaciones} editable={!fijo} onChangeText={(t) => cambiar({ observaciones: t })} multiline
          accessibilityLabel="Observaciones" placeholder="Algo más que la mesa tenga que saber" placeholderTextColor={theme.colors.textSoft}
          style={caja(['observaciones'], [styles.areaTexto])} />
      </View>

        </>
      )}

      {listado.length ? (
        <View accessibilityRole="alert" style={[styles.card, { backgroundColor: statusTones.danger.bg, borderColor: statusTones.danger.bd }]}>
          <Text style={[styles.titulo, { color: statusTones.danger.tx, fontFamily: typography.bold }]}>Para corregir</Text>
          {listado.map(({ campo, etiqueta: nombre, texto }) => (
            <Text key={`${campo}:${texto}`} style={[styles.texto, { color: statusTones.danger.tx, fontFamily: typography.medium }]}>{`• ${nombre}: ${texto}`}</Text>
          ))}
        </View>
      ) : null}
      {falla ? avisoDe(falla.tipo === 'reintentable' || falla.tipo === 'espera' ? 'warning' : 'danger', falla.mensaje) : null}
      {enviando ? <ActivityIndicator color={theme.colors.primary} accessibilityLabel={`Mandando: ${ACCIONES[accion].titulo.toLowerCase()}`} /> : null}

      {botonDe(accion, true)}
      {/* Con un envío sin resultado, la otra acción no se ofrece: con otro uuid crearía un segundo caso. */}
      {!pendiente && (otra === 'avisar' || puedeIngresar) ? botonDe(otra, false) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 40, gap: 12 },
  centro: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  card: { borderWidth: 1, borderRadius: radii.xl, padding: 14, gap: 8 },
  titulo: { fontSize: fontSizes.base },
  etiqueta: { fontSize: fontSizes.sm },
  ayuda: { fontSize: fontSizes.xs },
  texto: { fontSize: fontSizes.sm },
  error: { fontSize: fontSizes.xs },
  separado: { marginTop: 8 },
  flex: { flex: 1 },
  input: { minHeight: 46, borderWidth: 1, borderRadius: radii.lg, paddingHorizontal: 12, paddingVertical: 10, fontSize: fontSizes.sm },
  areaTexto: { minHeight: 96, textAlignVertical: 'top' },
  opciones: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  opcion: { minHeight: 44, paddingHorizontal: 12, borderWidth: 1, borderRadius: radii.lg, alignItems: 'center', justifyContent: 'center' },
  contador: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 48 },
  paso: { width: 44, height: 44, borderWidth: 1, borderRadius: radii.full, alignItems: 'center', justifyContent: 'center' },
  valor: { minWidth: 28, textAlign: 'center', fontSize: fontSizes.base },
  casilla: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44 },
  aviso: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: radii.lg, padding: 10 },
});
