// Statement import: parsing bank / card files, deciding what to import, and Amazon order matching.
// All fixtures are made up (test/fixtures); PDF statements are built as positioned text items, the way pdf.js returns them.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadBrowserScript, fixture } from './helpers.ts';

const S = loadBrowserScript('statements.js', 'Statements');
const parse = (name: string) => S.parseFile({ name, text: fixture(name) });

const BUCKETS = ['Groceries', 'Restaurants', 'Household', 'Car/Gas', 'Utilities', 'Health/Beauty', 'Entertainment', 'Giving']
  .map((name, i) => ({ id: i + 1, name, archived: false }));
const bucket = (id: number | null) => (id == null ? null : BUCKETS[id - 1].name);

// ---------- PDF helpers: one text line = items at the same y ----------
type Item = { x: number; y: number; w: number; str: string };
const line = (y: number, ...cells: [x: number, str: string, w?: number][]): Item[] =>
  cells.map(([x, str, w = str.length * 5]) => ({ x, y, w, str }));
const page = (...lines: Item[][]): Item[] => lines.flat();

describe('amounts, dates and descriptions', () => {
  test('parseAmount understands bank number formats', () => {
    assert.equal(S.parseAmount('$1,234.56'), 1234.56);
    assert.equal(S.parseAmount('(12.00)'), -12);
    assert.equal(S.parseAmount('12.00-'), -12);
    assert.equal(S.parseAmount('-$5.10'), -5.1);
    assert.equal(S.parseAmount(''), null);
    assert.equal(S.parseAmount('abc'), null);
  });

  test('parseDate normalises every date style to YYYY-MM-DD', () => {
    for (const s of ['11/05/2026', '11/5/26', '2026-11-05', 'Nov 5, 2026', '05 Nov 2026']) assert.equal(S.parseDate(s), '2026-11-05', s);
    assert.equal(S.parseDate(new Date(2026, 10, 5)), '2026-11-05');
    assert.equal(S.parseDate(45658), '2025-01-01'); // Excel serial day
    assert.equal(S.parseDate('not a date'), null);
  });

  test('cleanDescription strips bank noise but keeps the merchant', () => {
    const cases: [string, string][] = [
      ['PURCHASE AUTHORIZED ON 10/30 KROGER #123 RALEIGH NC S386243123456789 CARD 1234', 'KROGER #123 RALEIGH NC'],
      ['DUKE ENERGY PAYMENT   PPD ID: 1234', 'DUKE ENERGY PAYMENT'],
      ['Card Purchase With Pin 10/02 Powers Great American Raleigh NC', 'Powers Great American Raleigh NC'],
      ['STARBUCKS STORE 1234 RALEIGH NC     10/29', 'STARBUCKS STORE 1234 RALEIGH NC'],
      ['ALDI INC 000480086  CARY                NC', 'ALDI INC CARY'],
      ['AMAZON MKTPL*AB12CD34E Amzn.com/bill WA', 'AMAZON MKTPL'],
      ['1021 Deposited OR Cashed Check', 'Check #1021'],
      ['AplPay CHIPOTLE 1234 CARY 919-555-1234', 'CHIPOTLE 1234 CARY'],
    ];
    for (const [raw, want] of cases) assert.equal(S.cleanDescription(raw), want, raw);
  });

  test('merchantKey groups the same merchant across formats', () => {
    assert.equal(S.merchantKey('AMAZON MKTPL'), 'amazon');
    assert.equal(S.merchantKey('Amazon: USB cable'), 'amazon');
    assert.equal(S.merchantKey('TESLA INC SUPERCHARGPALO ALTO'), 'tesla inc');
    assert.equal(S.merchantKey('SQ *BLUE BOTTLE COFFEE'), 'blue bottle');
    assert.equal(S.merchantKey('HARRIS TEETER #0123'), 'harris teeter');
  });
});

