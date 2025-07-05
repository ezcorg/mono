// Static exchange rates (fetched at build time)
// Last updated: 2025-07-04T22:33:35.261Z
export const EXCHANGE_RATES = {
  "USD": 1,
  "AUD": 1.5253,
  "BGN": 1.6621,
  "BRL": 5.4162,
  "CAD": 1.3593,
  "CHF": 0.79426,
  "CNY": 7.1628,
  "CZK": 20.953,
  "DKK": 6.3412,
  "EUR": 0.84983,
  "GBP": 0.73298,
  "HKD": 7.8497,
  "HUF": 338.64,
  "IDR": 16194,
  "ILS": 3.3505,
  "INR": 85.41,
  "ISK": 121.02,
  "JPY": 144.4,
  "KRW": 1363.39,
  "MXN": 18.6403,
  "MYR": 4.221,
  "NOK": 10.068,
  "NZD": 1.6498,
  "PHP": 56.55,
  "PLN": 3.6082,
  "RON": 4.2984,
  "SEK": 9.5611,
  "SGD": 1.2741,
  "THB": 32.34,
  "TRY": 39.852,
  "ZAR": 17.6222
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
