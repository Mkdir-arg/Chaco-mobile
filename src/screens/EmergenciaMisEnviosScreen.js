import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, ActivityIndicator, RefreshControl, Platform } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { useToast } from '../context/ToastContext';
import CustomButton from '../components/CustomButton';
import { descartar, getEnviosLocales, getMisEnvios, reintentar } from '../services/emergenciaCola';
import { ESTADOS_LOCALES, estadoDelCaso, listaDeErrores, textoDeCode } from '../utils/emergencia';
import { formatDate } from '../utils/dates';
import { statusTones } from '../theme/statusBadges';
import { fontSizes, radii } from '../theme';

export const AVISO_SIN_RED = 'Sin conexión: se muestra la última lista guardada.';
export const AVISO_DESACTUALIZADA = 'No se pudo actualizar: se muestra la última lista guardada.';

// «Mis envíos» de M1: lo que todavía está en el teléfono (en cola, con error o devuelto para
// corregir) y lo que ya recibió el servidor (§7). `syncTick` cambia cuando termina una
// sincronización de fondo: se relee lo local. `onNuevo` abre el Formulario 1.
export default function EmergenciaMisEnviosScreen({ syncTick = 0, onNuevo, onCorregir, onCambio }) {
  const { theme, typography } = useTheme();
  const { showToast, showAlert } = useToast();
  const [locales, setLocales] = useState([]);
  const [recibidos, setRecibidos] = useState(null);
  const [cargando, setCargando] = useState(true);
  const [refrescando, setRefrescando] = useState(false);
  const [ocupado, setOcupado] = useState(null);
  const montado = useRef(true);

  const leerLocales = useCallback(async () => {
    try {
      const lista = await getEnviosLocales();
      if (montado.current) setLocales(lista);
    } catch {
      // Sin base legible se deja lo anterior.
    }
  }, []);

  const cargar = useCallback(async ({ silencioso = false } = {}) => {
    if (silencioso) setRefrescando(true);
    await leerLocales();
    try {
      const res = await getMisEnvios();
      if (montado.current) setRecibidos(res);
    } catch (e) {
      if (montado.current) setRecibidos((prev) => prev || { casos: [], error: e });
    } finally {
      if (montado.current) {
        setCargando(false);
        setRefrescando(false);
      }
    }
  }, [leerLocales]);

  useEffect(() => {
    montado.current = true;
    cargar();
    return () => { montado.current = false; };
  }, [cargar]);
  useEffect(() => { if (syncTick) leerLocales(); }, [syncTick, leerLocales]);

  const reintentarUno = async (item) => {
    setOcupado(item.uuid_cliente);
    try {
      const res = await reintentar(item.uuid_cliente);
      if (res?.offline) showToast({ type: 'warning', message: 'Sin conexión. Se envía solo cuando vuelva.' });
      else if (res?.synced > 0) showToast({ type: 'success', message: 'Familia enviada.' });
      else if (res?.failed > 0) showToast({ type: 'warning', message: 'No se pudo enviar. Mirá el detalle.' });
      await cargar();
    } catch (e) {
      showToast({ type: 'error', message: e?.message || 'No se pudo reintentar.' });
    } finally {
      if (montado.current) setOcupado(null);
      onCambio?.();
    }
  };

  const confirmarDescarte = (item) => showAlert('Descartar envío',
    `Se borra del teléfono lo cargado de «${item.resumen}», con sus fotos. No se puede deshacer.`, [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Descartar',
        style: 'destructive',
        onPress: async () => {
          try {
            await descartar(item.uuid_cliente);
          } catch (e) {
            showToast({ type: 'error', message: e?.message || 'No se pudo descartar.' });
          }
          await leerLocales();
          onCambio?.();
        },
      },
    ]);

  const insignia = (titulo, tono) => (
    <View style={[styles.insignia, { backgroundColor: statusTones[tono].bg, borderColor: statusTones[tono].bd }]}>
      <Text style={[styles.insigniaTexto, { color: statusTones[tono].tx, fontFamily: typography.bold }]}>{titulo}</Text>
    </View>
  );

  const tarjetaLocal = (item) => {
    const estado = ESTADOS_LOCALES[item.estado] || ESTADOS_LOCALES.pendiente;
    const errores = item.estado === 'corregir' ? listaDeErrores(item.errores) : [];
    const motivo = item.estado === 'error' ? textoDeCode(item.code, item.detail) : null;
    const espera = item.estado === 'pendiente' && item.code === 'RATE_LIMITED' ? textoDeCode('RATE_LIMITED') : null;
    return (
      <View key={item.uuid_cliente} style={[styles.card, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}>
        <View style={styles.cabecera}>
          <Text style={[styles.flex, styles.titulo, { color: theme.colors.text, fontFamily: typography.bold }]}>{item.resumen}</Text>
          {insignia(estado.titulo, estado.tono)}
        </View>
        <Text style={[styles.texto, { color: theme.colors.textMuted, fontFamily: typography.medium }]}>
          {`Cargado el ${formatDate(item.creado_en, { includeTime: true })}`}
        </Text>
        {motivo ? <Text style={[styles.texto, { color: statusTones.danger.tx, fontFamily: typography.medium }]}>{motivo}</Text> : null}
        {espera ? <Text style={[styles.texto, { color: theme.colors.textMuted, fontFamily: typography.medium }]}>{espera}</Text> : null}
        {item.estado === 'corregir' ? (
          <Text style={[styles.texto, { color: statusTones.danger.tx, fontFamily: typography.semibold }]}>
            {item.code === 'ARCHIVO_LOCAL_FALTANTE' ? textoDeCode('ARCHIVO_LOCAL_FALTANTE') : textoDeCode('VALIDACION')}
          </Text>
        ) : null}
        {errores.map(({ campo, etiqueta, texto }) => (
          <Text key={`${campo}:${texto}`} style={[styles.texto, { color: statusTones.danger.tx, fontFamily: typography.medium }]}>{`• ${etiqueta}: ${texto}`}</Text>
        ))}
        <View style={styles.acciones}>
          {item.estado === 'corregir' ? (
            <CustomButton title="Corregir" size="SM" iconLeft="create-outline" onPress={() => onCorregir && onCorregir(item.uuid_cliente)} />
          ) : null}
          {item.puedeReintentar ? (
            <CustomButton title="Reintentar" size="SM" variant="secondary" iconLeft="refresh" loading={ocupado === item.uuid_cliente}
              disabled={!!ocupado} onPress={() => reintentarUno(item)} />
          ) : null}
          {item.puedeDescartar ? (
            <CustomButton title="Descartar" size="SM" variant="tertiary" iconLeft="trash-outline" disabled={!!ocupado}
              onPress={() => confirmarDescarte(item)} />
          ) : null}
        </View>
      </View>
    );
  };

  const tarjetaRecibido = (caso) => {
    const { titulo, tono } = estadoDelCaso(caso.estado);
    return (
      <View key={caso.numero} style={[styles.card, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}>
        <View style={styles.cabecera}>
          <Text style={[styles.flex, styles.titulo, { color: theme.colors.text, fontFamily: typography.bold }]}>{`Caso ${caso.numero}`}</Text>
          {insignia(titulo, tono)}
        </View>
        <Text style={[styles.texto, { color: theme.colors.textMuted, fontFamily: typography.medium }]}>
          {`${caso.total_declarado ?? 0} persona${caso.total_declarado === 1 ? '' : 's'} · recibido el ${formatDate(caso.creado_en, { includeTime: true })}`}
        </Text>
      </View>
    );
  };

  const aviso = recibidos?.desdeCache ? (recibidos.sinRed ? AVISO_SIN_RED : AVISO_DESACTUALIZADA) : null;
  const casos = recibidos?.casos || [];

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.background }} contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refrescando} onRefresh={() => cargar({ silencioso: true })}
        colors={[theme.colors.primary]} tintColor={theme.colors.primary} />}>
      {onNuevo ? <CustomButton title="Relevar una familia" size="L" iconLeft="add-circle-outline" onPress={onNuevo} /> : null}
      <Text accessibilityRole="header" style={[styles.seccion, { color: theme.colors.text, fontFamily: typography.bold }]}>En el teléfono</Text>
      {locales.length ? locales.map(tarjetaLocal) : (
        <Text style={[styles.texto, { color: theme.colors.textSoft, fontFamily: typography.medium }]}>No hay envíos pendientes.</Text>
      )}

      <Text accessibilityRole="header" style={[styles.seccion, { color: theme.colors.text, fontFamily: typography.bold }]}>Recibidos</Text>
      {aviso ? (
        <View style={[styles.aviso, { backgroundColor: statusTones.warning.bg, borderColor: statusTones.warning.bd }]}>
          <Text style={[styles.texto, { color: statusTones.warning.tx, fontFamily: typography.semibold }]}>{aviso}</Text>
        </View>
      ) : null}
      {refrescando && Platform.OS === 'web' ? <ActivityIndicator color={theme.colors.primary} accessibilityLabel="Actualizando" /> : null}
      {cargando ? <ActivityIndicator color={theme.colors.primary} accessibilityLabel="Cargando tus envíos" /> : null}
      {!cargando && recibidos?.error && !recibidos?.desdeCache ? (
        <Text style={[styles.texto, { color: statusTones.danger.tx, fontFamily: typography.medium }]}>
          {recibidos.error?.network ? 'Sin conexión: no se pudo traer la lista.' : (recibidos.error?.message || 'No se pudo traer la lista.')}
        </Text>
      ) : null}
      {!cargando && !casos.length && !recibidos?.error ? (
        <Text style={[styles.texto, { color: theme.colors.textSoft, fontFamily: typography.medium }]}>Todavía no hay familias recibidas.</Text>
      ) : null}
      {casos.map(tarjetaRecibido)}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 32, gap: 10 },
  seccion: { fontSize: fontSizes.lg, marginTop: 6 },
  card: { borderWidth: 1, borderRadius: radii.xl, padding: 14, gap: 6 },
  cabecera: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  titulo: { fontSize: fontSizes.base },
  texto: { fontSize: fontSizes.sm },
  flex: { flex: 1 },
  insignia: { borderWidth: 1, borderRadius: radii.full, paddingHorizontal: 10, paddingVertical: 3 },
  insigniaTexto: { fontSize: fontSizes.xs },
  aviso: { borderWidth: 1, borderRadius: radii.lg, padding: 10 },
  acciones: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
});
