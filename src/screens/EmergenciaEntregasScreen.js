import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable, ActivityIndicator, RefreshControl, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../context/ThemeContext';
import CustomButton from '../components/CustomButton';
import { getEntregasDispositivo } from '../services/emergenciaApi';
import { estadoDeEntrega, normalizarEntregas, recepcionesAbiertas, resumenDeItems } from '../services/emergenciaKits';
import { esSinModulo } from '../services/sinModulo';
import { formatDate } from '../utils/dates';
import { statusTones } from '../theme/statusBadges';
import { fontSizes, radii } from '../theme';

export const SIN_ENTREGAS = 'No hay entregas por recibir en este dispositivo.';
export const ERROR_SIN_RED = 'Sin conexión: no se pudo traer las entregas. La recepción de kits necesita señal.';
export const TEXTO_EN_CURSO = 'Recepción sin terminar';

// M3-1 · Entregas por recibir de un dispositivo (§10 con `?pendientes=1`: EN_CAMINO y PREPARADA, de
// la más vieja a la más nueva). `onAbrir(entrega)` abre la recepción. Un 404 (el dispositivo dejó de
// ser del usuario) llama a `onNoEncontrado`; un 403 SIN_MODULO, a `onSinModulo(mensaje)`.
// `recarga` cambia cuando hay que volver a pedir la lista (botón de sincronizar del Banner).
export default function EmergenciaEntregasScreen({ dispositivo, onAbrir, onNoEncontrado, onSinModulo, recarga = 0 }) {
  const { theme, typography } = useTheme();
  const [entregas, setEntregas] = useState(null);
  const [abiertas, setAbiertas] = useState([]);
  const [avisos, setAvisos] = useState([]);
  const [error, setError] = useState('');
  const [cargando, setCargando] = useState(true);
  const [refrescando, setRefrescando] = useState(false);
  const montado = useRef(true);
  // El valor con el que se montó no pide nada: solo un cambio posterior.
  const recargaInicial = useRef(recarga);
  const dispositivoId = dispositivo?.id;

  const cargar = useCallback(async ({ silencioso = false } = {}) => {
    if (silencioso) setRefrescando(true);
    try {
      const lista = normalizarEntregas(await getEntregasDispositivo(dispositivoId, { pendientes: true }));
      const enCurso = await recepcionesAbiertas(dispositivoId, lista.map((item) => item.id)).catch(() => null);
      if (!montado.current) return;
      setEntregas(lista);
      setAbiertas(enCurso?.abiertas || []);
      // Un aviso de una recepción incierta que se resolvió se muestra hasta salir de la pantalla.
      if (enCurso?.avisos?.length) setAvisos((prev) => [...prev, ...enCurso.avisos]);
      setError('');
    } catch (e) {
      if (!montado.current) return;
      if (Number(e?.status) === 404 && !e?.unexpectedHtml) {
        onNoEncontrado?.();
        return;
      }
      if (esSinModulo(e)) {
        onSinModulo?.(e?.payload?.detail || 'Tu usuario no recibe kits en ningún dispositivo.');
        return;
      }
      setError(e?.network ? ERROR_SIN_RED : (e?.message || 'No se pudo traer las entregas.'));
    } finally {
      if (montado.current) {
        setCargando(false);
        setRefrescando(false);
      }
    }
  }, [dispositivoId, onNoEncontrado, onSinModulo]);

  useEffect(() => {
    montado.current = true;
    cargar();
    return () => { montado.current = false; };
  }, [dispositivoId]);
  useEffect(() => { if (recarga !== recargaInicial.current) cargar({ silencioso: true }); }, [recarga]);

  const insignia = (titulo, tono) => (
    <View style={[styles.insignia, { backgroundColor: statusTones[tono].bg, borderColor: statusTones[tono].bd }]}>
      <Text style={[styles.insigniaTexto, { color: statusTones[tono].tx, fontFamily: typography.bold }]}>{titulo}</Text>
    </View>
  );

  const tarjeta = (entrega) => {
    const estado = estadoDeEntrega(entrega.estado);
    const salida = entrega.despachada_en
      ? `Despachada el ${formatDate(entrega.despachada_en, { includeTime: true })}`
      : 'Sin marca de salida';
    const enCurso = abiertas.includes(String(entrega.id));
    const resumen = resumenDeItems(entrega);
    return (
      <Pressable key={String(entrega.id)} accessibilityRole="button"
        accessibilityLabel={`Entrega ${entrega.numero}, ${estado.titulo}. ${salida}. ${resumen}${enCurso ? `. ${TEXTO_EN_CURSO}` : ''}`}
        onPress={() => onAbrir?.(entrega)}
        style={({ pressed }) => [styles.card, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }, pressed && styles.presionada]}>
        <View style={styles.cabecera}>
          <Text style={[styles.flex, styles.numero, { color: theme.colors.text, fontFamily: typography.bold }]}>{`Entrega ${entrega.numero}`}</Text>
          {insignia(estado.titulo, estado.tono)}
        </View>
        <Text style={[styles.texto, { color: theme.colors.textMuted, fontFamily: typography.medium }]}>{salida}</Text>
        <Text style={[styles.texto, { color: theme.colors.text, fontFamily: typography.semibold }]}>{resumen}</Text>
        {entrega.observacion_mesa ? (
          <Text style={[styles.texto, { color: theme.colors.textMuted, fontFamily: typography.medium }]}>{`Mesa: ${entrega.observacion_mesa}`}</Text>
        ) : null}
        <View style={styles.pie}>
          {enCurso ? insignia(TEXTO_EN_CURSO, 'warning') : <View />}
          <Ionicons name="chevron-forward" size={20} color={theme.colors.textSoft} accessible={false} importantForAccessibility="no" />
        </View>
      </Pressable>
    );
  };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.background }} contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refrescando} onRefresh={() => cargar({ silencioso: true })}
        colors={[theme.colors.primary]} tintColor={theme.colors.primary} />}>
      <Text accessibilityRole="header" style={[styles.titulo, { color: theme.colors.text, fontFamily: typography.bold }]}>Entregas por recibir</Text>
      {refrescando && Platform.OS === 'web' ? <ActivityIndicator color={theme.colors.primary} accessibilityLabel="Actualizando las entregas" /> : null}
      {cargando ? <ActivityIndicator size="large" color={theme.colors.primary} accessibilityLabel="Cargando las entregas" /> : null}
      {error ? (
        <View accessibilityRole="alert" style={[styles.aviso, { backgroundColor: statusTones.danger.bg, borderColor: statusTones.danger.bd }]}>
          <Text style={[styles.texto, { color: statusTones.danger.tx, fontFamily: typography.semibold }]}>{error}</Text>
        </View>
      ) : null}
      {error ? <CustomButton title="Reintentar" variant="secondary" iconLeft="refresh" onPress={() => cargar({ silencioso: true })} /> : null}
      {avisos.map((texto, indice) => (
        <View key={`aviso-${indice}`} accessibilityRole="alert" style={[styles.aviso, { backgroundColor: statusTones.info.bg, borderColor: statusTones.info.bd }]}>
          <Text style={[styles.texto, { color: statusTones.info.tx, fontFamily: typography.semibold }]}>{texto}</Text>
        </View>
      ))}
      {(entregas || []).map(tarjeta)}
      {entregas && !entregas.length ? (
        <View style={styles.centro}>
          <Ionicons name="cube-outline" size={30} color={theme.colors.textSoft} accessible={false} importantForAccessibility="no" />
          <Text style={[styles.texto, styles.centrado, { color: theme.colors.textSoft, fontFamily: typography.medium }]}>{SIN_ENTREGAS}</Text>
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 32, gap: 10 },
  titulo: { fontSize: fontSizes.lg },
  card: { borderWidth: 1, borderRadius: radii.xl, padding: 14, gap: 6 },
  presionada: { opacity: 0.7, transform: [{ scale: 0.98 }] },
  cabecera: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  pie: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  numero: { fontSize: fontSizes.base },
  texto: { fontSize: fontSizes.sm },
  flex: { flex: 1 },
  insignia: { borderWidth: 1, borderRadius: radii.full, paddingHorizontal: 10, paddingVertical: 3 },
  insigniaTexto: { fontSize: fontSizes.xs },
  aviso: { borderWidth: 1, borderRadius: radii.lg, padding: 10 },
  centro: { alignItems: 'center', gap: 8, paddingVertical: 32 },
  centrado: { textAlign: 'center' },
});
