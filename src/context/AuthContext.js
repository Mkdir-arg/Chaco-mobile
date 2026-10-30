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
import { subscribeSinModulo } from '../services/dispositivosService';
import { moduloInicial } from '../services/modulos';

const AuthContext = createContext({});

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [moduloActivo, setModuloActivoState] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    let sessionExpired = false;
    const unsubscribe = subscribeBecasSessionExpired(() => {
      sessionExpired = true;
      if (mounted) {
        setUser(null);
        setModuloActivoState(null);
      }
    });
    // El back dejó de admitir un módulo: se actualiza la sesión; sin módulos, se sale.
    const unsubscribeSinModulo = subscribeSinModulo(async (modulo, tokenDelPedido) => {
      try {
        const next = await quitarModuloLocal(modulo, tokenDelPedido);
        if (!mounted || !next) return;
        // Sin módulos, quitarModuloLocal ya borró la sesión guardada.
        if (!next.modulos.length) {
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
    await clearBecasSession();
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
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);
