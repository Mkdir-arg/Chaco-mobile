import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable, Image, ActivityIndicator, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Location from 'expo-location';
import TextInput from '../components/FormInput';
import FechaInput from '../components/FechaInput';
import CustomButton from '../components/CustomButton';
import CameraModal from '../components/CameraModal';
import { useTheme } from '../context/ThemeContext';
import { useToast } from '../context/ToastContext';
import * as ImagePicker from '../services/imagePicker';
import { consultarPersona } from '../services/emergenciaApi';
import { identityFailure, DECEASED_MESSAGE } from '../services/identityLookup';
import { posicionActual, UBICACION_DEMORADA } from '../services/ubicacion';
import {
  abrirBorrador, guardarBorrador, ponerFoto, quitarFoto, encolarCaso, descartar, getLocalidadesGuardadas,
} from '../services/emergenciaCola';
import { aJpeg } from '../utils/jpeg';
import { cleanDigits, isValidDni, normalizeDateText, normalizeSex, parseDniCode } from '../utils/dni';
import {
  ASISTENCIA, AVISOS, CANTIDADES, FOTOS, MAX_DIRECCION, MAX_TRASLADO_OTRO, SEXOS, TRASLADOS,
  aCantidad, filtrarLocalidades, hayErrores, listaDeErrores, personaConfirmada, textoDeCode, totalDeclarado,
  validarCaso, validarConsulta,
} from '../utils/emergencia';
import { statusTones } from '../theme/statusBadges';
import { keyboardDismissModeFor } from '../utils/teclado';
import { fontSizes, radii } from '../theme';

const AUTOGUARDADO_MS = 500;
// Cambiar estos campos invalida lo que confirmó la consulta de identidad.
const CAMPOS_IDENTIDAD = ['dni', 'sexo'];

export const TEXTO_ENCOLADO = 'Guardado en el teléfono: se envía solo apenas haya señal.';
export const TEXTO_SIN_RED_CONSULTA = 'Sin conexión: no se pudo buscar a la persona. Cargá nombre y apellido; el envío se manda cuando haya señal.';
export const TEXTO_NO_ENCONTRADA = 'No figura en la Base de Personas: cargá nombre y apellido para darla de alta.';

