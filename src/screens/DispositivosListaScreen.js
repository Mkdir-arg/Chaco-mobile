import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable, ActivityIndicator, RefreshControl } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import NetInfo from '@react-native-community/netinfo';
import { useTheme } from '../context/ThemeContext';
import { statusTones } from '../theme/statusBadges';
import { getInspecciones } from '../services/dispositivosService';
import { direccionDe, seccionesDeLista, describirEnvio, ETIQUETA_ENVIO } from '../utils/dispositivos';
import { formatDate } from '../utils/dates';
import { fontSizes, radii } from '../theme';

const TONO_ENVIO = { pendiente: 'warning', en_cola: 'info', error: 'danger', enviado: 'success' };

// `syncTick` cambia cuando termina una sincronización: se relee lo local sin ir a la red.
export default function DispositivosListaScreen({ onAbrir, syncTick = 0 }) {
  const { theme, typography } = useTheme();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [sinRed, setSinRed] = useState(false);

  const cargar = useCallback(async ({ remoto = true, silencioso = false } = {}) => {
    if (silencioso) setRefreshing(true);
    try {
      const red = await NetInfo.fetch();
      setSinRed(!(red?.isConnected && red?.isInternetReachable !== false));
    } catch {
      setSinRed(true);
    }
    try {
      setItems(await getInspecciones({ refreshFromRemote: remoto }));
      setError('');
    } catch (e) {
      setError(e?.message || 'No se pudo cargar la lista.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { cargar(); }, [cargar]);
  useEffect(() => { if (syncTick) cargar({ remoto: false }); }, [syncTick, cargar]);

  const { pendientes, vencidos, enviados } = useMemo(() => seccionesDeLista(items), [items]);

  const tarjeta = (item, { vencido = false } = {}) => {
    const envio = item.envio;
    const motivo = envio?.estado === 'error' ? describirEnvio(envio) : null;
    const tono = statusTones[envio ? TONO_ENVIO[envio.estado] || 'gray' : (vencido ? 'danger' : 'gray')];
    const direccion = direccionDe(item.edificio || {});
    return (
      <Pressable key={item.id} accessibilityRole="button"
        accessibilityLabel={`Abrir relevamiento de ${item.edificio?.nombre || item.id}`}
        onPress={() => onAbrir && onAbrir(item.id)}
        style={[styles.card, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}>
        <View style={styles.cardTop}>
          <View style={styles.cardTitleBox}>
            <Text style={[styles.cardTitle, { color: theme.colors.text, fontFamily: typography.bold }]} numberOfLines={2}>
              {item.edificio?.nombre || `Relevamiento ${item.id}`}
            </Text>
            {item.edificio?.codigo ? (
              <Text style={[styles.meta, { color: theme.colors.textSoft, fontFamily: typography.medium }]}>{item.edificio.codigo}</Text>
            ) : null}
          </View>
          <View style={[styles.badge, { backgroundColor: tono.bg, borderColor: tono.bd }]}>
            <Text style={[styles.badgeText, { color: tono.tx, fontFamily: typography.bold }]}>
              {envio ? ETIQUETA_ENVIO[envio.estado] || envio.estado : (vencido ? 'Vencido' : 'Pendiente')}
            </Text>
          </View>
        </View>
        {direccion ? <Text style={[styles.meta, { color: theme.colors.textMuted, fontFamily: typography.medium }]} numberOfLines={2}>{direccion}</Text> : null}
        {item.fecha_vencimiento ? (
          <Text style={[styles.meta, { color: vencido ? statusTones.danger.tx : theme.colors.textMuted, fontFamily: typography.semibold }]}>
            {`Vence: ${formatDate(item.fecha_vencimiento)}`}
          </Text>
        ) : null}
        {motivo ? (
          <Text accessibilityRole="alert" style={[styles.meta, { color: statusTones.danger.tx, fontFamily: typography.semibold }]}>
            {motivo.titulo}
          </Text>
        ) : null}
      </Pressable>
    );
  };

  const seccion = (titulo, lista, opciones) => lista.length ? (
    <View key={titulo} style={styles.section}>
      <Text style={[styles.sectionTitle, { color: theme.colors.text, fontFamily: typography.bold }]}>{titulo}</Text>
      {lista.map((item) => tarjeta(item, opciones))}
    </View>
  ) : null;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.background }} contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => cargar({ silencioso: true })}
        colors={[theme.colors.primary]} tintColor={theme.colors.primary} />}>
      <Text style={[styles.title, { color: theme.colors.text, fontFamily: typography.bold }]}>Mis relevamientos</Text>

      {sinRed ? (
        <View style={[styles.aviso, { backgroundColor: statusTones.warning.bg, borderColor: statusTones.warning.bd }]}>
          <Ionicons name="cloud-offline-outline" size={18} color={statusTones.warning.tx} />
          <Text style={[styles.avisoText, { color: statusTones.warning.tx, fontFamily: typography.semibold }]}>
            Sin conexión: se muestra lo último que se descargó.
          </Text>
        </View>
      ) : null}

      {!!error ? (
        <View style={[styles.aviso, { backgroundColor: statusTones.danger.bg, borderColor: statusTones.danger.bd }]}>
          <Ionicons name="alert-circle-outline" size={18} color={statusTones.danger.tx} />
          <Text style={[styles.avisoText, { color: statusTones.danger.tx, fontFamily: typography.semibold }]}>{error}</Text>
        </View>
      ) : null}

      {loading ? (
        <View style={styles.centro}><ActivityIndicator size="large" color={theme.colors.primary} /></View>
      ) : (
        <>
          {seccion('Pendientes', pendientes)}
          {seccion('Vencidos', vencidos, { vencido: true })}
          {seccion('Enviados / en cola', enviados)}
          {!items.length && !error ? (
            <View style={styles.centro}>
              <Ionicons name="file-tray-outline" size={30} color={theme.colors.textSoft} />
              <Text style={[styles.meta, { color: theme.colors.textSoft, fontFamily: typography.medium }]}>
                No tenés relevamientos asignados.
              </Text>
            </View>
          ) : null}
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 32 },
  title: { fontSize: fontSizes.xl, marginBottom: 12 },
  section: { marginBottom: 16 },
  sectionTitle: { fontSize: fontSizes.base, marginBottom: 8 },
  card: { borderWidth: 1, borderRadius: radii.xl, padding: 14, marginBottom: 10, gap: 4 },
  cardTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 },
  cardTitleBox: { flex: 1 },
  cardTitle: { fontSize: fontSizes.base },
  meta: { fontSize: fontSizes.xs },
  badge: { borderWidth: 1, borderRadius: radii.full, paddingHorizontal: 10, paddingVertical: 4 },
  badgeText: { fontSize: fontSizes.xxs },
  aviso: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: radii.lg, padding: 10, marginBottom: 12 },
  avisoText: { flex: 1, fontSize: fontSizes.xs },
  centro: { alignItems: 'center', gap: 8, paddingVertical: 32 },
});
