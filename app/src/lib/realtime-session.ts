type DisconnectableClient = { disconnect: () => void | Promise<void> };

// Do not open a replacement provider session until the previous session has
// settled. Morphly permits retrying disconnect on the same client when pending.
export async function disconnectRealtimeClient(client: DisconnectableClient | null): Promise<void> {
  if (!client) return;

  try {
    await client.disconnect();
  } catch (error) {
    if ((error as { code?: string })?.code !== 'SESSION_STOP_PENDING') throw error;
    await client.disconnect();
  }
}

// lastFrameAt and now must use the same monotonic clock (performance.now()).
export function shouldRestartRealtime(
  state: string,
  lastFrameAt: number,
  now: number,
  timeoutMs: number,
): boolean {
  if (state === 'disconnected') return true;
  if (!['connected', 'generating', 'connecting', 'reconnecting'].includes(state)) return false;
  return Number.isFinite(lastFrameAt)
    && Number.isFinite(now)
    && Number.isFinite(timeoutMs)
    && timeoutMs >= 0
    && now - lastFrameAt >= timeoutMs;
}

// Reconnecting consumes the original deadline; each provider connection is
// capped at the one-hour limit accepted by Morphly's session credentials.
export function remainingSessionSeconds(deadlineMs: number, now: number): number {
  if (!Number.isFinite(deadlineMs) || !Number.isFinite(now)) return 0;
  return Math.min(3600, Math.max(0, Math.ceil((deadlineMs - now) / 1000)));
}
