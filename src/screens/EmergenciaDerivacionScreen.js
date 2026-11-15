import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable, ActivityIndicator, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import TextInput from '../components/FormInput';
import CustomButton from '../components/CustomButton';
import { useTheme } from '../context/ThemeContext';
import { useToast } from '../context/ToastContext';
import {
  MAX_OBSERVACION, MOTIVOS_RECHAZO, TEXTO_SIN_RED, abrirSesion, aceptar, clasificarErrorLlegada, escucharRed, hayConexion,
  nombreDelResponsable, rechazar, resumenDeAsistencia, resumenDelGrupo, tituloDeNecesidad, validarRechazo,
} from '../services/emergenciaLlegadas';
import { formatDate } from '../utils/dates';
import { statusTones } from '../theme/statusBadges';
import { keyboardDismissModeFor } from '../utils/teclado';
import { fontSizes, radii } from '../theme';

export const TEXTO_VENCIDA = 'Venció el plazo, pero la mesa todavía no la cerró: se puede aceptar igual.';

const PRIORIDADES = { ALTA: ['Prioridad alta', 'danger'], MEDIA: ['Prioridad media', 'warning'], BAJA: ['Prioridad baja', 'gray'] };

// M2-2 · La derivación pendiente (§13.3, §13.4): la familia, lo que pidió la mesa, y «Aceptar» o
// «Rechazar» con motivo. Con conexión: sin red no se manda nada. El token se fija al abrir.
// Aceptar y rechazar NO son idempotentes: si un envío queda incierto (red, timeout, 5xx, WAF), el
// reintento que recibe 409 con el estado que esa acción produce es «se hizo».
// - `onAceptada(caso, resultado)`: 200, o 409 INGRESO_EN_CURSO tras un intento incierto.
// - `onRechazada(resultado)`: 200, o 409 con el caso de vuelta en la mesa tras un intento incierto.
// - `onConflicto(clasificacion)`: 409 de estado → el padre recarga por `estado_actual` (§13.1).
// - `onNoEncontrado()`: 404. `onSinModulo(mensaje)`: 403. `onEnviando(bool)`: hay un envío en curso.
// El resultado llega al padre aunque la pantalla ya no esté.
export default function EmergenciaDerivacionScreen({
  busqueda, plazasLibres = null, onAceptada, onRechazada, onConflicto, onNoEncontrado, onSinModulo, onEnviando,
}) {
  const { theme, typography } = useTheme();
  const { showAlert, showToast } = useToast();
  const derivacion = busqueda?.derivacion;
  const [sesion, setSesion] = useState(null);
  const [errorSesion, setErrorSesion] = useState('');
  const [enviando, setEnviando] = useState(null);
  const [incierto, setIncierto] = useState(null);
  const [falla, setFalla] = useState(null);
  const [sinRed, setSinRed] = useState(false);
  const [rechazando, setRechazando] = useState(false);
  const [motivo, setMotivo] = useState(null);
  const [observacion, setObservacion] = useState('');
  const [intentado, setIntentado] = useState(false);
  const [erroresServidor, setErroresServidor] = useState({});
  const montado = useRef(true);
  const enviandoRef = useRef(false);

  useEffect(() => {
    montado.current = true;
    abrirSesion().then((abierta) => { if (montado.current) setSesion(abierta); })
      .catch((e) => { if (montado.current) setErrorSesion(e?.message || 'No hay sesión iniciada.'); });
    hayConexion().then((hay) => { if (montado.current) setSinRed(!hay); }).catch(() => {});
    const dejarDeEscuchar = escucharRed((hay) => { if (montado.current) setSinRed(!hay); });
    return () => {
      montado.current = false;
      dejarDeEscuchar();
    };
  }, [derivacion?.id]);

  const avisarEnviando = (valor) => {
    try {
      onEnviando?.(valor);
    } catch {
      // Solo informa.
    }
  };

  // Lo común a aceptar y rechazar: un solo envío a la vez, la red, el aviso al padre y los errores.
  const enviar = async (accion, hacer) => {
    if (enviandoRef.current || !sesion) return;
    if (!await hayConexion()) {
      if (!montado.current) return;
      setSinRed(true);
      showAlert('Sin conexión', TEXTO_SIN_RED, [{ text: 'Entendido' }]);
      return;
    }
    enviandoRef.current = true;
    if (montado.current) {
      setSinRed(false);
      setEnviando(accion);
      setFalla(null);
    }
    avisarEnviando(true);
    try {
      await hacer();
    } catch (e) {
      const c = e?.clasificacion || clasificarErrorLlegada(e);
      if (c.tipo === 'obsoleto') return;
      if (c.tipo === 'conflicto') {
        onConflicto?.(c);
        return;
      }
      if (c.tipo === 'no_encontrado') {
        showAlert('Derivación no disponible', c.mensaje, [{ text: 'Entendido' }]);
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
      setIncierto(e?.incierto ? accion : null);
      if (c.tipo === 'sin_red') {
        setSinRed(true);
        showAlert('Sin conexión', TEXTO_SIN_RED, [{ text: 'Entendido' }]);
        return;
      }
      if (c.tipo === 'validacion' && accion === 'rechazar') {
        setErroresServidor(c.errores || {});
        if (c.errores?.generales?.length) setFalla({ tipo: 'rechazo', mensaje: c.errores.generales.join('\n') });
        return;
      }
      if (c.tipo === 'validacion') {
        // 400 `plazas` de aceptar: sin camas libres, o una se ocupó mientras se aceptaba.
        setFalla({ tipo: 'rechazo', mensaje: [...(c.errores?.plazas || []), ...(c.errores?.generales || [])].join('\n') || c.mensaje });
        return;
      }
      setFalla(c);
    } finally {
      enviandoRef.current = false;
      if (montado.current) setEnviando(null);
      avisarEnviando(false);
    }
  };

  const tocarAceptar = () => enviar('aceptar', async () => {
    const r = await aceptar(sesion, derivacion, { incierto: incierto === 'aceptar' });
    if (r.resultado === 'ya_aceptada') {
      showToast({ type: 'info', message: r.mensaje });
    } else if (r.faltantes > 0) {
      showAlert('Derivación aceptada con camas de menos', r.mensaje || `Faltan ${r.faltantes} camas. Se puede seguir.`, [{ text: 'Entendido' }]);
    } else {
      showToast({ type: 'success', message: r.mensaje || 'Derivación aceptada.' });
    }
    onAceptada?.(r.caso, r);
  });

  const mandarRechazo = () => enviar('rechazar', async () => {
    const r = await rechazar(sesion, derivacion, { motivo, observacion }, { incierto: incierto === 'rechazar' });
    showToast({ type: 'success', message: r.resultado === 'ya_rechazada' ? r.mensaje : 'Derivación rechazada: el caso vuelve a la mesa.' });
    onRechazada?.(r);
  });

  const tocarConfirmarRechazo = () => {
    if (enviandoRef.current) return;
    setIntentado(true);
    if (Object.keys(validarRechazo({ motivo, observacion })).length) return;
    // El reintento de un rechazo incierto manda lo mismo: no se vuelve a preguntar.
    if (incierto === 'rechazar') {
      mandarRechazo();
      return;
    }
    const titulo = MOTIVOS_RECHAZO.find((m) => m.valor === motivo)?.titulo || motivo;
    showAlert('Rechazar la derivación', `Motivo: ${titulo}. El caso vuelve a la mesa y no se puede deshacer desde la app.`, [
      { text: 'Cancelar', style: 'cancel' },
      { text: 'Rechazar', style: 'destructive', onPress: mandarRechazo },
    ]);
  };

  if (!derivacion) {
    return <View style={styles.centro}><Text style={[styles.texto, { color: theme.colors.text, fontFamily: typography.medium }]}>No hay derivación para mostrar.</Text></View>;
  }
  if (errorSesion) {
    return <View style={styles.centro}><Text style={[styles.texto, { color: theme.colors.text, fontFamily: typography.medium }]}>{errorSesion}</Text></View>;
  }

  const tarjeta = [styles.card, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }];
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
  const dato = (titulo, valor) => (valor ? (
    <View style={styles.dato}>
      <Text style={etiqueta}>{titulo}</Text>
      <Text style={[styles.texto, { color: theme.colors.text, fontFamily: typography.medium }]}>{valor}</Text>
    </View>
  ) : null);
  const mensajes = (lista, prefijo) => (lista || []).map((mensaje, indice) => (
    <Text key={`${prefijo}:${indice}`} accessibilityLiveRegion="polite" style={[styles.error, { color: theme.colors.danger, fontFamily: typography.medium }]}>{mensaje}</Text>
  ));

  const caso = derivacion.caso;
  const [prioridad, tonoPrioridad] = PRIORIDADES[caso?.prioridad] || [caso?.prioridad ? `Prioridad ${caso.prioridad.toLowerCase()}` : null, 'gray'];
  const libres = plazasLibres ?? busqueda?.plazas_libres ?? null;
  const asistencia = resumenDeAsistencia(derivacion.grupo);
  const erroresCliente = intentado ? validarRechazo({ motivo, observacion }) : {};
  const erroresMotivo = [...(erroresCliente.motivo || []), ...(erroresServidor.motivo || [])];
  const erroresObservacion = [...(erroresCliente.observacion || []), ...(erroresServidor.observacion || [])];
  const ocupado = !!enviando || !sesion;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.background }} contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode={keyboardDismissModeFor(Platform.OS === 'ios' ? 'interactive' : 'on-drag')}>
      {sinRed ? avisoDe('warning', TEXTO_SIN_RED, 'cloud-offline-outline') : null}

      <View style={tarjeta}>
        <Text accessibilityRole="header" style={[styles.titulo, { color: theme.colors.text, fontFamily: typography.bold }]}>{`Caso ${caso?.numero || ''}`.trim()}</Text>
        <View style={styles.fila}>
          {insignia('warning', 'Por aceptar', 'estado')}
          {prioridad ? insignia(tonoPrioridad, prioridad, 'prioridad') : null}
          {derivacion.vencida ? insignia('danger', 'Vencida', 'vencida') : null}
        </View>
        {derivacion.vencida ? avisoDe('warning', TEXTO_VENCIDA, 'time-outline') : null}
        {dato('Responsable', nombreDelResponsable(derivacion.responsable))}
        {dato('Camas pedidas', `${derivacion.plazas_pedidas}${caso?.total_declarado ? ` · ${caso.total_declarado} personas declaradas` : ''}`)}
        {libres != null ? <Text style={ayuda}>{libres === 1 ? '1 cama libre en este dispositivo' : `${libres || 'Sin'} camas libres en este dispositivo`}</Text> : null}
        {dato('Derivada', [derivacion.derivada_por, derivacion.derivada_en ? formatDate(derivacion.derivada_en, { includeTime: true }) : null].filter(Boolean).join(' · '))}
        {dato('Vence', derivacion.vence_en ? formatDate(derivacion.vence_en, { includeTime: true }) : null)}
      </View>

      <View style={tarjeta}>
        <Text accessibilityRole="header" style={[styles.titulo, { color: theme.colors.text, fontFamily: typography.bold }]}>La familia</Text>
        <Text style={[styles.texto, { color: theme.colors.text, fontFamily: typography.medium }]}>{resumenDelGrupo(derivacion.grupo)}</Text>
        {asistencia ? <Text style={ayuda}>{asistencia}</Text> : null}
        {derivacion.necesidades.length ? (
          <View style={styles.fila}>{derivacion.necesidades.map((n) => insignia('warning', tituloDeNecesidad(n), n))}</View>
        ) : null}
        {dato('Teléfono', derivacion.telefono)}
        {dato('Observaciones', derivacion.observaciones)}
      </View>

      {falla ? avisoDe(falla.tipo === 'reintentable' ? 'warning' : 'danger', falla.mensaje) : null}
      {enviando ? <ActivityIndicator color={theme.colors.primary} accessibilityLabel={enviando === 'aceptar' ? 'Aceptando la derivación' : 'Rechazando la derivación'} /> : null}

      {!rechazando ? (
        <>
          <CustomButton title={incierto === 'aceptar' ? 'Reintentar aceptar' : 'Aceptar y reservar camas'} size="L"
            iconLeft={incierto === 'aceptar' ? 'refresh' : 'checkmark-done-outline'} loading={enviando === 'aceptar'}
            disabled={ocupado || incierto === 'rechazar'} onPress={tocarAceptar} />
          <CustomButton title="Rechazar" size="L" variant="secondary" iconLeft="close-circle-outline"
            disabled={ocupado || incierto === 'aceptar'} onPress={() => setRechazando(true)} />
        </>
      ) : (
        <View style={tarjeta}>
          <Text accessibilityRole="header" style={[styles.titulo, { color: theme.colors.text, fontFamily: typography.bold }]}>Rechazar la derivación</Text>
          <Text style={etiqueta}>Motivo *</Text>
          <View style={styles.opciones} accessibilityRole="radiogroup" accessibilityLabel="Motivo del rechazo">
            {MOTIVOS_RECHAZO.map((opcion) => {
              const elegida = motivo === opcion.valor;
              const fijo = ocupado || incierto === 'rechazar';
              return (
                <Pressable key={opcion.valor} accessibilityRole="radio" accessibilityState={{ selected: elegida, checked: elegida, disabled: fijo }}
                  accessibilityLabel={`Motivo: ${opcion.titulo}`} disabled={fijo}
                  onPress={() => { setMotivo(opcion.valor); setErroresServidor({}); }}
                  style={[styles.opcion, { borderColor: elegida ? theme.colors.primary : theme.colors.border,
                    backgroundColor: elegida ? `${theme.colors.primary}18` : theme.colors.surface }]}>
                  <Text style={{ color: elegida ? theme.colors.primary : theme.colors.text, fontFamily: elegida ? typography.bold : typography.medium, fontSize: fontSizes.sm }}>{opcion.titulo}</Text>
                </Pressable>
              );
            })}
          </View>
          {mensajes(erroresMotivo, 'motivo')}
          <Text style={[etiqueta, styles.separado]}>{motivo === 'OTRO' ? 'Qué pasó *' : 'Observación (opcional)'}</Text>
          <TextInput value={observacion} editable={!ocupado && incierto !== 'rechazar'} multiline maxLength={MAX_OBSERVACION}
            accessibilityLabel="Observación del rechazo" placeholder="Lo que la mesa tenga que saber" placeholderTextColor={theme.colors.textSoft}
            onChangeText={(valor) => { if (incierto !== 'rechazar') { setObservacion(valor); setErroresServidor({}); } }}
            style={[styles.input, styles.areaTexto, { color: theme.colors.text, backgroundColor: theme.colors.surface,
              borderColor: erroresObservacion.length ? theme.colors.danger : theme.colors.border }]} />
          {mensajes(erroresObservacion, 'observacion')}
          <CustomButton title={incierto === 'rechazar' ? 'Reintentar rechazo' : 'Confirmar rechazo'} size="L" iconLeft="close-circle-outline"
            loading={enviando === 'rechazar'} disabled={ocupado} onPress={tocarConfirmarRechazo} />
          {incierto !== 'rechazar' ? (
            <CustomButton title="Volver sin rechazar" variant="secondary" disabled={ocupado}
              onPress={() => { setRechazando(false); setIntentado(false); setErroresServidor({}); }} />
          ) : null}
        </View>
      )}
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
  fila: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  dato: { gap: 2 },
  opciones: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  opcion: { borderWidth: 1, borderRadius: radii.full, paddingHorizontal: 14, paddingVertical: 10, minHeight: 44, justifyContent: 'center' },
  input: { minHeight: 46, borderWidth: 1, borderRadius: radii.lg, paddingHorizontal: 12, paddingVertical: 10, fontSize: fontSizes.sm },
  areaTexto: { minHeight: 96, textAlignVertical: 'top' },
  aviso: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: radii.lg, padding: 10 },
  insignia: { alignSelf: 'flex-start', borderWidth: 1, borderRadius: radii.full, paddingHorizontal: 10, paddingVertical: 3 },
});
