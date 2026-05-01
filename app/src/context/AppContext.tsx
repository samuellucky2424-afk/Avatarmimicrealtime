import { createContext, useContext, useState, useCallback, useMemo, useEffect } from 'react';
import type { ReactNode } from 'react';
import { apiFetch } from '@/lib/api-client';
import { useAuth } from './AuthContext';

export interface Transaction {
  id: string;
  type: 'credit' | 'debit';
  amount: number;
  credits: number;
  description: string;
  timestamp: string;
}

interface AppContextType {
  balance: number;
  credits: number;
  setBalance: (balance: number) => void;
  setCredits: (credits: number) => void;
  addBalance: (amount: number) => void;
  addCredits: (amount: number) => void;
  deductBalance: (amount: number) => void;
  deductCredits: (amount: number) => void;
  sessionStatus: 'LIVE' | 'IDLE';
  setSessionStatus: (status: 'LIVE' | 'IDLE') => void;
  isLoading: boolean;
  setLoading: (loading: boolean) => void;
  transactions: Transaction[];
  addTransaction: (transaction: Omit<Transaction, 'id' | 'timestamp'>) => void;
  notifications: Notification[];
  addNotification: (notification: Omit<Notification, 'id' | 'timestamp'>) => void;
  clearNotifications: () => void;
}

