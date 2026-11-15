import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable, ActivityIndicator, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import TextInput from '../components/FormInput';
import CustomButton from '../components/CustomButton';
import { useTheme } from '../context/ThemeContext';
import { useToast } from '../context/ToastContext';
import {
  MAX_AULA, MAX_ENCARGADO, MAX_MOTIVO_CANCELAR, MAX_OBSERVACION, MAX_TARJETA, MOTIVOS_DIFERENCIA, TEXTO_SIN_RED,
  abrirSesion, alojar, cancelar, cargarCamas, cerrarDiferencia, clasificarErrorLlegada, escucharRed, hayConexion,
  sectorDeLaFamilia, textoDeLiberadas, validarAlojar, validarCancelar, validarDiferencia,
} from '../services/emergenciaLlegadas';
import { statusTones } from '../theme/statusBadges';
import { keyboardDismissModeFor } from '../utils/teclado';
import { fontSizes, radii } from '../theme';

const personas = (n) => (n === 1 ? '1 persona' : `${n} personas`);

// Lo que cambia entre los tres cierres: título, botón, qué se le dice a la guardia antes y la confirmación.
export const CIERRES = {
  alojar: {
    titulo: 'Familia alojada',
    boton: 'Alojar a la familia',
    icono: 'home-outline',
    resumen: ({ confirmadas }) => `Están las ${personas(confirmadas)} confirmadas. El ingreso se cierra con la familia alojada y las camas reservadas que sobren se liberan.`,
    pregunta: ({ confirmadas, total }) => `Se aloja a la familia: ${confirmadas} de ${total}. El ingreso se cierra y no se puede deshacer desde la app.`,
    confirmar: 'Alojar',
    destructiva: false,
  },
  diferencia: {
    titulo: 'Cerrar con diferencia',
    boton: 'Cerrar con diferencia',
    icono: 'git-compare-outline',
    resumen: ({ confirmadas, total }) => `Llegaron menos personas: ${confirmadas} de ${total} confirmadas. Se alojan las confirmadas y las camas reservadas sin usar se liberan.`,
    pregunta: ({ confirmadas, total }) => `Se cierra el ingreso con ${confirmadas} de ${total}: ${personas(total - confirmadas)} sin confirmar quedan afuera y sus camas se liberan. No se puede deshacer desde la app.`,
    confirmar: 'Cerrar con diferencia',
    destructiva: true,
  },
  cancelar: {
    titulo: 'Cancelar ingreso',
    boton: 'Cancelar el ingreso',
    icono: 'close-circle-outline',
    resumen: () => 'Todavía no se confirmó a nadie. Se liberan todas las camas reservadas para la familia y el caso vuelve a la mesa.',
    pregunta: () => 'Se liberan todas las camas reservadas para la familia y el caso vuelve a la mesa. No se puede deshacer desde la app.',
    confirmar: 'Cancelar el ingreso',
    destructiva: true,
  },
};

