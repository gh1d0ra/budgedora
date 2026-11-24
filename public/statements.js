// Budgedora — bank / credit-card statement parsing (AMEX, Chase, Wells Fargo, generic CSV, Excel, OFX/QFX).
// Pure functions — no DOM. Exposed as window.Statements (and module.exports for tests).
(function (root) {
  'use strict';

  // ---------- small helpers ----------
  const pad = (n) => String(n).padStart(2, '0');
  const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

  function parseCsv(text) {
    text = text.replace(/^﻿/, '');
    const rows = []; let row = [], field = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (c === '"') q = false; else field += c; }
      else if (c === '"') q = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; }
      else field += c;
    }
    if (field || row.length) { row.push(field); rows.push(row); }
    return rows.filter((r) => r.some((x) => String(x).trim()));
  }

  /** "$1,594.98" → 1594.98 · "(12.00)" → -12 · "-1482.11" → -1482.11 · number → number · else null */
  function parseAmount(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    let s = String(v ?? '').trim();
    if (!s) return null;
    let neg = false;
    if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
    if (/-$/.test(s)) { neg = true; s = s.slice(0, -1); } // "12.00-"
    s = s.replace(/[$€£\s,]/g, '');
    if (s.startsWith('+')) s = s.slice(1);
    if (!/^-?\d*\.?\d+$/.test(s)) return null;
    const n = Number(s);
    return neg ? -n : n;
  }

  /** 9/2/2026 · 09/02/26 · 2026-09-02 · Date · Excel serial · 20260902120000 (OFX) → "YYYY-MM-DD" or null */
  function parseDate(v) {
    if (v instanceof Date && !isNaN(v)) return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
    if (typeof v === 'number' && v > 20000 && v < 80000) { // Excel serial date
      const d = new Date(Math.round((v - 25569) * 864e5));
      return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    }
    const s = String(v ?? '').trim();
    let m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})\b/);
    if (m) {
      const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
      return valid(y, Number(m[1]), Number(m[2]));
    }
    m = s.match(/^(\d{4})-?(\d{2})-?(\d{2})/);
    if (m) return valid(Number(m[1]), Number(m[2]), Number(m[3]));
    m = s.match(/^(\d{1,2})[ -]([A-Za-z]{3})[a-z]*[ -,]+(\d{4})$/); // 02 Sep 2026
    if (m) return valid(Number(m[3]), MON.indexOf(m[2].toLowerCase()) + 1, Number(m[1]));
    m = s.match(/^([A-Za-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4})$/); // Sep 2, 2026
    if (m) return valid(Number(m[3]), MON.indexOf(m[1].toLowerCase()) + 1, Number(m[2]));
    return null;
  }
  const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  function valid(y, mo, d) {
    if (!(y >= 1990 && y <= 2100 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return null;
    const dt = new Date(y, mo - 1, d);
    return dt.getMonth() === mo - 1 ? `${y}-${pad(mo)}-${pad(d)}` : null;
  }

  /** Tidy a statement description into a readable note. */
  function cleanDescription(s) {
    let t = String(s ?? '');
    t = t.replace(/^(PURCHASE|RECURRING PAYMENT|PURCHASE RETURN|MONEY TRANSFER) AUTHORIZED ON \d\d?\/\d\d?\s+/i, '') // Wells Fargo checking
      .replace(/^(\d+) Deposited OR Cashed Check$/i, 'Check #$1')
      .replace(/\s+(PPD|CCD|WEB|TEL) ID:\s*\S+/gi, '')
      .replace(/^(Recurring )?Card (Purchase|Return)( With Pin)?\s+(\d\d\/\d\d\s+)?/i, '') // Chase checking
      .replace(/^\d\d\/\d\d\s+(?=\D)/, '')
      .replace(/\s*Order Number\s+\S+/gi, '') // Chase card: Amazon order numbers on a second line
      .replace(/\s*Amzn\.com\/bill\b/gi, '')
      .replace(/^((?:amazon|amzn|kindle)[^*]*)\*\w+/i, '$1') // "AMAZON MKTPL*BC7QL8P53" → "AMAZON MKTPL"
      .replace(/^((?:amazon|amzn|kindle).*?)\s+WA\s*$/i, '$1')
      .replace(/\s+[SP]\d{8,}\s+CARD\s+\d{4}\s*$/i, '')
      .replace(/\s+CARD\s+\d{4}\s*$/i, '')
      .replace(/^(AplPay|APLPAY|GglPay|GOOGLE PAY)\s+/i, '')
      .replace(/\s+\d\d\/\d\d\s*$/, '') // Chase checking CSV: card date at the end ("… RALEIGH NC     10/29")
      .replace(/\s{2,}[A-Z]{2}\s*$/, '') // trailing state code after a gap ("RALEIGH        NC")
      .replace(/\b\d{3}-\d{3}-\d{4}\b/g, '') // phone numbers
      // ACH codes: YYMMDD dates, masked accounts, long reference numbers ("261011", "xxxxx5035", "790252001Epayi")
      .split(/\s+/).filter((w) => !/^\d{6,}$|^x{3,}\d+$|^(?=(?:\D*\d){6})[A-Za-z0-9]+$/i.test(w)).join(' ')
      .trim();
    return t.slice(0, 200);
  }

  /** Merchant key used to learn & share buckets: "TESLA INC SUPERCHARG..." → "tesla inc". */
  function merchantKey(note) {
    const n = String(note ?? '').trim();
    if (/^(amazon|amzn)/i.test(n)) return 'amazon'; // "AMAZON MKTPL", "Amazon.com", "Amazon: USB cable" are one merchant
    if (/^kindle/i.test(n)) return 'kindle';
    const words = n.toLowerCase()
      .replace(/^(sq|tst|sp|pp|paypal|py|dd|in|bt|pos|ach|debit card|checkcard)\s*\*\s*/i, '')
      .replace(/[*#].*$/, '')
      .split(/[^a-z&']+/).map((w) => w.replace(/'s?$/, '')).filter((w) => w.length >= 2 && w !== 'the');
    return words.slice(0, 2).join(' ');
  }

  // ---------- skip rules ----------
  // Card payments & transfers move money between your own accounts — importing them would double count.
  const PAYMENT_RE = /\b(payment\s*-?\s*thank\s*you|online payment|mobile payment|autopay|auto[- ]pay|automatic payment|epayment|e-payment|ach pmt|moneyline|fid bkg svc|card payment|credit card payment|payment to chase card|chase credit crd|amex epayment|american express ach|applecard gsbank|citi card online|discover e-payment|capital one.*pymt|online transfer|transfer|xfer|internal transfer|book transfer)\b/i;
  const INCOME_RE = /\b(payroll|direct dep|dir dep|salary|interest (paid|payment)|deposit|zelle from|venmo cashout|tax ref|irs treas|ssa treas|cash back reward|rewards? redemption)\b/i;

  // ---------- bucket hints ----------
  // hint → words a user's bucket name might contain (first match wins)
  const HINT_WORDS = {
    groceries: ['grocer', 'food', 'supermarket'],
    restaurants: ['restaurant', 'dining', 'eating', 'takeout', 'food'],
    car: ['car', 'gas', 'auto', 'fuel', 'transport'],
    utilities: ['utilit', 'bills', 'phone', 'internet'],
    entertainment: ['entertain', 'fun', 'subscri', 'stream'],
    health: ['health', 'medical', 'beauty', 'doctor', 'pharm'],
    clothes: ['cloth', 'apparel', 'shoe'],
    household: ['household', 'home', 'shopping', 'supplies'],
    insurance: ['insurance', 'hoa', 'tax'],
    education: ['educat', 'school', 'tuition'],
    giving: ['giving', 'donat', 'church', 'tithe', 'charit', 'gift'],
    vacation: ['vacation', 'travel', 'trip'],
  };
  // merchant / description keywords → hint
  const MERCHANTS = [
    ['groceries', /\b(aldi|lidl|costco|sam'?s club|kroger|publix|food lion|harris teeter|wegmans|whole foods|wholefds|trader joe|sprouts|safeway|albertsons|h-e-b|heb|meijer|giant|stop & shop|hannaford|winn[- ]dixie|piggly|weis|instacart|grocery|groceries|supermarket|market basket|fresh market|international market|walmart grocery|wm supercenter)\b/i],
    ['restaurants', /\b(restaurant|grill|bistro|cafe|caf[eé]|coffee|starbucks|dunkin|mcdonald|bojangle|chick-?fil|wendy|burger|taco bell|chipotle|subway|domino|pizza|papa john|panera|kfc|popeyes|sonic|arby|zaxby|cook ?out|waffle house|ihop|denny|olive garden|applebee|chili'?s|outback|texas roadhouse|five guys|jersey mike|firehouse|qdoba|panda express|steak|sushi|bbq|barbecue|diner|bakery|kitchen|tavern|pub|bar & grill|doordash|uber ?eats|grubhub|postmates|angus barn|tst\*|toast)\b/i],
    ['car', /\b(shell|exxon|exxonmobil|mobil|bp|chevron|sunoco|citgo|marathon|speedway|circle k|wawa|sheetz|quiktrip|qt|racetrac|valero|murphy usa|costco gas|sam'?s fuel|fuel|gas station|tesla.*superch|supercharg|ev charg|chargepoint|parking|park mobile|parkmobile|toll|nc quick pass|ezpass|e-zpass|sunpass|tesla|autozone|advance auto|o'?reilly|napa|jiffy lube|valvoline|firestone|discount tire|car wash|dmv|ncdmv|uber trip|lyft)\b/i],
    ['utilities', /\b(duke energy|dominion|piedmont natural|enbridge|psnc|wake electric|att payment|natural gas|electric|power co|water|sewer|city of|town of|spectrum|xfinity|comcast|at&t|att\*|verizon|t-mobile|tmobile|mint mobile|google fi|cox comm|frontier|google fiber|waste|trash|republic services)\b/i],
    ['entertainment', /\b(netflix|spotify|apple\.com|hulu|disney|disneyplus|hbo|max\.com|paramount|peacock|youtube|apple\.com\/bill|itunes|audible|kindle|amc|regal|cinema|theat(er|re)|ticketmaster|steam|playstation|xbox|nintendo|sling|fubo)\b/i],
    ['health', /\b(radiology|diagn|planet fitness|fitness|gym|ymca|massage|pharmacy|cvs|walgreens|rite aid|dental|dentist|orthodon|medical|clinic|hospital|health|physician|pediatric|urgent care|wakemed|wake med|unc health|duke health|labcorp|quest diag|optometr|vision|eye care|dermatol|chiropr|therapy|salon|barber|spa|ulta|sephora|great clips|sport clips|nail)\b/i],
    ['clothes', /\b(t ?j ?maxx|tjmaxx|marshalls|ross|old navy|gap|banana republic|kohl|nike|adidas|h&m|zara|uniqlo|burlington|nordstrom|macy|dillard|belk|children'?s place|childrens? place|carter|shoe|famous footwear|dsw|foot locker|american eagle|aeropostale|forever 21|j\.?crew)\b/i],
    ['household', /\b(home depot|lowe'?s|target|amazon|amzn|walmart|wal-mart|ikea|bed bath|wayfair|dollar tree|dollar general|family dollar|big lots|homegoods|tuesday morning|hobby lobby|michaels|joann|ace hardware|menards|costco whse|best buy|staples|office depot)\b/i],
    ['insurance', /\b(state farm|allstate|geico|progressive|nationwide|farmers ins|liberty mutual|usaa|travelers|erie ins|insurance|hoa|homeowners assoc|property tax|county tax|tax collector)\b/i],
    ['education', /\b(school|academy|university|college|tuition|education|tutor|kumon|coursera|udemy|scholastic|learning)\b/i],
    ['giving', /(church|baptist|methodist|presbyterian|lutheran|ministr|chapel|tithe)/i],
    ['giving', /\b(church|ministr|donation|donate|tithe|charity|foundation|red cross|salvation army|gofundme|unicef|world vision|compassion)\b/i],
    ['vacation', /\b(airline|airlines|delta air|american air|united air|southwest|jetblue|spirit air|frontier air|alaska air|hotel|marriott|hilton|hyatt|holiday inn|hampton inn|airbnb|vrbo|expedia|booking\.com|priceline|hotels\.com|kayak|resort|cruise|amtrak)\b/i],
  ];
  // bank-provided categories (Chase "Food & Drink", AMEX "Restaurant-Restaurant", …) → hint
  const CATEGORIES = [
    ['groceries', /grocer|supermarket/i],
    ['restaurants', /restaurant|food & drink|dining|fast food|bar & caf/i],
    ['car', /fuel|gas\b|gasoline|automotive|auto |parking|toll|transportation/i],
    ['utilities', /utilit|cable|internet|telephone|communications|bills/i],
    ['entertainment', /entertainment|streaming|movie|theat/i],
    ['health', /health|pharmac|medical|doctor|dental|wellness|personal care/i],
    ['clothes', /clothing|apparel|shoe/i],
    ['insurance', /insurance/i],
    ['education', /education|school/i],
    ['giving', /gift|donation|charit/i],
    ['vacation', /travel|airline|lodging|hotel|vacation/i],
    ['household', /home|hardware|household|department|merchandise|shopping/i],
  ];

  function hintFor(desc, category) {
    for (const [h, re] of MERCHANTS) if (re.test(desc)) return h;
    if (category) for (const [h, re] of CATEGORIES) if (re.test(category)) return h;
    return null;
  }

  /** Map a hint to one of the user's buckets (by name words), or null. */
  function bucketForHint(hint, buckets) {
    if (!hint) return null;
    const words = HINT_WORDS[hint] || [];
    for (const w of words) {
      const b = buckets.find((x) => !x.archived && x.name.toLowerCase().split(/[^a-z]+/).some((p) => p.startsWith(w)));
      if (b) return b;
    }
    return null;
  }

  // ---------- format detection ----------
  const findCol = (head, ...names) => {
    for (const n of names) { const i = head.indexOf(n); if (i >= 0) return i; }
    for (const n of names) { const i = head.findIndex((h) => h.includes(n)); if (i >= 0) return i; }
    return -1;
  };

  /**
   * Turn a table (array of rows of cells) into raw transactions.
   * Returns { source, kind: 'card'|'bank'|'unknown', txns: [{date, desc, amount (as in file), spend (+ = money out), category, type, member}] }
   */
  function parseTable(rows, fileName = '') {
    rows = rows.map((r) => r.map((c) => (typeof c === 'string' ? c.trim() : c)));
    // Wells Fargo: no header, 5 columns "date","-12.34","*","","DESCRIPTION"
    const wf = rows.filter((r) => r.length >= 5 && parseDate(r[0]) && parseAmount(r[1]) != null && /^\*?$/.test(String(r[2] ?? '')));
    if (wf.length && wf.length >= rows.length * 0.8) {
      const txns = wf.map((r) => tx(r[0], r[4], r[1], -1));
      const bankish = txns.some((t) => /PURCHASE AUTHORIZED ON|RECURRING PAYMENT AUTHORIZED|DIRECT DEP|ATM WITHDRAWAL|ONLINE TRANSFER|CHECK #|^CHECK\b|MOBILE DEPOSIT/i.test(t.raw));
      return { source: 'Wells Fargo', kind: bankish ? 'bank' : 'card', txns };
    }

    const first = (rows[0] || []).map(norm);
    if (first.includes('bucket') && first.includes('date') && first.includes('amount')) throw new Error('This looks like a Budgedora CSV — use “Import CSV” for it.');

    // find the header row (some exports, e.g. AMEX Excel, start with a few summary lines)
    let hr = -1;
    for (let i = 0; i < Math.min(rows.length, 30); i++) {
      const h = rows[i].map(norm);
      if (h.some((x) => x.includes('date')) && h.some((x) => /amount|debit|credit|withdrawal|deposit/.test(x)) && h.some((x) => /description|payee|merchant|name|memo|details|transaction/.test(x))) { hr = i; break; }
    }
    if (hr < 0) throw new Error(`Couldn't find the columns in ${fileName || 'this file'} (expected Date, Description and Amount).`);
    const head = rows[hr].map(norm);
    const body = rows.slice(hr + 1);
    if (head.includes('bucket')) throw new Error('This looks like a Budgedora CSV — use “Import CSV” for it.');

    const col = {
      date: findCol(head, 'transaction date', 'trans. date', 'trans date', 'date', 'posting date', 'post date', 'posted date'),
      desc: findCol(head, 'description', 'payee', 'merchant', 'name', 'transaction description', 'details'),
      amount: findCol(head, 'amount', 'transaction amount'),
      debit: findCol(head, 'debit', 'withdrawal', 'withdrawals', 'money out'),
      credit: findCol(head, 'credit', 'deposit', 'deposits', 'money in'),
      category: findCol(head, 'category'),
      type: findCol(head, 'type', 'transaction type'),
      member: findCol(head, 'card member', 'cardholder', 'card holder'),
    };
    if (col.desc === col.date) col.desc = findCol(head, 'description', 'payee', 'merchant');
    if (col.date < 0 || col.desc < 0 || (col.amount < 0 && col.debit < 0)) throw new Error(`Couldn't find Date, Description and Amount columns in ${fileName || 'this file'}.`);

    let source = 'Statement', kind = 'unknown', sign = 0;
    if (head.includes('transaction date') && head.includes('post date')) { source = 'Chase'; kind = 'card'; sign = -1; }
    else if (head.includes('details') && head.includes('posting date')) { source = 'Chase'; kind = 'bank'; sign = -1; col.date = head.indexOf('posting date'); col.desc = head.indexOf('description'); }
    else if (head.some((h) => /card member|appears on your statement|extended details/.test(h))) { source = 'American Express'; kind = 'card'; sign = 1; }
    else if (/amex|american express/i.test(fileName)) { source = 'American Express'; kind = 'card'; sign = 1; }
    else if (/chase/i.test(fileName)) { source = 'Chase'; sign = -1; }
    else if (/wells|wf/i.test(fileName)) { source = 'Wells Fargo'; sign = -1; }
    else if (head.includes('balance')) kind = 'bank';

    const txns = [];
    for (const r of body) {
      if (!parseDate(r[col.date])) continue;
      let amt;
      if (col.amount >= 0) amt = parseAmount(r[col.amount]);
      else {
        const d = parseAmount(r[col.debit]), c = col.credit >= 0 ? parseAmount(r[col.credit]) : null;
        amt = d ? -Math.abs(d) : c ? Math.abs(c) : null; // normalise to "negative = money out"
        sign = -1;
      }
      if (amt == null || Math.abs(amt) < 0.005) continue;
      const t = tx(r[col.date], r[col.desc], amt, sign);
      if (col.category >= 0) t.category = String(r[col.category] ?? '');
      if (col.type >= 0) t.type = String(r[col.type] ?? '');
      if (col.member >= 0) t.member = String(r[col.member] ?? '').replace(/\s+/g, ' ').trim();
      txns.push(t);
    }
    if (!sign) {
      // Unknown bank: most rows are purchases, so the majority sign is "money out".
      const pos = txns.filter((t) => t.amount > 0).length;
      sign = pos >= txns.length / 2 ? 1 : -1;
    }
    txns.forEach((t) => { t.spend = round2(t.amount * sign); });
    return { source, kind, txns };
  }

  const round2 = (n) => Math.round(n * 100) / 100;
  function tx(date, desc, amount, sign) {
    const a = typeof amount === 'number' ? amount : parseAmount(amount);
    return { date: parseDate(date), raw: String(desc ?? '').trim(), desc: cleanDescription(desc), amount: a, spend: round2(a * (sign || 1)), category: '', type: '', member: '' };
  }

  /** OFX / QFX (Quicken / Money download) — every bank offers it; amounts are negative for money out. */
  function parseOfx(text) {
    const tag = (blk, t) => { const m = blk.match(new RegExp(`<${t}>([^<\\r\\n]*)`, 'i')); return m ? m[1].trim() : ''; };
    const org = tag(text, 'ORG');
    const kind = /<CREDITCARDMSGSRSV1>|<CCSTMTRS>/i.test(text) ? 'card' : 'bank';
    const txns = text.split(/<STMTTRN>/i).slice(1).map((blk) => {
      const name = tag(blk, 'NAME'), memo = tag(blk, 'MEMO');
      const t = tx(tag(blk, 'DTPOSTED').slice(0, 8), name || memo, parseAmount(tag(blk, 'TRNAMT')), -1);
      t.type = tag(blk, 'TRNTYPE');
      return t;
    }).filter((t) => t.date && t.amount);
    let source = org || 'OFX';
    if (/amex|american express/i.test(org)) source = 'American Express';
    else if (/chase/i.test(org)) source = 'Chase';
    else if (/wells/i.test(org)) source = 'Wells Fargo';
    return { source, kind, txns };
  }

  // ---------- PDF statements ----------
  // Input: pages of positioned text items [{x, y, w, str}] (from pdf.js). Works on any statement whose
  // transaction lines look like "MM/DD[/YY] description … amount [balance]" — Chase checking & card, AMEX, Wells Fargo.
  const AMT_RE = /^\(?-?\$?-?\d{1,3}(,\d{3})*\.\d\d\)?-?$|^\(?-?\$?-?\d+\.\d\d\)?-?$/;
  const LINE_DATE_RE = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?\*?(?:\s+|$)/;
  const MONTHS_RE = '(January|February|March|April|May|June|July|August|September|October|November|December)';

  function pdfLines(pages) {
    const out = [];
    for (const items of pages) {
      const rows = [];
      for (const it of items) {
        if (!String(it.str).trim()) continue;
        let row = rows.find((r) => Math.abs(r.y - it.y) <= 2.5);
        if (!row) { row = { y: it.y, items: [] }; rows.push(row); }
        row.items.push({ x: it.x, w: it.w || 0, str: String(it.str).trim() });
      }
      rows.sort((a, b) => b.y - a.y).forEach((r) => {
        r.items.sort((a, b) => a.x - b.x);
        // glue a lone "$" / "-$" to the number after it
        for (let i = r.items.length - 2; i >= 0; i--) if (/^-?\$$/.test(r.items[i].str)) { r.items[i + 1].str = r.items[i].str + r.items[i + 1].str; r.items[i + 1].x = r.items[i].x; r.items.splice(i, 1); }
        r.text = r.items.map((i) => i.str).join(' ');
        out.push(r);
      });
    }
    return out;
  }

  /** Statement period → { start: Date, end: Date } so "10/26" gets the right year (also across Dec → Jan). */
  function statementPeriod(text) {
    const mi = (s) => MON.indexOf(s.slice(0, 3).toLowerCase());
    let m = text.match(new RegExp(`${MONTHS_RE} (\\d{1,2}),? (\\d{4})\\s*(?:through|to|-|–)\\s*${MONTHS_RE} (\\d{1,2}),? (\\d{4})`, 'i'));
    if (m) return { start: new Date(+m[3], mi(m[1]), +m[2]), end: new Date(+m[6], mi(m[4]), +m[5]) };
    // Wells Fargo: "November 6, 2026" + "Beginning balance on 10/8" … "Ending balance on 11/6"
    const b = text.match(/Beginning balance on (\d{1,2})\/(\d{1,2})\b(?!\/)/i), e = text.match(/Ending balance on (\d{1,2})\/(\d{1,2})\b(?!\/)/i);
    const sd = text.match(new RegExp(`${MONTHS_RE} (\\d{1,2}),? (\\d{4})`, 'i'));
    if (b && e && sd) {
      const y = +sd[3], em = +e[1] - 1, bm = +b[1] - 1;
      return { start: new Date(bm > em ? y - 1 : y, bm, +b[2]), end: new Date(y, em, +e[2]) };
    }
    m = text.match(/(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})\s*(?:-|–|to|through)\s*(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})/i);
    const yy = (s) => (s.length === 2 ? 2000 + Number(s) : Number(s));
    if (m) return { start: new Date(yy(m[3]), +m[1] - 1, +m[2]), end: new Date(yy(m[6]), +m[4] - 1, +m[5]) };
    m = text.match(/(?:closing date|statement date|ending balance on)\s*:?\s*(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})/i);
    if (m) { const end = new Date(yy(m[3]), +m[1] - 1, +m[2]); return { start: new Date(end.getFullYear(), end.getMonth() - 1, end.getDate()), end }; }
    m = text.match(new RegExp(`${MONTHS_RE} \\d{1,2},? (\\d{4})`, 'i')) || text.match(/\b(20\d\d)\b/);
    if (m) { const y = Number(m[m.length - 1]); return { start: new Date(y, 0, 1), end: new Date(y, 11, 31) }; }
    return null;
  }

  function parsePdf(pages, fileName = '') {
    const lines = pdfLines(pages);
    const all = lines.map((l) => l.text).join('\n');
    const period = statementPeriod(all);
    let source = 'Statement';
    if (/JPMorgan Chase|chase\.com|Chase (Total|Secure|Premier|Sapphire|Freedom|Checking)/i.test(all)) source = 'Chase';
    else if (/American Express|americanexpress\.com/i.test(all)) source = 'American Express';
    else if (/Wells Fargo|wellsfargo\.com/i.test(all)) source = 'Wells Fargo';
    const kind = /CHECKING SUMMARY|checking account|savings account|Ending daily balance|Deposits and Additions|Deposits\/Additions/i.test(all) ? 'bank' : 'card';

    const START = /TRANSACTION DETAIL|ACCOUNT ACTIVITY|TRANSACTION HISTORY|^(New Charges|Payments and Credits|Detail)\b/i;
    const END = /\*end\*\s*transaction|^Ending (daily )?Balance\b|Totals Year-to-Date|INTEREST CHARGES|^Ending balance on|^Fees\b.*\bTotal|^Total (New Charges|Payments)|^Totals\b/i;
    const hasSections = lines.some((l) => START.test(l.text));
    let inTx = !hasSections, prev = null, cols = null;

    const txns = [];
    for (const l of lines) {
      if (START.test(l.text)) { inTx = true; prev = null; }
      if (END.test(l.text)) { inTx = false; prev = null; continue; }
      // column header with separate deposit / withdrawal columns (Wells Fargo checking)
      if (/deposits|additions|credits/i.test(l.text) && /withdrawals|subtractions|debits/i.test(l.text)) {
        const right = (re) => { const it = l.items.find((i) => re.test(i.str)); return it ? it.x + it.w : null; };
        cols = { dep: right(/deposits|additions|credits/i), wd: right(/withdrawals|subtractions|debits/i), bal: right(/balance/i) };
        continue;
      }
      if (!inTx) continue;
      const dm = l.items[0].str.match(LINE_DATE_RE);
      const amts = [];
      for (let i = l.items.length - 1; i > 0 && AMT_RE.test(l.items[i].str); i--) amts.unshift(l.items[i]);
      if (dm && amts.length) {
        const mo = Number(dm[1]), d = Number(dm[2]);
        let y;
        if (dm[3]) y = dm[3].length === 2 ? 2000 + Number(dm[3]) : Number(dm[3]);
        else if (period) y = period.start.getFullYear() !== period.end.getFullYear() && mo - 1 > period.end.getMonth() ? period.start.getFullYear() : period.end.getFullYear();
        else y = new Date().getFullYear();
        const descItems = l.items.slice(0, l.items.length - amts.length);
        const first = descItems[0].str.slice(dm[0].length);
        const desc = [first, ...descItems.slice(1).map((i) => i.str)].filter(Boolean).join(' ');
        if (!desc || /^(beginning|ending|previous|new) balance/i.test(desc)) { prev = null; continue; }
        let amount, sign;
        if (cols && (cols.dep || cols.wd)) {
          // pick the amount by column: closest right edge
          const near = (it) => { const r = it.x + it.w; const c = [['dep', cols.dep], ['wd', cols.wd], ['bal', cols.bal]].filter((x) => x[1] != null).sort((a, b) => Math.abs(a[1] - r) - Math.abs(b[1] - r)); return c[0][0]; };
          const hit = amts.map((a) => [near(a), parseAmount(a.str)]).find(([c]) => c !== 'bal');
          if (!hit) { prev = null; continue; }
          amount = hit[0] === 'wd' ? -Math.abs(hit[1]) : Math.abs(hit[1]);
          sign = -1;
        } else {
          amount = parseAmount(amts[0].str); // with 2+ numbers the last one is the running balance
          sign = kind === 'bank' ? -1 : 1;
        }
        if (amount == null || Math.abs(amount) < 0.005) { prev = null; continue; }
        const t = tx(`${y}-${pad(mo)}-${pad(d)}`, desc, amount, sign);
        t.descX = descItems.length > 1 && !first ? descItems[1].x : l.items[0].x + 20;
        t.extra = 0;
        txns.push(t); prev = t;
      } else if (prev && !dm && !amts.length && prev.extra < 1 && l.items[0].x >= prev.descX - 4 && l.text.length <= 60 && !START.test(l.text)) {
        // wrapped description ("…Whiteville NC Card" + "5306")
        prev.raw += ' ' + l.text; prev.desc = cleanDescription(prev.raw); prev.extra++;
      } else prev = null;
    }
    // account holders' names (from the address block) trail many bank descriptions: "… Apple.Com Bill Igor Ghidora"
    const holders = new Set();
    const IGNORE = /\b(CHECKING|SAVINGS|SUMMARY|CUSTOMER|SERVICE|INFORMATION|ACCOUNT|BALANCE|STATEMENT|WELLS|FARGO|CHASE|BANK|AMERICAN|EXPRESS|TRANSACTIONS?|DETAIL|PAYMENTS?|IMPORTANT|NEW|TOTALS?|ACTIVITY|CARD|AND|OTHER|OF|THE|FOR|PURCHASES?|CREDITS?|FEES?|INTEREST|CHARGES?|YEAR|DATE|AMOUNT|DESCRIPTION|NOTICE|MESSAGE|REWARDS|POINTS|WAY|ST|RD|DR|AVE|LN|CT|BLVD|BOX)\b/;
    for (const l of lines.slice(0, 80)) if (/^[A-Z]{2,}( [A-Z]{1,})*$/.test(l.text) && l.text.split(' ').length >= 2 && l.text.split(' ').length <= 4 && !IGNORE.test(l.text)) l.text.split(' ').forEach((w) => w.length > 1 && holders.add(w.toLowerCase()));
    if (holders.size) for (const t of txns) {
      const w = t.desc.split(' ');
      let n = w.length;
      while (n > 1 && (holders.has(w[n - 1].toLowerCase()) || (/^[A-Z]$/i.test(w[n - 1]) && n > 2 && holders.has(w[n - 2].toLowerCase())))) n--;
      if (n < w.length && w.slice(n).some((x) => holders.has(x.toLowerCase()))) t.desc = w.slice(0, n).join(' ');
    }
    txns.forEach((t) => { delete t.descX; delete t.extra; });
    if (!txns.length) throw new Error(`No transactions found in ${fileName || 'this PDF'}. If it's a scanned image, download the CSV instead.`);
    return { source, kind, txns, check: totalsCheck(lines, txns, kind) };
  }

  /** Compare what we read with the statement's own summary, so a missed line can't go unnoticed. */
  function totalsCheck(lines, txns, kind) {
    const find = (re) => { for (const l of lines) { if (!re.test(l.text)) continue; const a = [...l.items].reverse().find((i) => AMT_RE.test(i.str)); if (a) return parseAmount(a.str); } return null; };
    const got = round2(txns.reduce((s, t) => s + t.amount, 0));
    let expected = null;
    if (kind === 'bank') {
      const b = find(/^Beginning Balance\b/i), e = find(/^Ending Balance\b/i);
      if (b != null && e != null) expected = round2(e - b);
    } else {
      const b = find(/^Previous Balance\b/i), e = find(/^New Balance\b/i);
      if (b != null && e != null) {
        expected = round2(e - b);
        const extra = (find(/^Fees Charged\b/i) || 0) + (find(/^Interest Charged\b/i) || 0);
        if (Math.abs(got - expected) >= 0.005 && Math.abs(got + extra - expected) < 0.005) expected = round2(expected - extra); // fees not listed as lines
      }
    }
    return expected == null ? null : { expected, got, ok: Math.abs(got - expected) < 0.005 };
  }

  /**
   * Decide what to do with each transaction: skip reason, duplicate check, bucket guess.
   * ctx: { buckets, expenses } (expenses: {date, amount, note, bucketId}, amount in dollars)
   */
  function plan(parsed, ctx) {
    const buckets = ctx.buckets.filter((b) => !b.archived);
    // learn merchant → bucket from history
    const learnedCounts = new Map();
    for (const e of ctx.expenses) {
      const k = merchantKey(e.note);
      if (!k) continue;
      const m = learnedCounts.get(k) || new Map();
      m.set(e.bucketId, (m.get(e.bucketId) || 0) + 1);
      learnedCounts.set(k, m);
    }
    const learned = (k) => {
      const m = learnedCounts.get(k); if (!m) return null;
      const id = [...m.entries()].sort((a, b) => b[1] - a[1])[0][0];
      return buckets.find((b) => b.id === id) || null;
    };
    // existing expenses for duplicate detection (multiset: two identical coffees on one day are both real)
    const have = new Map();
    // same day + amount + merchant (so "AMAZON MKTPL" still matches an expense renamed to "Amazon: USB cable")
    const dupKey = (date, amount, note) => `${date}|${Math.round(amount * 100)}|${merchantKey(note) || String(note).toLowerCase()}`;
    for (const e of ctx.expenses) { const k = dupKey(e.date, e.amount, e.note); have.set(k, (have.get(k) || 0) + 1); }

    const rows = [];
    for (const file of parsed) {
      for (const t of file.txns) {
        const kind = file.kind;
        let skip = null;
        const text = `${t.raw} ${t.type}`;
        if (/^payment$/i.test(t.type) || PAYMENT_RE.test(text)) skip = t.spend < 0 ? 'Card payment' : 'Payment / transfer';
        else if (/^(acct_xfer|loan_pmt)$/i.test(t.type)) skip = 'Transfer';
        else if (t.spend > 0 && /^(atm |cash )?withdrawal\b|\batm withdrawal\b/i.test(t.desc)) skip = 'Cash withdrawal';
        else if (t.spend < 0 && (INCOME_RE.test(text) || kind === 'bank')) skip = 'Money in';
        const k = dupKey(t.date, t.spend, t.desc);
        let dup = false;
        if (have.get(k) > 0) { dup = true; have.set(k, have.get(k) - 1); }
        const key = merchantKey(t.desc);
        const b = learned(key) || bucketForHint(hintFor(t.raw, t.category), buckets);
        rows.push({
          ...t, source: file.source, key,
          skip, dup, on: !skip && !dup,
          bucketId: b ? b.id : null, manual: false,
        });
      }
    }
    rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    return rows;
  }

  // ---------- Amazon order history (amazon.com → Request Your Information → Your Orders) ----------
  const AMAZON_RE = /amazon|amzn|kindle|audible/i;

  /** Amazon's export: one row per item. Returns {amazon: true, orders: Map(orderId → {id, date, items:[{name, amount, ship}]})} or null. */
  function parseAmazon(rows) {
    for (let hr = 0; hr < Math.min(rows.length, 5); hr++) {
      const h = rows[hr].map(norm);
      const col = (re) => h.findIndex((x) => re.test(x));
      const id = col(/^(order ?id|orderid)$/), name = col(/^(product ?name|productname|title)$/);
      if (id < 0 || name < 0) continue;
      const date = col(/^(order ?date|orderdate)$/), ship = col(/^(ship date|shipdate|fulfilled ?date)$/);
      const total = col(/^(total owed|item total|total charged)$/), unit = col(/^(unit price|our ?price|purchase price per unit)$/);
      const tax = col(/^(unit price tax|our ?price ?tax)$/), qty = col(/^(quantity|original ?quantity)$/);
      const status = col(/^order status$/);
      const orders = new Map();
      for (const r of rows.slice(hr + 1)) {
        const oid = String(r[id] ?? '').trim();
        if (!oid || (status >= 0 && /cancel/i.test(r[status]))) continue;
        const q = qty >= 0 ? Number(r[qty]) || 1 : 1;
        let amt = total >= 0 ? parseAmount(r[total]) : null;
        if (amt == null && unit >= 0) { const u = parseAmount(r[unit]); if (u != null) amt = (u + (tax >= 0 ? parseAmount(r[tax]) || 0 : 0)) * q; }
        const o = orders.get(oid) || { id: oid, date: parseDate(String(r[date] ?? '')), items: [] };
        o.items.push({ name: String(r[name] ?? '').replace(/\s+/g, ' ').trim() || 'item', amount: amt == null ? null : round2(amt), ship: ship >= 0 ? parseDate(String(r[ship] ?? '')) : null });
        orders.set(oid, o);
      }
      return { amazon: true, source: 'Amazon orders', orders };
    }
    return null;
  }

  const shortName = (n) => {
    n = n.replace(/\s*[,|(\[].*$/, '').trim() || n; // Amazon titles: "Brand Thing, 12 Pack, Blue (Pack of 2)" → "Brand Thing"
    if (n.length <= 42) return n;
    const c = n.slice(0, 42), sp = c.lastIndexOf(' ');
    return (sp > 24 ? c.slice(0, sp) : c) + '…';
  };
  const dayDiff = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 864e5);
  const sumOf = (items) => round2(items.reduce((s, i) => s + (i.amount || 0), 0));
  /** Items of one order whose prices add up to a charge (Amazon charges each shipment separately). */
  function subsetFor(items, amount) {
    const its = items.filter((i) => i.amount != null);
    if (Math.abs(sumOf(its) - amount) < 0.015) return its;
    if (its.length > 14) return null;
    let best = null;
    for (let m = 1; m < 1 << its.length; m++) {
      let s = 0, n = 0;
      for (let i = 0; i < its.length; i++) if (m & (1 << i)) { s += its[i].amount; n++; }
      if (Math.abs(s - amount) < 0.015 && (!best || n < best.n)) best = { m, n };
    }
    return best ? its.filter((_, i) => best.m & (1 << i)) : null;
  }

  const PRODUCT_HINTS = [
    ['clothes', /\b(shirt|t-shirt|tee|socks?|dress|pants|jeans|leggings|shorts|jacket|coat|sweater|hoodie|shoes?|sneakers?|boots?|sandals?|slippers?|underwear|bras?|pajamas?|hat|beanie|gloves?|scarf|swimsuit)\b/i],
    ['health', /\b(vitamins?|supplements?|shampoo|conditioner|toothpaste|toothbrush|floss|lotion|sunscreen|deodorant|razors?|bandages?|ibuprofen|tylenol|advil|allergy|probiotics?|skin ?care|serum|makeup|mascara|moisturizer|first aid|thermometer|hair)\b/i],
    ['groceries', /\b(coffee|tea|snacks?|cereal|chocolate|candy|protein|almonds|nuts|olive oil|spices?|pasta|rice|sauce|k-cups?|creamer|honey|cookies|crackers|granola)\b/i],
    ['education', /\b(textbook|workbook|notebooks?|pencils?|crayons?|markers|backpack|school|flash ?cards|calculator)\b/i],
    ['entertainment', /\b(kindle edition|ebook|movie|blu-ray|dvd|video game|board game|puzzle|lego|toy|playing cards)\b/i],
    ['car', /\b(car|automotive|tires?|wiper|motor oil|dash ?cam)\b/i],
  ];

  /**
   * Put product names on Amazon charges. Matches by the order number Chase prints under each charge,
   * else by amount + date (whole order or one shipment). Mutates rows: desc, amazon ('order' | 'amount'), and the bucket guess.
   */
  function enrichAmazon(rows, orders, buckets) {
    const used = new Set();
    let candidates = 0, matched = 0;
    const byAmount = (r) => {
      const amt = Math.abs(r.spend), lo = r.spend < 0 ? -5 : -3, hi = r.spend < 0 ? 120 : 30;
      let best = null;
      for (const o of orders.values()) {
        if (used.has(o.id) || !o.date) continue;
        const d = dayDiff(r.date, o.date);
        if (d < lo || d > hi) continue;
        const groups = [o.items];
        const ships = [...new Set(o.items.map((i) => i.ship).filter(Boolean))];
        if (ships.length > 1) ships.forEach((s) => groups.push(o.items.filter((i) => i.ship === s)));
        for (const g of groups) {
          if (Math.abs(sumOf(g) - amt) >= 0.015) continue;
          const score = Math.abs(d - 1) + (g === o.items ? 0 : 0.5);
          if (!best || score < best.score) best = { o, items: g, score, whole: g === o.items };
        }
      }
      if (best && best.whole) used.add(best.o.id);
      return best;
    };
    for (const r of rows) {
      if (!AMAZON_RE.test(`${r.raw || ''} ${r.desc || ''}`) || /^(amazon|kindle)( return)?:/i.test(r.desc)) continue;
      candidates++;
      const on = (String(r.raw || '').match(/Order Number\s+([A-Z0-9]{3}-\d{7}-\d{7})/i) || [])[1];
      let items = null, how = null, oid = on;
      if (on && orders.has(on)) { items = subsetFor(orders.get(on).items, Math.abs(r.spend)) || orders.get(on).items; how = 'order'; }
      else { const b = byAmount(r); if (b) { items = b.items; how = 'amount'; oid = b.o.id; } }
      if (!items || !items.length) continue;
      matched++;
      const digital = /^D\d\d-/.test(oid || '') || /kindle/i.test(r.raw || r.desc);
      const prefix = (digital ? 'Kindle' : 'Amazon') + (r.spend < 0 ? ' return' : '');
      const names = items.map((i) => shortName(i.name));
      r.desc = `${prefix}: ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` +${names.length - 3} more` : ''}`.slice(0, 200);
      r.items = items.map((i) => i.name);
      r.amazon = how;
      if (buckets && !r.manual) {
        // the bucket follows the biggest item ("air fryer + vitamins" is a Household purchase)
        const main = [...items].sort((a, b) => (b.amount || 0) - (a.amount || 0))[0].name;
        const hint = digital && !/kindle edition/i.test(main) ? 'entertainment' : (PRODUCT_HINTS.find(([, re]) => re.test(main)) || [])[0];
        const b = bucketForHint(hint, buckets.filter((x) => !x.archived));
        if (b) r.bucketId = b.id;
      }
    }
    return { candidates, matched };
  }

  /** Read one file (text for CSV/OFX, or an XLSX workbook already parsed by SheetJS) into {source, kind, txns}. */
  function parseFile({ name, text, workbook, XLSX, pdfPages }) {
    if (pdfPages) return parsePdf(pdfPages, name);
    if (workbook) {
      let lastErr;
      for (const sn of workbook.SheetNames) {
        const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sn], { header: 1, raw: true, defval: '' });
        try { const p = parseTable(rows, name); if (p.txns.length) return p; } catch (e) { lastErr = e; }
      }
      throw lastErr || new Error(`No transactions found in ${name}.`);
    }
    if (/<OFX>|OFXHEADER/i.test(text.slice(0, 2000))) return parseOfx(text);
    const table = parseCsv(text);
    return parseAmazon(table) || parseTable(table, name);
  }

  const api = { parseCsv, parseAmount, parseDate, cleanDescription, merchantKey, parseTable, parseOfx, parsePdf, parseFile, parseAmazon, enrichAmazon, AMAZON_RE, plan, hintFor, bucketForHint };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Statements = api;
})(typeof window !== 'undefined' ? window : globalThis);
