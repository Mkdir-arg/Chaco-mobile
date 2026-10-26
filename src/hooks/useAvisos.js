import { useCallback, useEffect, useRef, useState } from 'react';
import NetInfo from '@react-native-community/netinfo';
import relevamientoService from '../services/relevamientoService';
import { becasRequest } from '../services/becasApi';
import {
  contarNoLeidos, listarAvisos, marcarLeido, marcarTodoLeido, purgarLeidosViejos,
} from '../services/avisos';
import { detectarCola, detectarRechazos, detectarRelevamientosNuevos } from '../services/detectoresAvisos';

const CADA_15_MIN_MS = 15 * 60 * 1000;

const hayRed = async () => {
  try {
    const estado = await NetInfo.fetch();
    return !!estado?.isConnected && estado?.isInternetReachable !== false;
  } catch {
    return false;
  }
};

// Avisos dentro de la app. Todo error queda acá adentro: nunca llega a la sincronización
// ni al refresco que llaman a estas funciones.
export default function useAvisos({ activo, userId, onNuevos }) {
  const [avisos, setAvisos] = useState([]);
  const [noLeidos, setNoLeidos] = useState(0);
  const ultimaRechazosRef = useRef(0);
  const rechazosEnCursoRef = useRef(false);
  const onNuevosRef = useRef(onNuevos);
  onNuevosRef.current = onNuevos;

  const contexto = useCallback(async () => {
    const [db, owner] = await Promise.all([relevamientoService.getAvisosDb(), relevamientoService.getOwnerIdActual()]);
    return owner ? { db, owner, pedir: becasRequest, hayRed } : null;
  }, []);

  const recargar = useCallback(async () => {
    try {
      const ctx = await contexto();
      if (!ctx) { setAvisos([]); setNoLeidos(0); return; }
      await purgarLeidosViejos(ctx.db, ctx.owner);
      setAvisos(await listarAvisos(ctx.db, ctx.owner));
      setNoLeidos(await contarNoLeidos(ctx.db, ctx.owner));
    } catch (error) {
      console.warn('[AVISOS][RECARGAR]', error?.message);
    }
  }, [contexto]);

  const publicar = useCallback(async (creados) => {
    if (!creados.length) return;
    await recargar();
    try {
      onNuevosRef.current?.(creados);
    } catch {
      // El toast es accesorio.
    }
  }, [recargar]);

  // Tras cada refresco de relevamientos (cada 8 s y al reconectar). Solo con datos
  // frescos del servidor: un listado en caché no es base confiable.
  const alRefrescarRelevamientos = useCallback(async (resultado) => {
    try {
      if (!resultado || resultado.success === false || resultado.offline) return;
      const ctx = await contexto();
      if (!ctx) return;
      const records = resultado.records || [];
      const creados = [...await detectarRelevamientosNuevos(ctx, records)];
      const ahora = Date.now();
      if (ahora - ultimaRechazosRef.current >= CADA_15_MIN_MS && !rechazosEnCursoRef.current && await hayRed()) {
        rechazosEnCursoRef.current = true;
        ultimaRechazosRef.current = ahora;
        try {
          creados.push(...await detectarRechazos(ctx, records));
        } finally {
          rechazosEnCursoRef.current = false;
        }
      }
      await publicar(creados);
    } catch (error) {
      console.warn('[AVISOS][RELEVAMIENTOS]', error?.message);
    }
  }, [contexto, publicar]);

  // Tras cada pasada de sincronización, con la cola local.
  const alSincronizar = useCallback(async () => {
    try {
      const ctx = await contexto();
      if (!ctx) return;
      const operaciones = await relevamientoService.getOperacionesParaAvisos();
      await publicar(await detectarCola(ctx, operaciones));
    } catch (error) {
      console.warn('[AVISOS][COLA]', error?.message);
    }
  }, [contexto, publicar]);

  const leer = useCallback(async (aviso) => {
    try {
      const ctx = await contexto();
      if (ctx) await marcarLeido(ctx.db, ctx.owner, aviso.id);
    } catch (error) {
      console.warn('[AVISOS][LEER]', error?.message);
    }
    await recargar();
  }, [contexto, recargar]);

  const leerTodo = useCallback(async () => {
    try {
      const ctx = await contexto();
      if (ctx) await marcarTodoLeido(ctx.db, ctx.owner);
    } catch (error) {
      console.warn('[AVISOS][LEER_TODO]', error?.message);
    }
    await recargar();
  }, [contexto, recargar]);

  // Otra sesión en el mismo teléfono: cada usuario ve solo lo suyo, y al abrir la app
  // se vuelve a consultar de inmediato.
  useEffect(() => {
    ultimaRechazosRef.current = 0;
    if (!activo) { setAvisos([]); setNoLeidos(0); return; }
    recargar();
  }, [activo, userId, recargar]);

  return { avisos, noLeidos, recargar, alRefrescarRelevamientos, alSincronizar, leer, leerTodo };
}
