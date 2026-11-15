import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable, ActivityIndicator, RefreshControl, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../context/ThemeContext';
import CustomButton from '../components/CustomButton';
import { getMisDispositivos } from '../services/emergenciaApi';
import { dispositivosConKits } from '../services/emergenciaKits';
import { dispositivosQueAdmiten } from '../services/emergenciaLlegadas';
import { esSinModulo } from '../services/sinModulo';
import { statusTones } from '../theme/statusBadges';
import { fontSizes, radii } from '../theme';

export const SIN_DISPOSITIVOS = 'No recibís kits en ningún dispositivo. Pedí que te sumen al equipo de un dispositivo con un rol que reciba kits.';
export const ERROR_SIN_RED = 'Sin conexión: no se pudo traer tus dispositivos. La recepción de kits necesita señal.';
export const SIN_DISPOSITIVOS_LLEGADAS = 'No admitís familias en ningún dispositivo. Pedí que te sumen al equipo de un dispositivo con un rol que admita familias.';
export const ERROR_SIN_RED_LLEGADAS = 'Sin conexión: no se pudo traer tus dispositivos. La llegada de familias necesita señal.';

const plural = (n, uno, varios, ninguno) => (n === 1 ? `1 ${uno}` : `${n || ninguno} ${varios}`);

// Lo que cambia entre M3 (`modo="kits"`, por defecto) y M2 (`modo="llegadas"`): qué filas entran
// (§9, `recibe_kits` o `admite`), el detalle de cada una y los textos.
const MODOS = {
  kits: {
    filtrar: dispositivosConKits,
    detalle: (d) => plural(d.entregas_pendientes, 'entrega por recibir', 'entregas por recibir', 'Sin'),
    destacado: (d) => d.entregas_pendientes > 0,
    vacio: SIN_DISPOSITIVOS,
    sinRed: ERROR_SIN_RED,
    sinModulo: SIN_DISPOSITIVOS,
  },
  llegadas: {
    filtrar: dispositivosQueAdmiten,
    // El aviso de derivaciones nuevas es este contador (no hay notificaciones).
    detalle: (d) => `${plural(d.derivaciones_pendientes, 'derivación por aceptar', 'derivaciones por aceptar', 'Sin')} · ${plural(d.plazas_libres, 'cama libre', 'camas libres', 'Sin')}`,
    destacado: (d) => d.derivaciones_pendientes > 0,
    vacio: SIN_DISPOSITIVOS_LLEGADAS,
    sinRed: ERROR_SIN_RED_LLEGADAS,
    sinModulo: SIN_DISPOSITIVOS_LLEGADAS,
  },
};

