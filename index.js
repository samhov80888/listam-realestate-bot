// index.js — List.am: ուղարկում է ՄԻԱՅՆ նոր տեղադրված հայտարարություններից max 5 հատ
import 'dotenv/config';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { Telegraf } from 'telegraf';
import pLimit from 'p-limit';
import fs from 'fs';

const {
  BOT_TOKEN,
  CHAT_ID,
  SEARCH_URLS,
  INTERVAL_MS = '120000', // 2 րոպե
  REQUEST_TIMEOUT_MS = '10000',
  CONCURRENCY = '3',
  NODE_ENV,
  MAX_NEW_PER_TICK = '5',
  SEEN_STORE_PATH = './seen-items.json',
} = process.env;

// ──────────────────────────────────────────────
// Օգնական՝ SEARCH_URLS
// ──────────────────────────────────────────────
function safeParseUrls(raw) {
  try {
    const arr = JSON.parse(raw || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

// ──────────────────────────────────────────────
// Seen store (seen + maxId)
// ──────────────────────────────────────────────
function loadStore() {
  try {
    const raw = fs.readFileSync(SEEN_STORE_PATH, 'utf-8');
    const parsed = JSON.parse(raw);

    // Հին ձևաչափից мигրացիա (երբ պահում էինք ուղղակի array)
    if (Array.isArray(parsed)) {
      return { seen: new Set(parsed), maxId: null };
    }

    const seenArr = Array.isArray(parsed.seen) ? parsed.seen : [];
    const maxId =
      typeof parsed.maxId === 'number' && Number.isFinite(parsed.maxId)
        ? parsed.maxId
        : null;

    return { seen: new Set(seenArr), maxId };
  } catch {
    return { seen: new Set(), maxId: null };
  }
}

function saveStore(seen, maxId) {
  try {
    const obj = { seen: [...seen], maxId: maxId ?? null };
    fs.writeFileSync(SEEN_STORE_PATH, JSON.stringify(obj), 'utf-8');
  } catch (e) {
    console.error('⚠️ Cannot write seen store:', e.message);
  }
}

// item ID–ն հանում ենք link–ից՝ /item/23085989
function extractItemId(link) {
  const m = /\/item\/(\d+)/.exec(link);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

// ──────────────────────────────────────────────
// Սկզբնական լոգեր
// ──────────────────────────────────────────────
const { seen, maxId: initialMaxId } = loadStore();
let maxId = initialMaxId;

console.log('ENV:', {
  hasToken: !!BOT_TOKEN,
  chatId: CHAT_ID,
  intervalMs: Number(INTERVAL_MS),
  timeoutMs: Number(REQUEST_TIMEOUT_MS),
  concurrency: Number(CONCURRENCY),
  urlsCount: safeParseUrls(SEARCH_URLS).length,
  maxNewPerTick: Number(MAX_NEW_PER_TICK),
  seenStorePath: SEEN_STORE_PATH,
  seenCount: seen.size,
  maxId,
});

if (!BOT_TOKEN || !CHAT_ID) {
  console.error('❌ .env-ում պետք է լինի BOT_TOKEN և CHAT_ID');
  process.exit(1);
}

// ──────────────────────────────────────────────
// Token check
// ──────────────────────────────────────────────
try {
  const { data: g } = await axios.get(
    `https://api.telegram.org/bot${BOT_TOKEN}/getMe`,
    { timeout: 8000 }
  );
  console.log('🧪 getMe:', g);
  if (!g?.ok) {
    console.error('❌ Invalid token:', g?.description || g);
    process.exit(1);
  }
} catch (e) {
  console.error('❌ getMe failed:', e?.message || e);
  process.exit(1);
}

// ──────────────────────────────────────────────
// Bot (send-only mode)
// ──────────────────────────────────────────────
const bot = new Telegraf(BOT_TOKEN);
console.log('🤖 Bot initialized (send-only mode)');

// ──────────────────────────────────────────────
// HTTP client
// ──────────────────────────────────────────────
const http = axios.create({
  timeout: Number(REQUEST_TIMEOUT_MS),
  headers: {
    'User-Agent': 'Mozilla/5.0 (compatible; listam-realestate-bot/1.0)',
    'Accept-Language': 'hy-AM,hy;q=0.9,en;q=0.8',
    Accept: 'text/html,application/xhtml+xml',
  },
});

// ──────────────────────────────────────────────
// Scraper helpers
// ──────────────────────────────────────────────
function toAbsolute(url) {
  if (!url) return null;
  if (url.startsWith('http')) return url;
  if (url.startsWith('/')) return 'https://www.list.am' + url;
  return 'https://www.list.am/' + url;
}

async function fetchItemLinks(url) {
  console.log(' → fetching:', url);
  try {
    const { data: html, status } = await http.get(url);
    console.log(`   ↳ status ${status}`);
    const $ = cheerio.load(html);

    const links = [];
    $('.dl a, .gl a').each((_, el) => {
      const href = $(el).attr('href');
      if (href && /\/item\/\d+/.test(href)) {
        const abs = toAbsolute(href);
        if (abs && !links.includes(abs)) links.push(abs);
      }
    });

    if (!links.length) {
      $('a').each((_, el) => {
        const href = $(el).attr('href');
        if (href && /\/item\/\d+/.test(href)) {
          const abs = toAbsolute(href);
          if (abs && !links.includes(abs)) links.push(abs);
        }
      });
    }

    if (NODE_ENV === 'development') {
      console.log(`   ↳ extracted ${links.length} item link(s)`);
    }

    return links;
  } catch (e) {
    const status = e?.response?.status;
    if (status === 403) {
      console.log('⚠️ 403 Forbidden (list.am rate-limit) — skip this URL this tick');
      return [];
    }
    throw e;
  }
}

// Label ըստ URL-ի
function getLabelForSourceUrl(sourceUrl) {
  try {
    const u = new URL(sourceUrl);
    const path = u.pathname || '';

    if (/\/category\/60/.test(path)) return 'Տներ';
    if (/\/category\/1386/.test(path)) return 'Բիզնես';

    return 'Անշարժ գույք';
  } catch {
    return 'Անշարժ գույք';
  }
}

// ──────────────────────────────────────────────
// Warmup — եթե seen-ը դատարկ է, մի անգամ ստարտի պահին
// ──────────────────────────────────────────────
async function warmupSeenIfEmpty() {
  if (seen.size > 0) {
    return false; // արդեն ունենք տվյալներ, warmup պետք չէ
  }

  console.log(
    '🔥 Warmup: seen is empty, seeding with CURRENT items (հետո կուղարկենք միայն ավելի նոր ID-ներ)'
  );

  const urls = safeParseUrls(SEARCH_URLS);
  const limit = pLimit(Number(CONCURRENCY));
  const allLinks = new Set();

  await Promise.all(
    urls.map((u) =>
      limit(async () => {
        const links = await fetchItemLinks(u);
        links.forEach((l) => allLinks.add(l));
      })
    )
  );

  let warmupMaxId = maxId ?? null;

  allLinks.forEach((l) => {
    seen.add(l);
    const id = extractItemId(l);
    if (id != null) {
      if (warmupMaxId == null || id > warmupMaxId) {
        warmupMaxId = id;
      }
    }
  });

  maxId = warmupMaxId;
  saveStore(seen, maxId);

  console.log(
    '🔥 Warmup done, seeded items:',
    seen.size,
    'maxId =',
    maxId ?? 'null'
  );
  return true;
}

// ──────────────────────────────────────────────
// Build message with *truly new* items (ID > maxId)
// ──────────────────────────────────────────────
async function buildNewestUnseenMessage() {
  const urls = safeParseUrls(SEARCH_URLS);
  if (!urls.length) {
    return { any: false, text: '' };
  }

  const limit = pLimit(Number(CONCURRENCY));
  /** @type {{link: string; sourceUrl: string; id: number | null}[]} */
  const freshItems = [];

  await Promise.all(
    urls.map((u) =>
      limit(async () => {
        const links = await fetchItemLinks(u);
        for (const link of links) {
          const id = extractItemId(link);

          // Եթե ID չունի, fallback-ով միայն 'seen'–ով ստուգենք
          if (id == null) {
            if (!seen.has(link)) {
              freshItems.push({ link, sourceUrl: u, id: null });
            }
            continue;
          }

          // Եթե ունենք maxId և այս ID-ն <= maxId, համարում ենք
          // «հին» հայտարարություն (դրանից առաջ արդեն կային),
          // անգամ եթե link-ը երբեք չենք տեսել։
          if (maxId != null && id <= maxId) {
            continue;
          }

          // Այստեղ ID > maxId կամ maxId=null, ու link-ը նոր է նաև 'seen'-ի տեսանկյունից
          if (!seen.has(link)) {
            freshItems.push({ link, sourceUrl: u, id });
          }
        }
      })
    )
  );

  if (!freshItems.length) {
    return { any: false, text: '' };
  }

  // Կարող ենք sort անել ըստ ID–ի նվազման (ամենամեծը՝ ամենաթարմը)
  freshItems.sort((a, b) => {
    if (a.id == null || b.id == null) return 0;
    return b.id - a.id;
  });

  const max = Number(MAX_NEW_PER_TICK);
  const newest = freshItems.slice(0, max);

  // update seen + maxId
  newest.forEach(({ link, id }) => {
    seen.add(link);
    if (id != null) {
      if (maxId == null || id > maxId) {
        maxId = id;
      }
    }
  });
  saveStore(seen, maxId);

  const lines = ['🆕 Վերջին նոր տեղադրված հայտարարություններ՝'];
  newest.forEach(({ link, sourceUrl }) => {
    const label = getLabelForSourceUrl(sourceUrl);
    lines.push(`• [${label}] ${link}`);
  });

  return {
    any: true,
    text: lines.join('\n'),
  };
}

// ──────────────────────────────────────────────
// Tick
// ──────────────────────────────────────────────
async function tick() {
  try {
    console.log('⏳ tick...');

    const didWarmup = await warmupSeenIfEmpty();
    if (didWarmup) {
      console.log('↩️ Warmup tick finished — no messages sent');
      return;
    }

    const { any, text } = await buildNewestUnseenMessage();

    if (!any) {
      console.log('↩️ No new items — nothing sent');
      return;
    }

    console.log(
      '🧾 preview:\n' +
        text.split('\n').slice(0, 5).join('\n') +
        (text.includes('\n') ? '\n…' : '')
    );

    await bot.telegram.sendMessage(CHAT_ID, text, {
      disable_web_page_preview: false,
    });
    console.log('📨 sent, maxId now =', maxId ?? 'null');
  } catch (e) {
    const status = e?.response?.status;
    console.error('❌ Tick error:', status, e?.message || e);

    if (status === 403) {
      console.log('↩️ Soft skip (403) — error not sent to Telegram');
      return;
    }
  }
}

// ──────────────────────────────────────────────
// Start
// ──────────────────────────────────────────────
console.log('✅ Bot started. Interval =', INTERVAL_MS, 'ms');
tick();
setInterval(tick, Number(INTERVAL_MS));
