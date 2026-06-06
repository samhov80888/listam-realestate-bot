import 'dotenv/config';
import fs from 'fs';
import { Telegraf, Markup } from 'telegraf';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { FILTERS } from './filters.js';

puppeteer.use(StealthPlugin());

const {
  BOT_TOKEN,
  CHAT_IDS,
  INTERVAL_MS = '900000',
  REQUEST_DELAY_MS = '30000',
  MAX_NEW_PER_TICK = '0',
  SEEN_STORE_PATH = './seen-items.json',
  SETTINGS_STORE_PATH = './settings.json',
  PUPPETEER_EXECUTABLE_PATH,
  PROXY_HOST,
  PROXY_PORT,
  PROXY_USER,
  PROXY_PASS,
  NODE_ENV,
} = process.env;

let chatIds = [];

try {
  chatIds = CHAT_IDS ? JSON.parse(CHAT_IDS) : [];
} catch {
  console.error('❌ CHAT_IDS պետք է լինի JSON array, օրինակ՝ [6551638804]');
  process.exit(1);
}

if (!BOT_TOKEN || !chatIds.length) {
  console.error('❌ Պարտադիր են BOT_TOKEN և CHAT_IDS');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function loadJson(path, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function saveJson(path, data) {
  try {
    fs.writeFileSync(path, JSON.stringify(data, null, 2), 'utf8');
  } catch (error) {
    console.error('❌ Չհաջողվեց պահպանել ֆայլը:', path, error.message);
  }
}

function loadSettings() {
  const fallback = {
    enabledFilters: Object.fromEntries(
      FILTERS.map(filter => [filter.id, !!filter.enabledByDefault])
    ),
  };

  const settings = loadJson(SETTINGS_STORE_PATH, fallback);

  if (!settings.enabledFilters || typeof settings.enabledFilters !== 'object') {
    settings.enabledFilters = {};
  }

  for (const filter of FILTERS) {
    if (typeof settings.enabledFilters[filter.id] !== 'boolean') {
      settings.enabledFilters[filter.id] = !!filter.enabledByDefault;
    }
  }

  saveJson(SETTINGS_STORE_PATH, settings);
  return settings;
}

function loadSeenStore() {
  const parsed = loadJson(SEEN_STORE_PATH, {});
  const store = {};

  for (const filter of FILTERS) {
    const value = parsed[filter.id];

    store[filter.id] = {
      seen: new Set(Array.isArray(value?.seen) ? value.seen : []),
      maxId:
        typeof value?.maxId === 'number' && Number.isFinite(value.maxId)
          ? value.maxId
          : null,
    };
  }

  return store;
}

function saveSeenStore(store) {
  const out = {};

  for (const [filterId, entry] of Object.entries(store)) {
    out[filterId] = {
      seen: [...entry.seen],
      maxId: entry.maxId ?? null,
    };
  }

  saveJson(SEEN_STORE_PATH, out);
}

let settings = loadSettings();
const seenStore = loadSeenStore();

console.log('ENV:', {
  hasToken: !!BOT_TOKEN,
  chatIds,
  intervalMs: Number(INTERVAL_MS),
  requestDelayMs: Number(REQUEST_DELAY_MS),
  maxNewPerTick: Number(MAX_NEW_PER_TICK),
  seenStorePath: SEEN_STORE_PATH,
  settingsStorePath: SETTINGS_STORE_PATH,
  filtersCount: FILTERS.length,
  nodeEnv: NODE_ENV,
});

function extractItemId(link) {
  const match = /\/item\/(\d+)/.exec(link);
  if (!match) return null;

  const id = Number(match[1]);
  return Number.isFinite(id) ? id : null;
}

function normalizeItemLink(link) {
  if (!link) return null;

  let result = link;

  if (!result.startsWith('http')) {
    result = `https://www.list.am${result.startsWith('/') ? '' : '/'}${result}`;
  }

  return result.split('?')[0];
}

function getEnabledFilters() {
  return FILTERS.filter(filter => settings.enabledFilters[filter.id]);
}

function areAllFiltersEnabled() {
  return FILTERS.every(filter => settings.enabledFilters[filter.id]);
}

function setAllFilters(enabled) {
  for (const filter of FILTERS) {
    settings.enabledFilters[filter.id] = enabled;
  }

  saveJson(SETTINGS_STORE_PATH, settings);
}

async function launchBrowser() {
  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-web-security',
    '--disable-features=IsolateOrigins,site-per-process',
    '--window-size=1366,768',
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

  return puppeteer.launch(launchOptions);
}

async function createPage(browser) {
  const page = await browser.newPage();

  if (PROXY_USER && PROXY_PASS) {
    await page.authenticate({
      username: PROXY_USER,
      password: PROXY_PASS,
    });
  }

  await page.setViewport({ width: 1366, height: 768 });

  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  );

  await page.setExtraHTTPHeaders({
    'Accept-Language': 'hy-AM,hy;q=0.9,en;q=0.8',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  });

  page.setDefaultNavigationTimeout(120000);
  page.setDefaultTimeout(60000);

  return page;
}

async function fetchItemLinks(browser, filter) {
  let page;

  try {
    page = await createPage(browser);

    console.log(` → fetching [${filter.label}]:`, filter.url);

    await page.goto(filter.url, {
      waitUntil: 'domcontentloaded',
      timeout: 120000,
    });

    await page.waitForSelector('body', { timeout: 60000 });

    const pageUrl = page.url();

    if (pageUrl.includes('blocked') || pageUrl.includes('captcha')) {
      console.log(`⚠️ Possible block/captcha [${filter.label}]:`, pageUrl);
      return null;
    }

    await sleep(3000);

    const links = await page.evaluate(() => {
      const set = new Set();

      document.querySelectorAll('a[href*="/item/"]').forEach(a => {
        let href = a.getAttribute('href') || a.href;

        if (href && /\/item\/\d+/.test(href)) {
          if (!href.startsWith('http')) {
            href = `https://www.list.am${href}`;
          }

          set.add(href.split('?')[0]);
        }
      });

      return [...set];
    });

    console.log(`   ↳ extracted ${links.length} item link(s) [${filter.label}]`);

    return links;
  } catch (error) {
    console.error(`❌ Scrape error [${filter.label}]:`, error.message);
    return null;
  } finally {
    if (page) {
      await page.close().catch(() => {});
    }
  }
}

async function fetchItemDetails(browser, link) {
  let page;

  try {
    page = await createPage(browser);

    await page.goto(link, {
      waitUntil: 'domcontentloaded',
      timeout: 120000,
    });

    await page.waitForSelector('body', { timeout: 60000 });

    return page.evaluate(() => {
      const title =
        document.querySelector('.gl-header')?.innerText?.trim() ||
        document.querySelector('.at')?.innerText?.trim() ||
        document.querySelector('h1')?.innerText?.trim() ||
        'Անվերնագիր';

      const price =
        document.querySelector('.price')?.innerText?.trim() ||
        document.querySelector('.gl-prc')?.innerText?.trim() ||
        'Գին նշված չէ';

      const description =
        document.querySelector('#desc')?.innerText?.trim() ||
        document.querySelector('.gl-dsc')?.innerText?.trim() ||
        'Առանց նկարագրության';

      return { title, price, description };
    });
  } catch (error) {
    console.error('❌ Item detail error:', link, error.message);

    return {
      title: 'Անվերնագիր',
      price: 'Գին նշված չէ',
      description: 'Նկարագրություն չկա',
    };
  } finally {
    if (page) {
      await page.close().catch(() => {});
    }
  }
}

async function warmupIfFilterEmpty(browser, filter) {
  const entry = seenStore[filter.id];

  if (entry.seen.size > 0 || entry.maxId != null) {
    return false;
  }

  console.log(`🔥 Warmup [${filter.label}]`);

  const links = await fetchItemLinks(browser, filter);

  if (links === null) {
    console.log(`↩️ Warmup skipped [${filter.label}] because request failed`);
    await sleep(Number(REQUEST_DELAY_MS));
    return false;
  }

  for (const rawLink of links) {
    const link = normalizeItemLink(rawLink);
    const id = extractItemId(link);

    if (!link || !id) continue;

    entry.seen.add(link);

    if (entry.maxId == null || id > entry.maxId) {
      entry.maxId = id;
    }
  }

  saveSeenStore(seenStore);

  console.log(
    `🔥 Warmup done [${filter.label}]: seen=${entry.seen.size}, maxId=${entry.maxId}`
  );

  await sleep(Number(REQUEST_DELAY_MS));
  return true;
}

async function warmupEnabledEmptyFilters(browser) {
  let didAnyWarmup = false;

  for (const filter of getEnabledFilters()) {
    const didWarmup = await warmupIfFilterEmpty(browser, filter);

    if (didWarmup) {
      didAnyWarmup = true;
    }
  }

  return didAnyWarmup;
}

async function buildNewestMessage(browser) {
  const freshItems = [];

  for (const filter of getEnabledFilters()) {
    const entry = seenStore[filter.id];
    const links = await fetchItemLinks(browser, filter);

    if (links === null) {
      await sleep(Number(REQUEST_DELAY_MS));
      continue;
    }

    for (const rawLink of links) {
      const link = normalizeItemLink(rawLink);
      const id = extractItemId(link);

      if (!link || !id) continue;

      if (entry.maxId != null && id <= entry.maxId) {
        continue;
      }

      if (!entry.seen.has(link)) {
        freshItems.push({ filter, link, id });
      }
    }

    await sleep(Number(REQUEST_DELAY_MS));
  }

  if (!freshItems.length) {
    return { any: false, text: '' };
  }

  freshItems.sort((a, b) => b.id - a.id);

  let newest = freshItems;
  const max = Number(MAX_NEW_PER_TICK);

  if (Number.isFinite(max) && max > 0) {
    newest = freshItems.slice(0, max);
  }

  for (const item of newest) {
    const entry = seenStore[item.filter.id];

    entry.seen.add(item.link);

    if (entry.maxId == null || item.id > entry.maxId) {
      entry.maxId = item.id;
    }
  }

  saveSeenStore(seenStore);

  const lines = ['🆕 Վերջին նոր տեղադրված հայտարարություններ՝'];

  for (const item of newest) {
    const details = await fetchItemDetails(browser, item.link);

    lines.push('');
    lines.push(`🏷️ ${item.filter.label}`);
    lines.push(`Վերնագիր: ${details.title}`);
    lines.push(`Գին: ${details.price}`);
    lines.push(`Հղում: ${item.link}`);

    if (details.description && details.description !== 'Առանց նկարագրության') {
      const shortDescription =
        details.description.length > 500
          ? `${details.description.slice(0, 500)}...`
          : details.description;

      lines.push('');
      lines.push(shortDescription);
    }
  }

  return {
    any: true,
    text: lines.join('\n'),
  };
}

async function sendToAllChats(text) {
  const maxLength = 3800;
  const chunks = [];
  const lines = text.split('\n');
  let chunk = '';

  for (const line of lines) {
    if ((chunk + '\n' + line).length > maxLength) {
      chunks.push(chunk);
      chunk = line;
      continue;
    }

    chunk = chunk ? `${chunk}\n${line}` : line;
  }

  if (chunk) {
    chunks.push(chunk);
  }

  for (const chatId of chatIds) {
    for (const part of chunks) {
      try {
        await bot.telegram.sendMessage(chatId, part, {
          disable_web_page_preview: false,
        });

        await sleep(1200);
      } catch (error) {
        console.error(
          '❌ Telegram send error:',
          error.response?.description || error.message,
          'chatId:',
          chatId
        );
      }
    }
  }
}

let isTickRunning = false;

async function tick({ force = false } = {}) {
  if (isTickRunning) {
    console.log('⏭️ Tick already running — skip');
    return;
  }

  isTickRunning = true;

  let browser;

  try {
    console.log('\n⏱ Ստուգում եմ նոր հայտարարությունները…');

    browser = await launchBrowser();

    const didWarmup = await warmupEnabledEmptyFilters(browser);

    if (didWarmup && !force) {
      console.log('↩️ Warmup finished — no messages sent');
      return;
    }

    const { any, text } = await buildNewestMessage(browser);

    if (!any) {
      console.log('😴 Նոր հայտարարություն չկա');
      return;
    }

    await sendToAllChats(text);

    console.log('✅ Tick ավարտված');
  } catch (error) {
    console.error('❌ Tick error:', error.message || error);
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }

    isTickRunning = false;
  }
}

