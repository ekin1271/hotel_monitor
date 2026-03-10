const puppeteer = require('puppeteer');
const fs = require('fs');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const STATE_FILE = 'price_state.json';

const AGENCY_RULES = [
  { pattern: '103810219', name: 'PENINSULA' },
  { pattern: '103816', name: 'AKAY(FIT)' },
  { pattern: '103810175', name: 'SUMMER' },
  { pattern: '103810222', name: 'CARTHAGE' },
  { pattern: '103825', name: 'KILIT GLOBAL' },
];

function generateUrls() {
  const urls = [];
  const now = new Date();
  for (let m = 0; m < 6; m++) {
    const date = new Date(now.getFullYear(), now.getMonth() + m, 15);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const checkIn = `15.${month}.${year}`;
    const outDate = new Date(date);
    outDate.setDate(outDate.getDate() + 7);
    const outDay = String(outDate.getDate()).padStart(2, '0');
    const outMonth = String(outDate.getMonth() + 1).padStart(2, '0');
    const checkOut = `${outDay}.${outMonth}.${outDate.getFullYear()}`;
    const url = `https://www.bgoperator.ru/price.shtml?action=price&tid=211&idt=&flt2=100510000863&id_price=121110211811&data=${checkIn}&d2=${checkOut}&f7=7&f3=&f8=&ho=0&ins=0-40000-EUR&flt=100411293179&p=0100319900.0100319900`;
    urls.push({ url, checkIn });
  }
  return urls;
}

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn('Telegram ayarlari eksik');
    return;
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });
  if (!resp.ok) {
    console.error('Telegram hatasi:', resp.status, await resp.text());
  } else {
    console.log('Telegram bildirimi gonderildi.');
  }
}

async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      const distance = 500;
      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        totalHeight += distance;
        if (totalHeight >= document.body.scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 200);
      setTimeout(() => { clearInterval(timer); resolve(); }, 30000);
    });
  });
}

async function scrapePage(browser, url, checkIn) {
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36');
  await page.setViewport({ width: 1920, height: 1080 });

  console.log(`  Yukleniyor: ${checkIn}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await new Promise(r => setTimeout(r, 10000));
  await autoScroll(page);
  await new Promise(r => setTimeout(r, 5000));

  const results = await page.evaluate((agencyRules) => {
    function identifyAgency(urr) {
      const id2Match = urr.match(/id2=([^&]+)/);
      if (!id2Match) return null;
      const ids = id2Match[1].split(';');
      for (const id of ids) {
        for (const rule of agencyRules) {
          if (id.includes(rule.pattern)) return rule.name;
        }
      }
      return null;
    }

    const offers = [];
    const allRows = document.querySelectorAll('table tr');
    let currentHotel = '';

    for (const tr of allRows) {
      const hotelLink = tr.querySelector('a[href*="action=shw"]');
      if (hotelLink) {
        currentHotel = hotelLink.textContent.trim();
        continue;
      }

      const agencyLis = tr.querySelectorAll('li.s8.i_t1');
      if (agencyLis.length === 0) continue;

      const li = agencyLis[0];
      const urr = li.getAttribute('urr') || '';
      const agency = identifyAgency(urr);
      if (!agency) continue;

      // Fiyat
      const priceEl = tr.querySelector('td.c_pe b');
      if (!priceEl) continue;
      const priceRub = parseInt(priceEl.textContent.replace(/\D/g, ''));
      if (!priceRub) continue;

      // Oda adı
      const roomEl = tr.querySelector('td.c_ns');
      const roomType = roomEl ? roomEl.textContent.trim().split('\n')[0].trim() : 'UNKNOWN';

      if (currentHotel) {
        offers.push({ agency, hotelName: currentHotel, roomType, priceRub });
      }
    }
    return offers;
  }, AGENCY_RULES);

  await page.close();
  console.log(`  ${results.length} teklif bulundu.`);
  return results;
}

function analyzeOffers(checkIn, offers, prevState, newState) {
  const alerts = [];
  const groups = {};

  for (const offer of offers) {
    const key = `${checkIn}__${offer.hotelName}__${offer.roomType}`;
    if (!groups[key]) groups[key] = { hotelName: offer.hotelName, roomType: offer.roomType, peninsula: null, rivals: [] };
    if (offer.agency === 'PENINSULA') {
      if (!groups[key].peninsula || offer.priceRub < groups[key].peninsula)
        groups[key].peninsula = offer.priceRub;
    } else {
      groups[key].rivals.push({ agency: offer.agency, price: offer.priceRub });
    }
  }

  for (const [key, data] of Object.entries(groups)) {
    if (!data.peninsula || data.rivals.length === 0) continue;
    const cheapest = data.rivals.reduce((a, b) => a.price < b.price ? a : b);
    const rivalAhead = cheapest.price < data.peninsula;
    const wasAhead = prevState[key] === true;

    newState[key] = rivalAhead;

    // Sadece yeni geçişte bildir
    if (rivalAhead && !wasAhead) {
      const diff = data.peninsula - cheapest.price;
      alerts.push({
        checkIn,
        hotel: data.hotelName,
        room: data.roomType,
        peninsulaPrice: data.peninsula,
        cheapestAgency: cheapest.agency,
        cheapestPrice: cheapest.price,
        diff,
      });
    }
  }

  return alerts;
}

function buildMessage(alerts) {
  const lines = ['🚨 <b>Peninsula Fiyat Uyarisi</b>', ''];
  for (const a of alerts) {
    lines.push(`📅 ${a.checkIn}`);
    lines.push(`🏨 <b>${a.hotel}</b>`);
    lines.push(`🛏 ${a.room}`);
    lines.push(`📌 Peninsula: ${a.peninsulaPrice.toLocaleString('tr-TR')} RUB`);
    lines.push(`🏆 ${a.cheapestAgency}: ${a.cheapestPrice.toLocaleString('tr-TR')} RUB`);
    lines.push(`📉 Fark: ${a.diff.toLocaleString('tr-TR')} RUB`);
    lines.push('─────────────────');
  }
  lines.push(`\n🕐 ${new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' })}`);
  return lines.join('\n');
}

function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  }
  return {};
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

async function main() {
  console.log('Tarama basliyor...');
  const prevState = loadState();
  const newState = { ...prevState };
  const allAlerts = [];

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });

  try {
    for (const { url, checkIn } of generateUrls()) {
      console.log(`Taranan: ${checkIn}`);
      const offers = await scrapePage(browser, url, checkIn);
      const alerts = analyzeOffers(checkIn, offers, prevState, newState);
      allAlerts.push(...alerts);
    }
  } finally {
    await browser.close();
  }

  saveState(newState);
  console.log('State kaydedildi.');

  if (allAlerts.length > 0) {
    console.log(`${allAlerts.length} uyari gonderiliyor...`);
    await sendTelegram(buildMessage(allAlerts));
  } else {
    console.log('Uyari yok, Peninsula onde veya durum degismedi.');
  }
}

main().catch(async err => {
  console.error('Hata:', err.message);
  await sendTelegram(`❌ <b>Peninsula Monitor Hatasi</b>\n\n${err.message}`).catch(() => {});
  process.exit(1);
});
