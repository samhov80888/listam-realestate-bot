// index.js — List.am Bot SUPER STABLE (text only)

import 'dotenv/config';
import fs from 'fs';
import pLimit from 'p-limit';
import { Telegraf } from 'telegraf';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteer.use(StealthPlugin());

// ====================== ENV ======================
const {
  BOT_TOKEN,
  CHAT_IDS,                       // 🔹 բազմակի chatId-ներ
  SEARCH_URLS,
  INTERVAL_MS = '1200000',        // default 20 րոպե
  PROXY_HOST,
  PROXY_PORT,
  PROXY_USER,
  PROXY_PASS,
  MAX_NEW_PER_TICK = '0',         // 0 = ուղարկել բոլոր նորերը
  SEEN_STORE_PATH = './seen-items.json',
  PUPPETEER_EXECUTABLE_PATH,      // Hetzner-ի համար կարող ես դնել /usr/bin/chromium-browser
} = process.env;

const urls = JSON.parse(SEARCH_URLS || '[]');

// CHAT_IDS → զանգված
let chatIds = [];
try {
  chatIds = CHAT_IDS ? JSON.parse(CHAT_IDS) : [];
} catch (e) {
  console.error('❌ CHAT_IDS պետք է լինի վավեր JSON, օրինակ՝ [6551638804, 1234567890]');
  process.exit(1);
}

if (!BOT_TOKEN || chatIds.length === 0 || urls.length === 0) {
  console.error('❌ Պարտադիր են BOT_TOKEN, CHAT_IDS և SEARCH_URLS');
  process.exit(1);
}

// ====================== STORE ======================
function loadStore() {
  try {
    return JSON.parse(fs.readFileSync(SEEN_STORE_PATH, 'utf8')) || {};
  } catch {
    console.log('ℹ️ Store ֆայլ չկա, սկսում եմ 0–ից');
    return {};
  }
}

function saveStore(data) {
  try {
    fs.writeFileSync(SEEN_STORE_PATH, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('❌ Չհաջողվեց պահպանել store-ը:', e.message);
  }
}

let store = loadStore(); // { [url]: { maxId: number } }

// ====================== HELPERS ======================
function extractId(url) {
  const m = /\/item\/(\d+)/.exec(url);
  return m ? Number(m[1]) : null;
}

function getLabel(url) {
  if (url.includes('/category/60')) return 'Տներ';
  if (url.includes('/category/1386')) return 'Բիզնես';
  return 'Անշարժ գույք';
}

function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}

// ====================== BROWSER HELPERS ======================
async function launchBrowser() {
  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-web-security',
    '--disable-features=IsolateOrigins,site-per-process',
  ];

  if (PROXY_HOST && PROXY_PORT) {
    args.push(`--proxy-server=${PROXY_HOST}:${PROXY_PORT}`);
    console.log('🌐 Proxy enabled:', PROXY_HOST, PROXY_PORT);
  }

  const launchOptions = {
    headless: true,
    args,
  };

  if (PUPPETEER_EXECUTABLE_PATH) {
    launchOptions.executablePath = PUPPETEER_EXECUTABLE_PATH;
  }

  const browser = await puppeteer.launch(launchOptions);
  return browser;
}

async function createPage(browser) {
  const page = await browser.newPage();

  if (PROXY_USER && PROXY_PASS) {
    await page.authenticate({ username: PROXY_USER, password: PROXY_PASS });
  }

  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  );

  await page.setExtraHTTPHeaders({
    'Accept-Language': 'hy-AM,hy;q=0.9,en;q=0.8',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  });

  return page;
}

// ====================== SCRAPERS ======================
async function fetchItemLinks(browser, url) {
  let page;
  try {
    page = await createPage(browser);
    console.log('🔎 Բացում եմ →', url);

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForSelector('a[href*="/item/"]', { timeout: 30000 });

    const links = await page.evaluate(() => {
      const set = new Set();
      document.querySelectorAll('a[href*="/item/"]').forEach(a => {
        let h = a.getAttribute('href') || a.href;
        if (h && /\/item\/\d+/.test(h)) {
          if (!h.startsWith('http')) h = 'https://www.list.am' + h;
          set.add(h.split('?')[0]);
        }
      });
      return [...set];
    });

    console.log(`   → Գտա ${links.length} հայտարարություն`);
    return links;
  } catch (err) {
    console.error('❌ Scrape error (list):', url, err.message);
    return [];
  } finally {
    if (page) await page.close();
  }
}

