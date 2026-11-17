// LEMO price-watch bot — check.js (v2)
// Fetches public prices for LEMO brands (Sidi Ali, Aïn Atlas, Oulmès, Bahia,
// Vitalya, Glass, Orangina) at Carrefour (via Bringo) and Marjane (via Glovo)
// and compares them with the last known state in prices.json.
// On change -> sends a Telegram message. First run only records the baseline.
// No dependencies: Node 18+ (global fetch).
// Env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID.
// Flags: --dry-run (no send, no state write) · --full-report (send the full
// price list once, no state change — on-demand test / digest)

const fs = require('fs');
const path = require('path');

const CONFIG = require('./config.json');
const STATE_PATH = path.join(__dirname, 'prices.json');
const DRY_RUN = process.argv.includes('--dry-run');

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveState(state) {
  if (DRY_RUN) return;
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      'Accept-Language': 'fr-MA,fr;q=0.9',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
  return await res.text();
}

function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function norm(s) {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip accents: Oulmès -> oulmes
    .replace(/\./g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Parse ALL products from a Bringo-style category page.
// Page text pattern per product: [optional -NN%] NAME "Quantité" PRICE MAD
// Names start with Eau / Pack / Boisson / Jus / Soda.
function parseProducts(text) {
  const re =
    /(?:-\d+%\s*)?\b(Eau|Pack|Boisson|Jus|Soda)\b[^Q]{2,90}?\s+Quantité\s+(\d+),(\d{2})\s*MAD/g;
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const raw = m[0].slice(0, m[0].indexOf('Quantité')).trim();
    const name = raw.replace(/^-\d+%\s*/, '').replace(/\s+/g, ' ').trim();
    const price = parseFloat(`${m[2]}.${m[3]}`);
    out.push({ name, price });
  }
  return out;
}

// Fallback: price for one exact product name = first "X,XX MAD" after the name.
function findPrice(text, name) {
  const hay = norm(text);
  const needle = norm(name);
  const idx = hay.indexOf(needle);
  if (idx === -1) return null;
  const window = hay.slice(idx, idx + 300);
  const m = window.match(/(\d+),(\d{2})\s*mad/);
  if (!m) return null;
  return parseFloat(`${m[1]}.${m[2]}`);
}

function brandOf(name, brands) {
  const n = norm(name);
  return brands.find((b) => n.includes(norm(b))) || null;
}

// Short display name for the report: drop generic words + the brand word,
// keep variant + size. "Eau Gazeuse Orange Oulmès 25cl" -> "Orange 25cl".
// verbose=true keeps "Minérale"/"Gazeuse" (used only to tell apart two
// products that would otherwise share the same short name).
const DROP_WORDS = new Set([
  'eau', 'minerale', 'de', 'table', 'gazeuse', 'petillante', 'boisson',
  'bouteille', 'en', 'verre', 'pet', 'canette', 'classique', 'bulles', 'fruitees',
]);
function shortName(name, brand, verbose = false) {
  const brandWords = new Set(norm(brand).split(' '));
  const drop = verbose
    ? new Set([...DROP_WORDS].filter((w) => w !== 'minerale' && w !== 'gazeuse'))
    : DROP_WORDS;
  const tokens = name.split(/\s+/);
  const kept = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (drop.has(norm(t)) || brandWords.has(norm(t))) continue;
    // merge number + unit tokens ("25" + "CL" -> "25cl")
    if (/^\d+([,.]\d+)?$/.test(t) && i + 1 < tokens.length && /^(cl|l)$/i.test(tokens[i + 1])) {
      kept.push(t + (tokens[i + 1].toLowerCase() === 'l' ? 'L' : 'cl'));
      i++;
      continue;
    }
    kept.push(t.replace(/\.$/, ''));
  }
  return kept
    .map((t) =>
      t
        .replace(/^(\d+[,.]?\d*)cl$/i, (_, a) => `${a}cl`)
        .replace(/^(\d+[,.]?\d*)l$/i, (_, a) => `${a}L`)
    )
    .join(' ')
    .trim();
}

// Fetch + parse all products of one source (paginated when configured).
// Returns { products, error }.
async function fetchSourceProducts(source) {
  let products = [];
  try {
    if (source.paginate) {
      // Bringo-style pagination: page=1..N, limit=100, stop when a page is short/empty.
      for (let page = 1; page <= 5; page++) {
        const sep = source.url.includes('?') ? '&' : '?';
        const url = `${source.url}${sep}page=${page}&limit=100`;
        const text = stripTags(await fetchText(url));
        const found = parseProducts(text);
        console.log(`  page ${page}: ${found.length} products`);
        products = products.concat(found);
        if (found.length < 100) break;
      }
    } else {
      const text = stripTags(await fetchText(source.url));
      products = parseProducts(text);
      if (products.length === 0 && (source.products || []).length > 0) {
        // Fallback to exact-name matching (e.g. Glovo pages).
        for (const p of source.products) {
          const price = findPrice(text, p);
          if (price !== null) products.push({ name: p, price });
        }
      }
    }
  } catch (e) {
    return { products: [], error: e.message };
  }
  return { products, error: null };
}

