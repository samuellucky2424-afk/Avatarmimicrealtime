import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, CheckCircle2, Coins, Copy, CreditCard, ExternalLink, Loader2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { useAuth } from '@/context/AuthContext';
import { apiFetch } from '@/lib/api-client';
import { CREDITS_PER_SECOND } from '@/lib/billing';
import { DB_TABLES } from '@/lib/dbNames';
import { formatNaira, resolveStoredPlanPriceNGN } from '@/lib/pricing';
import { supabase } from '@/lib/supabase';

type CreditPlan = {
  id: string;
  name: string;
  credits: number;
  priceNGN: number;
};

type SupabasePlan = {
  id: string;
  name: string | null;
  credits: number | string | null;
  usd_price: number | string | null;
  created_at?: string | null;
};

type PaystackCheckout = {
  reference: string;
  authorizationUrl: string;
  accessCode?: string;
  planId?: string;
  planName?: string;
  credits?: number;
  amountNGN?: number;
};

function normalizePlan(plan: SupabasePlan): CreditPlan | null {
  const credits = Math.max(0, Math.floor(Number(plan.credits) || 0));
  const priceNGN = resolveStoredPlanPriceNGN(plan.usd_price);

  if (!plan.id || credits <= 0 || priceNGN <= 0) {
    return null;
  }

  return {
    id: plan.id,
    name: plan.name?.trim() || `${credits.toLocaleString()} Credits`,
    credits,
    priceNGN,
  };
}

function formatTime(credits: number): string {
  const seconds = credits / CREDITS_PER_SECOND;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;

  if (minutes > 0) {
    return `~${minutes}m ${remainingSeconds}s`;
  }

  return `~${remainingSeconds}s`;
}

function getPaystackReferenceFromLocation(): string {
  if (typeof window === 'undefined') return '';

  const directReference = new URLSearchParams(window.location.search).get('reference');
  if (directReference) return directReference;

  const hashQuery = window.location.hash.includes('?') ? window.location.hash.split('?')[1] : '';
  return new URLSearchParams(hashQuery).get('reference') || '';
}

async function getAccessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token || null;
}

