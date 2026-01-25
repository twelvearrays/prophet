import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatPrice(price: number): string {
  return `${(price * 100).toFixed(1)}¢`
}

export function formatMoney(amount: number): string {
  const prefix = amount >= 0 ? '+' : ''
  return `${prefix}$${Math.abs(amount).toFixed(2)}`
}

export function formatPercent(value: number): string {
  const prefix = value >= 0 ? '+' : ''
  return `${prefix}${value.toFixed(1)}%`
}