// Formulario 1 de Emergencia (M1 · Ingreso de familias, contrato §6), en los cuatro bloques del
// manual. Todo se guarda en el borrador del teléfono (sobrevive a cerrar la app) y «Enviar» lo
// encola con la hora de ese momento. `uuid`: el borrador que el servidor devolvió para corregir.
export default function EmergenciaFormulario1Screen({ uuid = null, onTerminar }) {
  const { theme, typography } = useTheme();
  const { showToast, showAlert } = useToast();
  const [cargando, setCargando] = useState(true);
  const [errorCarga, setErrorCarga] = useState('');
  const [uuidCliente, setUuidCliente] = useState(null);
  const [datos, setDatos] = useState(null);
  const [fotos, setFotos] = useState({});
  const [erroresServidor, setErroresServidor] = useState({});
  const [intentado, setIntentado] = useState(false);
  const [localidades, setLocalidades] = useState([]);
  const [busquedaLocalidad, setBusquedaLocalidad] = useState('');
  const [consultando, setConsultando] = useState(false);
  const [avisoConsulta, setAvisoConsulta] = useState(null);
  const [ubicando, setUbicando] = useState(false);
  const [errorUbicacion, setErrorUbicacion] = useState('');
  const [fotoEnProceso, setFotoEnProceso] = useState(null);
  const [scanner, setScanner] = useState(false);
  const [scannerTrabado, setScannerTrabado] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const montado = useRef(true);
  const ultimo = useRef(null);
  const terminado = useRef(false);
  const scannerTrabadoRef = useRef(false);

  useEffect(() => {
    montado.current = true;
    (async () => {
      try {
        const borrador = await abrirBorrador({ uuid });
        if (!montado.current) return;
        if (!borrador) { setErrorCarga('Este relevamiento ya no está en el teléfono.'); return; }
        setUuidCliente(borrador.uuid_cliente);
        setDatos(borrador.datos);
        setFotos(borrador.fotos || {});
        setErroresServidor(borrador.errores || {});
        if (borrador.errores) setIntentado(true);
        else if (!borrador.nuevo) showToast({ type: 'info', message: 'Recuperamos lo que habías cargado.' });
      } catch (e) {
        if (montado.current) setErrorCarga(e?.message || 'No se pudo abrir el formulario.');
      } finally {
        if (montado.current) setCargando(false);
      }
    })();
    getLocalidadesGuardadas().then((res) => {
      if (montado.current) setLocalidades(res?.localidades || []);
    }).catch(() => {});
    return () => { montado.current = false; };
  }, [uuid]);

  // Autoguardado; lo último tipeado no espera al temporizador si se cierra la pantalla.
  useEffect(() => {
    if (!datos || !uuidCliente || terminado.current) return undefined;
    ultimo.current = { uuid: uuidCliente, datos };
    const timer = setTimeout(() => guardarBorrador(uuidCliente, datos).catch(() => {}), AUTOGUARDADO_MS);
    return () => clearTimeout(timer);
  }, [datos, uuidCliente]);
  useEffect(() => () => {
    if (!terminado.current && ultimo.current) guardarBorrador(ultimo.current.uuid, ultimo.current.datos).catch(() => {});
  }, []);

  const cambiar = (cambios) => {
    setDatos((prev) => {
      const next = { ...prev, ...cambios };
      if (CAMPOS_IDENTIDAD.some((campo) => campo in cambios && cambios[campo] !== prev[campo])) next.consulta = null;
      return next;
    });
    setErroresServidor((prev) => {
      const claves = Object.keys(cambios);
      if (!claves.some((clave) => prev[clave] || (clave in cantidadesYTotal && prev.total))) return prev;
      const next = { ...prev };
      claves.forEach((clave) => {
        delete next[clave];
        if (clave in cantidadesYTotal) delete next.total;
      });
      return next;
    });
    if (CAMPOS_IDENTIDAD.some((campo) => campo in cambios)) setAvisoConsulta(null);
  };

  const errores = {
    ...erroresServidor,
    ...(intentado && datos ? validarCaso(datos) : {}),
  };
  const errorDe = (...campos) => campos.flatMap((campo) => errores[campo] || []);

  // ---- Identidad ----
  const buscarPersona = async () => {
    const faltan = validarConsulta(datos);
    if (hayErrores(faltan)) {
      setAvisoConsulta({ tono: 'warning', texto: listaDeErrores(faltan).map((e) => e.texto).join(' ') });
      return;
    }
    setConsultando(true);
    setAvisoConsulta(null);
    const dni = cleanDigits(datos.dni);
    const sexo = String(datos.sexo).toUpperCase();
    try {
      const respuesta = await consultarPersona({ dni, sexo });
      if (!montado.current) return;
      const persona = respuesta?.data || {};
      cambiar({
        nombre: persona.nombre || datos.nombre,
        apellido: persona.apellido || datos.apellido,
        fecha_nacimiento: persona.fecha_nacimiento ? normalizeDateText(persona.fecha_nacimiento) : datos.fecha_nacimiento,
      });
      setDatos((prev) => ({ ...prev, consulta: { estado: 'encontrada', dni, sexo } }));
      setAvisoConsulta({ tono: 'success', texto: `Encontramos a ${[persona.nombre, persona.apellido].filter(Boolean).join(' ')} en la Base de Personas.` });
    } catch (e) {
      if (!montado.current) return;
      let estado = 'error';
      let aviso;
      if (Number(e?.status) === 404 && e?.payload?.fallecido === true) {
        estado = 'fallecida';
        aviso = { tono: 'danger', texto: `${DECEASED_MESSAGE}. Revisá el DNI.` };
      } else if (Number(e?.status) === 404) {
        estado = 'no_encontrada';
        aviso = { tono: 'warning', texto: TEXTO_NO_ENCONTRADA };
      } else if (e?.network) {
        estado = 'sin_red';
        aviso = { tono: 'warning', texto: TEXTO_SIN_RED_CONSULTA };
      } else {
        aviso = { tono: 'warning', texto: identityFailure(e).message };
      }
      setDatos((prev) => ({ ...prev, consulta: { estado, dni, sexo } }));
      setAvisoConsulta(aviso);
    } finally {
      if (montado.current) setConsultando(false);
    }
  };

  const abrirScanner = async () => {
    if (Platform.OS !== 'web') {
      const permiso = await ImagePicker.requestCameraPermissionsAsync().catch(() => null);
      if (!permiso?.granted) {
        showToast({ type: 'warning', message: 'Necesitamos permiso de la cámara para escanear el DNI.' });
        return;
      }
    }
    scannerTrabadoRef.current = false;
    setScannerTrabado(false);
    setScanner(true);
  };
  const cerrarScanner = () => {
    scannerTrabadoRef.current = false;
    setScannerTrabado(false);
    setScanner(false);
  };
  const alEscanear = ({ data, type } = {}) => {
    if (scannerTrabadoRef.current) return;
    scannerTrabadoRef.current = true;
    setScannerTrabado(true);
    const leido = parseDniCode(data, String(type || '').toUpperCase());
    if (!isValidDni(leido.dni_numero)) {
      showToast({ type: 'warning', message: 'No se pudo leer el DNI. Probá de nuevo o cargalo a mano.' });
      cerrarScanner();
      return;
    }
    const sexo = normalizeSex(leido.dni_sexo);
    const dni = cleanDigits(leido.dni_numero);
    const conNombre = !!(leido.nombres && leido.apellido);
    setDatos((prev) => ({
      ...prev,
      dni,
      sexo: ['F', 'M'].includes(sexo) ? sexo : prev.sexo,
      nombre: leido.nombres || prev.nombre,
      apellido: leido.apellido || prev.apellido,
      fecha_nacimiento: leido.fecha_nacimiento || prev.fecha_nacimiento,
      consulta: conNombre ? { estado: 'escaneado', dni, sexo } : null,
    }));
    setAvisoConsulta(conNombre ? { tono: 'success', texto: 'Datos tomados del DNI.' } : null);
    cerrarScanner();
  };

  // ---- Fotos ----
  const guardarFoto = async (campo, asset) => {
    if (!asset?.uri && !asset?.file) return;
    setFotoEnProceso(campo);
    try {
      const convertido = await aJpeg(asset);
      const temporal = Platform.OS !== 'web' && convertido.uri !== asset.uri;
      const item = await ponerFoto(uuidCliente, campo, convertido, { temporal });
      if (!montado.current) return;
      setFotos((prev) => ({ ...prev, [campo]: item }));
      setErroresServidor((prev) => {
        if (!prev[campo]) return prev;
        const next = { ...prev };
        delete next[campo];
        return next;
      });
    } catch (e) {
      if (montado.current) showToast({ type: 'error', message: textoDeCode(e?.code, e?.message) });
    } finally {
      if (montado.current) setFotoEnProceso(null);
    }
  };
  const elegirFoto = (campo, titulo) => {
    const desde = (obtener) => async () => {
      try {
        const resultado = await obtener();
        if (resultado && !resultado.canceled && resultado.assets?.[0]) await guardarFoto(campo, resultado.assets[0]);
      } catch (e) {
        showToast({ type: 'error', message: e?.message || 'No se pudo abrir la cámara.' });
      }
    };
    const camara = async () => {
      if (Platform.OS !== 'web') {
        const permiso = await ImagePicker.requestCameraPermissionsAsync();
        if (!permiso?.granted) {
          showToast({ type: 'warning', message: 'Necesitamos permiso de la cámara para sacar la foto.' });
          return null;
        }
      }
      return ImagePicker.launchCameraAsync({ mediaTypes: ['images'], allowsEditing: false, quality: 0.8 });
    };
    showAlert(titulo, 'Elegí de dónde tomarla.', [
      { text: 'Cámara', onPress: desde(camara) },
      { text: 'Galería', onPress: desde(() => ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: false, quality: 0.8 })) },
      { text: 'Cancelar', style: 'cancel' },
    ]);
  };
  const sacarFoto = async (campo) => {
    try {
      await quitarFoto(uuidCliente, campo);
      if (montado.current) setFotos((prev) => { const next = { ...prev }; delete next[campo]; return next; });
    } catch (e) {
      showToast({ type: 'error', message: e?.message || 'No se pudo quitar la foto.' });
    }
  };

  // ---- Ubicación (opcional) ----
  const tomarUbicacion = async () => {
    setUbicando(true);
    setErrorUbicacion('');
    try {
      const permiso = await Location.requestForegroundPermissionsAsync();
      if (permiso?.status !== 'granted') {
        setErrorUbicacion('Sin permiso de ubicación: se puede enviar sin GPS.');
        return;
      }
      const posicion = await posicionActual(Location.Accuracy.High);
      if (!montado.current) return;
      const { latitude, longitude, accuracy } = posicion?.coords || {};
      cambiar({
        latitud: Number(Number(latitude).toFixed(6)),
        longitud: Number(Number(longitude).toFixed(6)),
        precision_m: Number.isFinite(accuracy) ? Math.round(accuracy * 10) / 10 : null,
      });
    } catch (e) {
      if (montado.current) setErrorUbicacion(e?.code === UBICACION_DEMORADA ? e.message : 'No se pudo obtener la ubicación. Se puede enviar sin GPS.');
    } finally {
      if (montado.current) setUbicando(false);
    }
  };

  // ---- Envío ----
  const enviar = async () => {
    const locales = validarCaso(datos);
    setIntentado(true);
    if (hayErrores(locales)) {
      const cantidad = Object.keys(locales).length;
      showToast({ type: 'warning', message: `Falta${cantidad === 1 ? '' : 'n'} ${cantidad} dato${cantidad === 1 ? '' : 's'} para poder enviar.` });
      return;
    }
    setEnviando(true);
    try {
      await guardarBorrador(uuidCliente, datos);
      const resultado = await encolarCaso(uuidCliente, { datos, relevadoEn: new Date() });
      const envio = resultado?.envio;
      if (envio?.estado === 'corregir') {
        // El servidor ya contestó 400: el borrador volvió con los errores, se corrige acá mismo.
        if (montado.current) {
          setErroresServidor(envio.errores || {});
          showToast({ type: 'warning', message: textoDeCode('VALIDACION') });
        }
        return;
      }
      terminado.current = true;
      if (envio?.estado === 'enviado') {
        showToast({ type: 'success', message: envio.resultado?.numero ? `Familia enviada: caso ${envio.resultado.numero}.` : 'Familia enviada.' });
      } else if (envio?.estado === 'error') {
        showToast({ type: 'warning', message: textoDeCode(envio.code, envio.detail) });
      } else {
        showToast({ type: 'info', message: TEXTO_ENCOLADO });
      }
      if (montado.current && onTerminar) onTerminar(resultado);
    } catch (e) {
      if (e?.errores && montado.current) setIntentado(true);
      if (montado.current) showAlert('No se pudo enviar', e?.message || 'Probá de nuevo.');
    } finally {
      if (montado.current) setEnviando(false);
    }
  };

  const confirmarDescarte = () => showAlert('Descartar relevamiento', 'Se borra lo cargado de esta familia, con sus fotos. No se puede deshacer.', [
    { text: 'Cancelar', style: 'cancel' },
    {
      text: 'Descartar',
      style: 'destructive',
      onPress: async () => {
        terminado.current = true;
        await descartar(uuidCliente).catch(() => false);
        if (montado.current && onTerminar) onTerminar(null);
      },
    },
  ]);

  if (cargando) {
    return <View style={styles.centro}><ActivityIndicator size="large" color={theme.colors.primary} accessibilityLabel="Abriendo el formulario" /></View>;
  }
  if (!datos) {
    return (
      <View style={styles.centro}>
        <Text style={[styles.texto, { color: theme.colors.text, fontFamily: typography.medium }]}>{errorCarga}</Text>
      </View>
    );
  }

  const tarjeta = [styles.card, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }];
  const tituloSeccion = [styles.titulo, { color: theme.colors.text, fontFamily: typography.bold }];
  const etiqueta = [styles.etiqueta, { color: theme.colors.text, fontFamily: typography.semibold }];
  const ayuda = [styles.ayuda, { color: theme.colors.textMuted, fontFamily: typography.medium }];
  const caja = (campos) => [styles.input, {
    color: theme.colors.text, backgroundColor: theme.colors.surface,
    borderColor: errorDe(...campos).length ? theme.colors.danger : theme.colors.border,
  }];

  const errorCampo = (campos) => {
    const mensajes = errorDe(...campos);
    if (!mensajes.length) return null;
    return mensajes.map((mensaje) => (
      <Text key={mensaje} accessibilityLiveRegion="polite" style={[styles.error, { color: theme.colors.danger, fontFamily: typography.medium }]}>{mensaje}</Text>
    ));
  };

  const opcionesDe = ({ opciones, valor, onElegir, nombre }) => (
    <View style={styles.opciones} accessibilityRole="radiogroup" accessibilityLabel={nombre}>
      {opciones.map((opcion) => {
        const elegida = valor === opcion.valor;
        return (
          <Pressable key={opcion.valor} accessibilityRole="radio" accessibilityState={{ selected: elegida, checked: elegida }}
            accessibilityLabel={`${nombre}: ${opcion.titulo}`} onPress={() => onElegir(opcion.valor)}
            style={[styles.opcion, { borderColor: elegida ? theme.colors.primary : theme.colors.border,
              backgroundColor: elegida ? `${theme.colors.primary}18` : theme.colors.surface }]}>
            <Text style={{ color: elegida ? theme.colors.primary : theme.colors.text, fontFamily: elegida ? typography.bold : typography.medium, fontSize: fontSizes.sm }}>{opcion.titulo}</Text>
          </Pressable>
        );
      })}
    </View>
  );

  const contador = ({ clave, titulo }) => {
    const valor = aCantidad(datos[clave]);
    return (
      <View style={styles.contador}>
        <Text style={[styles.flex, etiqueta]}>{titulo}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel={`Restar ${titulo}`} disabled={valor <= 0}
          onPress={() => cambiar({ [clave]: Math.max(0, valor - 1) })}
          style={[styles.paso, { borderColor: theme.colors.border, opacity: valor <= 0 ? 0.4 : 1 }]}>
          <Ionicons name="remove" size={20} color={theme.colors.text} accessible={false} importantForAccessibility="no" />
        </Pressable>
        <Text accessibilityLabel={`${titulo}: ${valor}`} style={[styles.valor, { color: theme.colors.text, fontFamily: typography.bold }]}>{valor}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel={`Sumar ${titulo}`}
          onPress={() => cambiar({ [clave]: valor + 1 })}
          style={[styles.paso, { borderColor: theme.colors.border }]}>
          <Ionicons name="add" size={20} color={theme.colors.text} accessible={false} importantForAccessibility="no" />
        </Pressable>
      </View>
    );
  };

  const casilla = ({ clave, titulo }) => {
    const marcada = datos[clave] === true;
    return (
      <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: marcada }} accessibilityLabel={titulo}
        onPress={() => cambiar({ [clave]: !marcada })} style={styles.casilla}>
        <Ionicons name={marcada ? 'checkbox' : 'square-outline'} size={24} color={marcada ? theme.colors.primary : theme.colors.textSoft}
          accessible={false} importantForAccessibility="no" />
        <Text style={[styles.flex, etiqueta]}>{titulo}</Text>
      </Pressable>
    );
  };

  const aviso = ({ tono, texto }) => (
    <View accessibilityRole="alert" style={[styles.aviso, { backgroundColor: statusTones[tono].bg, borderColor: statusTones[tono].bd }]}>
      <Text style={[styles.texto, { color: statusTones[tono].tx, fontFamily: typography.semibold }]}>{texto}</Text>
    </View>
  );

  const total = totalDeclarado(datos);
  const confirmada = personaConfirmada(datos.consulta);
  const sugeridas = filtrarLocalidades(localidades, busquedaLocalidad);
  const conUbicacion = datos.latitud != null && datos.longitud != null;
  const listado = listaDeErrores(errores);

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.background }} contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode={keyboardDismissModeFor(Platform.OS === 'ios' ? 'interactive' : 'on-drag')}>

      <View style={tarjeta}>
        <Text accessibilityRole="header" style={tituloSeccion}>1. Traslado y responsable</Text>
        <Text style={etiqueta}>¿Cómo llegó la familia? *</Text>
        {opcionesDe({ nombre: 'Traslado', opciones: TRASLADOS, valor: datos.traslado, onElegir: (valor) => cambiar({ traslado: valor }) })}
        {errorCampo(['traslado'])}
        {datos.traslado === 'OTRA' ? (
          <>
            <TextInput value={datos.traslado_otro} onChangeText={(texto) => cambiar({ traslado_otro: texto })}
              maxLength={MAX_TRASLADO_OTRO} accessibilityLabel="Otro traslado" placeholder="Contá cómo llegó"
              placeholderTextColor={theme.colors.textSoft} style={caja(['traslado_otro'])} />
            {errorCampo(['traslado_otro'])}
          </>
        ) : null}

        <Text style={[etiqueta, styles.separado]}>DNI del responsable *</Text>
        <View style={styles.fila}>
          <TextInput value={datos.dni} onChangeText={(texto) => cambiar({ dni: cleanDigits(texto).slice(0, 8) })}
            keyboardType="number-pad" maxLength={8} accessibilityLabel="DNI del responsable" placeholder="Solo números"
            placeholderTextColor={theme.colors.textSoft} style={[...caja(['dni']), styles.flex]} />
          <CustomButton title="Escanear DNI" variant="secondary" iconLeft="scan-outline" onPress={abrirScanner} />
        </View>
        {errorCampo(['dni'])}
        <Text style={etiqueta}>Sexo (como figura en el DNI)</Text>
        {opcionesDe({ nombre: 'Sexo', opciones: SEXOS, valor: datos.sexo, onElegir: (valor) => cambiar({ sexo: valor }) })}
        <CustomButton title="Buscar persona" variant="secondary" iconLeft="search-outline" loading={consultando}
          disabled={consultando} onPress={buscarPersona} />
        {avisoConsulta ? aviso(avisoConsulta) : null}

        <Text style={[etiqueta, styles.separado]}>{confirmada ? 'Nombre' : 'Nombre *'}</Text>
        <TextInput value={datos.nombre} onChangeText={(texto) => cambiar({ nombre: texto })} autoCapitalize="words"
          accessibilityLabel="Nombre" placeholderTextColor={theme.colors.textSoft} style={caja(['nombre'])} />
        {errorCampo(['nombre'])}
        <Text style={etiqueta}>{confirmada ? 'Apellido' : 'Apellido *'}</Text>
        <TextInput value={datos.apellido} onChangeText={(texto) => cambiar({ apellido: texto })} autoCapitalize="words"
          accessibilityLabel="Apellido" placeholderTextColor={theme.colors.textSoft} style={caja(['apellido'])} />
        {errorCampo(['apellido'])}
        {!confirmada ? <Text style={ayuda}>Si la persona no está en el legajo, con esto se la da de alta.</Text> : null}
        <FechaInput label="Fecha de nacimiento" value={datos.fecha_nacimiento} onSelect={(texto) => cambiar({ fecha_nacimiento: texto })} />
        {errorCampo(['fecha_nacimiento'])}
        <Text style={etiqueta}>Teléfono de contacto</Text>
        <TextInput value={datos.telefono} onChangeText={(texto) => cambiar({ telefono: texto })} keyboardType="phone-pad"
          accessibilityLabel="Teléfono de contacto" placeholderTextColor={theme.colors.textSoft} style={caja(['telefono'])} />
        {casilla({ clave: 'documento_extraviado', titulo: 'Perdió el documento (sabe el número)' })}
      </View>

      <View style={tarjeta}>
        <Text accessibilityRole="header" style={tituloSeccion}>2. Personas que ingresan juntas</Text>
        <Text style={ayuda}>El responsable también cuenta.</Text>
        {['Menores', 'Adultos', 'Mayores'].map((grupo) => (
          <View key={grupo}>
            <Text style={[etiqueta, styles.separado]}>{grupo}</Text>
            {CANTIDADES.filter((c) => c.grupo === grupo).map((c) => (
              <React.Fragment key={c.clave}>{contador({ clave: c.clave, titulo: `${grupo} · ${c.titulo}` })}</React.Fragment>
            ))}
          </View>
        ))}
        <Text accessibilityLiveRegion="polite" style={[etiqueta, styles.separado]}>{`Total: ${total} persona${total === 1 ? '' : 's'}`}</Text>
        {errorCampo(['total', ...CANTIDADES.map((c) => c.clave)])}
      </View>

      <View style={tarjeta}>
        <Text accessibilityRole="header" style={tituloSeccion}>3. Quiénes necesitan asistencia</Text>
        {ASISTENCIA.map((c) => (
          <View key={c.clave}>
            {contador({ clave: c.clave, titulo: c.titulo })}
            {errorCampo([c.clave])}
          </View>
        ))}
        {AVISOS.map((c) => <React.Fragment key={c.clave}>{casilla(c)}</React.Fragment>)}
      </View>

      <View style={tarjeta}>
        <Text accessibilityRole="header" style={tituloSeccion}>4. Ubicación y fotos</Text>
        <Text style={etiqueta}>Dirección o referencia *</Text>
        <TextInput value={datos.direccion} onChangeText={(texto) => cambiar({ direccion: texto })} maxLength={MAX_DIRECCION}
          accessibilityLabel="Dirección o referencia" placeholder="Calle y número, o una referencia"
          placeholderTextColor={theme.colors.textSoft} style={caja(['direccion'])} />
        {errorCampo(['direccion'])}

        <Text style={[etiqueta, styles.separado]}>Localidad</Text>
        {datos.localidad != null ? (
          <View style={[styles.elegida, { borderColor: theme.colors.primary }]}>
            <Text style={[styles.flex, styles.texto, { color: theme.colors.text, fontFamily: typography.semibold }]}>{datos.localidad_nombre || `Localidad ${datos.localidad}`}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Quitar localidad" onPress={() => cambiar({ localidad: null, localidad_nombre: '' })}>
              <Ionicons name="close-circle" size={22} color={theme.colors.textSoft} accessible={false} importantForAccessibility="no" />
            </Pressable>
          </View>
        ) : (
          <>
            <TextInput value={busquedaLocalidad} onChangeText={setBusquedaLocalidad} accessibilityLabel="Buscar localidad"
              placeholder={localidades.length ? 'Escribí para buscar' : 'Sin lista de localidades: se puede enviar sin elegir'}
              editable={localidades.length > 0} placeholderTextColor={theme.colors.textSoft} style={caja(['localidad'])} />
            {sugeridas.map((item) => (
              <Pressable key={String(item.id)} accessibilityRole="button" accessibilityLabel={`Elegir ${item.nombre}`}
                onPress={() => { cambiar({ localidad: item.id, localidad_nombre: item.nombre }); setBusquedaLocalidad(''); }}
                style={[styles.sugerida, { borderColor: theme.colors.border }]}>
                <Text style={[styles.texto, { color: theme.colors.text, fontFamily: typography.medium }]}>{item.nombre}</Text>
              </Pressable>
            ))}
          </>
        )}
        {errorCampo(['localidad'])}

        <Text style={[etiqueta, styles.separado]}>Ubicación GPS (opcional)</Text>
        {conUbicacion ? (
          <View style={styles.fila}>
            <Text style={[styles.flex, styles.texto, { color: theme.colors.text, fontFamily: typography.medium }]}>
              {`${datos.latitud}, ${datos.longitud}${datos.precision_m != null ? ` (±${datos.precision_m} m)` : ''}`}
            </Text>
            <CustomButton title="Quitar" variant="tertiary" size="SM" onPress={() => cambiar({ latitud: null, longitud: null, precision_m: null })} />
          </View>
        ) : null}
        <CustomButton title={conUbicacion ? 'Volver a tomar ubicación' : 'Tomar ubicación'} variant="secondary" iconLeft="locate-outline"
          loading={ubicando} disabled={ubicando} onPress={tomarUbicacion} />
        {errorUbicacion ? <Text style={ayuda}>{errorUbicacion}</Text> : null}
        {errorCampo(['latitud', 'longitud', 'precision_m'])}

        {FOTOS.map(({ clave, titulo }) => {
          const foto = fotos[clave];
          return (
            <View key={clave} style={styles.separado}>
              <Text style={etiqueta}>{`${titulo} (opcional)`}</Text>
              {foto ? (
                <View style={[styles.foto, { borderColor: theme.colors.border }]}>
                  <Image source={{ uri: foto.uri }} style={styles.miniatura} accessibilityLabel={titulo} />
                  <View style={styles.flex}>
                    <CustomButton title="Cambiar" variant="secondary" size="SM" onPress={() => elegirFoto(clave, titulo)} />
                  </View>
                  <Pressable accessibilityRole="button" accessibilityLabel={`Quitar ${titulo}`} onPress={() => sacarFoto(clave)}>
                    <Ionicons name="trash-outline" size={22} color={theme.colors.danger} accessible={false} importantForAccessibility="no" />
                  </Pressable>
                </View>
              ) : (
                <CustomButton title={`Agregar ${titulo.toLowerCase()}`} variant="secondary" iconLeft="camera-outline"
                  loading={fotoEnProceso === clave} disabled={!!fotoEnProceso} onPress={() => elegirFoto(clave, titulo)} />
              )}
              {errorCampo([clave])}
            </View>
          );
        })}

        <Text style={[etiqueta, styles.separado]}>Observaciones</Text>
        <TextInput value={datos.observaciones} onChangeText={(texto) => cambiar({ observaciones: texto })} multiline
          accessibilityLabel="Observaciones" placeholder="Algo más que la mesa tenga que saber"
          placeholderTextColor={theme.colors.textSoft} style={[...caja(['observaciones']), styles.areaTexto]} />
      </View>

      {listado.length ? (
        <View accessibilityRole="alert" style={[styles.card, { backgroundColor: statusTones.danger.bg, borderColor: statusTones.danger.bd }]}>
          <Text style={[styles.titulo, { color: statusTones.danger.tx, fontFamily: typography.bold }]}>Para corregir</Text>
          {listado.map(({ campo, etiqueta: nombre, texto }) => (
            <Text key={`${campo}:${texto}`} style={[styles.texto, { color: statusTones.danger.tx, fontFamily: typography.medium }]}>{`• ${nombre}: ${texto}`}</Text>
          ))}
        </View>
      ) : null}

      <CustomButton title="Enviar" size="L" iconLeft="send-outline" loading={enviando} disabled={enviando || !!fotoEnProceso} onPress={enviar} />
      <CustomButton title="Descartar relevamiento" variant="tertiary" iconLeft="trash-outline" disabled={enviando} onPress={confirmarDescarte} />

      <CameraModal visible={scanner} purpose="scanner" locked={scannerTrabado} onClose={cerrarScanner}
        onBarcodeScanned={alEscanear}
        onError={(e) => { cerrarScanner(); showToast({ type: 'error', message: e?.message || 'No se pudo iniciar la cámara.' }); }} />
    </ScrollView>
  );
}

