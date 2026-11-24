// "Smarts": the amount calculator, plain-English questions, periods and suggestions (public/smart.js).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadBrowserScript } from './helpers.ts';

const Smart = loadBrowserScript('smart.js', 'Smart');
const TODAY = new Date(2026, 10, 24); // Tue Nov 24 2026

const buckets = [
  { id: 1, name: 'Groceries', archived: false },
  { id: 2, name: 'Restaurants', archived: false },
  { id: 3, name: 'Car/Gas', archived: false },
  { id: 4, name: 'Entertainment', archived: false },
  { id: 5, name: 'Utilities', archived: false },
];
const expenses = [
  { date: '2026-11-20', amount: 120.5, note: 'Costco', bucketId: 1 },
  { date: '2026-10-03', amount: 15.49, note: 'Netflix', bucketId: 4 },
  { date: '2026-09-03', amount: 15.49, note: 'Netflix', bucketId: 4 },
  { date: '2026-08-03', amount: 15.49, note: 'Netflix', bucketId: 4 },
  { date: '2026-07-03', amount: 15.49, note: 'Netflix', bucketId: 4 },
  { date: '2025-03-10', amount: 45, note: 'Shell', bucketId: 3 },
];
const ctx = { today: TODAY, buckets, expenses, bucketById: (id: number) => buckets.find((b) => b.id === id) };

describe('amount field calculator', () => {
  test('does arithmetic without eval', () => {
    assert.equal(Smart.evalAmount('45.20+12'), 57.2);
    assert.equal(Smart.evalAmount('12.50+3.25*2'), 19);
    assert.equal(Smart.evalAmount('(10+5)/3'), 5);
    assert.equal(Smart.evalAmount('-20'), -20); // refund
  });
  test('ignores currency signs and letters, and never runs code', () => {
    assert.equal(Smart.evalAmount('$45.20'), 45.2);
    assert.equal(Smart.evalAmount('12,50'), 12.5); // decimal comma
    assert.equal(Smart.evalAmount('alert(1)'), 1); // only "(1)" is left: numbers and operators
  });
  test('returns null for incomplete or impossible sums', () => {
    for (const s of ['1/0', '2+', '(3', 'constructor', '']) assert.equal(Smart.evalAmount(s), null, s);
  });
});

describe('periods', () => {
  test('presets are relative to today', () => {
    assert.deepEqual(Smart.preset('this-month', [], TODAY), { from: '2026-11-01', to: '2026-11-30', label: 'This month', kind: 'month', y: 2026, m: 10 });
    assert.equal(Smart.preset('last-month', [], TODAY).label, 'October 2026');
    assert.deepEqual([Smart.preset('last-12', [], TODAY).from, Smart.preset('last-12', [], TODAY).to], ['2025-12-01', '2026-11-30']);
  });
  test('previous() is the same-sized period before', () => {
    assert.equal(Smart.previous(Smart.P.month(2026, 0)).label, 'December 2025');
    assert.equal(Smart.previous(Smart.P.year(2026)).label, '2025');
    const q = Smart.P.range(new Date(2026, 3, 1), new Date(2026, 5, 30), 'Q2');
    assert.deepEqual([Smart.previous(q).from, Smart.previous(q).to], ['2026-01-01', '2026-03-31']);
  });
});

describe('plain-English questions', () => {
  const ask = (text: string) => Smart.parseQuery(text, ctx);

  test('bucket + relative period', () => {
    const q = ask('groceries last 3 months');
    assert.deepEqual(q.buckets.map((b: any) => b.name), ['Groceries']);
    assert.deepEqual([q.periods[0].from, q.periods[0].to], ['2026-09-01', '2026-11-24']);
    assert.equal(q.intent, 'total');
  });

  test('aliases: "gas" finds Car/Gas, "eating out" finds Restaurants', () => {
    assert.deepEqual(ask('gas 2025').buckets.map((b: any) => b.name), ['Car/Gas']);
    assert.deepEqual(ask('eating out this year').buckets.map((b: any) => b.name), ['Restaurants']);
  });

  test('comparisons', () => {
    const q = ask('restaurants vs groceries 2025');
    assert.equal(q.intent, 'compare-buckets');
    assert.equal(q.buckets.length, 2);
    const y = ask('car/gas 2025 vs 2024');
    assert.equal(y.intent, 'compare-periods');
    assert.deepEqual(y.periods.map((p: any) => p.label), ['2024', '2025']); // oldest first
  });

  test('intents, amount filters and quarters', () => {
    assert.equal(ask('top expenses in march').intent, 'top');
    assert.equal(ask('average monthly utilities').intent, 'average');
    assert.equal(ask('how many times restaurants last 3 months').intent, 'count');
    assert.equal(ask('over 200 this year').min, 200);
    assert.deepEqual([ask('q2 2025').periods[0].from, ask('q2 2025').periods[0].to], ['2025-04-01', '2025-06-30']);
  });

  test('a word from your notes becomes a note search', () => {
    assert.deepEqual(ask('netflix').words, ['netflix']);
  });
});

describe('suggestions and insights', () => {
  test('suggestBucket learns from your notes first', () => {
    assert.equal(Smart.suggestBucket('costco run', ctx).name, 'Groceries');
    assert.equal(Smart.suggestBucket('dinner at a restaurant', ctx).name, 'Restaurants');
    assert.equal(Smart.suggestBucket('zz', ctx), null);
  });

  test('suggestFromAmount offers a repeated charge in one tap', () => {
    assert.deepEqual(Smart.suggestFromAmount(15.49, ctx), [{ bucketId: 4, note: 'Netflix', n: 4 }]);
  });

  test('recurring() finds subscriptions with a steady price', () => {
    assert.deepEqual(Smart.recurring(expenses, TODAY), [{ note: 'Netflix', amount: 15.49, bucketId: 4 }]);
  });
});
