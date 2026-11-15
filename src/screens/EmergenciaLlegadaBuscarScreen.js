import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, ActivityIndicator, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import TextInput from '../components/FormInput';
import CustomButton from '../components/CustomButton';
import { useTheme } from '../context/ThemeContext';
import {
  TEXTO_SIN_RED, abrirSesion, buscar, clasificarErrorLlegada, escucharRed, hayConexion, pasoDeBusqueda,
} from '../services/emergenciaLlegadas';
import { cleanDigits } from '../utils/dni';
import { formatDate } from '../utils/dates';
import { statusTones } from '../theme/statusBadges';
import { keyboardDismissModeFor } from '../utils/teclado';
import { fontSizes, radii } from '../theme';

export const TITULO_BUSCAR = 'Buscar a la familia';
export const AYUDA_DNI = 'El DNI del responsable o de cualquier persona ya confirmada de la familia.';

// M2-1 · Buscar a la familia por DNI (§13.2) en un dispositivo. Con conexión: sin red se bloquea con
// aviso. El token y el usuario se fijan al abrir la pantalla (abrirSesion); una respuesta que llega
// con otra sesión, o después de salir, se descarta.
// - DERIVACION PENDIENTE → `onDerivacion(busqueda)` (M2-2); ACEPTADA → `onIntegrantes(caso, dni)`.
// - SIN_DERIVACION y ALOJADA se muestran acá. «Ingresar igual» y «Avisar a la mesa» (§13.10) son de
//   la próxima versión: `onProximamente(titulo)`.
// - 429: cuenta regresiva con Retry-After; 404 → `onNoEncontrado`; 403 SIN_MODULO → `onSinModulo(mensaje)`.
// `dniInicial` y `autoBuscar`: la recarga por `estado_actual` (§13.1) vuelve acá con el DNI, y con
// DERIVADO busca sola. `aviso`: el `detail` del 409 que trajo acá.
export default function EmergenciaLlegadaBuscarScreen({
  dispositivo, dniInicial = '', autoBuscar = false, aviso = null,
  onDerivacion, onIntegrantes, onNoEncontrado, onSinModulo, onProximamente,
}) {
  const { theme, typography } = useTheme();
  const [sesion, setSesion] = useState(null);
  const [errorSesion, setErrorSesion] = useState('');
  const [dni, setDni] = useState(cleanDigits(dniInicial));
  const [buscando, setBuscando] = useState(false);
  const [resultado, setResultado] = useState(null);
  const [errorDni, setErrorDni] = useState([]);
  const [falla, setFalla] = useState(null);
  const [sinRed, setSinRed] = useState(false);
  const [esperaHasta, setEsperaHasta] = useState(0);
  const [ahora, setAhora] = useState(Date.now());
  const montado = useRef(true);
  const buscandoRef = useRef(false);

  useEffect(() => {
    montado.current = true;
    (async () => {
      try {
        const abierta = await abrirSesion();
        if (!montado.current) return;
        setSesion(abierta);
        if (autoBuscar && dniInicial) ejecutar(abierta, cleanDigits(dniInicial));
      } catch (e) {
        if (montado.current) setErrorSesion(e?.message || 'No hay sesión iniciada.');
      }
    })();
    hayConexion().then((hay) => { if (montado.current) setSinRed(!hay); }).catch(() => {});
    const dejarDeEscuchar = escucharRed((hay) => { if (montado.current) setSinRed(!hay); });
    return () => {
      montado.current = false;
      dejarDeEscuchar();
    };
  }, [dispositivo?.id]);

  const esperando = esperaHasta > ahora;
  useEffect(() => {
    if (!esperando) return undefined;
    const timer = setInterval(() => setAhora(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [esperando]);

  const ejecutar = async (base, valor) => {
    if (buscandoRef.current || !base) return;
    buscandoRef.current = true;
    setBuscando(true);
    setFalla(null);
    setErrorDni([]);
    setResultado(null);
    try {
      const busqueda = await buscar(base, dispositivo.id, valor);
      if (!montado.current) return;
      const paso = pasoDeBusqueda(busqueda);
      if (paso === 'derivacion') {
        onDerivacion?.(busqueda);
        return;
      }
      if (paso === 'integrantes') {
        onIntegrantes?.(busqueda.derivacion.caso, busqueda.dni || valor);
        return;
      }
      setResultado(busqueda);
    } catch (e) {
      if (!montado.current) return;
      const c = e?.clasificacion || clasificarErrorLlegada(e, { campos: ['dni'] });
      if (c.tipo === 'obsoleto') return;
      if (c.tipo === 'no_encontrado') {
        onNoEncontrado?.();
        return;
      }
      if (c.tipo === 'sin_modulo') {
        onSinModulo?.(c.mensaje);
        return;
      }
      if (c.tipo === 'sin_red') {
        setSinRed(true);
        return;
      }
      if (c.tipo === 'validacion') {
        setErrorDni(c.errores?.dni || []);
        if (c.errores?.generales?.length) setFalla({ tipo: 'rechazo', mensaje: c.errores.generales.join('\n') });
        return;
      }
      if (c.espera) {
        setAhora(Date.now());
        setEsperaHasta(Date.now() + c.espera);
      }
      setFalla(c);
    } finally {
      buscandoRef.current = false;
      if (montado.current) setBuscando(false);
    }
  };

  const tocarBuscar = async () => {
    if (buscandoRef.current || !sesion || esperando) return;
    if (!await hayConexion()) {
      if (montado.current) setSinRed(true);
      return;
    }
    if (montado.current) setSinRed(false);
    await ejecutar(sesion, dni);
  };

  const cambiarDni = (texto) => {
    setDni(cleanDigits(texto).slice(0, 8));
    setErrorDni([]);
    setResultado(null);
  };

  if (errorSesion) {
    return <View style={styles.centro}><Text style={[styles.texto, { color: theme.colors.text, fontFamily: typography.medium }]}>{errorSesion}</Text></View>;
  }

  // Texto de estado siempre sobre su propio fondo (statusTones): se lee igual en tema claro y oscuro.
  const avisoDe = (tono, texto, icono, clave) => (
    <View key={clave} accessibilityRole="alert" style={[styles.aviso, { backgroundColor: statusTones[tono].bg, borderColor: statusTones[tono].bd }]}>
      {icono ? <Ionicons name={icono} size={18} color={statusTones[tono].tx} accessible={false} importantForAccessibility="no" /> : null}
      <Text style={[styles.flex, styles.texto, { color: statusTones[tono].tx, fontFamily: typography.semibold }]}>{texto}</Text>
    </View>
  );
  const insignia = (tono, texto) => (
    <View style={[styles.insignia, { backgroundColor: statusTones[tono].bg, borderColor: statusTones[tono].bd }]}>
      <Text style={[styles.ayuda, { color: statusTones[tono].tx, fontFamily: typography.semibold }]}>{texto}</Text>
    </View>
  );
  const tarjeta = [styles.card, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }];
  const ayuda = [styles.ayuda, { color: theme.colors.textMuted, fontFamily: typography.medium }];

  const segundos = Math.max(1, Math.ceil((esperaHasta - ahora) / 1000));
  const tituloBoton = esperando ? `Buscar en ${segundos} s` : 'Buscar';
  const paso = resultado ? pasoDeBusqueda(resultado) : null;
  const camas = resultado?.plazas_libres ?? 0;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.background }} contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode={keyboardDismissModeFor(Platform.OS === 'ios' ? 'interactive' : 'on-drag')}>
      {sinRed ? avisoDe('warning', TEXTO_SIN_RED, 'cloud-offline-outline') : null}
      {aviso?.texto ? avisoDe(aviso.tono || 'info', aviso.texto, 'information-circle-outline') : null}

      <View style={tarjeta}>
        <Text accessibilityRole="header" style={[styles.titulo, { color: theme.colors.text, fontFamily: typography.bold }]}>{TITULO_BUSCAR}</Text>
        <Text style={ayuda}>{AYUDA_DNI}</Text>
        <TextInput value={dni} onChangeText={cambiarDni} keyboardType="number-pad" maxLength={8} accessibilityLabel="DNI"
          placeholder="Solo números" placeholderTextColor={theme.colors.textSoft} returnKeyType="search" onSubmitEditing={tocarBuscar}
          style={[styles.input, { color: theme.colors.text, backgroundColor: theme.colors.surface,
            borderColor: errorDni.length ? theme.colors.danger : theme.colors.border }]} />
        {errorDni.map((mensaje, indice) => (
          <Text key={`dni-${indice}`} accessibilityLiveRegion="polite" style={[styles.error, { color: theme.colors.danger, fontFamily: typography.medium }]}>{mensaje}</Text>
        ))}
        <CustomButton title={tituloBoton} size="L" iconLeft="search-outline" loading={buscando}
          disabled={!sesion || buscando || esperando || sinRed} onPress={tocarBuscar} />
      </View>

      {buscando ? <ActivityIndicator color={theme.colors.primary} accessibilityLabel="Buscando a la familia" /> : null}
      {falla ? avisoDe(falla.tipo === 'espera' || falla.tipo === 'reintentable' ? 'warning' : 'danger', falla.mensaje) : null}

      {paso === 'sin_derivacion' ? (
        <View style={tarjeta}>
          <Text accessibilityRole="header" style={[styles.titulo, { color: theme.colors.text, fontFamily: typography.bold }]}>Sin derivación</Text>
          {avisoDe('info', resultado.mensaje || 'No hay una derivación para este DNI en tu dispositivo.')}
          <Text style={ayuda}>{camas === 1 ? '1 cama libre en este dispositivo' : `${camas || 'Sin'} camas libres en este dispositivo`}</Text>
          {camas >= 1 ? (
            <CustomButton title="Ingresar igual" variant="secondary" iconLeft="enter-outline" onPress={() => onProximamente?.('Ingresar igual')} />
          ) : null}
          <CustomButton title="Avisar a la mesa" variant="secondary" iconLeft="megaphone-outline" onPress={() => onProximamente?.('Avisar a la mesa')} />
        </View>
      ) : null}

      {paso === 'alojada' ? (
        <View style={tarjeta}>
          <Text accessibilityRole="header" style={[styles.titulo, { color: theme.colors.text, fontFamily: typography.bold }]}>Ya está alojada</Text>
          {resultado.alojada_aca ? insignia('success', 'En este dispositivo') : null}
          {avisoDe('info', resultado.mensaje || 'La persona tiene una estadía abierta en la red.')}
          {resultado.alojada_en ? (
            <Text style={ayuda}>{`${resultado.alojada_en}${resultado.alojada_desde ? ` · desde el ${formatDate(resultado.alojada_desde, { includeTime: true })}` : ''}`}</Text>
          ) : null}
        </View>
      ) : null}

      {paso === 'desconocido' ? avisoDe('warning', resultado.mensaje || 'El servidor contestó algo que esta versión no entiende. Actualizá la app.') : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 40, gap: 12 },
  centro: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  card: { borderWidth: 1, borderRadius: radii.xl, padding: 14, gap: 8 },
  titulo: { fontSize: fontSizes.base },
  ayuda: { fontSize: fontSizes.xs },
  texto: { fontSize: fontSizes.sm },
  error: { fontSize: fontSizes.xs },
  flex: { flex: 1 },
  input: { minHeight: 46, borderWidth: 1, borderRadius: radii.lg, paddingHorizontal: 12, paddingVertical: 10, fontSize: fontSizes.base },
  aviso: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: radii.lg, padding: 10 },
  insignia: { alignSelf: 'flex-start', borderWidth: 1, borderRadius: radii.full, paddingHorizontal: 10, paddingVertical: 3 },
});
