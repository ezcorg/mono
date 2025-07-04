#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function fetchExchangeRates() {
  try {
    console.log('Fetching latest exchange rates...');

    const response = await fetch('https://api.frankfurter.app/latest?from=USD');

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();

    // Add USD as base currency
    const rates = {
      USD: 1,
      ...data.rates
    };

    // Generate the currency.ts file content
    const currencyFileContent = `// Static exchange rates (fetched at build time)
// Last updated: ${new Date().toISOString()}
export const EXCHANGE_RATES = ${JSON.stringify(rates, null, 2)} as const;

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
    throw new Error(\`Missing exchange rate for \${from} or \${to}\`);
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
`;

    // Write the updated currency.ts file
    const currencyFilePath = path.join(__dirname, '..', 'src', 'currency.ts');
    fs.writeFileSync(currencyFilePath, currencyFileContent);

    console.log(`✅ Exchange rates updated successfully! (${Object.keys(rates).length} currencies)`);
    console.log(`📄 Updated file: ${currencyFilePath}`);

  } catch (error) {
    console.error('❌ Failed to fetch exchange rates:', error.message);
    console.log('📄 Using fallback rates from existing currency.ts file');
    process.exit(0); // Don't fail the build, just use existing rates
  }
}

// Run the script
fetchExchangeRates();