async function fetchItemDetails(browser, link) {
  let page;
  try {
    page = await createPage(browser);
    await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('body', { timeout: 30000 }); // էլ չենք սպասում կոնկրետ .gl-header-ին

    const data = await page.evaluate(() => {
      const title =
        document.querySelector('.gl-header')?.innerText?.trim() ||
        document.querySelector('.at')?.innerText?.trim() ||
        'Անվերնագիր';

      const price =
        document.querySelector('.price')?.innerText?.trim() ||
        document.querySelector('.gl-prc')?.innerText?.trim() ||
        'Գին նշված չէ';

      const descRaw =
        document.querySelector('#desc')?.innerText?.trim() ||
        document.querySelector('.gl-dsc')?.innerText?.trim() ||
        '';

      const description = descRaw || 'Առանց նկարագրության';

      return { title, price, description };
    });

    return data;
  } catch (err) {
    console.error('❌ Item detail error:', link, err.message);
    return {
      title: 'Անվերնագիր',
      price: 'Գին չկա',
      description: 'Նկարագրություն չկա',
    };
  } finally {
    if (page) await page.close();
  }
}

// ====================== WARMUP ======================
async function warmupIfNeeded(browser) {
  const hasWarmup = Object.values(store).some(
    v => v && v.maxId != null,
  );
  if (hasWarmup) return;

  console.log('🔥 Առաջին գործարկում → WARMUP');

  const limit = pLimit(2);

  await Promise.all(
    urls.map(url =>
      limit(async () => {
        const links = await fetchItemLinks(browser, url);
        store[url] = store[url] || { maxId: null };

        for (const link of links) {
          const id = extractId(link);
          if (id && (!store[url].maxId || id > store[url].maxId)) {
            store[url].maxId = id;
          }
        }
      }),
    ),
  );

  saveStore(store);
  console.log('⚡ Warmup ավարտված');
}

// ====================== MAIN LOOP ======================
async function tick(bot) {
  console.log('\n⏱ Ստուգում եմ նոր հայտարարությունները…');

  const browser = await launchBrowser();

  try {
    await warmupIfNeeded(browser);

    const limit = pLimit(2);
    const newItems = [];

    await Promise.all(
      urls.map(url =>
        limit(async () => {
          store[url] = store[url] || { maxId: null };

          const links = await fetchItemLinks(browser, url);

          for (const link of links) {
            const id = extractId(link);
            if (!id) continue;

            if (!store[url].maxId || id > store[url].maxId) {
              newItems.push({ link, id, sourceUrl: url });
              store[url].maxId = id;
            }
          }
        }),
      ),
    );

    if (!newItems.length) {
      console.log('😴 Նոր հայտարարություն չկա');
      return;
    }

    newItems.sort((a, b) => b.id - a.id);

    const maxToSend = Number(MAX_NEW_PER_TICK) || newItems.length;
    const toSend = newItems.slice(0, maxToSend);

    console.log(`📬 Ուղարկում եմ ${toSend.length} նոր հայտարարություն…`);

    for (const item of toSend) {
      const details = await fetchItemDetails(browser, item.link);

      const lines = [
        `${getLabel(item.sourceUrl)} — ՆՈՐ հայտարարություն`,
        '',
        `Վերնագիր: ${details.title}`,
        `Գին: ${details.price}`,
        '',
        details.description,
        '',
        `Հղում: ${item.link}`,
      ];

      const text = lines.join('\n');

      for (const chatId of chatIds) {
        try {
          await bot.telegram.sendMessage(chatId, text);
          await sleep(1500); // anti-flood
        } catch (err) {
          console.error(
            '❌ Telegram send error:',
            err.response?.description || err.message,
            'chatId:',
            chatId,
            'URL:',
            item.link,
          );
        }
      }
    }

    saveStore(store);
    console.log('✅ Tick ավարտված');
  } finally {
    await browser.close();
  }
}

// ====================== START BOT ======================
const bot = new Telegraf(BOT_TOKEN);

console.log(
  '🤖 List.am Bot SUPER STABLE – աշխատում է, ստուգում եմ ամեն',
  Number(INTERVAL_MS) / 60000,
  'րոպեն մեկ',
);

tick(bot).catch(e => console.error('❌ Initial tick error:', e));

setInterval(() => {
  tick(bot).catch(err => console.error('❌ Tick error:', err));
}, Number(INTERVAL_MS));
