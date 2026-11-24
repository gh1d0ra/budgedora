// Creates (or recreates) a demo account with ~3 years of realistic expenses.
// Login: demo@budgedora.test / demo1234
// Usage: npm run seed
'use strict';
const { db, DEFAULT_BUCKETS, hashPassword } = require('../server.js');

const email = 'demo@budgedora.test';
const old = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
if (old) {
  db.prepare('DELETE FROM expenses WHERE user_id = ?').run(old.id);
  db.prepare('DELETE FROM buckets WHERE user_id = ?').run(old.id);
  db.prepare('DELETE FROM users WHERE id = ?').run(old.id);
}
const uid = Number(db.prepare('INSERT INTO users (email, name, pass_hash) VALUES (?, ?, ?)').run(email, 'Demo', hashPassword('demo1234')).lastInsertRowid);

const budgets = { Groceries: 90000, Restaurants: 30000, Utilities: 40000 };
const ids = {};
const insB = db.prepare('INSERT INTO buckets (user_id, name, icon, color, sort, monthly_budget) VALUES (?, ?, ?, ?, ?, ?)');
DEFAULT_BUCKETS.forEach(([n, i, c], idx) => { ids[n] = Number(insB.run(uid, n, i, c, idx, budgets[n] ?? null).lastInsertRowid); });

let seed = 7;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const pick = (a) => a[Math.floor(rnd() * a.length)];
const pad = (n) => String(n).padStart(2, '0');
const insE = db.prepare('INSERT INTO expenses (user_id, bucket_id, amount, date, note) VALUES (?, ?, ?, ?, ?)');
const today = new Date();
const start = new Date(today.getFullYear() - 2, 0, 1);
let count = 0;

db.exec('BEGIN');
for (let d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) {
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const growth = 1 + (d.getFullYear() - start.getFullYear()) * 0.06;
  const add = (b, cents, note) => { insE.run(uid, ids[b], Math.round(cents * growth), date, note); count++; };
  const dow = d.getDay(), dom = d.getDate(), mon = d.getMonth();
  if (dow === 6 || rnd() < 0.12) add('Groceries', 4000 + rnd() * 14000, pick(['Costco', 'Walmart', 'Aldi', 'Kroger', 'Trader Joes']));
  if (((dow === 5 || dow === 0) && rnd() < 0.6) || rnd() < 0.05) add('Restaurants', 1500 + rnd() * 7000, pick(['Chipotle', 'Pizza night', 'Starbucks', 'Olive Garden', 'Thai place']));
  if (rnd() < 0.08) add('Car/Gas', 3500 + rnd() * 3000, pick(['Shell', 'Costco gas', 'Exxon']));
  if (dom === 3) add('Utilities', 9000 + (mon < 2 || mon > 10 ? 9000 : mon > 5 && mon < 9 ? 7000 : 2000) + rnd() * 2000, 'Electric');
  if (dom === 8) insE.run(uid, ids.Utilities, 7999, date, 'Internet'), count++;
  if (dom === 12) add('Utilities', 4500 + rnd() * 1500, 'Water');
  if (dom === 15) insE.run(uid, ids.Entertainment, 1549, date, 'Netflix'), count++;
  if (dom === 20) insE.run(uid, ids.Entertainment, 1199, date, 'Spotify'), count++;
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
db.exec('COMMIT');
console.log(`Seeded ${count} expenses for ${email} (password: demo1234)`);
