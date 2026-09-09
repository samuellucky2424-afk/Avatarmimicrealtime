import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { ROUTES } from '@/lib/routes';
import { DB_RPC, DB_TABLES } from '@/lib/dbNames';
import { apiFetch } from '@/lib/api-client';
import { supabase } from '@/lib/supabase';
import type { Session, User as SupabaseUser } from '@supabase/supabase-js';

interface User {
  id: string;
  name: string;
  email: string;
  avatar?: string;
  createdAt?: string;
}

interface AuthContextType {
  user: User | null;
  isAuthenticated: boolean;
  isAdmin: boolean;
  adminLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  register: (email: string, name: string, password: string) => Promise<void>;
  loading: boolean;
  error: string | null;
  clearError: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

function formatUser(su: SupabaseUser): User {
  return {
    id: su.id,
    name: su.user_metadata?.name || su.email?.split('@')[0] || 'User',
    email: su.email || '',
    avatar: su.user_metadata?.avatar_url,
    createdAt: su.created_at,
  };
}

function sameUser(previous: User | null, next: User): boolean {
  return previous?.id === next.id
    && previous.name === next.name
    && previous.email === next.email
    && previous.avatar === next.avatar
    && previous.createdAt === next.createdAt;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);
  const [adminLoading, setAdminLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  // Backend-enforced admin check via Supabase RPC.
  // The DB function reads the clone admins table for
  // the currently authenticated user — the client cannot forge this result.
  const checkAdmin = useCallback(async (session: Session): Promise<boolean> => {
    try {
      const { data, error: rpcError } = await supabase.rpc(DB_RPC.isCurrentUserAdmin);
      if (!rpcError && Boolean(data)) {
        return true;
      }

      if (rpcError) {
        console.warn(`[auth] ${DB_RPC.isCurrentUserAdmin} RPC error:`, rpcError.message);
      }

      const userId = session.user.id;

      const { data: adminRow, error: adminError } = await supabase
        .from(DB_TABLES.admins)
        .select('user_id')
        .eq('user_id', userId)
        .maybeSingle();

      if (adminError) {
        console.warn(`[auth] ${DB_TABLES.admins} fallback admin check failed:`, adminError.message);
      } else if (adminRow?.user_id) {
        return true;
      }

      const userEmail = session.user.email;
      if (userEmail) {
        const { data: adminEmailRow, error: adminEmailError } = await supabase
          .from(DB_TABLES.admins)
          .select('user_id')
          .ilike('email', userEmail)
          .maybeSingle();

        if (adminEmailError) {
          console.warn(`[auth] ${DB_TABLES.admins} email fallback admin check failed:`, adminEmailError.message);
        } else if (adminEmailRow?.user_id) {
          return true;
        }
      }

      const bearerToken = session.access_token;
      if (bearerToken) {
        const response = await apiFetch('/admin-status', {
          headers: {
            Authorization: `Bearer ${bearerToken}`,
          },
        });

        if (response.ok) {
          const status = await response.json().catch(() => null);
          return Boolean(status?.isAdmin);
        }

        const status = await response.json().catch(() => null);
        console.warn('[auth] admin-status fallback failed:', response.status, status?.warning || status?.error || status);
      }

      return false;
    } catch (e) {
      console.warn(`[auth] ${DB_RPC.isCurrentUserAdmin} failed:`, e);
      return false;
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    let receivedSession = false;
    let currentUserId: string | null = null;
    let adminRequest = 0;
    let adminTimer: ReturnType<typeof setTimeout> | undefined;

    // INITIAL_SESSION also restores the persisted login. A second getSession()
    // request can race newer sign-in/sign-out events, so use this single source.
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (!mounted) return;
      // A late initial snapshot must not undo a newer sign-in or sign-out.
      if (event === 'INITIAL_SESSION' && receivedSession) return;
      if (session?.user || event === 'INITIAL_SESSION' || event === 'SIGNED_OUT') {
        receivedSession = true;
      }

      if (!session?.user) {
        if (event !== 'SIGNED_OUT' && event !== 'INITIAL_SESSION') return;
        currentUserId = null;
        adminRequest += 1;
        clearTimeout(adminTimer);
        setUser(null);
        setIsAdmin(false);
        setAdminLoading(false);
        setLoading(false);
        return;
      }

      const identityChanged = currentUserId !== session.user.id;
      currentUserId = session.user.id;
      const nextUser = formatUser(session.user);
      setUser(previous => sameUser(previous, nextUser) ? previous : nextUser);
      setLoading(false);

      // Refresh/focus events must not replace the protected page with a loader:
      // unmounting Dashboard stops its active camera and AI session.
      if (identityChanged) {
        setIsAdmin(false);
        setAdminLoading(true);
      } else if (event !== 'TOKEN_REFRESHED' && event !== 'USER_UPDATED') {
        return;
      }

      const request = ++adminRequest;
      clearTimeout(adminTimer);
      // Supabase invokes auth callbacks while holding its auth lock. Keep all
      // API work outside that callback, and ignore results from older sessions.
      adminTimer = setTimeout(() => {
        void checkAdmin(session).then(admin => {
          if (!mounted || request !== adminRequest) return;
          setIsAdmin(admin);
          setAdminLoading(false);
        });
      }, 0);
    });

    return () => {
      mounted = false;
      clearTimeout(adminTimer);
      subscription.unsubscribe();
    };
  }, [checkAdmin]);

  const clearError = useCallback(() => setError(null), []);

  const login = async (email: string, password: string) => {
    setLoading(true);
    setError(null);
    try {
      const { error: authError } = await supabase.auth.signInWithPassword({ email, password });
      if (authError) throw authError;
      // The auth subscription updates state once; PublicRoute redirects after
      // that session's admin check completes.
    } catch (err: any) {
      const message = err.message || 'Login failed';
      setError(message);
      throw err;
    } finally {
      setLoading(false);
    }
  };

  const register = async (email: string, name: string, password: string) => {
    setLoading(true);
    setError(null);
    try {
      if (name.trim().length < 2) throw new Error('Name must be at least 2 characters');

      const { error: authError } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: {
            name: name.trim(),
            app: 'virtualpresenceai',
            app_name: 'Virtual Presence AI',
          },
        },
      });
      if (authError) throw authError;

      navigate(ROUTES.DEFAULT, { replace: true });
    } catch (err: any) {
      const message = err.message || 'Registration failed';
      setError(message);
      throw err;
    } finally {
      setLoading(false);
    }
  };

  const logout = useCallback(async () => {
    setLoading(true);
    try {
      const { error: authError } = await supabase.auth.signOut();
      if (authError) throw authError;
      setError(null);
      navigate(ROUTES.PUBLIC.LOGIN, { replace: true });
    } catch (err) {
      console.error('Logout error:', err);
    } finally {
      setLoading(false);
    }
  }, [navigate]);

  return (
    <AuthContext.Provider value={{
      user,
      isAuthenticated: !!user,
      isAdmin,
      adminLoading,
      login,
      logout,
      register,
      loading,
      error,
      clearError,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