function filtersKeyboard() {
  const rows = [];
  const allEnabled = areAllFiltersEnabled();

  rows.push([
    Markup.button.callback(
      allEnabled ? '✅ Բոլորը միացված են' : '☑️ Միացնել բոլորը',
      'toggle_all_filters'
    ),
  ]);

  for (const filter of FILTERS) {
    const enabled = settings.enabledFilters[filter.id];

    rows.push([
      Markup.button.callback(
        `${enabled ? '✅' : '⬜'} ${filter.label}`,
        `toggle_filter:${filter.id}`
      ),
    ]);
  }

  rows.push([
    // Markup.button.callback('🔄 Ստուգել հիմա', 'check_now'),
    // Markup.button.callback('📊 Կարգավիճակ', 'status'),
  ]);

  return Markup.inlineKeyboard(rows);
}

// function statusText() {
//   const enabledFilters = getEnabledFilters();

//   const filterLines = FILTERS.map(filter => {
//     const enabled = settings.enabledFilters[filter.id];
//     const entry = seenStore[filter.id];

//     return `${enabled ? '✅' : '⬜'} ${filter.label}\n   seen=${entry.seen.size}, maxId=${entry.maxId ?? 'null'}`;
//   });

//   return [
//     '📊 Բոտի կարգավիճակ',
//     '',
//     `Ակտիվ ֆիլտրեր՝ ${enabledFilters.length}/${FILTERS.length}`,
//     `Ստուգման ինտերվալ՝ ${Number(INTERVAL_MS) / 60000} րոպե`,
//     `Request delay՝ ${Number(REQUEST_DELAY_MS) / 1000} վրկ`,
//     `Նորերի սահմանափակում՝ ${
//       Number(MAX_NEW_PER_TICK) > 0 ? MAX_NEW_PER_TICK : 'անսահման'
//     }`,
//     '',
//     ...filterLines,
//   ].join('\n');
// }

