import React, { createContext, useContext, useEffect, useState } from 'react';
import {
  clearBecasSession,
  getModuloActivo,
  getStoredBecasUser,
  loginBecas,
  quitarModuloLocal,
  setModuloActivo as guardarModuloActivo,
  subscribeBecasSessionExpired,
} from '../services/becasApi';
import { subscribeSinModulo } from '../services/sinModulo';
import { olvidarPerfilGuardado } from '../services/emergenciaPerfil';
import { depurarBorradoresFicha, limpiarDatosLocalesEmergencia } from '../services/emergenciaLimpieza';

// Los borradores de la ficha de Emergencia tienen datos personales y de salud: no sobreviven a la
// sesión (logout, sesión vencida o sin el módulo). Si falla, el resto sigue igual.
const limpiarEmergencia = async () => {
  try {
    await limpiarDatosLocalesEmergencia();
  } catch {
    // Al abrir el módulo o al entrar se vuelven a depurar.
  }
};
import { moduloInicial } from '../services/modulos';

const AuthContext = createContext({});

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [moduloActivo, setModuloActivoState] = useState(null);
  const [loading, setLoading] = useState(true);
  // Por qué se cerró la sesión sin que la persona lo pidiera; lo muestra LoginScreen.
  const [avisoSesion, setAvisoSesion] = useState(null);

  useEffect(() => {
    let mounted = true;
    let sessionExpired = false;
    const unsubscribe = subscribeBecasSessionExpired(() => {
      sessionExpired = true;
      limpiarEmergencia();
      if (mounted) {
        setUser(null);
        setModuloActivoState(null);
      }
    });
    // El back dejó de admitir un módulo: se actualiza la sesión; sin módulos, se sale.
    const unsubscribeSinModulo = subscribeSinModulo(async (modulo, tokenDelPedido, detalle) => {
      try {
        const next = await quitarModuloLocal(modulo, tokenDelPedido);
        if (next && (modulo === 'emergencia' || !next.modulos.length)) await limpiarEmergencia();
        if (!mounted || !next) return;
        // Sin módulos, quitarModuloLocal ya borró la sesión guardada.
        if (!next.modulos.length) {
          setAvisoSesion(detalle || 'Tu usuario ya no tiene acceso a la app.');
          setUser(null);
          setModuloActivoState(null);
          return;
        }
        setUser(next);
        setModuloActivoState((actual) => (actual === modulo || !next.modulos.includes(actual)
          ? moduloInicial(next.modulos, null) : actual));
      } catch {
        // Sin poder actualizar la sesión guardada se deja como está.
      }
    });
    (async () => {
      try {
        const stored = await getStoredBecasUser();
        const guardado = stored ? await getModuloActivo() : null;
        if (mounted && !sessionExpired) {
          setUser(stored);
          setModuloActivoState(stored ? moduloInicial(stored.modulos, guardado) : null);
        }
      } catch {
        if (mounted) setUser(null);
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => {
      mounted = false;
      unsubscribe();
      unsubscribeSinModulo();
    };
  }, []);

  const login = async (username, password) => {
    try {
      const nextUser = await loginBecas({ username, password });
      // Los borradores de otro usuario (o vencidos) que hayan quedado no esperan a abrir Emergencia.
      depurarBorradoresFicha(nextUser?.id).catch(() => {});
      setAvisoSesion(null);
      setUser(nextUser);
      setModuloActivoState(moduloInicial(nextUser.modulos, null));
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error?.message || 'No se pudo iniciar sesion.',
        code: error?.code || null,
      };
    }
  };

  const logout = async () => {
    const ownerId = user?.id;
    await clearBecasSession();
    await olvidarPerfilGuardado(ownerId);
    await limpiarEmergencia();
    setAvisoSesion(null);
    setUser(null);
    setModuloActivoState(null);
  };

  const elegirModulo = async (modulo) => {
    setModuloActivoState(modulo);
    if (modulo) await guardarModuloActivo(modulo);
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        isAuthenticated: !!user,
        modulos: user?.modulos || [],
        moduloActivo,
        elegirModulo,
        login,
        logout,
        avisoSesion,
        limpiarAvisoSesion: () => setAvisoSesion(null),
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);
