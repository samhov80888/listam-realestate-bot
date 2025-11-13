// index.js — List.am: ուղարկում է ՄԻԱՅՆ նոր տեղադրված հայտարարություններ (per-URL maxId)
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
  MAX_NEW_PER_TICK = '0', // 0 -> ուղարկել բոլոր նորերը
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
// Seen store — ԱՌԱՆՁԻՆ per URL
// Ֆայլի ֆորմատը․
// {
//   "<url1>": { "seen": ["https://www.list.am/item/..", ...], "maxId": 23000000 },
//   "<url2>": { "seen": [...], "maxId": 22900000 }
// }
// ──────────────────────────────────────────────

/**
 * @typedef {{ seen: Set<string>; maxId: number | null }} PerUrlEntry
 */

/**
 * @returns {Record<string, PerUrlEntry>}
 */
function loadStore() {
  try {
    const raw = fs.readFileSync(SEEN_STORE_PATH, 'utf-8');
    const parsed = JSON.parse(raw);

    if (!parsed || typeof parsed !== 'object') {
      return {};
    }

    /** @type {Record<string, PerUrlEntry>} */
    const perUrl = {};

    for (const [url, v] of Object.entries(parsed)) {
      if (!v || typeof v !== 'object') continue;

      const seenArr = Array.isArray(v.seen) ? v.seen : [];
      const maxId =
        typeof v.maxId === 'number' && Number.isFinite(v.maxId)
          ? v.maxId
          : null;

      perUrl[url] = {
        seen: new Set(seenArr),
        maxId,
      };
    }

    return perUrl;
  } catch {
    return {};
  }
}

/**
 * @param {Record<string, PerUrlEntry>} store
 */
function saveStore(store) {
  try {
    const out = {};
    for (const [url, entry] of Object.entries(store)) {
      out[url] = {
        seen: [...entry.seen],
        maxId: entry.maxId ?? null,
      };
    }
    fs.writeFileSync(SEEN_STORE_PATH, JSON.stringify(out), 'utf-8');
  } catch (e) {
    console.error('⚠️ Cannot write seen store:', e.message);
  }
}

/**
 * lazy-init per-url entry
 * @param {Record<string, PerUrlEntry>} store
 * @param {string} url
 * @returns {PerUrlEntry}
 */
function getPerUrlEntry(store, url) {
  if (!store[url]) {
    store[url] = { seen: new Set(), maxId: null };
  }
  return store[url];
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
const store = loadStore();
const urls = safeParseUrls(SEARCH_URLS || '[]');

let totalSeen = 0;
const perUrlDebug = {};
for (const u of urls) {
  const e = getPerUrlEntry(store, u);
  totalSeen += e.seen.size;
  perUrlDebug[u] = { seenCount: e.seen.size, maxId: e.maxId ?? null };
}

console.log('ENV:', {
  hasToken: !!BOT_TOKEN,
  chatId: CHAT_ID,
  intervalMs: Number(INTERVAL_MS),
  timeoutMs: Number(REQUEST_TIMEOUT_MS),
  concurrency: Number(CONCURRENCY),
  urlsCount: urls.length,
  maxNewPerTick: Number(MAX_NEW_PER_TICK),
  seenStorePath: SEEN_STORE_PATH,
  totalSeen,
  perUrl: perUrlDebug,
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
// Warmup — եթե ԲՈԼՈՐ URL-ների համար seen/maxId չկա
// ──────────────────────────────────────────────
async function warmupIfAllEmpty() {
  if (!urls.length) return false;

  const hasAnyData = urls.some((u) => {
    const e = getPerUrlEntry(store, u);
    return e.seen.size > 0 || e.maxId != null;
  });

  if (hasAnyData) {
    return false; // արդեն կա store տվյալ
  }

  console.log(
    '🔥 Warmup: store is empty, seeding with CURRENT items per URL (հետո կուղարկենք միայն ավելի նոր ID-ներ)'
  );

  const limit = pLimit(Number(CONCURRENCY));

  await Promise.all(
    urls.map((u) =>
      limit(async () => {
        const links = await fetchItemLinks(u);
        const entry = getPerUrlEntry(store, u);

        links.forEach((l) => {
          entry.seen.add(l);
          const id = extractItemId(l);
          if (id != null) {
            if (entry.maxId == null || id > entry.maxId) {
              entry.maxId = id;
            }
          }
        });

        console.log(
          `   ↳ Warmup for ${u}: seen=${entry.seen.size}, maxId=${entry.maxId ?? 'null'}`
        );
      })
    )
  );

  saveStore(store);

  console.log('🔥 Warmup done.');
  return true;
}

// ──────────────────────────────────────────────
// Build message with *truly new* items (ID > per-url maxId)
// ──────────────────────────────────────────────
async function buildNewestUnseenMessage() {
  if (!urls.length) {
    return { any: false, text: '' };
  }

  const limit = pLimit(Number(CONCURRENCY));
  /** @type {{link: string; sourceUrl: string; id: number}[]} */
  const freshItems = [];

  await Promise.all(
    urls.map((u) =>
      limit(async () => {
        const entry = getPerUrlEntry(store, u);
        const links = await fetchItemLinks(u);

        for (const link of links) {
          const id = extractItemId(link);

          // Եթե ID չկար, չենք կարող "նոր տեղադրված" ճշգրիտ որոշել → skip
          if (id == null) {
            continue;
          }

          // per-URL maxId logic → ԱՅՍՏԵՂՆ Է ԳԼԽԱՎՈՐ ՄԱՍԸ
          // միայն ID > maxId–երն ենք համարում նոր տեղադրված
          if (entry.maxId != null && id <= entry.maxId) {
            continue; // հին հայտարարություն՝ կոնկրետ այս URL-ի համար
          }

          freshItems.push({ link, sourceUrl: u, id });
        }
      })
    )
  );

  if (!freshItems.length) {
    return { any: false, text: '' };
  }

  // sort՝ ամենաթարմ ID-ները վերևում
  freshItems.sort((a, b) => b.id - a.id);

  // եթե MAX_NEW_PER_TICK > 0 → կտրում ենք, հակառակ դեպքում՝ ուղարկում ենք բոլորին
  let newest = freshItems;
  const max = Number(MAX_NEW_PER_TICK);
  if (Number.isFinite(max) && max > 0) {
    newest = freshItems.slice(0, max);
  }

  // update per-url maxId (ստորադաս → ամենամեծ ID–ն դառնում է նոր maxId)
  newest.forEach(({ sourceUrl, id }) => {
    const entry = getPerUrlEntry(store, sourceUrl);
    if (entry.maxId == null || id > entry.maxId) {
      entry.maxId = id;
    }
  });

  saveStore(store);

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

    const didWarmup = await warmupIfAllEmpty();
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
    console.log('📨 sent');
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
