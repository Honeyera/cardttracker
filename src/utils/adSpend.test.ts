import { describe, it, expect } from 'vitest';
import { isAdTransaction, adSpendLimitFor, computeAdSpend } from './adSpend';
import { FinanceTransaction } from '@/hooks/useFinanceData';

const txn = (over: Partial<FinanceTransaction>): FinanceTransaction => ({
  id: 'tx',
  accountId: null,
  creditCardId: 'amex-1',
  date: '2026-06-15',
  description: '',
  merchantName: null,
  amount: 100,
  type: 'expense',
  category: null,
  isPending: false,
  isRecurring: false,
  ...over,
});

describe('isAdTransaction', () => {
  it.each([
    ['GOOGLE ADS', 'merchant'],
    ['FACEBK *ADS12345', 'merchant'],
    ['TikTok Ads', 'merchant'],
    ['Microsoft Advertising', 'merchant'],
    ['AMAZON ADVERTISING', 'merchant'],
    ['Taboola.com', 'merchant'],
  ])('matches %s via %s', (name) => {
    expect(isAdTransaction(txn({ merchantName: name }))).toBe(true);
  });

  it('matches via the Plaid Advertising category when merchant is generic', () => {
    expect(isAdTransaction(txn({ merchantName: 'GOOGL SVC', category: 'Advertising' }))).toBe(true);
  });

  it('matches via description when merchant is null', () => {
    expect(isAdTransaction(txn({ description: 'ADWORDS:1234567890' }))).toBe(true);
  });

  it.each([
    ['LinkedIn Premium'],   // subscription, not ads
    ['Amazon Marketplace'], // shopping, not Amazon Advertising
    ['Google Cloud'],
    ['Delta Air Lines'],
  ])('does NOT match %s', (name) => {
    expect(isAdTransaction(txn({ merchantName: name }))).toBe(false);
  });
});

describe('adSpendLimitFor', () => {
  it('gives the Amex its $150k cap via name or company', () => {
    expect(adSpendLimitFor({ name: 'Business Platinum', companyName: 'Amex' })).toBe(150_000);
    expect(adSpendLimitFor({ name: 'American Express Gold', companyName: null })).toBe(150_000);
  });

  it("matches the user's Gold cards, which don't say Amex in the title", () => {
    expect(adSpendLimitFor({ name: 'Business Gold', companyName: 'Honeyera' })).toBe(150_000);
    expect(adSpendLimitFor({ name: 'Gold Card 2', companyName: null })).toBe(150_000);
  });

  it('returns null for untracked cards', () => {
    expect(adSpendLimitFor({ name: 'Sapphire', companyName: 'Chase' })).toBeNull();
  });
});

describe('computeAdSpend', () => {
  const now = new Date(2026, 5, 30); // Jun 30, 2026 — day 181 of 365

  it('sums only ad transactions on the given card within the calendar year', () => {
    const txns = [
      txn({ merchantName: 'GOOGLE ADS', amount: 50_000 }),
      txn({ merchantName: 'FACEBK *ADS', amount: 25_000 }),
      txn({ merchantName: 'GOOGLE ADS', amount: 9_999, date: '2025-12-31' }), // prior year
      txn({ merchantName: 'GOOGLE ADS', amount: 9_999, creditCardId: 'other' }), // other card
      txn({ merchantName: 'Delta Air Lines', amount: 9_999 }), // not ads
    ];
    const s = computeAdSpend(txns, 'amex-1', 150_000, now);
    expect(s.spent).toBe(75_000);
    expect(s.fraction).toBeCloseTo(0.5);
    expect(s.year).toBe(2026);
  });

  it('subtracts ad-platform refunds and never goes negative', () => {
    const s = computeAdSpend([
      txn({ merchantName: 'GOOGLE ADS', amount: 10_000 }),
      txn({ merchantName: 'GOOGLE ADS', amount: 2_000, type: 'refund' }),
    ], 'amex-1', 150_000, now);
    expect(s.spent).toBe(8_000);

    const neg = computeAdSpend([
      txn({ merchantName: 'GOOGLE ADS', amount: 2_000, type: 'refund' }),
    ], 'amex-1', 150_000, now);
    expect(neg.spent).toBe(0);
  });

  it('projects straight-line pace to year end', () => {
    // $75k by Jun 30 (day 181) → ~$151k pace: just over the cap.
    const s = computeAdSpend([txn({ merchantName: 'GOOGLE ADS', amount: 75_000 })], 'amex-1', 150_000, now);
    expect(s.projected).toBeGreaterThan(150_000);
    expect(s.projected).toBeLessThan(153_000);
  });

  it('counts pending transactions as real spend', () => {
    const s = computeAdSpend([txn({ merchantName: 'GOOGLE ADS', amount: 500, isPending: true })], 'amex-1', 150_000, now);
    expect(s.spent).toBe(500);
  });
});