bot.start(async ctx => {
  await ctx.reply(
    'Բարև 👋\nԵս հետևում եմ List.am-ի ընտրված ֆիլտրերին և ուղարկում եմ միայն նոր տեղադրված հայտարարությունները։',
    filtersKeyboard()
  );
});

bot.command('filters', async ctx => {
  await ctx.reply('Ընտրիր՝ որ ֆիլտրերը լինեն ակտիվ․', filtersKeyboard());
});

// bot.command('status', async ctx => {
//   await ctx.reply(statusText());
// });

bot.command('check', async ctx => {
  await ctx.reply('Ստուգում եմ հիմա...');
  tick({ force: true }).catch(error => {
    console.error('❌ Manual check error:', error.message || error);
  });
});

bot.action('status', async ctx => {
  await ctx.answerCbQuery();
  // await ctx.reply(statusText());
});

bot.action('check_now', async ctx => {
  await ctx.answerCbQuery('Ստուգում եմ...');
  tick({ force: true }).catch(error => {
    console.error('❌ Manual check error:', error.message || error);
  });
});

bot.action('toggle_all_filters', async ctx => {
  const allEnabled = areAllFiltersEnabled();
  const nextState = !allEnabled;

  setAllFilters(nextState);

  await ctx.answerCbQuery(
    nextState ? 'Բոլոր ֆիլտրերը միացվեցին' : 'Բոլոր ֆիլտրերը անջատվեցին'
  );

  await ctx.editMessageReplyMarkup(filtersKeyboard().reply_markup);
});

