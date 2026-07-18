import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, Coins, MessageCircle } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { useAuth } from '@/context/AuthContext';
import { formatCreditMinutes } from '@/lib/billing';
import { DB_TABLES } from '@/lib/dbNames';
import { DEFAULT_DISPLAY_CURRENCY, formatPrice, normalizeDisplayCurrency, resolveStoredPlanPriceNGN, type DisplayCurrency } from '@/lib/pricing';
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
};

function normalizePlan(plan: SupabasePlan): CreditPlan | null {
  const credits = Math.max(0, Math.floor(Number(plan.credits) || 0));
  const priceNGN = resolveStoredPlanPriceNGN(plan.usd_price);
  if (!plan.id || credits <= 0 || priceNGN <= 0) return null;
  return {
    id: plan.id,
    name: plan.name?.trim().replace(/^\d[\d,]*\s+credits?$/i, 'Streaming package') || 'Streaming package',
    credits,
    priceNGN,
  };
}

function Subscription() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [creditPlans, setCreditPlans] = useState<CreditPlan[]>([]);
  const [selectedPlan, setSelectedPlan] = useState<CreditPlan | null>(null);
  const [whatsAppNumber, setWhatsAppNumber] = useState('');
  const [displayCurrency, setDisplayCurrency] = useState<DisplayCurrency>(DEFAULT_DISPLAY_CURRENCY);
  const [isLoadingPlans, setIsLoadingPlans] = useState(true);
  const [isLoadingWhatsApp, setIsLoadingWhatsApp] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const loadCheckout = async () => {
      setIsLoadingPlans(true);
      setIsLoadingWhatsApp(true);
      setLoadError(null);
      const loadPlans = async () => {
        try {
          const plansResult = await supabase
            .from(DB_TABLES.plans)
            .select('id,name,credits,usd_price')
            .gt('credits', 0)
            .gt('usd_price', 0)
            .order('credits', { ascending: true });
          if (cancelled) return;
          if (plansResult.error) {
            setLoadError(plansResult.error.message);
            return;
          }
          const plans = ((plansResult.data as SupabasePlan[]) || [])
            .map(normalizePlan)
            .filter((plan): plan is CreditPlan => plan !== null);
          setCreditPlans(plans);
        } finally {
          if (!cancelled) setIsLoadingPlans(false);
        }
      };

      const loadWhatsAppNumber = async () => {
        try {
          const settingsResult = await supabase
            .from(DB_TABLES.appSettings)
            .select('value')
            .eq('key', 'whatsapp_sales_number')
            .maybeSingle();
          if (cancelled) return;
          if (settingsResult.error) {
            toast.error(`Unable to load WhatsApp checkout: ${settingsResult.error.message}`);
            return;
          }
          setWhatsAppNumber(String(settingsResult.data?.value || '').replace(/\D/g, ''));
        } finally {
          if (!cancelled) setIsLoadingWhatsApp(false);
        }
      };

      const loadCurrency = async () => {
        const { data } = await supabase.from(DB_TABLES.appSettings).select('value').eq('key', 'display_currency').maybeSingle();
        if (!cancelled) setDisplayCurrency(normalizeDisplayCurrency(data?.value));
      };

      await Promise.allSettled([loadPlans(), loadWhatsAppNumber(), loadCurrency()]);
    };

    void loadCheckout();
    return () => { cancelled = true; };
  }, []);

  const proceedToWhatsApp = async () => {
    if (!selectedPlan) {
      toast.error('Select a minutes package first.');
      return;
    }
    if (!user?.email) {
      toast.error('Please sign in before ordering minutes.');
      navigate('/login');
      return;
    }
    if (!whatsAppNumber) {
      toast.error('The admin has not configured a WhatsApp sales number yet.');
      return;
    }

    const message = [
      'Hello, I want to purchase Avatar Mimic Real Time streaming minutes.',
      '',
      `Plan: ${selectedPlan.name}`,
      `Streaming time: ${formatCreditMinutes(selectedPlan.credits)}`,
      `Price: ${formatPrice(selectedPlan.priceNGN, displayCurrency)}`,
      `Account email: ${user.email}`,
      `User ID: ${user.id}`,
      '',
      'Please send me the payment instructions.',
    ].join('\n');

    if (window.electron?.isElectron) {
      try {
        const result = await window.electron.invoke('open-whatsapp-checkout', {
          phone: whatsAppNumber,
          message,
        });
        if (!result?.success) {
          toast.error(result?.error || 'WhatsApp could not be opened.');
        }
      } catch (error) {
        console.error('Unable to open WhatsApp checkout:', error);
        toast.error('WhatsApp could not be opened.');
      }
      return;
    }

    const checkoutUrl = `https://wa.me/${whatsAppNumber}?text=${encodeURIComponent(message)}`;
    window.open(checkoutUrl, '_blank', 'noopener,noreferrer');
  };

  return (
    <div className="min-h-screen bg-[#0f0f10] p-6 lg:p-12 flex flex-col items-center">
      <div className="w-full max-w-[800px] pb-32">
        <Button variant="ghost" onClick={() => navigate(-1)} className="mb-8 text-[#a1a1aa] hover:text-white">
          <ArrowLeft className="w-4 h-4 mr-2" /> Back
        </Button>

        <div className="mb-10">
          <h1 className="text-3xl font-bold text-white mb-2 tracking-tight">Purchase Minutes</h1>
          <p className="text-sm text-[#a1a1aa]">Choose a package and contact the admin through WhatsApp to complete your order.</p>
        </div>

        <div className="mb-8">
          <label className="block text-sm font-medium text-[#a1a1aa] mb-3">Select Minutes Package</label>
          {isLoadingPlans ? (
            <div className="rounded-xl border border-[#27272a] bg-[#131316] p-5 text-sm text-[#a1a1aa]">Loading time packages…</div>
          ) : loadError ? (
            <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-5 text-sm text-red-200">Unable to load checkout: {loadError}</div>
          ) : creditPlans.length === 0 ? (
            <div className="rounded-xl border border-[#27272a] bg-[#131316] p-5 text-sm text-[#a1a1aa]">No time packages are configured yet.</div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {creditPlans.map((plan) => {
                const isSelected = selectedPlan?.id === plan.id;
                return (
                  <button
                    key={plan.id}
                    onClick={() => setSelectedPlan(plan)}
                    className={`p-5 rounded-xl border text-left transition-all duration-200 ${isSelected ? 'bg-gradient-to-br from-emerald-600/15 via-emerald-600/5 to-transparent border-emerald-500 shadow-xl shadow-emerald-500/20 ring-2 ring-emerald-500/50' : 'bg-gradient-to-br from-[#131316] to-[#0f0f10] border-[#27272a] hover:border-[#3f3f46]'}`}
                  >
                    <div className="flex items-center gap-3 mb-3">
                      <div className={`w-10 h-10 rounded-full flex items-center justify-center ${isSelected ? 'bg-emerald-500/20' : 'bg-[#27272a]'}`}>
                        <Coins className={`w-5 h-5 ${isSelected ? 'text-emerald-400' : 'text-[#71717a]'}`} />
                      </div>
                      <div>
                        <p className="text-xs font-medium uppercase tracking-[0.18em] text-[#71717a]">{plan.name}</p>
                        <span className="text-lg font-bold text-white">{formatCreditMinutes(plan.credits)}</span>
                      </div>
                    </div>
                    <span className="text-xl font-bold text-white">{formatPrice(plan.priceNGN, displayCurrency)}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-5">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-full bg-emerald-500/20 flex items-center justify-center">
              <MessageCircle className="w-5 h-5 text-emerald-300" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-white">Complete your order on WhatsApp</h3>
              <p className="text-xs text-[#a1a1aa]">Your selected package and account details will be included automatically.</p>
            </div>
          </div>
          {!isLoadingWhatsApp && !whatsAppNumber && <p className="mb-3 text-sm text-amber-300">WhatsApp ordering is temporarily unavailable. The admin needs to add a sales number.</p>}
          <Button onClick={() => void proceedToWhatsApp()} disabled={!selectedPlan || isLoadingWhatsApp || !whatsAppNumber} className="bg-emerald-600 hover:bg-emerald-500 text-white font-medium">
            <MessageCircle className="w-4 h-4 mr-2" /> Proceed to WhatsApp
          </Button>
        </div>
      </div>

      {selectedPlan && (
        <div className="fixed bottom-0 left-0 w-full bg-[#0f0f10]/90 backdrop-blur-md border-t border-[#27272a] p-4 z-50 shadow-2xl">
          <div className="max-w-[800px] mx-auto w-full flex items-center justify-between gap-4">
            <div className="flex flex-col">
              <span className="text-sm text-[#a1a1aa] font-medium">Selected Package</span>
              <span className="text-xl font-bold text-white">{formatCreditMinutes(selectedPlan.credits)} / {formatPrice(selectedPlan.priceNGN, displayCurrency)}</span>
              <span className="text-xs text-[#71717a] mt-1">{selectedPlan.name} streaming time</span>
            </div>
            <Button onClick={() => void proceedToWhatsApp()} disabled={isLoadingWhatsApp || !whatsAppNumber} className="h-12 px-6 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-xl shadow-lg shadow-emerald-500/20">
              Proceed <ArrowRight className="w-5 h-5 ml-2" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export default Subscription;
