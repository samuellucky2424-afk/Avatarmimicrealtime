import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/context/AuthContext';
import { apiFetch } from '@/lib/api-client';
import { DB_RPC, DB_TABLES } from '@/lib/dbNames';
import { ROUTES } from '@/lib/routes';
import { formatNaira, resolveStoredPlanPriceNGN } from '@/lib/pricing';
import { BrandIcon } from '@/components/BrandIcon';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { LogOut, Search, Plus, Trash2, Pencil, Ban, Coins, Users, Activity, Banknote, BellRing } from 'lucide-react';

interface AdminUser {
  id: string;
  email: string;
  credits: number;
  is_blocked: boolean;
  blocked_reason: string | null;
  created_at: string;
}

interface Plan {
  id: string;
  name: string;
  credits: number;
  // The live database/RPC still uses the legacy usd_price name, but the value is now entered and shown as NGN.
  usd_price: number;
  created_at?: string;
}

interface AdminStats {
  total_users: number;
  blocked_users: number;
  total_credits: number;
  total_revenue: number;
  active_sessions: number;
}

interface AuditEntry {
  id: string;
  actor_id: string | null;
  action: string;
  target_table: string | null;
  target_id: string | null;
  payload: any;
  created_at: string;
}

type NotificationSeverity = 'info' | 'warning' | 'critical';

interface UserNotification {
  id: string;
  message: string;
  severity: NotificationSeverity;
  is_active: boolean;
  created_at: string;
}

