const LEGACY_USD_PRICE_LIMIT = 1000;
const LEGACY_USD_TO_NGN_RATE = 1150;
export type DisplayCurrency = 'USD' | 'NGN';
export const DEFAULT_DISPLAY_CURRENCY: DisplayCurrency = 'NGN';

export function resolveStoredPlanPriceNGN(value: number | string | null | undefined): number {
  const storedPrice = Math.max(0, Number(value) || 0);

  // Existing plan rows used to store USD-style values. New edits store the Naira amount directly.
  if (storedPrice > 0 && storedPrice < LEGACY_USD_PRICE_LIMIT) {
    return Math.round(storedPrice * LEGACY_USD_TO_NGN_RATE);
  }

  return Math.round(storedPrice);
}

export function formatNaira(amount: number): string {
  return `₦${Math.round(Number(amount || 0)).toLocaleString()}`;
}

export function normalizeDisplayCurrency(value: unknown): DisplayCurrency {
  return String(value).toUpperCase() === 'USD' ? 'USD' : 'NGN';
}

export function ngnToDisplayAmount(amountNGN: number, currency: DisplayCurrency): number {
  return currency === 'USD' ? Number(amountNGN || 0) / LEGACY_USD_TO_NGN_RATE : Number(amountNGN || 0);
}

export function displayAmountToNGN(amount: number, currency: DisplayCurrency): number {
  return currency === 'USD' ? Number(amount || 0) * LEGACY_USD_TO_NGN_RATE : Number(amount || 0);
}

export function formatPrice(amountNGN: number, currency: DisplayCurrency): string {
  if (currency === 'USD') {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(ngnToDisplayAmount(amountNGN, currency));
  }
  return formatNaira(amountNGN);
}
