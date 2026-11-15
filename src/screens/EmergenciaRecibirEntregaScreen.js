import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable, Image, ActivityIndicator, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import TextInput from '../components/FormInput';
import CustomButton from '../components/CustomButton';
import { useTheme } from '../context/ThemeContext';
import { useToast } from '../context/ToastContext';
import * as ImagePicker from '../services/imagePicker';
import { forgetWebFile } from '../services/webAttachments';
import {
  MAX_DIGITOS_CANTIDAD, MAX_OBSERVACION, TEXTO_SIN_RED, abrirRecepcion, clasificarErrorRecepcion, descartarIntento,
  diferenciasDe, enviarRecepcion, errorDeCantidad, escucharRed, guardarRecepcion, hayConexion, textoDeDiferencia, validarRecepcion,
} from '../services/emergenciaKits';
import { aJpeg, liberarJpeg } from '../utils/jpeg';
import { formatDate } from '../utils/dates';
import { textoDeCode } from '../utils/emergencia';
import { statusTones } from '../theme/statusBadges';
import { keyboardDismissModeFor } from '../utils/teclado';
import { fontSizes, radii } from '../theme';

const AUTOGUARDADO_MS = 400;

export const TEXTO_RECUPERADA = 'Recuperamos la recepción que habías empezado. Volvé a sacar la foto del remito.';
export const TEXTO_BLOQUEADA = 'Un intento anterior pudo haber llegado al servidor: las cantidades quedan fijas y «Reintentar» manda la misma recepción, sin duplicarla.';
export const TEXTO_SIN_DIFERENCIAS = 'Coincide con lo enviado.';

const sinVacios = (objeto) => Object.fromEntries(Object.entries(objeto || {}).filter(([, valor]) => valor != null));