bot.action(/^toggle_filter:(.+)$/, async ctx => {
  const filterId = ctx.match[1];
  const filter = FILTERS.find(item => item.id === filterId);

  if (!filter) {
    await ctx.answerCbQuery('Ֆիլտրը չի գտնվել');
    return;
  }

  settings.enabledFilters[filterId] = !settings.enabledFilters[filterId];

  saveJson(SETTINGS_STORE_PATH, settings);

  const isEnabled = settings.enabledFilters[filterId];

  await ctx.answerCbQuery(`${filter.label}: ${isEnabled ? 'միացված է' : 'անջատված է'}`);

  await ctx.editMessageReplyMarkup(filtersKeyboard().reply_markup);
});

try {
  const me = await bot.telegram.getMe();
  console.log('🧪 getMe:', me);
} catch (error) {
  console.error('❌ getMe failed:', error.message || error);
  process.exit(1);
}

console.log(
  '🤖 List.am Bot FINAL PRODUCTION — աշխատում է, ստուգում եմ ամեն',
  Number(INTERVAL_MS) / 60000,
  'րոպեն մեկ'
);

bot.telegram
  .deleteWebhook({ drop_pending_updates: true })
  .then(() => {
    console.log('🧹 Webhook deleted / pending updates dropped');
    return bot.launch();
  })
  .then(() => {
    console.log('✅ Polling launched');
  })
  .catch(error => {
    console.error('❌ bot.launch failed:', error.message || error);
  });

tick().catch(error => {
  console.error('❌ Initial tick error:', error.message || error);
});

setInterval(() => {
  tick().catch(error => {
    console.error('❌ Tick interval error:', error.message || error);
  });
}, Number(INTERVAL_MS));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));