// Budgedora "smarts": dates/periods, natural-language questions, insights and suggestions.
// Pure functions — no DOM. Exposed as window.Smart.
(function () {
  'use strict';

  // ---------- dates ----------
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const monthStart = (y, m) => new Date(y, m, 1);
  const monthEnd = (y, m) => new Date(y, m + 1, 0);
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const MON = MONTHS.map((m) => m.slice(0, 3));
  const daysBetween = (a, b) => Math.round((parseYmd(b) - parseYmd(a)) / 864e5) + 1;

  const P = {
    month(y, m) { return { from: ymd(monthStart(y, m)), to: ymd(monthEnd(y, m)), label: `${MONTHS[m]} ${y}`, kind: 'month', y, m }; },
    year(y) { return { from: `${y}-01-01`, to: `${y}-12-31`, label: String(y), kind: 'year', y }; },
    range(from, to, label) { return { from: ymd(from), to: ymd(to), label, kind: 'range' }; },
    all(expenses) {
      const dates = expenses.map((e) => e.date).sort();
      const today = ymd(new Date());
      return { from: dates[0] || today, to: dates[dates.length - 1] > today ? dates[dates.length - 1] : today, label: 'All time', kind: 'all' };
    },
  };

  /** Preset periods relative to today. */
  function preset(key, expenses, today = new Date()) {
    const y = today.getFullYear(), m = today.getMonth();
    switch (key) {
      case 'this-month': return { ...P.month(y, m), label: 'This month' };
      case 'last-month': { const d = new Date(y, m - 1, 1); return P.month(d.getFullYear(), d.getMonth()); }
      case 'last-3': return P.range(new Date(y, m - 2, 1), monthEnd(y, m), 'Last 3 months');
      case 'last-12': return P.range(new Date(y, m - 11, 1), monthEnd(y, m), 'Last 12 months');
      case 'this-year': return { ...P.year(y), label: `This year (${y})` };
      case 'last-year': return P.year(y - 1);
      case 'all': return P.all(expenses);
    }
  }

  /** The equally sized period right before p (used for "vs previous"). */
  function previous(p) {
    if (p.kind === 'month') { const d = new Date(p.y, p.m - 1, 1); return P.month(d.getFullYear(), d.getMonth()); }
    if (p.kind === 'year') return P.year(p.y - 1);
    if (p.kind === 'all') return null;
    const from = parseYmd(p.from), to = parseYmd(p.to);
    // whole-month ranges shift by months, others by days
    if (from.getDate() === 1 && addDays(to, 1).getDate() === 1) {
      const months = (to.getFullYear() - from.getFullYear()) * 12 + to.getMonth() - from.getMonth() + 1;
      return P.range(new Date(from.getFullYear(), from.getMonth() - months, 1), addDays(from, -1), 'previous period');
    }
    const len = daysBetween(p.from, p.to);
    return P.range(addDays(from, -len), addDays(from, -1), 'previous period');
  }

  const inP = (e, p) => e.date >= p.from && e.date <= p.to;
  const sum = (arr) => arr.reduce((s, e) => s + e.amount, 0);

  /** List of {key:'YYYY-MM', label} covering a period (clamped to data for 'all'). */
  function monthsIn(p) {
    const out = [];
    let d = parseYmd(p.from); d = new Date(d.getFullYear(), d.getMonth(), 1);
    const end = parseYmd(p.to);
    while (d <= end && out.length < 600) {
      out.push({ key: `${d.getFullYear()}-${pad(d.getMonth() + 1)}`, label: `${MON[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`, y: d.getFullYear(), m: d.getMonth() });
      d = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    }
    return out;
  }

  /** Months elapsed in a period, not counting the future (min 1). */
  function elapsedMonths(p, today = new Date()) {
    const t = ymd(today);
    const to = p.to > t ? t : p.to;
    if (to < p.from) return 1;
    const a = parseYmd(p.from), b = parseYmd(to);
    const whole = (b.getFullYear() - a.getFullYear()) * 12 + b.getMonth() - a.getMonth();
    const frac = b.getDate() / monthEnd(b.getFullYear(), b.getMonth()).getDate();
    return Math.max(1, whole + (a.getDate() === 1 ? frac : 1));
  }

  // ---------- bucket matching ----------
  const ALIASES = {
    groceries: ['grocery', 'groceries', 'food', 'supermarket', 'costco', 'walmart', 'aldi', 'kroger', 'publix', 'trader', 'safeway', 'heb', 'lidl', 'kaufland', 'market'],
    restaurants: ['restaurant', 'restaurants', 'dining', 'eating', 'takeout', 'take-out', 'coffee', 'starbucks', 'mcdonalds', 'pizza', 'lunch', 'dinner', 'breakfast', 'chipotle', 'doordash', 'ubereats', 'cafe'],
    household: ['household', 'house', 'home', 'grass', 'lawn', 'garden', 'mowing', 'cleaning', 'furniture', 'home depot', 'lowes', 'ikea', 'target', 'amazon'],
    gas: ['car', 'gas', 'fuel', 'auto', 'shell', 'exxon', 'chevron', 'bp', 'oil change', 'tires', 'parking', 'toll', 'carwash', 'mechanic'],
    insurance: ['insurance', 'tax', 'taxes', 'hoa', 'property', 'mortgage'],
    utilities: ['utilities', 'utility', 'electric', 'electricity', 'power', 'water', 'internet', 'phone', 'cell', 'trash', 'sewer', 'verizon', 'comcast', 'xfinity', 'att', 't-mobile'],
    education: ['education', 'school', 'tuition', 'books', 'course', 'class', 'classes', 'lessons', 'college', 'university'],
    giving: ['giving', 'church', 'tithe', 'donation', 'donations', 'charity', 'offering', 'gift', 'gifts', 'missions'],
    health: ['health', 'beauty', 'doctor', 'dentist', 'pharmacy', 'medicine', 'cvs', 'walgreens', 'haircut', 'salon', 'hospital', 'gym', 'medical', 'vitamins'],
    clothes: ['clothes', 'clothing', 'shoes', 'shirt', 'jeans', 'dress', 'apparel'],
    entertainment: ['entertainment', 'fun', 'movies', 'movie', 'netflix', 'spotify', 'disney', 'games', 'concert', 'tickets', 'hulu', 'youtube', 'streaming'],
    vacation: ['vacation', 'travel', 'trip', 'trips', 'hotel', 'flight', 'flights', 'airbnb', 'holiday', 'cruise'],
  };
  const stem = (w) => w.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/(ies)$/, 'y').replace(/s$/, '');

  /** Words that identify each bucket: its own name words + known aliases for that kind of bucket. */
  function bucketKeywords(b) {
    const own = b.name.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
    const kw = new Set(own.map(stem));
    for (const [, words] of Object.entries(ALIASES)) {
      if (words.some((w) => own.includes(w) || own.map(stem).includes(stem(w)))) words.forEach((w) => kw.add(stem(w)));
    }
    return kw;
  }

  function findBuckets(text, buckets) {
    const lower = ' ' + text.toLowerCase() + ' ';
    const words = new Set(lower.split(/[^a-z0-9]+/).filter(Boolean).map(stem));
    const found = [];
    for (const b of buckets) {
      if (lower.includes(' ' + b.name.toLowerCase())) { found.push({ b, pos: lower.indexOf(b.name.toLowerCase()) }); continue; }
      const kw = bucketKeywords(b);
      let pos = -1;
      for (const w of words) if (kw.has(w)) { pos = lower.search(new RegExp('\\b' + w)); break; }
      if (pos >= 0 || [...kw].some((k) => k.includes(' ') && lower.includes(k))) found.push({ b, pos: pos < 0 ? 999 : pos });
    }
    return found.sort((a, b) => a.pos - b.pos).map((x) => x.b);
  }

  // ---------- natural language ----------
  const STOP = new Set('how much did i we spend spent spending on in for the a an of at to and or vs versus compare compared with what was is my our were are total show me all by per month months year years last this top biggest largest most expensive average avg typical monthly weekly daily over under above below more less than since from between during each every trend count many often times money cost costs expenses expense purchases ytd today yesterday week weeks days day q1 q2 q3 q4 ever time so far whole out eating going went get got paid pay buy bought usually normally break down breakdown where'.split(' '));
  /** "in March 2025" / "since 2023" / "last 3 months" / "of all time" */
  const when = (p) => (/^(since|last|this|today|yesterday|past)/i.test(p.label) ? p.label : p.kind === 'all' ? 'of all time' : 'in ' + p.label);

  function parseQuery(text, ctx) {
    const today = ctx.today || new Date();
    const t = text.toLowerCase().replace(/[’']/g, '').trim();
    const Y = today.getFullYear(), M = today.getMonth();
    const q = { text, periods: [], buckets: [], intent: 'total', min: null, max: null, words: [], understood: [] };

    // --- periods ---
    const years = [...t.matchAll(/\b(19|20)\d{2}\b/g)].map((m) => Number(m[0]));
    const monthHits = [];
    t.replace(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b(?:\s+((?:19|20)\d{2}))?/g,
      (_, mon, yr) => { monthHits.push({ m: MON.findIndex((x) => mon.startsWith(x.toLowerCase())), y: yr ? Number(yr) : null }); });
    const quarter = t.match(/\bq([1-4])\b(?:\s+((?:19|20)\d{2}))?/);
    let rel;

    if ((rel = t.match(/\b(?:last|past|previous)\s+(\d+)\s+(day|week|month|year)s?\b/))) {
      const n = Number(rel[1]), unit = rel[2];
      const to = today;
      const from = unit === 'day' ? addDays(today, -n + 1) : unit === 'week' ? addDays(today, -7 * n + 1)
        : unit === 'month' ? new Date(Y, M - n + 1, 1) : new Date(Y - n + 1, 0, 1);
      q.periods.push(P.range(from, to, `last ${n} ${unit}s`));
    } else if (/\b(this|current)\s+month\b|\bmonth to date\b|\bmtd\b/.test(t)) q.periods.push({ ...P.month(Y, M), label: 'this month' });
    else if (/\b(last|previous)\s+month\b/.test(t)) { const d = new Date(Y, M - 1, 1); q.periods.push(P.month(d.getFullYear(), d.getMonth())); }
    else if (/\b(this|current)\s+week\b/.test(t)) { const s = addDays(today, -((today.getDay() + 6) % 7)); q.periods.push(P.range(s, addDays(s, 6), 'this week')); }
    else if (/\b(last|previous)\s+week\b/.test(t)) { const s = addDays(today, -((today.getDay() + 6) % 7) - 7); q.periods.push(P.range(s, addDays(s, 6), 'last week')); }
    else if (/\btoday\b/.test(t)) q.periods.push(P.range(today, today, 'today'));
    else if (/\byesterday\b/.test(t)) { const d = addDays(today, -1); q.periods.push(P.range(d, d, 'yesterday')); }
    else if (/\bytd\b|year to date|so far this year/.test(t)) q.periods.push(P.range(new Date(Y, 0, 1), today, `${Y} so far`));
    else if (/\b(this|current)\s+year\b/.test(t)) q.periods.push(P.year(Y));
    else if (/\b(last|previous)\s+year\b/.test(t) && !years.length) q.periods.push(P.year(Y - 1));
    else if ((rel = t.match(/\bsince\s+(?:(jan\w*|feb\w*|mar\w*|apr\w*|may|jun\w*|jul\w*|aug\w*|sep\w*|oct\w*|nov\w*|dec\w*)\s+)?((?:19|20)\d{2})\b/))) {
      const mi = rel[1] ? MON.findIndex((x) => rel[1].startsWith(x.toLowerCase())) : 0;
      q.periods.push(P.range(new Date(Number(rel[2]), mi, 1), today, `since ${rel[1] ? MONTHS[mi] + ' ' : ''}${rel[2]}`));
    } else if (quarter) {
      const qy = quarter[2] ? Number(quarter[2]) : (years[0] || Y), qi = Number(quarter[1]) - 1;
      q.periods.push(P.range(new Date(qy, qi * 3, 1), monthEnd(qy, qi * 3 + 2), `Q${qi + 1} ${qy}`));
    } else if (monthHits.length) {
      const looseYears = years.filter((y) => !monthHits.some((h) => h.y === y));
      for (const h of monthHits) {
        if (h.y) q.periods.push(P.month(h.y, h.m));
        else if (looseYears.length) looseYears.forEach((y) => q.periods.push(P.month(y, h.m)));
        else q.periods.push(P.month(h.m <= M ? Y : Y - 1, h.m));
      }
      // "march 2024 vs 2025" → also march of the loose years
      if (monthHits.length === 1 && monthHits[0].y && looseYears.length) looseYears.forEach((y) => q.periods.push(P.month(y, monthHits[0].m)));
    } else if (years.length) {
      [...new Set(years)].forEach((y) => q.periods.push(P.year(y)));
    }
    if (/\b(all time|ever|overall|lifetime)\b/.test(t)) q.periods = [P.all(ctx.expenses)];

    // --- buckets ---
    // A word that is literally in your notes (e.g. "netflix", "church", "electric") is more precise as a note
    // filter than as a bucket alias — unless it's part of the bucket's own name (e.g. "gas" in "Car/Gas").
    const noteWords = new Set(ctx.expenses.flatMap((e) => e.note.toLowerCase().split(/[^a-z0-9]+/)).filter((w) => w.length >= 3));
    const ownNameWords = new Set(ctx.buckets.flatMap((b) => b.name.toLowerCase().split(/[^a-z0-9]+/).map(stem)));
    const preferNote = t.split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w) && noteWords.has(w) && !ownNameWords.has(stem(w)));
    const bucketText = preferNote.reduce((s, w) => s.replace(new RegExp('\\b' + w + '\\b', 'g'), ' '), t);
    q.buckets = findBuckets(bucketText, ctx.buckets);

    // --- intent ---
    if (/\b(top|biggest|largest|most expensive|highest)\b/.test(t)) q.intent = 'top';
    else if (/\b(average|avg|typical|usually|normally)\b|\bper (month|week|day)\b/.test(t)) q.intent = 'average';
    else if (/\bhow (many|often)\b|\bcount\b|\bnumber of\b/.test(t)) q.intent = 'count';
    else if (/\b(trend|over time|by month|monthly|each month|every month)\b/.test(t)) q.intent = 'trend';
    else if (/\b(where|breakdown|break down|split|categories|buckets)\b/.test(t)) q.intent = 'breakdown';
    if (/\b(vs|versus|compare|compared|against)\b/.test(t) || q.periods.length > 1 || q.buckets.length > 1 && /\band\b/.test(t)) {
      if (q.periods.length > 1) q.intent = 'compare-periods';
      else if (q.buckets.length > 1) q.intent = 'compare-buckets';
      else if (q.periods.length === 1) { q.periods.push(previous(q.periods[0]) || q.periods[0]); q.intent = 'compare-periods'; }
    }
    let mm;
    if ((mm = t.match(/(?:over|above|more than|greater than|>)\s*\$?\s*(\d+(?:\.\d+)?)/))) q.min = Number(mm[1]);
    if ((mm = t.match(/(?:under|below|less than|cheaper than|<)\s*\$?\s*(\d+(?:\.\d+)?)/))) q.max = Number(mm[1]);

    // --- leftover words → search notes ---
    const bucketWords = new Set(q.buckets.flatMap((b) => [...bucketKeywords(b)]));
    q.words = [...new Set(t.split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w)
      && !MON.some((x) => w === x.toLowerCase() || MONTHS.some((mm) => mm.toLowerCase() === w))
      && (preferNote.includes(w) || (!bucketWords.has(stem(w)) && noteWords.has(w)))))];
    // Never let note words turn a sensible question into an empty answer.
    if (q.words.length && !filterFor(q, ctx, q.periods[0] || P.all(ctx.expenses)).length) q.words = [];
    // Show comparisons oldest → newest so "▲ x%" always means "went up over time".
    if (q.periods.length > 1) q.periods.sort((a, b) => (a.from < b.from ? -1 : 1));

    if (!q.periods.length) q.periods.push(q.intent === 'top' ? P.all(ctx.expenses) : P.all(ctx.expenses));

    // human readable "understood as"
    q.understood.push(q.buckets.length ? q.buckets.map((b) => b.name).join(' + ') : 'all buckets');
    q.understood.push(q.periods.map((p) => p.label).join(' vs '));
    if (q.words.length) q.understood.push(`notes containing “${q.words.join(' ')}”`);
    if (q.min != null) q.understood.push(`over ${q.min}`);
    if (q.max != null) q.understood.push(`under ${q.max}`);
    return q;
  }

  function filterFor(q, ctx, period, bucketsOverride) {
    const ids = new Set((bucketsOverride || q.buckets).map((b) => b.id));
    return ctx.expenses.filter((e) => inP(e, period)
      && (!ids.size || ids.has(e.bucketId))
      && (q.min == null || e.amount > q.min)
      && (q.max == null || e.amount < q.max)
      && (!q.words.length || q.words.every((w) => e.note.toLowerCase().includes(w))));
  }

  const pct = (a, b) => (b ? Math.round(((a - b) / b) * 100) : null);
  const deltaHtml = (a, b) => {
    const d = pct(a, b);
    if (d == null) return '';
    if (d === 0) return ' <span class="muted">(same as before)</span>';
    return ` <span class="${d > 0 ? 'up' : 'down'}">(${d > 0 ? '▲' : '▼'} ${Math.abs(d)}%)</span>`;
  };

  function monthlySeries(list, period) {
    const months = monthsIn(period);
    const map = new Map(months.map((m) => [m.key, 0]));
    list.forEach((e) => { const k = e.date.slice(0, 7); if (map.has(k)) map.set(k, map.get(k) + e.amount); });
    return { labels: months.map((m) => m.label), values: months.map((m) => map.get(m.key)) };
  }

  /** Builds an answer object: { headline (html), understood, chart?, list? } */
  function answer(q, ctx) {
    const f = ctx.fmt;
    const esc = ctx.esc;
    const bName = (bs) => (bs.length ? bs.map((b) => `${b.icon} ${esc(b.name)}`).join(' + ') : 'everything');
    const what = q.buckets.length ? bName(q.buckets) + (q.words.length ? ` (“${esc(q.words.join(' '))}”)` : '') : q.words.length ? `“${esc(q.words.join(' '))}”` : 'everything';
    const p = q.periods[0];
    const list = filterFor(q, ctx, p);
    const total = sum(list);
    const res = { understood: 'Understood as: ' + q.understood.join(' · '), list: null, chart: null };

    if (q.intent === 'compare-periods') {
      const totals = q.periods.map((pp) => sum(filterFor(q, ctx, pp)));
      const parts = q.periods.map((pp, i) => `<b>${f(totals[i])}</b> ${esc(when(pp))}`);
      res.headline = `${what}: ${parts.join(' vs ')}${q.periods.length === 2 ? deltaHtml(totals[1], totals[0]) : ''}`;
      const bs = q.buckets.length ? q.buckets : ctx.buckets.filter((b) => q.periods.some((pp) => sum(filterFor(q, ctx, pp, [b])) > 0));
      res.chart = {
        type: 'bar',
        labels: bs.map((b) => b.name),
        datasets: q.periods.map((pp, i) => ({ label: pp.label, data: bs.map((b) => sum(filterFor(q, ctx, pp, [b]))), colorIndex: i })),
      };
      return res;
    }

    if (q.intent === 'compare-buckets') {
      const totals = q.buckets.map((b) => sum(filterFor(q, ctx, p, [b])));
      res.headline = q.buckets.map((b, i) => `${b.icon} ${esc(b.name)} <b>${f(totals[i])}</b>`).join(' vs ') + ` <span class="muted">${esc(when(p))}</span>`;
      const series = q.buckets.map((b) => monthlySeries(filterFor(q, ctx, p, [b]), p));
      res.chart = { type: 'bar', labels: series[0].labels, datasets: q.buckets.map((b, i) => ({ label: b.name, data: series[i].values, color: b.color })) };
      return res;
    }

    if (q.intent === 'top') {
      const top = [...list].sort((a, b) => b.amount - a.amount).slice(0, 10);
      if (!top.length) { res.headline = `No expenses found for ${what} ${esc(when(p))}.`; return res; }
      const b0 = ctx.bucketById(top[0].bucketId);
      res.headline = `Biggest expense for ${what} ${esc(when(p))}: <b>${f(top[0].amount)}</b> — ${esc(top[0].note || b0?.name || '')} on ${ctx.fmtDate(top[0].date)}`;
      res.list = top;
      return res;
    }

    if (q.intent === 'breakdown' || (!q.buckets.length && !q.words.length && q.intent === 'total')) {
      const rows = ctx.buckets.map((b) => ({ b, v: sum(list.filter((e) => e.bucketId === b.id)) })).filter((r) => r.v > 0).sort((a, b) => b.v - a.v);
      res.headline = `You spent <b>${f(total)}</b> ${esc(when(p))} across ${list.length} expenses` +
        (rows[0] ? ` — most on ${rows[0].b.icon} ${esc(rows[0].b.name)} (${Math.round((rows[0].v / total) * 100)}%)` : '') + '.';
      res.chart = { type: 'bar', horizontal: true, labels: rows.map((r) => r.b.name), datasets: [{ label: p.label, data: rows.map((r) => r.v), colors: rows.map((r) => r.b.color) }] };
      return res;
    }

    const months = elapsedMonths(p, ctx.today);
    const series = monthlySeries(list, p);
    const multiMonth = series.labels.length > 1;

    if (q.intent === 'average') {
      const avg = total / months;
      res.headline = `On average you spend <b>${f(avg)}</b> per month on ${what} <span class="muted">(${esc(when(p))}, ${list.length} expenses, avg ticket ${f(list.length ? total / list.length : 0)})</span>`;
    } else if (q.intent === 'count') {
      res.headline = `<b>${list.length}</b> expenses for ${what} ${esc(when(p))}, totaling ${f(total)}` + (multiMonth ? ` — about ${(list.length / months).toFixed(1)} per month` : '') + '.';
    } else {
      const prev = previous(p);
      const prevTotal = prev ? sum(filterFor(q, ctx, prev)) : null;
      res.headline = `You spent <b>${f(total)}</b> on ${what} ${esc(when(p))}` +
        (prev && prevTotal ? deltaHtml(total, prevTotal) + ` <span class="muted">vs ${f(prevTotal)} the period before</span>` : '') +
        `<div class="muted" style="font-size:14px;font-weight:400;margin-top:4px">${list.length} expenses` +
        (multiMonth ? ` · ${f(total / months)}/month on average` : '') + '</div>';
    }
    if (multiMonth) {
      res.chart = { type: 'bar', labels: series.labels, datasets: [{ label: 'Spent', data: series.values, color: q.buckets[0]?.color }], avgLine: total / months };
    }
    res.list = [...list].sort((a, b) => b.amount - a.amount).slice(0, 5);
    return res;
  }

  // ---------- insights ----------
  function insights(period, ctx) {
    const f = ctx.fmt, esc = ctx.esc;
    const out = [];
    const today = ctx.today || new Date();
    const cur = ctx.expenses.filter((e) => inP(e, period));
    const total = sum(cur);
    if (!cur.length) return [{ icon: '🫙', html: 'No expenses in this period yet.' }];
    const prev = previous(period);
    const prevList = prev ? ctx.expenses.filter((e) => inP(e, prev)) : [];
    const prevTotal = sum(prevList);
    const isCurrent = period.from <= ymd(today) && period.to >= ymd(today);

    // projection for an in-progress month
    if (period.kind === 'month' && isCurrent) {
      const day = today.getDate(), dim = monthEnd(today.getFullYear(), today.getMonth()).getDate();
      const projected = (total / day) * dim;
      const last3 = [1, 2, 3].map((i) => { const d = new Date(today.getFullYear(), today.getMonth() - i, 1); return sum(ctx.expenses.filter((e) => inP(e, P.month(d.getFullYear(), d.getMonth())))); });
      const avg3 = last3.reduce((a, b) => a + b, 0) / 3;
      out.push({ icon: '🔮', html: `At this pace you'll spend about <b>${f(projected)}</b> this month` + (avg3 ? ` — ${projected > avg3 ? `<span class="up">${f(projected - avg3)} more</span>` : `<span class="down">${f(avg3 - projected)} less</span>`} than your 3-month average (${f(avg3)}).` : '.') });
    } else if (prev && prevTotal) {
      // compare only the elapsed part when the period is in progress
      const d = pct(total, prevTotal);
      out.push({ icon: d > 0 ? '📈' : '📉', html: `You spent <b>${f(total)}</b>, ${d === 0 ? 'the same as' : `<span class="${d > 0 ? 'up' : 'down'}">${Math.abs(d)}% ${d > 0 ? 'more' : 'less'}</span> than`} the previous period (${f(prevTotal)}).` });
    }

    // top bucket
    const byB = new Map();
    cur.forEach((e) => byB.set(e.bucketId, (byB.get(e.bucketId) || 0) + e.amount));
    const ranked = [...byB.entries()].sort((a, b) => b[1] - a[1]);
    const top = ctx.bucketById(ranked[0][0]);
    if (top) out.push({ icon: top.icon || '🏆', html: `<b>${esc(top.name)}</b> is your biggest bucket — ${f(ranked[0][1])}, ${Math.round((ranked[0][1] / total) * 100)}% of everything.` });

    // biggest movers vs previous period
    if (prevList.length) {
      const prevB = new Map();
      prevList.forEach((e) => prevB.set(e.bucketId, (prevB.get(e.bucketId) || 0) + e.amount));
      const moves = ctx.buckets.map((b) => ({ b, d: (byB.get(b.id) || 0) - (prevB.get(b.id) || 0) })).filter((x) => Math.abs(x.d) > 0).sort((a, b) => b.d - a.d);
      const up = moves[0], down = moves[moves.length - 1];
      if (up && up.d > 0 && !(period.kind === 'month' && isCurrent)) out.push({ icon: '⬆️', html: `${esc(up.b.name)} went up the most: <span class="up">+${f(up.d)}</span> vs the previous period.` });
      if (down && down.d < 0 && !(period.kind === 'month' && isCurrent)) out.push({ icon: '⬇️', html: `You cut back most on ${esc(down.b.name)}: <span class="down">−${f(-down.d)}</span>.` });
    }

    // budgets (only meaningful for single months)
    if (period.kind === 'month') {
      const over = ctx.buckets.filter((b) => b.monthlyBudget && (byB.get(b.id) || 0) > b.monthlyBudget);
      over.forEach((b) => out.push({ icon: '🚨', html: `${esc(b.name)} is over budget: ${f(byB.get(b.id))} of ${f(b.monthlyBudget)}.` }));
      const near = ctx.buckets.filter((b) => b.monthlyBudget && (byB.get(b.id) || 0) <= b.monthlyBudget && (byB.get(b.id) || 0) >= 0.85 * b.monthlyBudget);
      near.forEach((b) => out.push({ icon: '⚠️', html: `${esc(b.name)} is at ${Math.round(((byB.get(b.id) || 0) / b.monthlyBudget) * 100)}% of its ${f(b.monthlyBudget)} budget.` }));
    }

    // unusual single expense: far above that bucket's typical ticket
    const unusual = cur.map((e) => {
      const hist = ctx.expenses.filter((x) => x.bucketId === e.bucketId && x.id !== e.id && x.amount > 0).map((x) => x.amount).sort((a, b) => a - b);
      if (hist.length < 5) return null;
      const median = hist[Math.floor(hist.length / 2)];
      if (median < 5) return null; // tiny typical amounts make every ratio look huge
      return e.amount >= 3 * median && e.amount - median > 50 ? { e, ratio: e.amount / median } : null;
    }).filter(Boolean).sort((a, b) => b.ratio - a.ratio)[0];
    if (unusual) {
      const b = ctx.bucketById(unusual.e.bucketId);
      out.push({ icon: '👀', html: `Unusual: ${f(unusual.e.amount)} on ${esc(b?.name || '')}${unusual.e.note ? ` (${esc(unusual.e.note)})` : ''} on ${ctx.fmtDate(unusual.e.date)} — about ${unusual.ratio.toFixed(1)}× your typical ${esc(b?.name || '')} expense.` });
    }

    // recurring charges
    const rec = recurring(ctx.expenses, today);
    if (rec.length) {
      const monthly = rec.reduce((s, r) => s + r.amount, 0);
      out.push({ icon: '🔁', html: `Looks recurring: ${rec.slice(0, 5).map((r) => `${esc(r.note)} ${f(r.amount)}`).join(', ')}${rec.length > 5 ? '…' : ''} — about <b>${f(monthly)}/month</b> in total.` });
    }

    // weekend vs weekday
    const wkd = cur.filter((e) => [0, 6].includes(parseYmd(e.date).getDay()));
    const days = daysBetween(period.from, period.to < ymd(today) ? period.to : ymd(today));
    const monthLevel = cur.filter((e) => e.date.endsWith("-01")).length > cur.length * 0.5; // imported monthly sheets have no real days
    if (days >= 28 && cur.length >= 10 && !monthLevel) {
      const share = sum(wkd) / total;
      if (share > 0.4) out.push({ icon: '🗓️', html: `${Math.round(share * 100)}% of your spending happens on weekends.` });
    }
    return out;
  }

  /**
   * Recurring charges: same note with the same amount every time, in ≥4 of the last 6 full months.
   * Reported as a monthly cost (so a weekly $25 gift shows as ~$100/mo).
   */
  function recurring(expenses, today = new Date()) {
    const from = ymd(new Date(today.getFullYear(), today.getMonth() - 6, 1));
    const to = ymd(new Date(today.getFullYear(), today.getMonth(), 0));
    const groups = new Map();
    expenses.filter((e) => e.date >= from && e.date <= to && e.note.trim()).forEach((e) => {
      const k = e.note.trim().toLowerCase();
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(e);
    });
    const out = [];
    for (const [, list] of groups) {
      const perMonth = new Map();
      list.forEach((e) => perMonth.set(e.date.slice(0, 7), (perMonth.get(e.date.slice(0, 7)) || 0) + e.amount));
      if (perMonth.size < 4) continue;
      const amounts = list.map((e) => e.amount).sort((a, b) => a - b);
      const med = amounts[Math.floor(amounts.length / 2)];
      if (!amounts.every((a) => Math.abs(a - med) <= med * 0.05)) continue; // same price each time
      const monthly = [...perMonth.values()].sort((a, b) => a - b)[Math.floor(perMonth.size / 2)];
      out.push({ note: list[0].note, amount: monthly, bucketId: list[0].bucketId });
    }
    return out.sort((a, b) => b.amount - a.amount);
  }

  // ---------- entry suggestions ----------
  /** Guess a bucket from a note, learning from past notes first, then keyword aliases. */
  function suggestBucket(note, ctx) {
    const words = note.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
    if (!words.length) return null;
    const score = new Map();
    for (const e of ctx.expenses.slice(0, 3000)) {
      const n = e.note.toLowerCase();
      if (!n) continue;
      for (const w of words) if (n.includes(w)) score.set(e.bucketId, (score.get(e.bucketId) || 0) + 1);
    }
    const learned = [...score.entries()].sort((a, b) => b[1] - a[1])[0];
    if (learned) return ctx.bucketById(learned[0]);
    const found = findBuckets(note, ctx.buckets.filter((b) => !b.archived));
    return found[0] || null;
  }

  /** Same amount seen before (e.g. a subscription)? Offer note + bucket in one tap. */
  function suggestFromAmount(amount, ctx) {
    if (!amount) return [];
    const seen = new Map();
    for (const e of ctx.expenses) {
      if (Math.abs(e.amount - amount) > 0.001) continue;
      const k = e.bucketId + '|' + e.note.toLowerCase();
      const cur = seen.get(k) || { bucketId: e.bucketId, note: e.note, n: 0 };
      cur.n++; seen.set(k, cur);
    }
    return [...seen.values()].filter((s) => s.n >= 2 || s.note).sort((a, b) => b.n - a.n).slice(0, 3);
  }

  /** Safe arithmetic for the amount field: "12.50+3.25*2" → 19 */
  // Tiny recursive-descent parser (no eval, so the CSP can forbid it). Negative results = refunds.
  function evalAmount(str) {
    const toks = String(str).replace(/,/g, '.').replace(/[^\d.+\-*/()]/g, '').match(/\d*\.?\d+|\d+\.|[+\-*/()]/g);
    if (!toks) return null;
    let i = 0;
    const peek = () => toks[i];
    const expr = () => { let v = term(); while (peek() === '+' || peek() === '-') { const op = toks[i++]; const r = term(); v = op === '+' ? v + r : v - r; } return v; };
    const term = () => { let v = factor(); while (peek() === '*' || peek() === '/') { const op = toks[i++]; const r = factor(); v = op === '*' ? v * r : v / r; } return v; };
    const factor = () => {
      const t = toks[i++];
      if (t === '-') return -factor();
      if (t === '+') return factor();
      if (t === '(') { const v = expr(); if (toks[i++] !== ')') throw 0; return v; }
      if (t !== undefined && /^[\d.]+$/.test(t)) return Number(t);
      throw 0;
    };
    try {
      const v = expr();
      if (i !== toks.length || !Number.isFinite(v)) return null;
      return Math.round(v * 100) / 100;
    } catch { return null; }
  }

  window.Smart = { ymd, parseYmd, addDays, MONTHS, MON, P, preset, previous, inP, sum, monthsIn, elapsedMonths, parseQuery, answer, insights, recurring, suggestBucket, suggestFromAmount, evalAmount };
})();