// M3-2 · Recibir una entrega (§12): una cantidad por línea (precargada con lo enviado), la foto del
// remito (JPEG con aJpeg) y una observación. Requiere conexión: sin red no se manda nada y se avisa.
// El uuid_cliente nace al abrir (abrirRecepcion) y se conserva mientras la recepción esté abierta,
// también si se cierra la app; un reintento tras un error de red, timeout, 5xx o 429 usa el mismo.
// `onTerminar(motivo, detalle)`: 'recibida' (con el resultado), 'conflicto' (409 de estado: recargar
// las entregas) o 'no_encontrada' (404: recargar los dispositivos). `onSinModulo(mensaje)`: 403.
export default function EmergenciaRecibirEntregaScreen({ entrega, dispositivoId = null, onTerminar, onSinModulo }) {
  const { theme, typography } = useTheme();
  const { showToast, showAlert } = useToast();
  const [recepcion, setRecepcion] = useState(null);
  const [errorCarga, setErrorCarga] = useState('');
  const [cantidades, setCantidades] = useState({});
  const [observacion, setObservacion] = useState('');
  const [remito, setRemito] = useState(null);
  const [procesandoFoto, setProcesandoFoto] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [intentado, setIntentado] = useState(false);
  const [erroresServidor, setErroresServidor] = useState({});
  const [falla, setFalla] = useState(null);
  const [sinRed, setSinRed] = useState(false);
  const [esperaHasta, setEsperaHasta] = useState(0);
  const [ahora, setAhora] = useState(Date.now());
  const montado = useRef(true);
  const enviandoRef = useRef(false);
  const remitoRef = useRef(null);
  remitoRef.current = remito;

  useEffect(() => {
    montado.current = true;
    (async () => {
      try {
        const abierta = await abrirRecepcion(entrega, dispositivoId);
        if (!montado.current) return;
        setRecepcion(abierta);
        setCantidades(abierta.cantidades);
        setObservacion(abierta.observacion || '');
        if (abierta.recuperada) showToast({ type: 'info', message: TEXTO_RECUPERADA });
      } catch (e) {
        if (montado.current) setErrorCarga(e?.message || 'No se pudo abrir la recepción.');
      }
    })();
    hayConexion().then((hay) => { if (montado.current) setSinRed(!hay); }).catch(() => {});
    const dejarDeEscuchar = escucharRed((hay) => { if (montado.current) setSinRed(!hay); });
    return () => {
      montado.current = false;
      dejarDeEscuchar();
      liberarJpeg(remitoRef.current);
    };
  }, [entrega?.id]);

  // Lo tipeado se guarda con la recepción (no la foto): sobrevive a cerrar la app.
  useEffect(() => {
    if (!recepcion || recepcion.bloqueada) return undefined;
    const timer = setTimeout(() => {
      guardarRecepcion(recepcion.owner, entrega.id, { cantidades, observacion }).catch(() => {});
    }, AUTOGUARDADO_MS);
    return () => clearTimeout(timer);
  }, [cantidades, observacion, recepcion]);

  // Cuenta regresiva del Retry-After.
  const esperando = esperaHasta > ahora;
  useEffect(() => {
    if (!esperando) return undefined;
    const timer = setInterval(() => setAhora(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [esperando]);

  const bloqueada = !!recepcion?.bloqueada;

  const cambiarCantidad = (item, texto) => {
    if (bloqueada) return;
    setCantidades((prev) => ({ ...prev, [item]: texto }));
    setErroresServidor((prev) => {
      if (!prev.lineas?.[item] && !prev.cantidades) return prev;
      const lineas = { ...(prev.lineas || {}) };
      delete lineas[item];
      return sinVacios({ ...prev, lineas: Object.keys(lineas).length ? lineas : null, cantidades: null });
    });
  };

  // ---- Foto del remito ----
  const guardarFoto = async (asset) => {
    if (!asset?.uri && !asset?.file) return;
    setProcesandoFoto(true);
    try {
      const convertido = await aJpeg(asset);
      if (Platform.OS === 'web' && asset.uri && convertido.uri !== asset.uri) forgetWebFile(asset.uri);
      if (!montado.current) {
        liberarJpeg(convertido);
        return;
      }
      liberarJpeg(remitoRef.current);
      setRemito(convertido);
      setErroresServidor((prev) => (prev.remito ? sinVacios({ ...prev, remito: null }) : prev));
      setFalla((prev) => (prev?.tipo === 'pesada' ? null : prev));
    } catch (e) {
      if (montado.current) showToast({ type: 'error', message: textoDeCode(e?.code, e?.message) });
    } finally {
      if (montado.current) setProcesandoFoto(false);
    }
  };
  const elegirRemito = () => {
    const desde = (obtener) => async () => {
      try {
        const resultado = await obtener();
        if (resultado && !resultado.canceled && resultado.assets?.[0]) await guardarFoto(resultado.assets[0]);
      } catch (e) {
        showToast({ type: 'error', message: e?.message || 'No se pudo abrir la cámara.' });
      }
    };
    const camara = async () => {
      if (Platform.OS !== 'web') {
        const permiso = await ImagePicker.requestCameraPermissionsAsync();
        if (!permiso?.granted) {
          showToast({ type: 'warning', message: 'Necesitamos permiso de la cámara para sacar la foto del remito.' });
          return null;
        }
      }
      return ImagePicker.launchCameraAsync({ mediaTypes: ['images'], allowsEditing: false, quality: 0.8 });
    };
    showAlert('Foto del remito', 'Elegí de dónde tomarla.', [
      { text: 'Cámara', onPress: desde(camara) },
      { text: 'Galería', onPress: desde(() => ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: false, quality: 0.8 })) },
      { text: 'Cancelar', style: 'cancel' },
    ]);
  };
  const quitarRemito = () => {
    liberarJpeg(remitoRef.current);
    setRemito(null);
  };

  // ---- Envío ----
  const avisarResultado = (resultado) => {
    if (resultado.diferencias.length) {
      showAlert('Recibida con diferencias', [`Entrega ${entrega.numero}: la mesa ve lo que faltó o sobró.`,
        ...resultado.diferencias.map(textoDeDiferencia)].join('\n'), [{ text: 'Entendido' }]);
    } else {
      showToast({ type: 'success', message: `Entrega ${entrega.numero} recibida completa.` });
    }
  };

  const enviar = async () => {
    if (enviandoRef.current || !recepcion) return;
    enviandoRef.current = true;
    setEnviando(true);
    setFalla(null);
    try {
      const resultado = await enviarRecepcion({ entrega, recepcion, cantidades, remito, observacion });
      liberarJpeg(remitoRef.current);
      remitoRef.current = null;
      if (!montado.current) return;
      setRemito(null);
      avisarResultado(resultado);
      onTerminar?.('recibida', resultado);
    } catch (e) {
      const c = e?.clasificacion || clasificarErrorRecepcion(e);
      if (!montado.current) return;
      if (c.tipo === 'sin_red') {
        setSinRed(true);
        showAlert('Sin conexión', TEXTO_SIN_RED, [{ text: 'Entendido' }]);
      } else if (c.tipo === 'conflicto') {
        showAlert('La entrega ya no se puede recibir', c.mensaje, [{ text: 'Entendido' }]);
        onTerminar?.('conflicto', c);
        return;
      } else if (c.tipo === 'no_encontrada') {
        showAlert('Entrega no disponible', c.mensaje, [{ text: 'Entendido' }]);
        onTerminar?.('no_encontrada', c);
        return;
      } else if (c.tipo === 'sin_modulo') {
        onSinModulo?.(c.mensaje);
        return;
      } else if (c.tipo === 'validacion' || c.tipo === 'pesada') {
        setIntentado(true);
        setErroresServidor(c.errores || {});
        setRecepcion((prev) => prev && { ...prev, bloqueada: false });
        setFalla(c);
      } else {
        // reintentable, uuid_en_uso, sesion, rechazo: el pedido salió con este uuid.
        setRecepcion((prev) => prev && { ...prev, bloqueada: true });
        setFalla(c);
        if (c.espera) {
          setAhora(Date.now());
          setEsperaHasta(Date.now() + c.espera);
        }
      }
    } finally {
      enviandoRef.current = false;
      if (montado.current) setEnviando(false);
    }
  };

  const recibir = async () => {
    if (enviandoRef.current || !recepcion) return;
    setIntentado(true);
    if (Object.keys(validarRecepcion({ entrega, cantidades, remito })).length) return;
    if (!await hayConexion()) {
      if (!montado.current) return;
      setSinRed(true);
      showAlert('Sin conexión', TEXTO_SIN_RED, [{ text: 'Entendido' }]);
      return;
    }
    setSinRed(false);
    const diferencias = diferenciasDe(entrega, cantidades);
    // El reintento manda lo mismo que el primer intento, que ya se confirmó.
    if (diferencias.length && !bloqueada) {
      showAlert('Recibir con diferencias', [...diferencias.map(textoDeDiferencia),
        '', 'Después de confirmada, la recepción no se corrige.'].join('\n'), [
        { text: 'Revisar', style: 'cancel' },
        { text: 'Recibir igual', onPress: enviar },
      ]);
      return;
    }
    await enviar();
  };

  const confirmarDescarteIntento = () => showAlert('Descartar este intento',
    'Se empieza un intento nuevo con lo cargado y otro identificador.', [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Descartar intento',
        style: 'destructive',
        onPress: async () => {
          try {
            const uuid = await descartarIntento(recepcion.owner, entrega.id);
            if (!montado.current) return;
            setRecepcion((prev) => ({ ...prev, uuid_cliente: uuid, bloqueada: false }));
            setFalla(null);
            setEsperaHasta(0);
          } catch (e) {
            showToast({ type: 'error', message: e?.message || 'No se pudo descartar el intento.' });
          }
        },
      },
    ]);

  if (errorCarga) {
    return (
      <View style={styles.centro}>
        <Text style={[styles.texto, { color: theme.colors.text, fontFamily: typography.medium }]}>{errorCarga}</Text>
      </View>
    );
  }
  if (!recepcion) {
    return <View style={styles.centro}><ActivityIndicator size="large" color={theme.colors.primary} accessibilityLabel="Abriendo la recepción" /></View>;
  }

  const erroresCliente = intentado ? validarRecepcion({ entrega, cantidades, remito }) : {};
  const errorDeLinea = (item) => [...(erroresCliente.lineas?.[item] || []), ...(erroresServidor.lineas?.[item] || [])];
  const erroresRemito = [...(erroresCliente.remito || []), ...(erroresServidor.remito || [])];
  const diferencias = diferenciasDe(entrega, cantidades);
  const tarjeta = [styles.card, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }];
  const etiqueta = [styles.etiqueta, { color: theme.colors.text, fontFamily: typography.semibold }];
  const ayuda = [styles.ayuda, { color: theme.colors.textMuted, fontFamily: typography.medium }];
  const caja = (conError) => [styles.input, {
    color: theme.colors.text,
    backgroundColor: bloqueada ? theme.colors.background : theme.colors.surface,
    borderColor: conError ? theme.colors.danger : theme.colors.border,
  }];
  const mensajes = (lista) => lista.map((mensaje) => (
    <Text key={mensaje} accessibilityLiveRegion="polite" style={[styles.error, { color: theme.colors.danger, fontFamily: typography.medium }]}>{mensaje}</Text>
  ));
  const aviso = (tono, texto, icono) => (
    <View accessibilityRole="alert" style={[styles.aviso, { backgroundColor: statusTones[tono].bg, borderColor: statusTones[tono].bd }]}>
      {icono ? <Ionicons name={icono} size={18} color={statusTones[tono].tx} accessible={false} importantForAccessibility="no" /> : null}
      <Text style={[styles.flex, styles.texto, { color: statusTones[tono].tx, fontFamily: typography.semibold }]}>{texto}</Text>
    </View>
  );

  const segundos = Math.max(1, Math.ceil((esperaHasta - ahora) / 1000));
  let tituloBoton = bloqueada ? 'Reintentar' : 'Recibir';
  if (esperando) tituloBoton = `Reintentar en ${segundos} s`;
  const uuidEnUso = falla?.tipo === 'uuid_en_uso';

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.background }} contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode={keyboardDismissModeFor(Platform.OS === 'ios' ? 'interactive' : 'on-drag')}>
      {sinRed ? aviso('warning', TEXTO_SIN_RED, 'cloud-offline-outline') : null}

      <View style={tarjeta}>
        <Text accessibilityRole="header" style={[styles.titulo, { color: theme.colors.text, fontFamily: typography.bold }]}>{`Entrega ${entrega.numero}`}</Text>
        <Text style={ayuda}>{entrega.despachada_en ? `Despachada el ${formatDate(entrega.despachada_en, { includeTime: true })}` : 'Sin marca de salida'}</Text>
        {entrega.observacion_mesa ? <Text style={ayuda}>{`Mesa: ${entrega.observacion_mesa}`}</Text> : null}
      </View>

      {bloqueada && !uuidEnUso ? aviso('info', TEXTO_BLOQUEADA, 'lock-closed-outline') : null}

      <View style={tarjeta}>
        <Text accessibilityRole="header" style={[styles.titulo, { color: theme.colors.text, fontFamily: typography.bold }]}>¿Cuánto llegó?</Text>
        <Text style={ayuda}>Viene cargado lo enviado. Cambiá lo que no coincida; si no llegó nada de un ítem, poné 0.</Text>
        {entrega.lineas.map((linea) => {
          const item = String(linea.item);
          const errores = errorDeLinea(item);
          const texto = cantidades[item] ?? '';
          const recibida = errorDeCantidad(texto) ? null : Number(String(texto).trim());
          const resto = recibida == null ? 0 : recibida - linea.enviada;
          return (
            <View key={item} style={[styles.linea, { borderColor: theme.colors.border }]}>
              <View style={styles.fila}>
                <View style={styles.flex}>
                  <Text style={etiqueta}>{linea.nombre}</Text>
                  <Text style={ayuda}>{`Enviado: ${linea.enviada}${linea.unidad ? ` ${linea.unidad}` : ''}`}</Text>
                </View>
                <TextInput value={texto} onChangeText={(valor) => cambiarCantidad(item, valor)} editable={!bloqueada}
                  keyboardType="number-pad" maxLength={MAX_DIGITOS_CANTIDAD} accessibilityLabel={`Cantidad recibida de ${linea.nombre}`}
                  placeholder="0" placeholderTextColor={theme.colors.textSoft} style={[...caja(errores.length > 0), styles.cantidad]} />
              </View>
              {resto ? (
                <Text style={[styles.ayuda, { color: statusTones.warning.tx, fontFamily: typography.semibold }]}>
                  {resto < 0 ? `Faltan ${-resto}` : `Sobran ${resto}`}
                </Text>
              ) : null}
              {mensajes(errores)}
            </View>
          );
        })}
        {mensajes(erroresServidor.cantidades || [])}
        {diferencias.length
          ? aviso('warning', `Diferencias con lo enviado:\n${diferencias.map(textoDeDiferencia).join('\n')}`)
          : <Text accessibilityLiveRegion="polite" style={[styles.texto, { color: statusTones.success.tx, fontFamily: typography.semibold }]}>{TEXTO_SIN_DIFERENCIAS}</Text>}
      </View>

      <View style={tarjeta}>
        <Text accessibilityRole="header" style={[styles.titulo, { color: theme.colors.text, fontFamily: typography.bold }]}>Foto del remito *</Text>
        {remito ? (
          <View style={[styles.foto, { borderColor: theme.colors.border }]}>
            <Image source={{ uri: remito.uri }} style={styles.miniatura} accessibilityLabel="Foto del remito" />
            <View style={styles.flex}>
              <CustomButton title="Cambiar" variant="secondary" size="SM" disabled={procesandoFoto || enviando} onPress={elegirRemito} />
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel="Quitar foto del remito" disabled={enviando} onPress={quitarRemito}>
              <Ionicons name="trash-outline" size={22} color={theme.colors.danger} accessible={false} importantForAccessibility="no" />
            </Pressable>
          </View>
        ) : (
          <CustomButton title="Sacar foto del remito" variant="secondary" iconLeft="camera-outline"
            loading={procesandoFoto} disabled={procesandoFoto || enviando} onPress={elegirRemito} />
        )}
        {mensajes(erroresRemito)}

        <Text style={[etiqueta, styles.separado]}>Observación (opcional)</Text>
        <TextInput value={observacion} onChangeText={(valor) => { if (!bloqueada) setObservacion(valor); }} editable={!bloqueada}
          multiline maxLength={MAX_OBSERVACION} accessibilityLabel="Observación" placeholder="Lo que la mesa tenga que saber"
          placeholderTextColor={theme.colors.textSoft} style={[...caja((erroresServidor.observacion || []).length > 0), styles.areaTexto]} />
        {mensajes(erroresServidor.observacion || [])}
      </View>

      {erroresServidor.generales?.length ? aviso('danger', erroresServidor.generales.join('\n')) : null}
      {falla && falla.tipo !== 'sin_red' ? aviso(falla.tipo === 'reintentable' ? 'warning' : 'danger', falla.mensaje) : null}

      {uuidEnUso ? (
        <CustomButton title="Descartar este intento" size="L" variant="secondary" iconLeft="refresh" onPress={confirmarDescarteIntento} />
      ) : (
        <CustomButton title={tituloBoton} size="L" iconLeft={bloqueada ? 'refresh' : 'checkmark-done-outline'} loading={enviando}
          disabled={enviando || procesandoFoto || esperando} onPress={recibir} />
      )}
      {falla?.tipo === 'rechazo' ? (
        <CustomButton title="Descartar este intento" variant="tertiary" iconLeft="trash-outline" disabled={enviando} onPress={confirmarDescarteIntento} />
      ) : null}
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
  linea: { borderTopWidth: 1, paddingTop: 8, gap: 4 },
  fila: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  flex: { flex: 1 },
  input: { minHeight: 46, borderWidth: 1, borderRadius: radii.lg, paddingHorizontal: 12, paddingVertical: 10, fontSize: fontSizes.sm },
  cantidad: { width: 96, textAlign: 'center' },
  areaTexto: { minHeight: 96, textAlignVertical: 'top' },
  aviso: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: radii.lg, padding: 10 },
  foto: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderRadius: radii.lg, padding: 8 },
  miniatura: { width: 64, height: 64, borderRadius: radii.md },
});