// M2-5 · Cerrar el ingreso (§13.9): «Familia alojada» (N de N, con la sección 4: sector, aula, tarjeta
// familiar y quién recibe), «Cerrar con diferencia» (motivo, y qué pasó con «Otro») o «Cancelar
// ingreso» (motivo). Con conexión: sin red no se manda nada. El token se fija al abrir.
// Ninguno de los tres es idempotente: si el envío queda incierto (red, timeout, 5xx, WAF), «Reintentar»
// manda lo mismo sin volver a preguntar, y el 409 con el estado que esa acción produce es «se hizo»
// (muestra el `detail` del servidor: puede haberlo hecho otra guardia).
// - `onCerrado(resultado)`: 200, o el «se hizo» tras un intento incierto. `resultado.cierre` dice cuál.
// - `onConflicto(clasificacion)`: 409 de estado → el padre recarga por `estado_actual` (§13.1).
// - `onNoEncontrado()`: 404. `onSinModulo(mensaje)`: 403. `onEnviando(bool)`: hay un envío en curso.
// El resultado llega al padre aunque la pantalla ya no esté.
export default function EmergenciaCierreScreen({
  caso, cierre, confirmadas = 0, total = 0, integrantes = [], dispositivo,
  onCerrado, onConflicto, onNoEncontrado, onSinModulo, onEnviando,
}) {
  const { theme, typography } = useTheme();
  const { showAlert, showToast } = useToast();
  const config = CIERRES[cierre];
  const [sesion, setSesion] = useState(null);
  const [errorSesion, setErrorSesion] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [incierto, setIncierto] = useState(false);
  const [falla, setFalla] = useState(null);
  const [sinRed, setSinRed] = useState(false);
  const [intentado, setIntentado] = useState(false);
  const [erroresServidor, setErroresServidor] = useState({});
  const [esperaHasta, setEsperaHasta] = useState(0);
  const [ahora, setAhora] = useState(Date.now());
  // Alojar: la sección 4.
  const [sectores, setSectores] = useState(null);
  const [cargandoSectores, setCargandoSectores] = useState(cierre === 'alojar');
  const [errorSectores, setErrorSectores] = useState('');
  const [sector, setSector] = useState(null);
  const [aula, setAula] = useState('');
  const [tarjeta, setTarjeta] = useState(false);
  const [tarjetaNumero, setTarjetaNumero] = useState('');
  const [encargado, setEncargado] = useState('');
  // Diferencia y cancelar.
  const [motivo, setMotivo] = useState(cierre === 'cancelar' ? '' : null);
  const [observacion, setObservacion] = useState('');
  const montado = useRef(true);
  const enviandoRef = useRef(false);

  const avisarEnviando = (valor) => {
    try {
      onEnviando?.(valor);
    } catch {
      // Solo informa.
    }
  };

  // Un error de lectura o de envío que no se queda en la pantalla. Devuelve si lo derivó.
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

  // El sector se elige del mapa de camas (§13.7) y se propone el de las camas de la familia. Es opcional:
  // si el mapa no llega se puede alojar sin sector.
  const pedirSectores = async (base) => {
    if (cierre !== 'alojar' || !base || dispositivo?.id == null) {
      setCargandoSectores(false);
      return;
    }
    setCargandoSectores(true);
    setErrorSectores('');
    try {
      const mapa = await cargarCamas(base, dispositivo.id, caso.id);
      if (!montado.current) return;
      setSectores(mapa.sectores.map((s) => s.sector));
      setSector((actual) => actual ?? sectorDeLaFamilia(mapa, integrantes));
    } catch (e) {
      if (!montado.current) return;
      const c = e?.clasificacion || clasificarErrorLlegada(e);
      if (c.tipo === 'obsoleto') return;
      if (c.tipo === 'no_encontrado' || c.tipo === 'sin_modulo') {
        rutear(c);
        return;
      }
      setErrorSectores(c.tipo === 'sin_red' ? TEXTO_SIN_RED : 'No se pudieron traer los sectores. Podés alojar sin elegir sector.');
    } finally {
      if (montado.current) setCargandoSectores(false);
    }
  };

  useEffect(() => {
    montado.current = true;
    abrirSesion().then((abierta) => {
      if (!montado.current) return;
      setSesion(abierta);
      pedirSectores(abierta);
    }).catch((e) => {
      if (montado.current) {
        setErrorSesion(e?.message || 'No hay sesión iniciada.');
        setCargandoSectores(false);
      }
    });
    hayConexion().then((hay) => { if (montado.current) setSinRed(!hay); }).catch(() => {});
    const dejarDeEscuchar = escucharRed((hay) => { if (montado.current) setSinRed(!hay); });
    return () => {
      montado.current = false;
      dejarDeEscuchar();
    };
  }, [caso?.id, cierre]);

  const esperando = esperaHasta > ahora;
  useEffect(() => {
    if (!esperando) return undefined;
    const timer = setInterval(() => setAhora(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [esperando]);

  const datosDelCierre = () => (cierre === 'alojar'
    ? { sector, aula, tarjeta_entregada: tarjeta, tarjeta_numero: tarjetaNumero, encargado }
    : { motivo, observacion });
  const validar = () => {
    if (cierre === 'alojar') return validarAlojar(datosDelCierre());
    if (cierre === 'diferencia') return validarDiferencia(datosDelCierre());
    return validarCancelar(datosDelCierre());
  };

  const mandar = async () => {
    if (enviandoRef.current || !sesion) return;
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
      const opciones = { incierto };
      let r;
      if (cierre === 'alojar') r = await alojar(sesion, caso.id, datosDelCierre(), opciones);
      else if (cierre === 'diferencia') r = await cerrarDiferencia(sesion, caso.id, datosDelCierre(), opciones);
      else r = await cancelar(sesion, caso.id, datosDelCierre(), opciones);
      if (r.resultado === 'ya_hecho') {
        // El detail del servidor dice qué pasó (este teléfono antes, otra guardia o el backoffice).
        showToast({ type: 'info', message: r.detalle || r.mensaje });
      } else {
        const liberadas = textoDeLiberadas(r.liberadas);
        const hecho = cierre === 'cancelar' ? 'Ingreso cancelado: el caso volvió a la mesa.'
          : `Familia alojada${r.total_alojado != null ? ` · ${personas(r.total_alojado)}` : ''}.`;
        showToast({ type: 'success', message: [hecho, liberadas].filter(Boolean).join(' ') });
      }
      onCerrado?.({ cierre, ...r });
    } catch (e) {
      const c = e?.clasificacion || clasificarErrorLlegada(e);
      if (c.tipo === 'obsoleto') return;
      if (rutear(c)) return;
      if (!montado.current) {
        showToast({ type: 'warning', message: c.mensaje });
        return;
      }
      setIncierto(!!e?.incierto);
      if (c.tipo === 'sin_red') {
        setSinRed(true);
        showAlert('Sin conexión', TEXTO_SIN_RED, [{ text: 'Entendido' }]);
        return;
      }
      if (c.tipo === 'validacion') {
        setIntentado(true);
        setErroresServidor(c.errores || {});
        // `non_field_errors`: la acción no corresponde al contador (alguien confirmó o egresó mientras tanto).
        if (c.errores?.generales?.length) setFalla({ tipo: 'rechazo', mensaje: c.errores.generales.join('\n') });
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

  const tocar = () => {
    if (enviandoRef.current || esperando) return;
    setIntentado(true);
    if (Object.keys(validar()).length) return;
    // El reintento de un envío incierto manda lo mismo: no se vuelve a preguntar.
    if (incierto) {
      mandar();
      return;
    }
    showAlert(config.titulo, config.pregunta({ confirmadas, total }), [
      { text: 'Volver', style: 'cancel' },
      { text: config.confirmar, ...(config.destructiva ? { style: 'destructive' } : {}), onPress: mandar },
    ]);
  };

  if (!config) {
    return <View style={styles.centro}><Text style={[styles.texto, { color: theme.colors.text, fontFamily: typography.medium }]}>No hay nada para cerrar.</Text></View>;
  }
  if (errorSesion) {
    return <View style={styles.centro}><Text style={[styles.texto, { color: theme.colors.text, fontFamily: typography.medium }]}>{errorSesion}</Text></View>;
  }

  const tarjetaEstilo = [styles.card, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }];
  const etiqueta = [styles.etiqueta, { color: theme.colors.text, fontFamily: typography.semibold }];
  const ayuda = [styles.ayuda, { color: theme.colors.textMuted, fontFamily: typography.medium }];
  const avisoDe = (tono, contenido, icono) => (
    <View accessibilityRole="alert" style={[styles.aviso, { backgroundColor: statusTones[tono].bg, borderColor: statusTones[tono].bd }]}>
      {icono ? <Ionicons name={icono} size={18} color={statusTones[tono].tx} accessible={false} importantForAccessibility="no" /> : null}
      <Text style={[styles.flex, styles.texto, { color: statusTones[tono].tx, fontFamily: typography.semibold }]}>{contenido}</Text>
    </View>
  );
  const errores = { ...(intentado ? validar() : {}), ...erroresServidor };
  const mensajes = (campo) => (errores[campo] || []).map((mensaje, indice) => (
    <Text key={`${campo}:${indice}`} accessibilityLiveRegion="polite" style={[styles.error, { color: theme.colors.danger, fontFamily: typography.medium }]}>{mensaje}</Text>
  ));
  const fijo = enviando || incierto;
  const cambiar = (setter, campo) => (valor) => {
    if (fijo) return;
    setter(valor);
    if (erroresServidor[campo]) setErroresServidor((prev) => { const next = { ...prev }; delete next[campo]; return next; });
  };
  const caja = (campo, extra = []) => [styles.input, ...extra, { color: theme.colors.text, backgroundColor: theme.colors.surface,
    borderColor: errores[campo]?.length ? theme.colors.danger : theme.colors.border }];
  const chip = ({ clave, titulo, elegida, onPress, rotulo }) => (
    <Pressable key={clave} accessibilityRole="radio" accessibilityState={{ selected: elegida, checked: elegida, disabled: fijo }}
      accessibilityLabel={rotulo} disabled={fijo} onPress={onPress}
      style={[styles.opcion, { borderColor: elegida ? theme.colors.primary : theme.colors.border,
        backgroundColor: elegida ? `${theme.colors.primary}18` : theme.colors.surface }]}>
      <Text style={{ color: elegida ? theme.colors.primary : theme.colors.text, fontFamily: elegida ? typography.bold : typography.medium, fontSize: fontSizes.sm }}>{titulo}</Text>
    </Pressable>
  );

  const segundos = Math.max(1, Math.ceil((esperaHasta - ahora) / 1000));
  let tituloBoton = incierto ? `Reintentar: ${config.boton.toLowerCase()}` : config.boton;
  if (esperando) tituloBoton = `Reintentar en ${segundos} s`;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.background }} contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode={keyboardDismissModeFor(Platform.OS === 'ios' ? 'interactive' : 'on-drag')}>
      {sinRed ? avisoDe('warning', TEXTO_SIN_RED, 'cloud-offline-outline') : null}

      <View style={tarjetaEstilo}>
        <Text accessibilityRole="header" style={[styles.titulo, { color: theme.colors.text, fontFamily: typography.bold }]}>{`${config.titulo} · Caso ${caso?.numero || ''}`.trim()}</Text>
        <Text style={[styles.texto, { color: theme.colors.text, fontFamily: typography.medium }]}>{config.resumen({ confirmadas, total })}</Text>
      </View>

      {cierre === 'alojar' ? (
        <View style={tarjetaEstilo}>
          <Text accessibilityRole="header" style={[styles.titulo, { color: theme.colors.text, fontFamily: typography.bold }]}>Dónde queda la familia</Text>
          <Text style={etiqueta}>Sector (opcional)</Text>
          {cargandoSectores ? <ActivityIndicator color={theme.colors.primary} accessibilityLabel="Cargando los sectores" /> : null}
          {errorSectores ? <Text style={ayuda}>{errorSectores}</Text> : null}
          {sectores?.length ? (
            <View style={styles.opciones} accessibilityRole="radiogroup" accessibilityLabel="Sector">
              {sectores.map((s) => chip({
                clave: String(s.id), titulo: s.nombre, elegida: String(sector) === String(s.id), rotulo: `Sector: ${s.nombre}`,
                onPress: () => cambiar(setSector, 'sector')(String(sector) === String(s.id) ? null : s.id),
              }))}
            </View>
          ) : null}
          {sectores && !sectores.length ? <Text style={ayuda}>El dispositivo no tiene sectores con camas.</Text> : null}
          {mensajes('sector')}
          <Text style={[etiqueta, styles.separado]}>Aula o dormitorio (opcional)</Text>
          <TextInput value={aula} editable={!fijo} maxLength={MAX_AULA} accessibilityLabel="Aula o dormitorio"
            placeholderTextColor={theme.colors.textSoft} onChangeText={cambiar(setAula, 'aula')} style={caja('aula')} />
          {mensajes('aula')}
          <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: tarjeta, disabled: fijo }} accessibilityLabel="Se entregó la tarjeta familiar"
            disabled={fijo} onPress={() => cambiar(setTarjeta, 'tarjeta_numero')(!tarjeta)} style={styles.casilla}>
            <Ionicons name={tarjeta ? 'checkbox' : 'square-outline'} size={24} color={tarjeta ? theme.colors.primary : theme.colors.textSoft}
              accessible={false} importantForAccessibility="no" />
            <Text style={[styles.flex, etiqueta]}>Se entregó la tarjeta familiar</Text>
          </Pressable>
          {tarjeta ? (
            <>
              <Text style={etiqueta}>Número de tarjeta *</Text>
              <TextInput value={tarjetaNumero} editable={!fijo} maxLength={MAX_TARJETA} accessibilityLabel="Número de tarjeta"
                placeholderTextColor={theme.colors.textSoft} onChangeText={cambiar(setTarjetaNumero, 'tarjeta_numero')} style={caja('tarjeta_numero')} />
            </>
          ) : null}
          {mensajes('tarjeta_numero')}
          <Text style={[etiqueta, styles.separado]}>Quién recibe (opcional)</Text>
          <TextInput value={encargado} editable={!fijo} maxLength={MAX_ENCARGADO} accessibilityLabel="Quién recibe"
            placeholder="Vacío: vos" placeholderTextColor={theme.colors.textSoft} onChangeText={cambiar(setEncargado, 'encargado')} style={caja('encargado')} />
          {mensajes('encargado')}
        </View>
      ) : null}

      {cierre === 'diferencia' ? (
        <View style={tarjetaEstilo}>
          <Text style={etiqueta}>¿Por qué llegaron menos? *</Text>
          <View style={styles.opciones} accessibilityRole="radiogroup" accessibilityLabel="Motivo de la diferencia">
            {MOTIVOS_DIFERENCIA.map((opcion) => chip({
              clave: opcion.valor, titulo: opcion.titulo, elegida: motivo === opcion.valor, rotulo: `Motivo: ${opcion.titulo}`,
              onPress: () => cambiar(setMotivo, 'motivo')(opcion.valor),
            }))}
          </View>
          {mensajes('motivo')}
          <Text style={[etiqueta, styles.separado]}>{motivo === 'OTRO' ? 'Qué pasó *' : 'Observación (opcional)'}</Text>
          <TextInput value={observacion} editable={!fijo} multiline maxLength={MAX_OBSERVACION} accessibilityLabel="Observación de la diferencia"
            placeholder="Por ejemplo: no sabe su número de DNI" placeholderTextColor={theme.colors.textSoft}
            onChangeText={cambiar(setObservacion, 'observacion')} style={caja('observacion', [styles.areaTexto])} />
          {mensajes('observacion')}
        </View>
      ) : null}

      {cierre === 'cancelar' ? (
        <View style={tarjetaEstilo}>
          <Text style={etiqueta}>¿Por qué se cancela? *</Text>
          <TextInput value={motivo} editable={!fijo} multiline maxLength={MAX_MOTIVO_CANCELAR} accessibilityLabel="Motivo de la cancelación"
            placeholder="Lo que la mesa tenga que saber" placeholderTextColor={theme.colors.textSoft}
            onChangeText={cambiar(setMotivo, 'motivo')} style={caja('motivo', [styles.areaTexto])} />
          <Text style={ayuda}>{`${String(motivo || '').length} de ${MAX_MOTIVO_CANCELAR}`}</Text>
          {mensajes('motivo')}
        </View>
      ) : null}

      {falla ? avisoDe(falla.tipo === 'reintentable' || falla.tipo === 'espera' ? 'warning' : 'danger', falla.mensaje) : null}
      {enviando ? <ActivityIndicator color={theme.colors.primary} accessibilityLabel={`Mandando: ${config.titulo.toLowerCase()}`} /> : null}

      <CustomButton title={tituloBoton} size="L" iconLeft={incierto ? 'refresh' : config.icono} loading={enviando}
        disabled={enviando || !sesion || esperando} onPress={tocar} />
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
  opciones: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  opcion: { borderWidth: 1, borderRadius: radii.full, paddingHorizontal: 14, paddingVertical: 10, minHeight: 44, justifyContent: 'center' },
  casilla: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44 },
  input: { minHeight: 46, borderWidth: 1, borderRadius: radii.lg, paddingHorizontal: 12, paddingVertical: 10, fontSize: fontSizes.sm },
  areaTexto: { minHeight: 96, textAlignVertical: 'top' },
  aviso: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: radii.lg, padding: 10 },
});
