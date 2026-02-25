'use client';

import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { getToken, setToken, removeToken, getStoredUser, setStoredUser } from '../lib/auth';
import { login as apiLogin, register as apiRegister } from '../lib/api';

interface User {
  id: string;
  email: string;
}

interface AuthContextValue {
  token: string | null;
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  logout: () => void;
  isAuthenticated: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setTokenState] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  useEffect(() => {
    const t = getToken();
    const u = getStoredUser();
    setTokenState(t);
    setUser(u);
    setLoading(false);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const data = await apiLogin(email, password);
    setToken(data.token);
    setStoredUser(data.user);
    setTokenState(data.token);
    setUser(data.user);
    router.push('/');
  }, [router]);

  const register = useCallback(async (email: string, password: string) => {
    const data = await apiRegister(email, password);
    setToken(data.token);
    setStoredUser(data.user);
    setTokenState(data.token);
    setUser(data.user);
    router.push('/');
  }, [router]);

  const logout = useCallback(() => {
    removeToken();
    setTokenState(null);
    setUser(null);
    router.push('/login');
  }, [router]);

  const value: AuthContextValue = {
    token,
    user,
    loading,
    login,
    register,
    logout,
    isAuthenticated: !!token,
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
}