const cantidadesYTotal = Object.fromEntries(CANTIDADES.map(({ clave }) => [clave, true]));

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
  input: { minHeight: 46, borderWidth: 1, borderRadius: radii.lg, paddingHorizontal: 12, paddingVertical: 10, fontSize: fontSizes.sm },
  areaTexto: { minHeight: 96, textAlignVertical: 'top' },
  fila: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  flex: { flex: 1 },
  opciones: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  opcion: { minHeight: 44, paddingHorizontal: 12, borderWidth: 1, borderRadius: radii.lg, alignItems: 'center', justifyContent: 'center' },
  contador: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 48 },
  paso: { width: 44, height: 44, borderWidth: 1, borderRadius: radii.full, alignItems: 'center', justifyContent: 'center' },
  valor: { minWidth: 28, textAlign: 'center', fontSize: fontSizes.base },
  casilla: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44 },
  aviso: { borderWidth: 1, borderRadius: radii.lg, padding: 10 },
  elegida: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: radii.lg, padding: 12 },
  sugerida: { borderWidth: 1, borderRadius: radii.lg, padding: 12, minHeight: 44, justifyContent: 'center' },
  foto: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderRadius: radii.lg, padding: 8 },
  miniatura: { width: 64, height: 64, borderRadius: radii.md },
});