export default function AdminDashboard() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const [stats, setStats] = useState<AdminStats | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [search, setSearch] = useState('');
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [loadingPlans, setLoadingPlans] = useState(false);
  const [notifications, setNotifications] = useState<UserNotification[]>([]);
  const [notificationMessage, setNotificationMessage] = useState('');
  const [notificationSeverity, setNotificationSeverity] = useState<NotificationSeverity>('warning');
  const [savingNotification, setSavingNotification] = useState(false);
  const [whatsAppNumber, setWhatsAppNumber] = useState('');
  const [savingWhatsApp, setSavingWhatsApp] = useState(false);

  // Credits dialog
  const [creditsOpen, setCreditsOpen] = useState(false);
  const [creditsTarget, setCreditsTarget] = useState<AdminUser | null>(null);
  const [creditsValue, setCreditsValue] = useState('0');
  const [creditsReason, setCreditsReason] = useState('');

  // Block dialog
  const [blockOpen, setBlockOpen] = useState(false);
  const [blockTarget, setBlockTarget] = useState<AdminUser | null>(null);
  const [blockReason, setBlockReason] = useState('');

  // Plan editor
  const [planOpen, setPlanOpen] = useState(false);
  const [editingPlan, setEditingPlan] = useState<Plan | null>(null);
  const [planForm, setPlanForm] = useState<{ name: string; credits: string; price_ngn: string }>({
    name: '', credits: '', price_ngn: '',
  });

  const loadStats = useCallback(async () => {
    const { data, error } = await supabase.rpc(DB_RPC.adminStats);
    if (error) {
      toast.error('Stats error: ' + error.message);
      return;
    }
    setStats(data as AdminStats);
  }, []);

  const loadUsers = useCallback(async (q: string = '') => {
    setLoadingUsers(true);
    const { data, error } = await supabase.rpc(DB_RPC.adminListUsers, {
      p_search: q || null, p_limit: 200, p_offset: 0,
    });
    setLoadingUsers(false);
    if (error) {
      toast.error('Users error: ' + error.message);
      return;
    }
    setUsers((data as AdminUser[]) || []);
  }, []);

  const loadPlans = useCallback(async () => {
    setLoadingPlans(true);
    const { data, error } = await supabase
      .from(DB_TABLES.plans)
      .select('*')
      .order('credits', { ascending: true });
    setLoadingPlans(false);
    if (error) {
      toast.error('Plans error: ' + error.message);
      return;
    }
    setPlans((data as Plan[]) || []);
  }, []);

  const loadAudit = useCallback(async () => {
    const { data, error } = await supabase
      .from(DB_TABLES.auditLog)
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) {
      // not critical, ignore silently
      return;
    }
    setAudit((data as AuditEntry[]) || []);
  }, []);

  const loadNotifications = useCallback(async () => {
    const { data, error } = await supabase
      .from(DB_TABLES.notifications)
      .select('id,message,severity,is_active,created_at')
      .order('created_at', { ascending: false })
      .limit(20);
    if (error) {
      toast.error('Notifications error: ' + error.message);
      return;
    }
    setNotifications((data as UserNotification[]) || []);
  }, []);

  const loadWhatsAppNumber = useCallback(async () => {
    const { data, error } = await supabase
      .from(DB_TABLES.appSettings)
      .select('value')
      .eq('key', 'whatsapp_sales_number')
      .maybeSingle();
    if (error) {
      toast.error('WhatsApp settings error: ' + error.message);
      return;
    }
    setWhatsAppNumber(data?.value || '');
  }, []);

  useEffect(() => {
    void loadStats();
    void loadUsers();
    void loadPlans();
    void loadAudit();
    void loadNotifications();
    void loadWhatsAppNumber();
  }, [loadStats, loadUsers, loadPlans, loadAudit, loadNotifications, loadWhatsAppNumber]);

  const saveWhatsAppNumber = async () => {
    const normalized = whatsAppNumber.replace(/\D/g, '');
    if (normalized.length < 8 || normalized.length > 15) {
      toast.error('Enter the WhatsApp number with country code, using 8 to 15 digits.');
      return;
    }
    if (!user?.id) {
      toast.error('Admin session is unavailable. Please sign in again.');
      return;
    }

    setSavingWhatsApp(true);
    const { error } = await supabase.from(DB_TABLES.appSettings).upsert({
      key: 'whatsapp_sales_number',
      value: normalized,
      updated_by: user.id,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'key' });
    setSavingWhatsApp(false);
    if (error) {
      toast.error('Failed to save WhatsApp number: ' + error.message);
      return;
    }
    setWhatsAppNumber(normalized);
    toast.success('WhatsApp sales number saved.');
  };

  const publishNotification = async () => {
    const message = notificationMessage.trim();
    if (!message) {
      toast.error('Enter a notification message.');
      return;
    }
    if (!user?.id) {
      toast.error('Admin session is unavailable. Please sign in again.');
      return;
    }

    setSavingNotification(true);
    const { error: deactivateError } = await supabase
      .from(DB_TABLES.notifications)
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('is_active', true);
    if (deactivateError) {
      setSavingNotification(false);
      toast.error('Failed to replace the current notification: ' + deactivateError.message);
      return;
    }

    const { error } = await supabase.from(DB_TABLES.notifications).insert({
      message,
      severity: notificationSeverity,
      is_active: true,
      created_by: user.id,
    });
    setSavingNotification(false);
    if (error) {
      toast.error('Failed to publish notification: ' + error.message);
      return;
    }

    setNotificationMessage('');
    toast.success('Notification published to user dashboards.');
    void loadNotifications();
  };

  const clearActiveNotification = async () => {
    setSavingNotification(true);
    const { error } = await supabase
      .from(DB_TABLES.notifications)
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('is_active', true);
    setSavingNotification(false);
    if (error) {
      toast.error('Failed to clear notification: ' + error.message);
      return;
    }
    toast.success('User notification cleared.');
    void loadNotifications();
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    void loadUsers(search.trim());
  };

  // ---- Credits ----
  const openCredits = (u: AdminUser) => {
    setCreditsTarget(u);
    setCreditsValue(String(u.credits));
    setCreditsReason('');
    setCreditsOpen(true);
  };

  const submitCredits = async () => {
    if (!creditsTarget) return;
    const credits = Math.max(0, Math.floor(Number(creditsValue) || 0));
    const { error } = await supabase.rpc(DB_RPC.adminSetCredits, {
      p_user_id: creditsTarget.id,
      p_credits: credits,
      p_reason: creditsReason || null,
    });
    if (error) {
      toast.error('Failed: ' + error.message);
      return;
    }
    toast.success(`Set credits to ${credits} for ${creditsTarget.email}`);
    setCreditsOpen(false);
    void loadUsers(search.trim());
    void loadStats();
    void loadAudit();
  };

  // ---- Block ----
  const openBlock = (u: AdminUser) => {
    setBlockTarget(u);
    setBlockReason('');
    setBlockOpen(true);
  };

  const submitBlock = async (blocked: boolean) => {
    if (!blockTarget) return;
    const { error } = await supabase.rpc(DB_RPC.adminSetBlocked, {
      p_user_id: blockTarget.id,
      p_blocked: blocked,
      p_reason: blocked ? (blockReason || null) : null,
    });
    if (error) {
      toast.error('Failed: ' + error.message);
      return;
    }
    toast.success(blocked ? 'User blocked' : 'User unblocked');
    setBlockOpen(false);
    void loadUsers(search.trim());
    void loadStats();
    void loadAudit();
  };

  const quickToggleBlock = async (u: AdminUser) => {
    if (u.is_blocked) {
      const { error } = await supabase.rpc(DB_RPC.adminSetBlocked, {
        p_user_id: u.id, p_blocked: false, p_reason: null,
      });
      if (error) { toast.error(error.message); return; }
      toast.success('User unblocked');
      void loadUsers(search.trim());
      void loadStats();
      void loadAudit();
    } else {
      openBlock(u);
    }
  };

  // ---- Plans ----
  const openPlanCreate = () => {
    setEditingPlan(null);
    setPlanForm({ name: '', credits: '', price_ngn: '' });
    setPlanOpen(true);
  };
  const openPlanEdit = (p: Plan) => {
    setEditingPlan(p);
    setPlanForm({ name: p.name, credits: String(p.credits), price_ngn: String(resolveStoredPlanPriceNGN(p.usd_price)) });
    setPlanOpen(true);
  };
  const submitPlan = async () => {
    const credits = Math.max(0, Math.floor(Number(planForm.credits) || 0));
    const priceNGN = Math.max(0, Number(planForm.price_ngn) || 0);
    if (!planForm.name.trim()) { toast.error('Name required'); return; }

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        throw new Error('Please log in again before editing pricing.');
      }

      const response = await apiFetch('/admin-plan', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id: editingPlan?.id ?? null,
          name: planForm.name.trim(),
          credits,
          priceNGN,
        }),
      });

      const result = await response.json().catch(() => ({}));
      if (!response.ok || result?.status !== 'success') {
        throw new Error(result?.message || `Pricing API returned HTTP ${response.status}`);
      }
    } catch (apiError) {
      console.warn('[admin] pricing API failed, falling back to RPC:', apiError);
      const { error } = await supabase.rpc(DB_RPC.adminUpsertPlan, {
        p_id: editingPlan?.id ?? null,
        p_name: planForm.name.trim(),
        p_credits: credits,
        p_usd_price: priceNGN,
      });
      if (error) {
        const apiMessage = apiError instanceof Error ? apiError.message : 'Pricing API failed';
        toast.error(`Failed: ${apiMessage}. RPC fallback: ${error.message}`);
        return;
      }
    }

    toast.success(editingPlan ? 'Plan updated' : 'Plan created');
    setPlanOpen(false);
    void loadPlans();
    void loadAudit();
  };
  const deletePlan = async (p: Plan) => {
    if (!confirm(`Delete plan "${p.name}"?`)) return;
    const { error } = await supabase.rpc(DB_RPC.adminDeletePlan, { p_id: p.id });
    if (error) { toast.error('Failed: ' + error.message); return; }
    toast.success('Plan deleted');
    void loadPlans();
    void loadAudit();
  };

  const handleSignOut = async () => {
    await logout();
    navigate(ROUTES.PUBLIC.LOGIN, { replace: true });
  };

  const statCards = useMemo(() => ([
    { label: 'Total Users', value: stats?.total_users ?? '—', meta: 'Registered accounts', icon: Users, tone: 'text-slate-500' },
    { label: 'Blocked', value: stats?.blocked_users ?? '—', meta: 'Restricted accounts', icon: Ban, tone: 'text-rose-600' },
    { label: 'Total Credits', value: stats?.total_credits ?? '—', meta: 'Wallet balance', icon: Coins, tone: 'text-slate-500' },
    { label: 'Revenue (NGN)', value: stats ? Number(stats.total_revenue).toLocaleString() : '—', meta: 'Purchase value', icon: Banknote, tone: 'text-emerald-600' },
    { label: 'Active Sessions', value: stats?.active_sessions ?? '—', meta: 'Current activity', icon: Activity, tone: 'text-slate-500' },
  ]), [stats]);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex h-12 max-w-7xl items-center justify-between gap-3 px-4 sm:px-6 lg:px-8">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-slate-950">
              <BrandIcon className="h-5 w-5" />
            </div>
            <div className="flex min-w-0 items-baseline gap-2">
              <span className="text-sm font-semibold tracking-tight text-slate-900">Avatar Mimic Real Time</span>
              <span className="hidden text-[11px] uppercase tracking-[0.16em] text-slate-400 sm:inline">Admin Console</span>
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span className="hidden items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 font-medium text-emerald-700 sm:inline-flex">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> Online
            </span>
            <span className="hidden text-slate-600 md:inline">{user?.email}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={handleSignOut}
              className="h-7 rounded-md border-slate-300 bg-white px-2.5 text-xs text-slate-700 hover:bg-slate-100"
            >
              <LogOut className="mr-1 h-3.5 w-3.5" /> Sign out
            </Button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-7xl space-y-4 px-4 py-4 sm:px-6 lg:px-8 lg:py-5">
        <section className="flex flex-col gap-1">
          <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Overview</div>
          <div className="flex flex-wrap items-end justify-between gap-2">
            <h1 className="text-xl font-semibold tracking-tight text-slate-950">Operations Dashboard</h1>
            <p className="text-xs text-slate-500">Signed in as <span className="font-medium text-slate-700">{user?.email}</span> · RLS protected</p>
          </div>
        </section>

        <section className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-slate-200 bg-slate-200 md:grid-cols-3 xl:grid-cols-5">
          {statCards.map((s) => {
            const Icon = s.icon;
            return (
              <div key={s.label} className="bg-white px-3.5 py-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">{s.label}</p>
                  <Icon className={`h-3.5 w-3.5 ${s.tone}`} />
                </div>
                <p className="mt-1.5 text-xl font-semibold leading-none tracking-tight text-slate-950 tabular-nums">{s.value}</p>
                <p className="mt-1 text-[11px] text-slate-500">{s.meta}</p>
              </div>
            );
          })}
        </section>

        <Tabs defaultValue="users" className="gap-3">
          <div className="border-b border-slate-200">
            <TabsList className="h-9 gap-0 rounded-none border-0 bg-transparent p-0 shadow-none">
              <TabsTrigger
                value="users"
                className="rounded-none border-b-2 border-transparent px-3 py-2 text-sm text-slate-600 data-[state=active]:border-[#0c56d7] data-[state=active]:bg-transparent data-[state=active]:text-slate-950 data-[state=active]:shadow-none"
              >
                Users
              </TabsTrigger>
              <TabsTrigger
                value="pricing"
                className="rounded-none border-b-2 border-transparent px-3 py-2 text-sm text-slate-600 data-[state=active]:border-[#0c56d7] data-[state=active]:bg-transparent data-[state=active]:text-slate-950 data-[state=active]:shadow-none"
              >
                Pricing
              </TabsTrigger>
              <TabsTrigger
                value="notifications"
                className="rounded-none border-b-2 border-transparent px-3 py-2 text-sm text-slate-600 data-[state=active]:border-[#0c56d7] data-[state=active]:bg-transparent data-[state=active]:text-slate-950 data-[state=active]:shadow-none"
              >
                Notifications
              </TabsTrigger>
              <TabsTrigger
                value="audit"
                className="rounded-none border-b-2 border-transparent px-3 py-2 text-sm text-slate-600 data-[state=active]:border-[#0c56d7] data-[state=active]:bg-transparent data-[state=active]:text-slate-950 data-[state=active]:shadow-none"
              >
                Audit Log
              </TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="users">
            <Card className="gap-0 rounded-md border-slate-200 bg-white shadow-none">
              <CardHeader className="border-b border-slate-200 px-4 py-3">
                <CardTitle className="text-sm font-semibold text-slate-900">Users</CardTitle>
                <CardDescription className="text-xs text-slate-500">Edit credit balances, apply restrictions, and search the user base.</CardDescription>
              </CardHeader>
              <CardContent className="p-4">
                <form onSubmit={handleSearch} className="mb-3 flex flex-col gap-2 md:flex-row md:items-center">
                  <div className="relative flex-1">
                    <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                    <Input
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Search by email"
                      className="h-8 rounded-md border-slate-300 bg-white pl-8 text-xs text-slate-900 placeholder:text-slate-400"
                    />
                  </div>
                  <Button type="submit" className="h-8 rounded-md bg-[#0c56d7] px-3 text-xs text-white hover:bg-[#0948b5]">Search</Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="h-8 rounded-md border-slate-300 bg-white px-3 text-xs text-slate-700 hover:bg-slate-100"
                    onClick={() => { setSearch(''); void loadUsers(''); }}
                  >
                    Reset
                  </Button>
                </form>

                <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500">
                  <span>{loadingUsers ? 'Loading accounts…' : `Showing ${users.length} account${users.length === 1 ? '' : 's'}`}</span>
                  <span>Search via admin RPC</span>
                </div>

                <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
                  <Table>
                    <TableHeader>
                      <TableRow className="border-slate-200 bg-slate-50 hover:bg-slate-50">
                        <TableHead className="h-9 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">Email</TableHead>
                        <TableHead className="h-9 text-right text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">Credits</TableHead>
                        <TableHead className="h-9 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">Status</TableHead>
                        <TableHead className="h-9 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">Joined</TableHead>
                        <TableHead className="h-9 text-right text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {loadingUsers && (
                        <TableRow className="border-slate-100"><TableCell colSpan={5} className="py-5 text-center text-xs text-slate-500">Loading accounts…</TableCell></TableRow>
                      )}
                      {!loadingUsers && users.length === 0 && (
                        <TableRow className="border-slate-100"><TableCell colSpan={5} className="py-5 text-center text-xs text-slate-500">No users found.</TableCell></TableRow>
                      )}
                      {users.map((u) => (
                        <TableRow key={u.id} className="border-slate-100 hover:bg-slate-50/60">
                          <TableCell className="py-2.5 text-xs font-medium text-slate-900">{u.email}</TableCell>
                          <TableCell className="py-2.5 text-right text-xs font-medium tabular-nums text-slate-700">{u.credits}</TableCell>
                          <TableCell className="py-2.5">
                            {u.is_blocked ? (
                              <span className="inline-flex items-center gap-1 text-[11px] font-medium text-rose-600">
                                <span className="h-1.5 w-1.5 rounded-full bg-rose-500" /> Blocked
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-700">
                                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> Active
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="py-2.5 text-[11px] text-slate-500">
                            {u.created_at ? new Date(u.created_at).toLocaleDateString() : '—'}
                          </TableCell>
                          <TableCell className="py-2.5 text-right">
                            <div className="inline-flex flex-wrap justify-end gap-1.5">
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 rounded-md border-slate-300 bg-white px-2 text-[11px] text-slate-700 hover:bg-slate-100"
                                onClick={() => openCredits(u)}
                              >
                                <Coins className="mr-1 h-3.5 w-3.5" /> Credits
                              </Button>
                              <Button
                                size="sm"
                                className={u.is_blocked
                                  ? 'h-7 rounded-md bg-slate-900 px-2 text-[11px] text-white hover:bg-slate-800'
                                  : 'h-7 rounded-md bg-rose-600 px-2 text-[11px] text-white hover:bg-rose-700'}
                                onClick={() => quickToggleBlock(u)}
                              >
                                <Ban className="mr-1 h-3.5 w-3.5" />
                                {u.is_blocked ? 'Unblock' : 'Block'}
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="pricing">
            <div className="space-y-4">
            <Card className="gap-0 rounded-md border-slate-200 bg-white shadow-none">
              <CardHeader className="border-b border-slate-200 px-4 py-3">
                <CardTitle className="text-sm font-semibold text-slate-900">WhatsApp Checkout</CardTitle>
                <CardDescription className="text-xs text-slate-500">Customers are sent to this number with their selected credit plan and price.</CardDescription>
              </CardHeader>
              <CardContent className="p-4">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                  <div className="flex-1">
                    <Label htmlFor="whatsapp-number" className="text-xs font-medium text-slate-700">WhatsApp number with country code</Label>
                    <Input
                      id="whatsapp-number"
                      value={whatsAppNumber}
                      onChange={(event) => setWhatsAppNumber(event.target.value)}
                      placeholder="2348012345678"
                      className="mt-1.5 h-8 rounded-md border-slate-300 bg-white text-xs text-slate-900 caret-slate-900 placeholder:text-slate-400"
                    />
                    <p className="mt-1 text-[10px] text-slate-400">Digits only after saving. Do not include +, spaces, or a leading international 00.</p>
                  </div>
                  <Button onClick={saveWhatsAppNumber} disabled={savingWhatsApp} className="h-8 rounded-md bg-emerald-600 px-3 text-xs text-white hover:bg-emerald-700">
                    {savingWhatsApp ? 'Saving…' : 'Save WhatsApp number'}
                  </Button>
                </div>
              </CardContent>
            </Card>

            <Card className="gap-0 rounded-md border-slate-200 bg-white shadow-none">
              <CardHeader className="flex flex-col gap-2 border-b border-slate-200 px-4 py-3 md:flex-row md:items-center md:justify-between">
                <div>
                  <CardTitle className="text-sm font-semibold text-slate-900">Pricing Plans</CardTitle>
                  <CardDescription className="text-xs text-slate-500">Maintain the plans shown to customers.</CardDescription>
                </div>
                <Button onClick={openPlanCreate} className="h-8 rounded-md bg-[#0c56d7] px-3 text-xs text-white hover:bg-[#0948b5]">
                  <Plus className="mr-1 h-3.5 w-3.5" /> New Plan
                </Button>
              </CardHeader>
              <CardContent className="p-4">
                <div className="mb-2 flex items-center justify-between gap-2 text-[11px] text-slate-500">
                  <span>{loadingPlans ? 'Loading plans…' : `${plans.length} plan${plans.length === 1 ? '' : 's'} configured`}</span>
                  <span>Audited</span>
                </div>

                <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
                  <Table>
                    <TableHeader>
                      <TableRow className="border-slate-200 bg-slate-50 hover:bg-slate-50">
                        <TableHead className="h-9 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">Name</TableHead>
                        <TableHead className="h-9 text-right text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">Credits</TableHead>
                        <TableHead className="h-9 text-right text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">Price (NGN)</TableHead>
                        <TableHead className="h-9 text-right text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {loadingPlans && (
                        <TableRow className="border-slate-100"><TableCell colSpan={4} className="py-5 text-center text-xs text-slate-500">Loading plans…</TableCell></TableRow>
                      )}
                      {!loadingPlans && plans.length === 0 && (
                        <TableRow className="border-slate-100"><TableCell colSpan={4} className="py-5 text-center text-xs text-slate-500">No plans configured.</TableCell></TableRow>
                      )}
                      {plans.map((p) => (
                        <TableRow key={p.id} className="border-slate-100 hover:bg-slate-50/60">
                          <TableCell className="py-2.5 text-xs font-medium text-slate-900">{p.name}</TableCell>
                          <TableCell className="py-2.5 text-right text-xs font-medium tabular-nums text-slate-700">{p.credits}</TableCell>
                          <TableCell className="py-2.5 text-right text-xs font-medium tabular-nums text-slate-700">{formatNaira(resolveStoredPlanPriceNGN(p.usd_price))}</TableCell>
                          <TableCell className="py-2.5 text-right">
                            <div className="inline-flex flex-wrap justify-end gap-1.5">
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 rounded-md border-slate-300 bg-white px-2 text-[11px] text-slate-700 hover:bg-slate-100"
                                onClick={() => openPlanEdit(p)}
                              >
                                <Pencil className="mr-1 h-3.5 w-3.5" /> Edit
                              </Button>
                              <Button
                                size="sm"
                                className="h-7 rounded-md bg-rose-600 px-2 text-[11px] text-white hover:bg-rose-700"
                                onClick={() => deletePlan(p)}
                              >
                                <Trash2 className="mr-1 h-3.5 w-3.5" /> Delete
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
            </div>
          </TabsContent>

          <TabsContent value="notifications">
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.8fr)]">
              <Card className="gap-0 rounded-md border-slate-200 bg-white shadow-none">
                <CardHeader className="border-b border-slate-200 px-4 py-3">
                  <CardTitle className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                    <BellRing className="h-4 w-4 text-[#0c56d7]" /> Publish user notification
                  </CardTitle>
                  <CardDescription className="text-xs text-slate-500">
                    This message appears at the top of every signed-in user dashboard until you clear or replace it.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4 p-4">
                  <div>
                    <Label htmlFor="notification-message" className="text-xs font-medium text-slate-700">Message</Label>
                    <Textarea
                      id="notification-message"
                      value={notificationMessage}
                      onChange={(event) => setNotificationMessage(event.target.value.slice(0, 1000))}
                      placeholder="Example: Scheduled maintenance starts at 9:00 PM. Please save your work."
                      className="mt-1.5 min-h-28 resize-y rounded-md border-slate-300 bg-white text-sm text-slate-900 caret-slate-900 placeholder:text-slate-400"
                    />
                    <div className="mt-1 text-right text-[10px] text-slate-400">{notificationMessage.length}/1000</div>
                  </div>
                  <div>
                    <Label htmlFor="notification-severity" className="text-xs font-medium text-slate-700">Type</Label>
                    <select
                      id="notification-severity"
                      value={notificationSeverity}
                      onChange={(event) => setNotificationSeverity(event.target.value as NotificationSeverity)}
                      className="mt-1.5 h-9 w-full rounded-md border border-slate-300 bg-white px-3 text-xs text-slate-900 outline-none focus:border-[#0c56d7]"
                    >
                      <option value="info">Information</option>
                      <option value="warning">Warning</option>
                      <option value="critical">Critical</option>
                    </select>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      onClick={publishNotification}
                      disabled={savingNotification || !notificationMessage.trim()}
                      className="h-8 rounded-md bg-[#0c56d7] px-3 text-xs text-white hover:bg-[#0948b5]"
                    >
                      {savingNotification ? 'Publishing…' : 'Publish notification'}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={clearActiveNotification}
                      disabled={savingNotification || !notifications.some((item) => item.is_active)}
                      className="h-8 rounded-md border-slate-300 bg-white px-3 text-xs text-slate-700 hover:bg-slate-100"
                    >
                      Clear active notification
                    </Button>
                  </div>
                </CardContent>
              </Card>

              <Card className="gap-0 rounded-md border-slate-200 bg-white shadow-none">
                <CardHeader className="border-b border-slate-200 px-4 py-3">
                  <CardTitle className="text-sm font-semibold text-slate-900">Recent notifications</CardTitle>
                  <CardDescription className="text-xs text-slate-500">The active message is highlighted.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-2 p-4">
                  {notifications.length === 0 && <p className="py-6 text-center text-xs text-slate-500">No notifications published yet.</p>}
                  {notifications.map((item) => (
                    <div key={item.id} className={`rounded-md border p-3 ${item.is_active ? 'border-amber-300 bg-amber-50' : 'border-slate-200 bg-slate-50'}`}>
                      <div className="mb-1.5 flex items-center justify-between gap-2">
                        <span className="text-[10px] font-semibold uppercase tracking-[0.15em] text-slate-500">{item.severity}</span>
                        <span className={`text-[10px] font-medium ${item.is_active ? 'text-emerald-700' : 'text-slate-400'}`}>{item.is_active ? 'Active' : 'Inactive'}</span>
                      </div>
                      <p className="whitespace-pre-wrap text-xs leading-5 text-slate-800">{item.message}</p>
                      <p className="mt-2 text-[10px] text-slate-400">{new Date(item.created_at).toLocaleString()}</p>
                    </div>
                  ))}
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          <TabsContent value="audit">
            <Card className="gap-0 rounded-md border-slate-200 bg-white shadow-none">
              <CardHeader className="border-b border-slate-200 px-4 py-3">
                <CardTitle className="text-sm font-semibold text-slate-900">Audit Log</CardTitle>
                <CardDescription className="text-xs text-slate-500">Recent administrative actions captured for traceability.</CardDescription>
              </CardHeader>
              <CardContent className="p-4">
                <div className="mb-2 flex items-center justify-between gap-2 text-[11px] text-slate-500">
                  <span>{audit.length} recent event{audit.length === 1 ? '' : 's'}</span>
                  <span>Latest 100</span>
                </div>

                <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
                  <Table>
                    <TableHeader>
                      <TableRow className="border-slate-200 bg-slate-50 hover:bg-slate-50">
                        <TableHead className="h-9 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">When</TableHead>
                        <TableHead className="h-9 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">Action</TableHead>
                        <TableHead className="h-9 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">Target</TableHead>
                        <TableHead className="h-9 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">Payload</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {audit.length === 0 && (
                        <TableRow className="border-slate-100"><TableCell colSpan={4} className="py-5 text-center text-xs text-slate-500">No audit entries yet.</TableCell></TableRow>
                      )}
                      {audit.map((a) => (
                        <TableRow key={a.id} className="border-slate-100 hover:bg-slate-50/60">
                          <TableCell className="py-2.5 text-[11px] text-slate-500">{new Date(a.created_at).toLocaleString()}</TableCell>
                          <TableCell className="py-2.5">
                            <span className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-slate-700">{a.action}</span>
                          </TableCell>
                          <TableCell className="py-2.5 font-mono text-[11px] text-slate-600">
                            {a.target_table}:{a.target_id?.slice(0, 8)}
                          </TableCell>
                          <TableCell className="py-2.5 max-w-[320px] truncate font-mono text-[11px] text-slate-500">
                            {a.payload ? JSON.stringify(a.payload) : ''}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>

      {/* Edit credits dialog */}
      <Dialog open={creditsOpen} onOpenChange={setCreditsOpen}>
        <DialogContent className="rounded-md border-slate-200 bg-white p-5 text-slate-900 shadow-lg sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm font-semibold">Edit credits</DialogTitle>
            <DialogDescription className="text-xs text-slate-500">{creditsTarget?.email}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs font-medium text-slate-700">New credit balance</Label>
              <Input
                type="number" min={0} step={1}
                value={creditsValue}
                onChange={(e) => setCreditsValue(e.target.value)}
                className="mt-1.5 h-8 rounded-md border-slate-300 bg-white text-xs text-slate-900 caret-slate-900 placeholder:text-slate-400"
              />
            </div>
            <div>
              <Label className="text-xs font-medium text-slate-700">Reason (optional)</Label>
              <Input className="mt-1.5 h-8 rounded-md border-slate-300 bg-white text-xs text-slate-900 caret-slate-900 placeholder:text-slate-400" value={creditsReason} onChange={(e) => setCreditsReason(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" className="h-8 rounded-md border-slate-300 bg-white px-3 text-xs text-slate-700 hover:bg-slate-100" onClick={() => setCreditsOpen(false)}>Cancel</Button>
            <Button className="h-8 rounded-md bg-[#0c56d7] px-3 text-xs text-white hover:bg-[#0948b5]" onClick={submitCredits}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Block dialog */}
      <Dialog open={blockOpen} onOpenChange={setBlockOpen}>
        <DialogContent className="rounded-md border-slate-200 bg-white p-5 text-slate-900 shadow-lg sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm font-semibold">Block user</DialogTitle>
            <DialogDescription className="text-xs text-slate-500">{blockTarget?.email}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label className="text-xs font-medium text-slate-700">Reason</Label>
            <Input className="h-8 rounded-md border-slate-300 bg-white text-xs text-slate-900 caret-slate-900 placeholder:text-slate-400" value={blockReason} onChange={(e) => setBlockReason(e.target.value)} placeholder="e.g. Abuse" />
          </div>
          <DialogFooter>
            <Button variant="outline" className="h-8 rounded-md border-slate-300 bg-white px-3 text-xs text-slate-700 hover:bg-slate-100" onClick={() => setBlockOpen(false)}>Cancel</Button>
            <Button className="h-8 rounded-md bg-rose-600 px-3 text-xs text-white hover:bg-rose-700" onClick={() => submitBlock(true)}>Block</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Plan dialog */}
      <Dialog open={planOpen} onOpenChange={setPlanOpen}>
        <DialogContent className="rounded-md border-slate-200 bg-white p-5 text-slate-900 shadow-lg sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm font-semibold">{editingPlan ? 'Edit plan' : 'New plan'}</DialogTitle>
            <DialogDescription className="text-xs text-slate-500">
              Update the plan name, credit amount, and customer price shown in the app.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs font-medium text-slate-700">Name</Label>
              <Input className="mt-1.5 h-8 rounded-md border-slate-300 bg-white text-xs text-slate-900 caret-slate-900 placeholder:text-slate-400" value={planForm.name} onChange={(e) => setPlanForm({ ...planForm, name: e.target.value })} />
            </div>
            <div>
              <Label className="text-xs font-medium text-slate-700">Credits</Label>
              <Input type="number" min={0} value={planForm.credits}
                className="mt-1.5 h-8 rounded-md border-slate-300 bg-white text-xs text-slate-900 caret-slate-900 placeholder:text-slate-400"
                onChange={(e) => setPlanForm({ ...planForm, credits: e.target.value })} />
            </div>
            <div>
              <Label className="text-xs font-medium text-slate-700">Price (NGN)</Label>
              <Input type="number" min={0} step="1" value={planForm.price_ngn}
                className="mt-1.5 h-8 rounded-md border-slate-300 bg-white text-xs text-slate-900 caret-slate-900 placeholder:text-slate-400"
                onChange={(e) => setPlanForm({ ...planForm, price_ngn: e.target.value })} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" className="h-8 rounded-md border-slate-300 bg-white px-3 text-xs text-slate-700 hover:bg-slate-100" onClick={() => setPlanOpen(false)}>Cancel</Button>
            <Button className="h-8 rounded-md bg-[#0c56d7] px-3 text-xs text-white hover:bg-[#0948b5]" onClick={submitPlan}>{editingPlan ? 'Save' : 'Create'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
