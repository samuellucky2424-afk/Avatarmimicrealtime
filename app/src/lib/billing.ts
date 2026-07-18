export const CREDITS_PER_SECOND = 2;

export function creditsToSeconds(credits: number): number {
  return Math.max(0, Number(credits) || 0) / CREDITS_PER_SECOND;
}

export function creditsToMinutes(credits: number): number {
  return creditsToSeconds(credits) / 60;
}

export function minutesToCredits(minutes: number): number {
  return Math.max(0, Math.round((Number(minutes) || 0) * 60 * CREDITS_PER_SECOND));
}

export function formatCreditMinutes(credits: number): string {
  const totalSeconds = Math.floor(creditsToSeconds(credits));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (seconds === 0) return `${minutes.toLocaleString()} ${minutes === 1 ? 'minute' : 'minutes'}`;
  return `${minutes.toLocaleString()}m ${seconds}s`;
}