export interface Notification {
  id: string;
  type: 'success' | 'error' | 'warning' | 'info';
  title: string;
  message: string;
  timestamp: string;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

const BALANCE_KEY = 'morphly_balance';
const CREDITS_KEY = 'morphly_credits';
const TRANSACTIONS_KEY = 'morphly_transactions';

export function AppProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [balance, setBalanceState] = useState(0);
  const [credits, setCreditsState] = useState(0);
  const [sessionStatus, setSessionStatus] = useState<'LIVE' | 'IDLE'>('IDLE');
  const [isLoading, setLoading] = useState(false);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);

  const syncWallet = useCallback(async () => {
    if (!user?.id) {
      setBalanceState(0);
      setCreditsState(0);
      setTransactions([]);
      localStorage.removeItem(BALANCE_KEY);
      localStorage.removeItem(CREDITS_KEY);
      localStorage.removeItem(TRANSACTIONS_KEY);
      return;
    }

    try {
      const res = await apiFetch(`/wallet?userId=${user.id}`);
      if (!res.ok) {
        const rawBody = await res.text();
        let apiError = rawBody;
        try {
          const parsedBody = JSON.parse(rawBody);
          apiError = parsedBody?.error || parsedBody?.message || rawBody;
        } catch {
          // Keep raw body when response is not JSON.
        }

        const errorDetail = apiError ? `: ${apiError}` : '';
        throw new Error(`API returned ${res.status}${errorDetail}`);
      }

      const text = await res.text();
      let data: any;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`Invalid JSON format from API: ${text.substring(0, 20)}`);
      }

      if (data?.balance !== undefined) {
        setBalanceState(data.balance);
        localStorage.setItem(BALANCE_KEY, String(data.balance));
      }
      if (data?.credits !== undefined) {
        setCreditsState(data.credits);
        localStorage.setItem(CREDITS_KEY, String(data.credits));
      }

      const nextTransactions = Array.isArray(data?.transactions) ? data.transactions : [];
      setTransactions(nextTransactions);
      localStorage.setItem(TRANSACTIONS_KEY, JSON.stringify(nextTransactions));
    } catch (err) {
      console.warn('Failed to sync wallet data:', err);
    }
  }, [user?.id]);

  useEffect(() => {
    void syncWallet();
  }, [syncWallet]);

  useEffect(() => {
    if (!user?.id) {
      return;
    }

    const handleFocus = () => {
      void syncWallet();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void syncWallet();
      }
    };

    const intervalId = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void syncWallet();
      }
    }, 30000);

    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [syncWallet, user?.id]);

  const setBalance = useCallback((newBalance: number) => {
    setBalanceState(newBalance);
    localStorage.setItem(BALANCE_KEY, newBalance.toString());
  }, []);

  const setCredits = useCallback((newCredits: number) => {
    setCreditsState(newCredits);
    localStorage.setItem(CREDITS_KEY, newCredits.toString());
  }, []);

  const addBalance = useCallback((amount: number) => {
    const transaction: Transaction = {
      id: `tx_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      type: 'credit',
      amount,
      credits: 0,
      description: 'Balance added',
      timestamp: new Date().toISOString(),
    };
    
    setBalanceState(prev => {
      const newBalance = prev + amount;
      localStorage.setItem(BALANCE_KEY, newBalance.toString());
      return newBalance;
    });
    
    setTransactions(prev => {
      const updated = [transaction, ...prev].slice(0, 50);
      localStorage.setItem(TRANSACTIONS_KEY, JSON.stringify(updated));
      return updated;
    });
  }, []);

  const addCredits = useCallback((amount: number) => {
    const transaction: Transaction = {
      id: `tx_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      type: 'credit',
      amount: 0,
      credits: amount,
      description: 'Credits purchased',
      timestamp: new Date().toISOString(),
    };
    
    setCreditsState(prev => {
      const newCredits = prev + amount;
      localStorage.setItem(CREDITS_KEY, newCredits.toString());
      return newCredits;
    });
    
    setTransactions(prev => {
      const updated = [transaction, ...prev].slice(0, 50);
      localStorage.setItem(TRANSACTIONS_KEY, JSON.stringify(updated));
      return updated;
    });
  }, []);

  const deductBalance = useCallback((amount: number) => {
    const transaction: Transaction = {
      id: `tx_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      type: 'debit',
      amount,
      credits: 0,
      description: 'Session usage',
      timestamp: new Date().toISOString(),
    };
    
    setBalanceState(prev => {
      const newBalance = Math.max(0, prev - amount);
      localStorage.setItem(BALANCE_KEY, newBalance.toString());
      return newBalance;
    });
    
    setTransactions(prev => {
      const updated = [transaction, ...prev].slice(0, 50);
      localStorage.setItem(TRANSACTIONS_KEY, JSON.stringify(updated));
      return updated;
    });
  }, []);

  const deductCredits = useCallback((amount: number) => {
    const transaction: Transaction = {
      id: `tx_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      type: 'debit',
      amount: 0,
      credits: amount,
      description: 'Stream usage',
      timestamp: new Date().toISOString(),
    };
    
    setCreditsState(prev => {
      const newCredits = Math.max(0, prev - amount);
      localStorage.setItem(CREDITS_KEY, newCredits.toString());
      return newCredits;
    });
    
    setTransactions(prev => {
      const updated = [transaction, ...prev].slice(0, 50);
      localStorage.setItem(TRANSACTIONS_KEY, JSON.stringify(updated));
      return updated;
    });
  }, []);

  const addTransaction = useCallback((transactionData: Omit<Transaction, 'id' | 'timestamp'>) => {
    const transaction: Transaction = {
      ...transactionData,
      id: `tx_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date().toISOString(),
    };
    
    setTransactions(prev => {
      const updated = [transaction, ...prev].slice(0, 50);
      localStorage.setItem(TRANSACTIONS_KEY, JSON.stringify(updated));
      return updated;
    });
  }, []);

  const addNotification = useCallback((notificationData: Omit<Notification, 'id' | 'timestamp'>) => {
    const notification: Notification = {
      ...notificationData,
      id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date().toISOString(),
    };
    
    setNotifications(prev => {
      const updated = [notification, ...prev].slice(0, 20);
      return updated;
    });
    
    setTimeout(() => {
      setNotifications(prev => prev.filter(n => n.id !== notification.id));
    }, 5000);
  }, []);

  const clearNotifications = useCallback(() => {
    setNotifications([]);
  }, []);

  const value = useMemo(() => ({
    balance,
    credits,
    setBalance,
    setCredits,
    addBalance,
    addCredits,
    deductBalance,
    deductCredits,
    sessionStatus,
    setSessionStatus,
    isLoading,
    setLoading,
    transactions,
    addTransaction,
    notifications,
    addNotification,
    clearNotifications,
  }), [balance, credits, setBalance, setCredits, addBalance, addCredits, deductBalance, deductCredits, sessionStatus, isLoading, transactions, addTransaction, notifications, addNotification, clearNotifications]);

  return (
    <AppContext.Provider value={value}>
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const context = useContext(AppContext);
  if (context === undefined) {
    throw new Error('useApp must be used within an AppProvider');
  }
  return context;
}
