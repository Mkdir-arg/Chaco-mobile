import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable, ActivityIndicator, RefreshControl, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import CustomButton from '../components/CustomButton';
import { useTheme } from '../context/ThemeContext';
import { useToast } from '../context/ToastContext';
import {
  TEXTO_SIN_RED, abrirSesion, agregarPersona, cargarIntegrantes, cierreDisponible, clasificarErrorLlegada, escucharRed,
  agregarPendiente, esSoloLectura, olvidarAgregarPendiente, estadoDeIntegrante, hayConexion, textoDeCrecimiento, textoDelContador,
} from '../services/emergenciaLlegadas';
import { statusTones } from '../theme/statusBadges';
import { fontSizes, radii } from '../theme';

export const TEXTO_ALOJADA = 'Familia alojada: se muestra en modo lectura.';
export const TEXTO_FICHA_INCOMPLETA = 'Ficha incompleta';
const CIERRES = {
  alojar: { titulo: 'Familia alojada', icono: 'home-outline' },
  diferencia: { titulo: 'Cerrar con diferencia', icono: 'git-compare-outline' },
  cancelar: { titulo: 'Cancelar ingreso', icono: 'close-circle-outline' },
};

// M2-3 · Integrantes de la familia (§13.5): el contador «1 de 7 confirmadas», una fila por persona y
// «Agregar persona». Con la familia alojada o el caso cerrado, modo lectura. Con conexión: sin red no
// se carga nada (no hay lectura guardada) y se avisa; al volver la red se carga sola.
// Tocar una persona abre su ficha (`onAbrirPersona(integrante, caso)`): sin confirmar, para confirmarla
// con su cama (solo con el ingreso en curso); confirmada, para ver y completar las secciones 4 a 8
// (también con la familia alojada; con el caso cerrado, en lectura). El cierre que corresponde al
// contador (§13.9) abre su pantalla: `onCerrar(cierre, datos)`, con `cierre` 'alojar', 'diferencia' o
// 'cancelar' y `datos` lo último cargado (caso, contador, integrantes y `derivacion_id`, la derivación
// vigente que el cierre manda: Cambio 477).
// - `onConflicto(clasificacion)`: 409 de estado → el padre recarga por `estado_actual` (§13.1).
// - `onNoEncontrado()`: 404. `onSinModulo(mensaje)`: 403. `onEnviando(bool)`: «Agregar persona» en curso.
// `recarga` cambia cuando se pide volver a consultar (botón de sincronizar del Banner).
export default function EmergenciaIntegrantesScreen({
  caso: casoInicial, recarga = 0, onConflicto, onNoEncontrado, onSinModulo, onCerrar, onEnviando, onAbrirPersona,
}) {
  const { theme, typography } = useTheme();
  const { showAlert, showToast } = useToast();
  const [sesion, setSesion] = useState(null);
  const [datos, setDatos] = useState(null);
  const [error, setError] = useState(null);
  const [cargando, setCargando] = useState(true);
  const [refrescando, setRefrescando] = useState(false);
  const [sinRed, setSinRed] = useState(false);
  const [agregando, setAgregando] = useState(false);
  const [falla, setFalla] = useState(null);
  const [reintentoAgregar, setReintentoAgregar] = useState(false);
  const montado = useRef(true);
  const sesionRef = useRef(null);
  const datosRef = useRef(null);
  datosRef.current = datos;
  const pedido = useRef(0);
  const recargaInicial = useRef(recarga);
  const agregandoRef = useRef(false);
  const casoId = casoInicial?.id;

  const cargar = async ({ silencioso = false } = {}) => {
    const base = sesionRef.current;
    if (!base) return;
    const numero = ++pedido.current;
    if (silencioso) setRefrescando(true);
    try {
      const respuesta = await cargarIntegrantes(base, casoId);
      if (!montado.current || numero !== pedido.current) return;
      // Alojada o cerrada ya no admite altas: un «Agregar persona» pendiente de este caso se olvida.
      if (esSoloLectura(respuesta.caso)) {
        olvidarAgregarPendiente(base, casoId).catch(() => {});
        setReintentoAgregar(false);
      }
      setDatos(respuesta);
      setError(null);
      setSinRed(false);
    } catch (e) {
      if (!montado.current || numero !== pedido.current) return;
      const c = e?.clasificacion || clasificarErrorLlegada(e);
      if (c.tipo === 'obsoleto') return;
      if (c.tipo === 'conflicto') {
        // El GET de integrantes solo abre con el ingreso aceptado (§13.5). Un 409 acá con un estado que
        // el router manda a integrantes (CERRADO o ALOJADO sin ingreso aceptado, p. ej. la mesa cerró el
        // caso después de un rechazo) volvería a montar esta misma pantalla sin fin: se busca de nuevo.
        onConflicto?.(c.destino === 'integrantes' ? { ...c, destino: 'buscar' } : c);
        return;
      }
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
      setError(c);
    } finally {
      if (montado.current && numero === pedido.current) {
        setCargando(false);
        setRefrescando(false);
      }
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
        // Un «Agregar persona» que quedó sin resultado (otra entrada, la app cerrada): se ofrece reintentarlo.
        agregarPendiente(abierta, casoId).then((uuid) => { if (montado.current && uuid) setReintentoAgregar(true); }).catch(() => {});
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
      // Volvió la red y no había nada cargado: se carga sola.
      if (hay && !datosRef.current) cargar();
    });
    return () => {
      montado.current = false;
      dejarDeEscuchar();
    };
  }, [casoId]);
  useEffect(() => { if (recarga !== recargaInicial.current) cargar({ silencioso: true }); }, [recarga]);

  const avisarEnviando = (valor) => {
    try {
      onEnviando?.(valor);
    } catch {
      // Solo informa.
    }
  };

  const mandarAgregar = async () => {
    if (agregandoRef.current || !sesionRef.current) return;
    // Se toma antes de mirar la red: dos toques seguidos no pasan los dos.
    agregandoRef.current = true;
    if (!await hayConexion()) {
      agregandoRef.current = false;
      if (!montado.current) return;
      setSinRed(true);
      showAlert('Sin conexión', TEXTO_SIN_RED, [{ text: 'Entendido' }]);
      return;
    }
    setAgregando(true);
    setFalla(null);
    avisarEnviando(true);
    try {
      const r = await agregarPersona(sesionRef.current, casoId);
      if (!montado.current) return;
      setReintentoAgregar(false);
      const n = r.integrante?.n ?? r.total_declarado;
      // El reenvío de un uuid cuya alta ya había llegado devuelve la misma fila: si esa persona ya estaba en
      // la lista, no se sumó nadie ahora.
      const yaEstaba = (datosRef.current?.integrantes || []).some((i) => i.n === r.integrante?.n);
      if (yaEstaba) {
        showToast({ type: 'info', message: `La persona ${n} ya se había sumado (envío anterior). Si llegó otra más, tocá «Agregar persona» de nuevo.` });
      } else {
        showToast({ type: 'success', message: `Se sumó la persona ${n} a la familia.` });
      }
      await cargar();
    } catch (e) {
      const c = e?.clasificacion || clasificarErrorLlegada(e);
      if (c.tipo === 'obsoleto') return;
      if (c.tipo === 'conflicto') {
        onConflicto?.(c);
        return;
      }
      if (c.tipo === 'no_encontrado') {
        onNoEncontrado?.();
        return;
      }
      if (c.tipo === 'sin_modulo') {
        onSinModulo?.(c.mensaje);
        return;
      }
      if (!montado.current) return;
      setReintentoAgregar(!!await agregarPendiente(sesionRef.current, casoId).catch(() => null));
      if (c.tipo === 'sin_red') {
        setSinRed(true);
        return;
      }
      setFalla(c.tipo === 'validacion' ? { tipo: 'rechazo', mensaje: (c.errores?.generales || [c.mensaje]).join('\n') } : c);
    } finally {
      agregandoRef.current = false;
      if (montado.current) setAgregando(false);
      avisarEnviando(false);
    }
  };

  const tocarAgregar = () => {
    if (agregandoRef.current) return;
    // Reintento de un «Agregar» incierto: el mismo pedido (el uuid guardado), sin volver a preguntar.
    if (reintentoAgregar) {
      mandarAgregar();
      return;
    }
    const siguiente = (datos?.total_declarado || 0) + 1;
    showAlert('Agregar persona', `¿Llegó una persona más? Se suma la persona ${siguiente} a la familia, sin cama reservada: se elige una libre al confirmarla.`, [
      { text: 'Cancelar', style: 'cancel' },
      { text: 'Agregar', onPress: mandarAgregar },
    ]);
  };

  const tarjeta = [styles.card, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }];
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

  const caso = datos?.caso || casoInicial;
  const lectura = esSoloLectura(datos?.caso);
  const cierre = datos ? cierreDisponible(datos) : null;
  const crecimiento = datos ? textoDeCrecimiento(datos) : null;

  const fila = (integrante) => {
    const estado = estadoDeIntegrante(integrante.estado);
    const titulo = integrante.persona?.nombre || `Persona ${integrante.n}`;
    const detalle = [
      integrante.persona?.dni ? `DNI ${integrante.persona.dni}` : null,
      integrante.plaza ? `Cama ${integrante.plaza.nombre || integrante.plaza.codigo}` : null,
      integrante.parentesco || null,
    ].filter(Boolean).join(' · ');
    const incompleta = integrante.estado === 'CONFIRMADA' && !integrante.ficha_completa;
    const etiquetaA11y = [`${integrante.n}. ${titulo}`, estado.titulo, detalle, incompleta ? TEXTO_FICHA_INCOMPLETA : null].filter(Boolean).join('. ');
    const sinConfirmar = integrante.estado === 'SIN_CONFIRMAR';
    // Sin confirmar solo se confirma con el ingreso en curso; la ficha de una confirmada se abre siempre.
    const deshabilitada = (sinConfirmar && lectura) || agregando;
    const accion = sinConfirmar ? 'Confirmar persona con su ficha y su cama' : 'Ver y completar la ficha';
    return (
      <Pressable key={String(integrante.n)} accessibilityRole="button" accessibilityLabel={etiquetaA11y}
        accessibilityHint={deshabilitada ? undefined : accion} accessibilityState={{ disabled: deshabilitada }} disabled={deshabilitada}
        onPress={() => onAbrirPersona?.(integrante, datos?.caso || casoInicial)}
        style={({ pressed }) => [styles.persona, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }, pressed && styles.presionada]}>
        <View style={styles.cabecera}>
          <Text style={[styles.flex, styles.nombre, { color: theme.colors.text, fontFamily: typography.bold }]}>{`${integrante.n}. ${titulo}`}</Text>
          {insignia(estado.tono, estado.titulo, 'estado')}
        </View>
        {detalle ? <Text style={ayuda}>{detalle}</Text> : null}
        {incompleta ? insignia('warning', TEXTO_FICHA_INCOMPLETA, 'ficha') : null}
      </Pressable>
    );
  };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.background }} contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refrescando} onRefresh={() => cargar({ silencioso: true })}
        colors={[theme.colors.primary]} tintColor={theme.colors.primary} />}>
      {sinRed ? avisoDe('warning', TEXTO_SIN_RED, 'cloud-offline-outline') : null}
      <View style={tarjeta}>
        <Text accessibilityRole="header" style={[styles.titulo, { color: theme.colors.text, fontFamily: typography.bold }]}>{`Caso ${caso?.numero || ''}`.trim()}</Text>
        {datos ? (
          <Text accessibilityLiveRegion="polite" style={[styles.contador, { color: theme.colors.text, fontFamily: typography.bold }]}>{textoDelContador(datos)}</Text>
        ) : null}
        {crecimiento ? <Text style={ayuda}>{crecimiento}</Text> : null}
        {datos?.con_ficha_incompleta ? <Text style={ayuda}>{datos.con_ficha_incompleta === 1 ? '1 persona con la ficha incompleta' : `${datos.con_ficha_incompleta} personas con la ficha incompleta`}</Text> : null}
        {lectura ? avisoDe('success', TEXTO_ALOJADA, 'home-outline') : null}
      </View>

      {refrescando && Platform.OS === 'web' ? <ActivityIndicator color={theme.colors.primary} accessibilityLabel="Actualizando los integrantes" /> : null}
      {cargando && !datos && !sinRed ? <ActivityIndicator size="large" color={theme.colors.primary} accessibilityLabel="Cargando los integrantes" /> : null}
      {error ? avisoDe(error.tipo === 'reintentable' ? 'warning' : 'danger', error.mensaje) : null}
      {(error || sinRed) && !datos ? (
        <CustomButton title="Reintentar" variant="secondary" iconLeft="refresh" disabled={!sesion} onPress={() => cargar({ silencioso: true })} />
      ) : null}

      {(datos?.integrantes || []).map(fila)}

      {falla ? avisoDe(falla.tipo === 'reintentable' ? 'warning' : 'danger', falla.mensaje) : null}
      {datos && !lectura ? (
        <>
          <CustomButton title={reintentoAgregar ? 'Reintentar agregar persona' : 'Agregar persona'} variant="secondary"
            iconLeft="person-add-outline" loading={agregando} disabled={agregando || !sesion} onPress={tocarAgregar} />
          {cierre ? (
            <CustomButton title={CIERRES[cierre].titulo} size="L" iconLeft={CIERRES[cierre].icono} disabled={agregando}
              onPress={() => onCerrar?.(cierre, datos)} />
          ) : null}
        </>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 40, gap: 10 },
  card: { borderWidth: 1, borderRadius: radii.xl, padding: 14, gap: 6 },
  persona: { borderWidth: 1, borderRadius: radii.xl, padding: 14, gap: 6 },
  presionada: { opacity: 0.7, transform: [{ scale: 0.98 }] },
  cabecera: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  titulo: { fontSize: fontSizes.base },
  contador: { fontSize: fontSizes.lg },
  nombre: { fontSize: fontSizes.sm },
  ayuda: { fontSize: fontSizes.xs },
  texto: { fontSize: fontSizes.sm },
  flex: { flex: 1 },
  aviso: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: radii.lg, padding: 10 },
  insignia: { alignSelf: 'flex-start', borderWidth: 1, borderRadius: radii.full, paddingHorizontal: 10, paddingVertical: 3 },
});