function Subscription() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [creditPlans, setCreditPlans] = useState<CreditPlan[]>([]);
  const [selectedPlan, setSelectedPlan] = useState<CreditPlan | null>(null);
  const [checkout, setCheckout] = useState<PaystackCheckout | null>(null);
  const [paymentReference, setPaymentReference] = useState('');
  const [paymentError, setPaymentError] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isCheckingPayment, setIsCheckingPayment] = useState(false);
  const [isLoadingPlans, setIsLoadingPlans] = useState(true);
  const [plansError, setPlansError] = useState<string | null>(null);

  useEffect(() => {
    const reference = getPaystackReferenceFromLocation();
    if (reference) {
      setPaymentReference(reference);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    const fetchPlans = async (showLoading = true) => {
      if (showLoading) {
        setIsLoadingPlans(true);
      }
      setPlansError(null);

      try {
        const { data, error } = await supabase
          .from(DB_TABLES.plans)
          .select('id,name,credits,usd_price,created_at')
          .gt('credits', 0)
          .gt('usd_price', 0)
          .order('credits', { ascending: true });

        if (error) {
          throw error;
        }

        const nextPlans = ((data as SupabasePlan[]) || [])
          .map(normalizePlan)
          .filter((plan): plan is CreditPlan => plan !== null);

        if (cancelled) return;

        setCreditPlans(nextPlans);
        setSelectedPlan((current) => {
          if (!current) return null;
          return nextPlans.find((plan) => plan.id === current.id) ?? null;
        });
      } catch (error) {
        console.warn('Failed to fetch Supabase pricing plans:', error);
        if (!cancelled) {
          const message = error instanceof Error ? error.message : 'Unable to load live pricing from Supabase.';
          setPlansError(message);
          setCreditPlans([]);
          setSelectedPlan(null);
        }
      } finally {
        if (!cancelled && showLoading) {
          setIsLoadingPlans(false);
        }
      }
    };

    void fetchPlans(true);

    const plansChannel = supabase
      .channel('surevideotool-pricing-plans')
      .on('postgres_changes', { event: '*', schema: 'public', table: DB_TABLES.plans }, () => {
        void fetchPlans(false);
      })
      .subscribe();

    return () => {
      cancelled = true;
      void supabase.removeChannel(plansChannel);
    };
  }, []);

  const currentReference = useMemo(
    () => paymentReference || checkout?.reference || '',
    [checkout?.reference, paymentReference],
  );

  const handleSelectPlan = (plan: CreditPlan) => {
    setSelectedPlan(plan);
    setCheckout(null);
    setPaymentReference('');
    setPaymentError(null);
  };

  const copyPaymentReference = async () => {
    if (!currentReference) {
      toast.error('Start a Paystack checkout first.');
      return;
    }

    try {
      await navigator.clipboard.writeText(currentReference);
      toast.success('Payment reference copied.');
    } catch (error) {
      console.error(error);
      toast.error('Unable to copy payment reference.');
    }
  };

  const handleProceedToPayment = async () => {
    if (!selectedPlan) return;

    if (!user) {
      toast.error('Please log in to purchase credits.');
      navigate('/login');
      return;
    }

    if (!user.email) {
      toast.error('Your account is missing an email address.');
      return;
    }

    setIsProcessing(true);
    setPaymentError(null);

    try {
      const accessToken = await getAccessToken();
      if (!accessToken) {
        throw new Error('Please log in again before starting payment.');
      }

      const response = await apiFetch('/paystack-initialize', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          userId: user.id,
          email: user.email,
          name: user.name || user.email.split('@')[0] || 'Tech Lord Media User',
          planId: selectedPlan.id,
        }),
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok || data?.status !== 'success' || !data?.authorizationUrl || !data?.reference) {
        throw new Error(data?.message || `Paystack returned HTTP ${response.status}`);
      }

      const nextCheckout: PaystackCheckout = {
        reference: data.reference,
        authorizationUrl: data.authorizationUrl,
        accessCode: data.accessCode,
        planId: data.planId,
        planName: data.planName,
        credits: Number(data.credits || selectedPlan.credits),
        amountNGN: Number(data.amountNGN || selectedPlan.priceNGN),
      };

      setCheckout(nextCheckout);
      setPaymentReference(data.reference);

      const opened = window.open(data.authorizationUrl, '_blank', 'noopener,noreferrer');
      if (opened) {
        toast.success('Paystack checkout opened.');
      } else {
        toast.success('Paystack checkout is ready.');
        toast.info('Use the Open Checkout button if your browser blocked the new tab.');
      }
    } catch (error) {
      console.error(error);
      const message = error instanceof Error ? error.message : 'Unable to initialize Paystack payment';
      setPaymentError(message);
      toast.error(message);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleVerifyPaystackPayment = async () => {
    if (!currentReference) {
      toast.error('Start a Paystack checkout first.');
      return;
    }

    if (!user?.id) {
      toast.error('Please log in before verifying payment.');
      return;
    }

    setIsCheckingPayment(true);
    setPaymentError(null);

    try {
      const accessToken = await getAccessToken();
      if (!accessToken) {
        throw new Error('Please log in again before verifying payment.');
      }

      const response = await apiFetch('/verify-payment', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          provider: 'paystack',
          reference: currentReference,
        }),
      });

      const data = await response.json().catch(() => ({}));

      if (response.status === 202 || data?.status === 'pending') {
        toast.info(data?.message || 'Payment is still pending. Please try again shortly.');
        return;
      }

      if (!response.ok || data?.status !== 'success') {
        throw new Error(data?.message || `Paystack returned HTTP ${response.status}`);
      }

      const creditsAdded = Number(data?.creditsAdded || 0);
      if (creditsAdded > 0) {
        toast.success(`Payment verified. ${creditsAdded.toLocaleString()} credits added.`);
      } else {
        toast.success(data?.message || 'Payment already processed.');
      }

      if (Number.isFinite(Number(data?.newCredits))) {
        toast.info(`Wallet balance: ${Number(data.newCredits).toLocaleString()} credits.`);
      }
    } catch (error) {
      console.error(error);
      const message = error instanceof Error ? error.message : 'Unable to verify Paystack payment right now';
      setPaymentError(message);
      toast.error(message);
    } finally {
      setIsCheckingPayment(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0f0f10] p-6 lg:p-12 flex flex-col items-center">
      <div className="w-full max-w-[800px] pb-32">
        <Button
          variant="ghost"
          onClick={() => navigate(-1)}
          className="mb-8 text-[#a1a1aa] hover:text-white"
        >
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back
        </Button>

        <div className="mb-12">
          <h1 className="text-3xl font-bold text-white mb-2 tracking-tight">Purchase Credits</h1>
          <p className="text-sm text-[#a1a1aa]">Select credits to power your AI transformations</p>
        </div>

        <div className="mb-6 rounded-2xl border border-[#27272a] bg-[#131316] p-5 shadow-xl shadow-black/20">
          <p className="text-sm text-white font-semibold mb-2">Need the latest version?</p>
          <p className="text-sm text-[#a1a1aa] mb-4">
            Click Recharge from the wallet page to go to Settings, then use the "Check for New Version" button to download and install updates immediately.
          </p>
          <Button
            onClick={() => navigate('/settings')}
            className="bg-blue-600 hover:bg-blue-500 text-white font-medium"
          >
            Go to Settings
          </Button>
        </div>

        <div className="mb-8">
          <label className="block text-sm font-medium text-[#a1a1aa] mb-3">Select Credits</label>
          {isLoadingPlans ? (
            <div className="rounded-xl border border-[#27272a] bg-[#131316] p-5 text-sm text-[#a1a1aa]">
              Loading live pricing from Supabase...
            </div>
          ) : plansError ? (
            <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-5 text-sm text-red-200">
              Could not load live pricing from Supabase: {plansError}
            </div>
          ) : creditPlans.length === 0 ? (
            <div className="rounded-xl border border-[#27272a] bg-[#131316] p-5 text-sm text-[#a1a1aa]">
              No credit plans are configured yet.
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {creditPlans.map((plan) => {
                const isSelected = selectedPlan?.id === plan.id;

                return (
                  <button
                    key={plan.id}
                    onClick={() => handleSelectPlan(plan)}
                    className={`p-5 rounded-xl border text-left transition-all duration-200 ${
                      isSelected
                        ? 'bg-gradient-to-br from-blue-600/15 via-blue-600/5 to-transparent border-blue-500 shadow-xl shadow-blue-500/20 ring-2 ring-blue-500/50'
                        : 'bg-gradient-to-br from-[#131316] to-[#0f0f10] border-[#27272a] hover:border-[#3f3f46] hover:bg-[#1a1a1f]'
                    }`}
                  >
                    <div className="flex items-center gap-3 mb-3">
                      <div
                        className={`w-10 h-10 rounded-full flex items-center justify-center ${
                          isSelected ? 'bg-blue-500/20' : 'bg-[#27272a]'
                        }`}
                      >
                        <Coins className={`w-5 h-5 ${isSelected ? 'text-blue-400' : 'text-[#71717a]'}`} />
                      </div>
                      <div>
                        <p className="text-xs font-medium uppercase tracking-[0.18em] text-[#71717a]">{plan.name}</p>
                        <span className="text-lg font-bold text-white">{plan.credits.toLocaleString()} Credits</span>
                        <span className="text-xs text-[#71717a] ml-2">{formatTime(plan.credits)}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xl font-bold text-white">{formatNaira(plan.priceNGN)}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="bg-[#131316] border border-[#27272a] rounded-xl p-5 mb-8">
          <h3 className="text-sm font-semibold text-white mb-2">How credits work</h3>
          <ul className="text-sm text-[#a1a1aa] space-y-1">
            <li>- 2 credits are deducted per second of stream time</li>
            <li>- 500 credits is about 4 minutes 10 seconds</li>
            <li>- 1000 credits is about 8 minutes 20 seconds</li>
            <li>- Credits never expire</li>
          </ul>
        </div>

        <div className="bg-[#131316] border border-[#27272a] rounded-xl p-5 mb-8">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-full bg-blue-500/15 flex items-center justify-center">
              <CreditCard className="w-5 h-5 text-blue-300" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-white">Paystack checkout</h3>
              <p className="text-xs text-[#71717a]">Secure card, transfer, USSD, and bank checkout</p>
            </div>
          </div>

          <ul className="text-sm text-[#a1a1aa] space-y-1">
            <li>- Select a credit plan and open Paystack checkout</li>
            <li>- Complete the payment using any method Paystack shows</li>
            <li>- Return here and click Verify Payment if credits are not added immediately</li>
          </ul>

          {user?.email && (
            <p className="text-xs text-blue-300 mt-4">
              Payment email for this session: {user.email}
            </p>
          )}

          {currentReference && (
            <div className="mt-4 rounded-xl border border-[#27272a] bg-[#0f0f10] p-4">
              <p className="text-xs uppercase tracking-[0.18em] text-[#71717a] mb-2">Paystack reference</p>
              <p className="break-all text-sm font-semibold text-white">{currentReference}</p>
              <div className="mt-3 flex items-center gap-2 text-xs text-emerald-300">
                <CheckCircle2 className="w-4 h-4" />
                Checkout created. Complete payment before verification.
              </div>
            </div>
          )}

          {paymentError && (
            <p className="text-sm text-red-400 mt-4">{paymentError}</p>
          )}

          <div className="mt-4 flex flex-wrap gap-3">
            <Button
              type="button"
              onClick={handleProceedToPayment}
              disabled={!selectedPlan || isProcessing}
              className="bg-blue-600 hover:bg-blue-500 text-white font-medium"
            >
              {isProcessing ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <CreditCard className="w-4 h-4 mr-2" />}
              Pay with Paystack
            </Button>

            {checkout?.authorizationUrl && (
              <Button
                type="button"
                variant="outline"
                onClick={() => window.open(checkout.authorizationUrl, '_blank', 'noopener,noreferrer')}
                className="border-[#3f3f46] bg-transparent text-white hover:bg-[#1a1a1f]"
              >
                <ExternalLink className="w-4 h-4 mr-2" />
                Open Checkout
              </Button>
            )}

            <Button
              type="button"
              variant="outline"
              onClick={handleVerifyPaystackPayment}
              disabled={!currentReference || isCheckingPayment}
              className="border-[#3f3f46] bg-transparent text-white hover:bg-[#1a1a1f]"
            >
              {isCheckingPayment ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
              Verify Payment
            </Button>

            <Button
              type="button"
              variant="outline"
              onClick={copyPaymentReference}
              disabled={!currentReference}
              className="border-[#3f3f46] bg-transparent text-white hover:bg-[#1a1a1f]"
            >
              <Copy className="w-4 h-4 mr-2" />
              Copy Reference
            </Button>
          </div>
        </div>

        <div className="text-center">
          <p className="text-sm text-[#71717a] mb-4">All purchases are one-time. No subscriptions or hidden fees.</p>
        </div>
      </div>

      {selectedPlan && (
        <div className="fixed bottom-0 left-0 w-full bg-[#0f0f10]/90 backdrop-blur-md border-t border-[#27272a] p-4 flex justify-between items-center z-50 animate-in slide-in-from-bottom shadow-2xl">
          <div className="max-w-[800px] mx-auto w-full flex items-center justify-between">
            <div className="flex flex-col">
              <span className="text-sm text-[#a1a1aa] font-medium">Selected Plan</span>
              <span className="text-xl font-bold text-white tracking-tight">
                {selectedPlan.credits.toLocaleString()} Credits <span className="text-blue-500 font-normal mx-1">/</span> {formatNaira(selectedPlan.priceNGN)}
              </span>
              <span className="text-xs text-[#71717a] mt-1">{selectedPlan.name} - {formatTime(selectedPlan.credits)} estimated time</span>
            </div>
            <div className="flex items-center gap-3">
              {currentReference && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleVerifyPaystackPayment}
                  disabled={isCheckingPayment}
                  className="h-12 px-6 border-[#3f3f46] bg-transparent text-white hover:bg-[#1a1a1f]"
                >
                  {isCheckingPayment ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                  Verify
                </Button>
              )}
              <Button
                onClick={handleProceedToPayment}
                disabled={isProcessing}
                className="h-12 px-8 bg-blue-600 hover:bg-blue-500 text-white font-bold rounded-xl shadow-lg shadow-blue-500/30 hover:scale-105 transition-all"
              >
                {isProcessing ? (
                  <Loader2 className="w-5 h-5 animate-spin mr-2" />
                ) : (
                  'Pay with Paystack'
                )}
                {!isProcessing && <ArrowRight className="w-5 h-5 ml-2" />}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default Subscription;
