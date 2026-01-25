/**
 * Generate a unique ID
 */
export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Format price as cents
 */
export function formatPrice(price: number): string {
  return `${(price * 100).toFixed(0)}¢`;
}

/**
 * Format P&L with sign
 */
export function formatPnL(pnl: number): string {
  const sign = pnl >= 0 ? '+' : '-';
  return `${sign}$${Math.abs(pnl).toFixed(2)}`;
}

/**
 * Format percentage
 */
export function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

/**
 * Sleep for ms
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Clamp a value between min and max
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Calculate time remaining in minutes
 */
export function getTimeRemaining(endTime: number, now: number = Date.now()): number {
  return Math.max(0, (endTime - now) / 60000);
}
