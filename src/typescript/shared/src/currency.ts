// Static exchange rates (fetched at build time)
// Last updated: 2025-07-04T01:41:25.945Z
export const EXCHANGE_RATES = {
  "USD": 1,
  "AUD": 1.5216,
  "BGN": 1.66,
  "BRL": 5.4313,
  "CAD": 1.3589,
  "CHF": 0.79367,
  "CNY": 7.1615,
  "CZK": 20.918,
  "DKK": 6.333,
  "EUR": 0.84875,
  "GBP": 0.73239,
  "HKD": 7.8499,
  "HUF": 339.14,
  "IDR": 16221,
  "ILS": 3.3578,
  "INR": 85.38,
  "ISK": 120.86,
  "JPY": 143.93,
  "KRW": 1362.08,
  "MXN": 18.7914,
  "MYR": 4.223,
  "NOK": 10.0789,
  "NZD": 1.6483,
  "PHP": 56.335,
  "PLN": 3.6059,
  "RON": 4.295,
  "SEK": 9.5497,
  "SGD": 1.2734,
  "THB": 32.39,
  "TRY": 39.858,
  "ZAR": 17.5267
} as const;

export const CURRENCY_SYMBOLS = {
  USD: '$',
  EUR: '€',
  GBP: '£',
  JPY: '¥',
  CAD: '$',
  AUD: '$',
  INR: '₹',
  CHF: 'Fr',
  CNY: '¥',
  SEK: 'kr',
  NOK: 'kr',
  BRL: 'R$',
  MXN: '$',
  PLN: 'zł',
  CZK: 'Kč',
  HUF: 'Ft',
  DKK: 'kr',
  SGD: '$',
  NZD: '$',
  TRY: '₺',
  THB: '฿',
  HKD: 'HK$',
  IDR: 'Rp',
  MYR: 'RM',
  PHP: '₱',
  ZAR: 'R',
  KRW: '₩',
  EGP: 'E£',
  SAR: '﷼',
  AED: 'د.إ',
  ILS: '₪',
  NPR: 'रू',
  PKR: '₨',
  BDT: '৳',
  VND: '₫',
  NGN: '₦',
  UAH: '₴',
  CLP: '$',
  COP: '$',
  ARS: '$',
  PER: 'S/',
  DZD: 'د.ج',
  MAD: 'د.م.',
  TUN: 'د.ت',
  ISK: 'kr',
  LKR: '₨',
  RSD: 'дин.',
  GEL: '₾',
  AZN: '₼',
  KZT: '₸',
  BYN: 'Br',
  MDL: 'L',
  AMD: '֏',
  BGN: 'лв',
  HRK: 'kn',
  RON: 'lei',
} as const;

export const CURRENCY_FLAGS = {
  USD: '🇺🇸',
  EUR: '🇪🇺',
  GBP: '🇬🇧',
  JPY: '🇯🇵',
  CAD: '🇨🇦',
  AUD: '🇦🇺',
  INR: '🇮🇳',
  CHF: '🇨🇭',
  CNY: '🇨🇳',
  SEK: '🇸🇪',
  NOK: '🇳🇴',
  BRL: '🇧🇷',
  MXN: '🇲🇽',
  PLN: '🇵🇱',
  CZK: '🇨🇿',
  HUF: '🇭🇺',
  DKK: '🇩🇰',
  SGD: '🇸🇬',
  NZD: '🇳🇿',
  TRY: '🇹🇷',
  THB: '🇹🇭',
  HKD: '🇭🇰',
  IDR: '🇮🇩',
  MYR: '🇲🇾',
  PHP: '🇵🇭',
  ZAR: '🇿🇦',
  KRW: '🇰🇷',
  EGP: '🇪🇬',
  SAR: '🇸🇦',
  AED: '🇦🇪',
  ILS: '🇮🇱',
  NPR: '🇳🇵',
  PKR: '🇵🇰',
  BDT: '🇧🇩',
  VND: '🇻🇳',
  NGN: '🇳🇬',
  UAH: '🇺🇦',
  CLP: '🇨🇱',
  COP: '🇨🇴',
  ARS: '🇦🇷',
  PER: '🇵🇪',
  DZD: '🇩🇿',
  MAD: '🇲🇦',
  TUN: '🇹🇳',
  ISK: '🇮🇸',
  LKR: '🇱🇰',
  RSD: '🇷🇸',
  GEL: '🇬🇪',
  AZN: '🇦🇿',
  KZT: '🇰🇿',
  BYN: '🇧🇾',
  MDL: '🇲🇩',
  AMD: '🇦🇲',
  BGN: '🇧🇬',
  HRK: '🇭🇷',
  RON: '🇷🇴',
} as const;

export type CurrencyCode = keyof typeof EXCHANGE_RATES;

export const MIN_USD_VALUE = 1000;
export const MAX_USD_VALUE = 1000000;

/**
 * Convert amount from one currency to another using static exchange rates
 */
export function convertCurrency(amount: number, from: CurrencyCode, to: CurrencyCode): number {
  if (from === to) return amount;
  
  const fromRate = EXCHANGE_RATES[from];
  const toRate = EXCHANGE_RATES[to];
  
  if (!fromRate || !toRate) {
    throw new Error(`Missing exchange rate for ${from} or ${to}`);
  }
  
  // Convert to USD first, then to target currency
  const usdAmount = amount / fromRate;
  return usdAmount * toRate;
}

/**
 * Get currency symbol for a given currency code
 */
export function getCurrencySymbol(code: CurrencyCode): string {
  return CURRENCY_SYMBOLS[code] || code;
}

/**
 * Get currency flag for a given currency code
 */
export function getCurrencyFlag(code: CurrencyCode): string {
  return CURRENCY_FLAGS[code] || '';
}

/**
 * Get all supported currencies as options for select elements
 */
export function getCurrencyOptions(): Array<{ code: CurrencyCode; label: string; symbol: string; flag: string }> {
  return Object.keys(EXCHANGE_RATES).map(code => ({
    code: code as CurrencyCode,
    label: code,
    symbol: getCurrencySymbol(code as CurrencyCode),
    flag: getCurrencyFlag(code as CurrencyCode),
  }));
}

/**
 * Convert budget values to USD for validation
 */
export function convertBudgetToUSD(amount: number, currency: CurrencyCode): number {
  return convertCurrency(amount, currency, 'USD');
}

/**
 * Check if budget meets minimum USD requirement
 */
export function isValidMinBudget(amount: number, currency: CurrencyCode): boolean {
  const usdAmount = convertBudgetToUSD(amount, currency);
  return usdAmount >= MIN_USD_VALUE;
}

/**
 * Check if a currency code is supported
 */
export function isSupportedCurrency(code: string): code is CurrencyCode {
  return code in EXCHANGE_RATES;
}