// M3-0 («Recepción de kits», `modo="kits"`) y M2-0 («Llegada de familias», `modo="llegadas"`): los
// dispositivos de «mis dispositivos» (§9) donde el usuario recibe kits o admite familias.
// Con uno solo se entra directo (`onElegir(dispositivo, { unico: true })`), salvo con
// `entrarDirecto={false}` (se volvió acá por un 404: entrar otra vez sería un bucle).
// `recarga` cambia cuando se pide volver a consultar (botón de sincronizar del Banner).
// `onSinModulo(mensaje)`: 403 SIN_MODULO.
export default function EmergenciaMisDispositivosScreen({ onElegir, onSinModulo, recarga = 0, entrarDirecto = true, modo = 'kits' }) {
  const config = MODOS[modo] || MODOS.kits;
  const { theme, typography } = useTheme();
  const [dispositivos, setDispositivos] = useState(null);
  const [error, setError] = useState('');
  const [cargando, setCargando] = useState(true);
  const [refrescando, setRefrescando] = useState(false);
  const montado = useRef(true);
  // El valor con el que se montó no pide nada: solo un cambio posterior.
  const recargaInicial = useRef(recarga);
  const entroDirecto = useRef(!entrarDirecto);

  const cargar = useCallback(async ({ silencioso = false } = {}) => {
    if (silencioso) setRefrescando(true);
    try {
      const lista = config.filtrar(await getMisDispositivos());
      if (!montado.current) return;
      setDispositivos(lista);
      setError('');
      if (lista.length === 1 && !entroDirecto.current) {
        entroDirecto.current = true;
        onElegir?.(lista[0], { unico: true });
      }
    } catch (e) {
      if (!montado.current) return;
      if (esSinModulo(e)) {
        onSinModulo?.(e?.payload?.detail || config.sinModulo);
        return;
      }
      setError(e?.network ? config.sinRed : (e?.message || 'No se pudo traer tus dispositivos.'));
    } finally {
      if (montado.current) {
        setCargando(false);
        setRefrescando(false);
      }
    }
  }, [onElegir, onSinModulo, config]);

  useEffect(() => {
    montado.current = true;
    cargar();
    return () => { montado.current = false; };
    // Solo al montarse: `onElegir` cambia en cada render del padre.
  }, []);
  useEffect(() => { if (recarga !== recargaInicial.current) cargar({ silencioso: true }); }, [recarga]);

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.background }} contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refrescando} onRefresh={() => cargar({ silencioso: true })}
        colors={[theme.colors.primary]} tintColor={theme.colors.primary} />}>
      <Text accessibilityRole="header" style={[styles.titulo, { color: theme.colors.text, fontFamily: typography.bold }]}>Elegí el dispositivo</Text>
      {refrescando && Platform.OS === 'web' ? <ActivityIndicator color={theme.colors.primary} accessibilityLabel="Actualizando tus dispositivos" /> : null}
      {cargando ? <ActivityIndicator size="large" color={theme.colors.primary} accessibilityLabel="Cargando tus dispositivos" /> : null}
      {error ? (
        <View accessibilityRole="alert" style={[styles.aviso, { backgroundColor: statusTones.danger.bg, borderColor: statusTones.danger.bd }]}>
          <Text style={[styles.texto, { color: statusTones.danger.tx, fontFamily: typography.semibold }]}>{error}</Text>
        </View>
      ) : null}
      {error && !dispositivos ? (
        <CustomButton title="Reintentar" variant="secondary" iconLeft="refresh" onPress={() => cargar({ silencioso: true })} />
      ) : null}
      {(dispositivos || []).map((dispositivo) => {
        const detalle = config.detalle(dispositivo);
        const destacado = config.destacado(dispositivo);
        return (
          <Pressable key={String(dispositivo.id)} accessibilityRole="button" accessibilityLabel={`${dispositivo.nombre}, ${detalle}`}
            onPress={() => onElegir?.(dispositivo, { unico: false })}
            style={({ pressed }) => [styles.card, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }, pressed && styles.presionada]}>
            <Ionicons name="business-outline" size={24} color={theme.colors.primary} accessible={false} importantForAccessibility="no" />
            <View style={styles.flex}>
              <Text style={[styles.nombre, { color: theme.colors.text, fontFamily: typography.bold }]}>{dispositivo.nombre}</Text>
              <Text style={[styles.texto, { color: destacado ? theme.colors.text : theme.colors.textMuted, fontFamily: typography.medium }]}>{detalle}</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color={theme.colors.textSoft} accessible={false} importantForAccessibility="no" />
          </Pressable>
        );
      })}
      {dispositivos && !dispositivos.length ? (
        <View style={styles.centro}>
          <Ionicons name="file-tray-outline" size={30} color={theme.colors.textSoft} accessible={false} importantForAccessibility="no" />
          <Text style={[styles.texto, styles.centrado, { color: theme.colors.textSoft, fontFamily: typography.medium }]}>{config.vacio}</Text>
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 32, gap: 10 },
  titulo: { fontSize: fontSizes.lg },
  card: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, borderRadius: radii.xl, padding: 16, minHeight: 64 },
  presionada: { opacity: 0.7, transform: [{ scale: 0.98 }] },
  nombre: { fontSize: fontSizes.base },
  texto: { fontSize: fontSizes.sm },
  flex: { flex: 1, gap: 2 },
  aviso: { borderWidth: 1, borderRadius: radii.lg, padding: 10 },
  centro: { alignItems: 'center', gap: 8, paddingVertical: 32 },
  centrado: { textAlign: 'center' },
});