// --full-report: send the whole current price list (grouped by store + brand).
// Does not read or write prices.json.
async function fullReport() {
  const seen = new Set();
  const stores = new Map(); // storeKey -> { label, brands: Map<brand, items[]> }
  for (const source of CONFIG.sources) {
    if (source.disabled) continue;
    console.log(`[fetch] ${source.label}`);
    const { products, error } = await fetchSourceProducts(source);
    if (error) {
      console.log(`[error] ${source.label}: ${error}`);
      continue;
    }
    const storeKey = source.store || source.id;
    if (!stores.has(storeKey)) stores.set(storeKey, { label: source.label, brands: new Map() });
    const store = stores.get(storeKey);
    for (const { name, price } of products) {
      const brand = source.brands ? brandOf(name, source.brands) : null;
      if (source.brands && !brand) continue;
      const key = `${storeKey} :: ${name}`;
      if (seen.has(key) || price <= 0) continue;
      seen.add(key);
      if (!store.brands.has(brand)) store.brands.set(brand, []);
      store.brands.get(brand).push({ name, price });
    }
  }
  const lines = [
    `📋 Prix LEMO — Tétouan`,
    `📅 ${new Date().toISOString().slice(0, 10)}`,
  ];
  for (const { label, brands } of stores.values()) {
    lines.push('', `🏪 ${label} — prix en MAD`, '```');
    for (const [brand, items] of brands) {
      // short names; colliding sizes: if the full names are identical the
      // pricier one is the pack, otherwise use the verbose name
      const shorts = items.map(({ name, price }) => ({ name, short: shortName(name, brand), price }));
      const byShort = {};
      for (const s of shorts) (byShort[s.short] = byShort[s.short] || []).push(s);
      for (const group of Object.values(byShort)) {
        if (group.length < 2) continue;
        const sameName = group.every((s) => norm(s.name) === norm(group[0].name));
        group.sort((a, b) => a.price - b.price);
        if (sameName) {
          for (let i = 1; i < group.length; i++) group[i].short += ' pack';
        } else {
          for (const s of group) s.short = shortName(s.name, brand, true);
        }
      }
      const width = Math.max(...shorts.map((s) => s.short.length));
      lines.push(brand.toUpperCase());
      for (const s of shorts) lines.push(`${s.short.padEnd(width + 2)}${s.price.toFixed(2)}`);
      lines.push('');
    }
    lines.push('```');
  }
  const msg = lines.join('\n');
  console.log(`[report] ${msg.length} chars, ${seen.size} products`);
  await sendTelegram(msg);
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.log('[telegram] no token/chat id — message NOT sent, printing it:');
    console.log(text);
    return false;
  }
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error('Telegram error: ' + JSON.stringify(data));
  console.log('[telegram] sent, message_id=' + data.result.message_id);
  return true;
}

async function main() {
  if (process.argv.includes('--full-report')) {
    await fullReport();
    return;
  }
  const state = loadState();
  const changes = [];
  const missing = [];
  const counts = {};
  const seen = new Set(); // dedupe across sources of the same store

  for (const source of CONFIG.sources) {
    if (source.disabled) {
      console.log(`[skip] ${source.label} (disabled)`);
      continue;
    }
    console.log(`[fetch] ${source.label}`);
    const { products, error } = await fetchSourceProducts(source);
    if (error) {
      console.log(`[error] ${source.label}: ${error}`);
      missing.push(`${source.label} (fetch failed)`);
      continue;
    }

    // Keep only the configured brands (if any), dedupe by name keeping the cheapest
    // (first in price-asc order = single bottle, not the pack with the same name).
    // Dedupe is per STORE, so the same product on two category pages of one
    // store is tracked once.
    const storeKey = source.store || source.id;
    let trackedThisSource = 0;
    for (const { name, price } of products) {
      const brand = source.brands ? brandOf(name, source.brands) : null;
      if (source.brands && !brand) continue;
      const key = `${storeKey} :: ${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (price <= 0) {
        // 0,00 MAD = out of stock / unavailable, not a price. Never record it.
        console.log(`  ${name}: unavailable (0,00 MAD) — skipped`);
        missing.push(`${source.label} — ${name} (rupture)`);
        continue;
      }
      counts[brand || source.id] = (counts[brand || source.id] || 0) + 1;
      trackedThisSource++;
      const prev = state[key];
      console.log(`  ${name}: ${prev === undefined ? '(new)' : prev} -> ${price} MAD`);
      if (prev === undefined) {
        state[key] = price; // baseline, no alert on first sight
      } else if (prev !== price) {
        const arrow = price < prev ? '🔻' : '🔺';
        changes.push(`${arrow} ${name}\n   ${source.label}\n   ${prev} → ${price} MAD`);
        state[key] = price;
      }
    }
    if (trackedThisSource === 0) missing.push(`${source.label} (no products parsed)`);
  }

  saveState(state);
  console.log('Products tracked per brand:', JSON.stringify(counts));

  if (changes.length > 0) {
    const msg =
      `🔔 Changement de prix — LEMO\n\n${changes.join('\n\n')}\n\n` +
      `📅 ${new Date().toISOString().slice(0, 10)}`;
    await sendTelegram(msg);
  } else {
    console.log('No price change.');
    if (missing.length > 0) console.log('Missing/failed: ' + missing.join(' ; '));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
