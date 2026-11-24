// Deterministic, realistic made-up expenses from Jan 1 two years ago until today.
// Returns rows of [bucketName, amountCents, 'YYYY-MM-DD', note].
export const DEMO_BUDGETS = { Groceries: 90000, Restaurants: 30000, Utilities: 40000 };

export function demoExpenses(today = new Date()) {
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const pad = (n) => String(n).padStart(2, '0');
  const rows = [];
  const start = new Date(today.getFullYear() - 2, 0, 1);

  for (let d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) {
    const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const growth = 1 + (d.getFullYear() - start.getFullYear()) * 0.06;
    const add = (b, cents, note, fixed) => rows.push([b, Math.round(fixed ? cents : cents * growth), date, note]);
    const dow = d.getDay(), dom = d.getDate(), mon = d.getMonth();
    if (dow === 6 || rnd() < 0.12) add('Groceries', 4000 + rnd() * 14000, pick(['Costco', 'Walmart', 'Aldi', 'Kroger', 'Trader Joes']));
    if (((dow === 5 || dow === 0) && rnd() < 0.6) || rnd() < 0.05) add('Restaurants', 1500 + rnd() * 7000, pick(['Chipotle', 'Pizza night', 'Starbucks', 'Olive Garden', 'Thai place']));
    if (rnd() < 0.08) add('Car/Gas', 3500 + rnd() * 3000, pick(['Shell', 'Costco gas', 'Exxon']));
    if (dom === 3) add('Utilities', 9000 + (mon < 2 || mon > 10 ? 9000 : mon > 5 && mon < 9 ? 7000 : 2000) + rnd() * 2000, 'Electric');
    if (dom === 8) add('Utilities', 7999, 'Internet', true);
    if (dom === 12) add('Utilities', 4500 + rnd() * 1500, 'Water');
    if (dom === 15) add('Entertainment', 1549, 'Netflix', true);
    if (dom === 20) add('Entertainment', 1199, 'Spotify', true);
    if (dow === 0) add('Giving', 10000, 'Church');
    if (dom === 1) add('House insurance/tax + HOA', 25000, 'HOA');
    if (dom === 10 && mon % 6 === 0) add('House insurance/tax + HOA', 180000, 'Property tax');
    if (mon >= 3 && mon <= 9 && dow === 3) add('Household + grass', 4500, 'Lawn service');
    if (rnd() < 0.04) add('Household + grass', 2000 + rnd() * 12000, pick(['Home Depot', 'Target', 'Amazon']));
    if (rnd() < 0.03) add('Health/Beauty', 2500 + rnd() * 9000, pick(['CVS', 'Haircut', 'Dentist copay']));
    if (rnd() < 0.025) add('Clothes', 3000 + rnd() * 9000, pick(['Old Navy', 'Shoes', 'Kohls']));
    if (dom === 5 && mon !== 6 && mon !== 7) add('Education', 15000, 'Piano lessons');
    if (rnd() < 0.03) add('Entertainment', 2000 + rnd() * 6000, pick(['Movies', 'Concert tickets', 'Bowling']));
    if (mon === 6 && dom >= 10 && dom <= 16) add('Vacation', 15000 + rnd() * 40000, pick(['Hotel', 'Flights', 'Beach rentals', 'Dinner out']));
  }
  return rows;
}