describe('CSV / OFX formats', () => {
  test('AMEX CSV: charges are positive, card member kept', () => {
    const p = parse('amex.csv');
    assert.equal(p.source, 'American Express');
    assert.equal(p.kind, 'card');
    assert.equal(p.txns.length, 6);
    const tesla = p.txns[0];
    assert.deepEqual([tesla.date, tesla.spend, tesla.member], ['2026-11-14', 14.2, 'JANE DOE']);
    assert.equal(p.txns.find((t: any) => /AUTOPAY/.test(t.desc)).spend, -1482.11);
  });

  test('Chase card CSV: negative amounts are purchases', () => {
    const p = parse('chase-card.csv');
    assert.deepEqual([p.source, p.kind], ['Chase', 'card']);
    assert.deepEqual(p.txns.map((t: any) => t.spend), [54.21, 41, -500, 20, -15]);
    assert.equal(p.txns[0].category, 'Groceries');
  });

  test('Chase checking CSV is detected as a bank account', () => {
    const p = parse('chase-checking.csv');
    assert.deepEqual([p.source, p.kind], ['Chase', 'bank']);
    assert.equal(p.txns[0].desc, 'DUKE ENERGY PAYMENT');
  });

  test('Wells Fargo headerless CSV', () => {
    const p = parse('wells-fargo.csv');
    assert.deepEqual([p.source, p.kind], ['Wells Fargo', 'bank']);
    assert.deepEqual(p.txns.map((t: any) => t.spend), [12.34, -1800, 300, 55]);
  });

  test('OFX / QFX download', () => {
    const p = parse('amex.qfx');
    assert.deepEqual([p.source, p.kind], ['American Express', 'card']);
    assert.deepEqual(p.txns.map((t: any) => [t.date, t.spend]), [['2026-11-02', 9.4], ['2026-10-26', -1482.11]]);
  });

  test('rejects a Budgedora export and files without the needed columns', () => {
    assert.throws(() => S.parseFile({ name: 'x.csv', text: 'date,bucket,amount,note\n2026-01-01,Groceries,5,x' }), /Budgedora CSV/);
    assert.throws(() => S.parseFile({ name: 'x.csv', text: 'foo,bar\n1,2' }), /Couldn't find/);
  });

  test('parseCsv handles quotes, embedded commas and a BOM', () => {
    assert.deepEqual(S.parseCsv('﻿a,"b, c","say ""hi"""\n1,2,3'), [['a', 'b, c', 'say "hi"'], ['1', '2', '3']]);
  });
});

describe('PDF statements', () => {
  const chaseCard = [page(
    line(800, [50, 'Chase Freedom']),
    line(790, [50, 'Opening/Closing Date 10/15/26 - 11/14/26']),
    line(770, [50, 'Previous Balance'], [400, '$1,000.00']),
    line(760, [50, 'New Balance'], [400, '$578.20']),
    line(740, [50, 'ACCOUNT ACTIVITY']),
    line(720, [50, '10/20'], [100, 'HARRIS TEETER #0123 CARY NC'], [450, '54.21']),
    line(710, [50, '11/02'], [100, 'Payment Thank You-Mobile'], [450, '-500.00']),
    line(700, [50, '11/05'], [100, 'AMAZON MKTPL*AB12CD34E'], [450, '23.99']),
    line(692, [100, 'Order Number 111-1111111-1111111']),
    line(670, [50, 'Totals Year-to-Date'], [450, '0.00']),
  )];

  test('Chase card PDF: lines, wrapped Amazon order number, and a totals check that balances', () => {
    const p = S.parsePdf(chaseCard, 'chase.pdf');
    assert.deepEqual([p.source, p.kind], ['Chase', 'card']);
    assert.deepEqual(p.txns.map((t: any) => [t.date, t.desc, t.spend]), [
      ['2026-10-20', 'HARRIS TEETER #0123 CARY NC', 54.21],
      ['2026-11-02', 'Payment Thank You-Mobile', -500],
      ['2026-11-05', 'AMAZON MKTPL', 23.99],
    ]);
    assert.match(p.txns[2].raw, /Order Number 111-1111111-1111111/);
    assert.deepEqual(p.check, { expected: -421.8, got: -421.8, ok: true });
  });

  test('a December–January statement puts each date in the right year', () => {
    const p = S.parsePdf([page(
      line(800, [50, 'Opening/Closing Date 12/15/25 - 01/14/26']),
      line(780, [50, 'ACCOUNT ACTIVITY']),
      line(760, [50, '12/20'], [100, 'SHELL OIL 57444'], [450, '41.00']),
      line(750, [50, '01/05'], [100, 'HARRIS TEETER #0123'], [450, '12.00']),
    )]);
    assert.deepEqual(p.txns.map((t: any) => t.date), ['2025-12-20', '2026-01-05']);
  });

  test('Wells Fargo checking PDF: deposit vs withdrawal by column, holder names removed', () => {
    const p = S.parsePdf([page(
      line(810, [50, 'JANE DOE']),
      line(800, [50, 'Wells Fargo Everyday Checking']),
      line(790, [50, 'November 6, 2026']),
      line(770, [50, 'Beginning balance on 10/8'], [400, '$1,000.00']),
      line(760, [50, 'Ending balance on 11/6'], [400, '$2,777.67']),
      line(740, [50, 'Transaction history']),
      line(730, [50, 'Date', 20], [100, 'Description', 50], [300, 'Deposits/ Additions', 60], [380, 'Withdrawals/ Subtractions', 80], [480, 'Ending daily balance', 60]),
      line(710, [50, '10/10'], [100, 'Purchase authorized on 10/09 Kroger #123 Raleigh NC'], [440, '12.34', 20]),
      line(700, [50, '10/12'], [100, 'Recurring Payment authorized on 10/11 Apple.Com/Bill Jane Doe'], [440, '9.99', 20]),
      line(690, [50, '10/15'], [100, 'Direct Dep Acme Payroll'], [325, '1,800.00', 35], [500, '2,777.67', 40]),
      line(670, [50, 'Ending balance on 11/6'], [500, '2,777.67', 40]),
    )], 'wf.pdf');
    assert.deepEqual([p.source, p.kind], ['Wells Fargo', 'bank']);
    assert.deepEqual(p.txns.map((t: any) => [t.date, t.desc, t.spend]), [
      ['2026-10-10', 'Kroger #123 Raleigh NC', 12.34],
      ['2026-10-12', 'Apple.Com/Bill', 9.99],
      ['2026-10-15', 'Direct Dep Acme Payroll', -1800],
    ]);
    assert.equal(p.check.ok, true);
  });

  test('a PDF with no transaction lines gives a helpful error', () => {
    assert.throws(() => S.parsePdf([page(line(800, [50, 'Just a letter']))], 'scan.pdf'), /No transactions found in scan\.pdf/);
  });
});

describe('plan: what gets imported', () => {
  const files = ['amex.csv', 'chase-card.csv', 'chase-checking.csv', 'wells-fargo.csv'].map(parse);

  test('skips card payments, transfers and income; keeps purchases and refunds', () => {
    const rows = S.plan(files, { buckets: BUCKETS, expenses: [] });
    const skipOf = (desc: string) => rows.find((r: any) => r.desc === desc).skip;
    assert.equal(skipOf('AUTOPAY PAYMENT - THANK YOU'), 'Card payment');
    assert.equal(skipOf('Payment Thank You-Mobile'), 'Card payment');
    assert.equal(skipOf('WF Credit Card AUTO PAY'), 'Payment / transfer');
    assert.equal(skipOf('ACME CORP PAYROLL'), 'Money in');
    assert.equal(skipOf('DIRECT DEP ACME PAYROLL'), 'Money in');
    assert.equal(skipOf('TARGET 0001'), null); // a refund is imported as a negative expense
    assert.equal(rows.filter((r: any) => r.on).length, 13);
    // newest first
    assert.deepEqual(rows.map((r: any) => r.date), [...rows.map((r: any) => r.date)].sort().reverse());
  });

  test('guesses buckets from merchant names and the bank category', () => {
    const rows = S.plan(files, { buckets: BUCKETS, expenses: [] });
    const bucketOf = (desc: string) => bucket(rows.find((r: any) => r.desc === desc).bucketId);
    assert.equal(bucketOf('TESLA INC SUPERCHARGPALO ALTO'), 'Car/Gas');
    assert.equal(bucketOf('ALDI INC CARY'), 'Groceries');
    assert.equal(bucketOf('HARRIS TEETER #0123'), 'Groceries'); // Chase category "Groceries"
    assert.equal(bucketOf('DUKE ENERGY PAYMENT'), 'Utilities');
    assert.equal(bucketOf('STARBUCKS STORE 1234 RALEIGH NC'), 'Restaurants');
  });

  test('history beats the built-in guess', () => {
    const expenses = [{ date: '2026-01-01', amount: 30, note: 'Starbucks Store 99', bucketId: 7 }];
    const rows = S.plan([parse('chase-checking.csv')], { buckets: BUCKETS, expenses });
    assert.equal(bucket(rows.find((r: any) => /STARBUCKS/.test(r.desc)).bucketId), 'Entertainment');
  });

  test('re-importing marks rows already saved as duplicates — once per saved expense', () => {
    const twice = { source: 'Chase', kind: 'card', txns: [...parse('chase-card.csv').txns.slice(0, 1), ...parse('chase-card.csv').txns.slice(0, 1)] };
    const expenses = [{ date: '2026-11-01', amount: 54.21, note: 'Harris Teeter (renamed)', bucketId: 1 }];
    const rows = S.plan([twice], { buckets: BUCKETS, expenses });
    assert.deepEqual(rows.map((r: any) => r.dup), [true, false]);
  });

  test('archived buckets are never suggested', () => {
    const buckets = BUCKETS.map((b) => (b.name === 'Groceries' ? { ...b, archived: true } : b));
    const rows = S.plan([parse('amex.csv')], { buckets, expenses: [] });
    assert.equal(rows.find((r: any) => r.desc === 'ALDI INC CARY').bucketId, null);
  });
});

describe('Amazon order history', () => {
  const amazon = parse('amazon-orders.csv');

  test('parses orders and leaves out cancelled ones', () => {
    assert.equal(amazon.amazon, true);
    assert.deepEqual([...amazon.orders.keys()], ['111-1111111-1111111', '222-2222222-2222222']);
    assert.equal(amazon.orders.get('222-2222222-2222222').items.length, 2);
  });

  test('matches a card charge by amount and date, and names what was bought', () => {
    const rows = S.plan([parse('amex.csv')], { buckets: BUCKETS, expenses: [] });
    const res = S.enrichAmazon(rows, amazon.orders, BUCKETS);
    const row = rows.find((r: any) => r.amazon);
    assert.equal(res.matched, 1);
    assert.match(row.desc, /^Amazon: Anker USB C Cable/);
    assert.equal(bucket(row.bucketId), 'Household');
  });

  test('matches by the order number printed on a Chase statement', () => {
    const p = S.parsePdf([page(
      line(800, [50, 'Chase Freedom']),
      line(790, [50, 'Opening/Closing Date 10/15/26 - 11/14/26']),
      line(740, [50, 'ACCOUNT ACTIVITY']),
      line(700, [50, '11/12'], [100, 'AMAZON MKTPL*AB12CD34E'], [450, '170.00']),
      line(692, [100, 'Order Number 222-2222222-2222222']),
    )]);
    const rows = S.plan([p], { buckets: BUCKETS, expenses: [] });
    S.enrichAmazon(rows, amazon.orders, BUCKETS);
    assert.equal(rows[0].desc, 'Amazon: Ninja Air Fryer Pro 4-in-1, Vitamin D3 Gummies');
    // a mixed order goes to the bucket of its most expensive item (air fryer → Household, not Health)
    assert.equal(bucket(rows[0].bucketId), 'Household');
  });
});
