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
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) { console.log(text); return; }
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  if (!resp.ok) console.error('Telegram hatasi:', resp.status, await resp.text());
  else console.log('Telegram bildirimi gonderildi.');
}

async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      const distance = 500;
      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        totalHeight += distance;
        if (totalHeight >= document.body.scrollHeight) { clearInterval(timer); resolve(); }
      }, 200);
      setTimeout(() => { clearInterval(timer); resolve(); }, 30000);
    });
  });
}

// Arkadaşın kodundaki gibi birebir aynı scraping
async function scrapePage(browser, targetUrl, checkIn) {
  console.log(`  Yukleniyor: ${checkIn}`);
  const browser2 = browser;
  const page = await browser2.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await page.setViewport({ width: 1920, height: 1080 });

  try {
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 90000 });
  } catch(e) {
    console.log(`  Timeout, devam ediliyor...`);
  }
  await new Promise(r => setTimeout(r, 5000));
  await autoScroll(page);
  await new Promise(r => setTimeout(r, 5000));

  const urlDateMatch = targetUrl.match(/data=(\d{2}\.\d{2}\.\d{4})/);
  const targetDate = urlDateMatch ? urlDateMatch[1] : null;

  // Arkadaşın page.evaluate kodu - birebir aynı
  const agencyRulesStr = JSON.stringify(AGENCY_RULES);
  const results = await page.evaluate((agencyRulesStr, targetDate) => {
    const agencyRules = JSON.parse(agencyRulesStr);

    function identifyAgency(id) {
      for (const rule of agencyRules) {
        if (id.includes(rule.pattern)) return rule.name;
      }
      return 'BILINMEYEN';
    }

    const offers = [];
    const allRows = document.querySelectorAll('table tr');
    let currentHotel = '';

    for (const tr of allRows) {
      const hotelLink = tr.querySelector('a[href*="action=shw"]');
      if (hotelLink) {
        currentHotel = hotelLink.textContent.trim();
      }

      const agencyLis = tr.querySelectorAll('li.s8.i_t1');
      if (agencyLis.length === 0) continue;

      let matchedLi = null;
      for (const li of agencyLis) {
        const urr = li.getAttribute('urr') || '';
        if (targetDate && urr.includes(targetDate)) { matchedLi = li; break; }
      }
      if (!matchedLi) matchedLi = agencyLis[0];

      const urr = matchedLi.getAttribute('urr') || '';
      const idMatch = urr.match(/id=(\d+)/);
      if (!idMatch) continue;

      const agencyId = idMatch[1];
      const agency = identifyAgency(agencyId);

      let priceRub = null;
      const buyLink = tr.querySelector('a[href*="/zaya"]');
      if (buyLink) {
        const trText = tr.textContent;
        const rubMatches = trText.match(/([\d\s]{4,})\s*р\./g);
        if (rubMatches) {
          for (const m of rubMatches) {
            const numMatch = m.match(/([\d\s]+)/);
            if (numMatch) {
              const val = parseInt(numMatch[1].replace(/\s/g, ''), 10);
              if (val > 1000) { priceRub = val; break; }
            }
          }
        }
      }

      let roomType = 'UNKNOWN';
      const trText = tr.textContent;
      const roomMatch = trText.match(/((?:STANDARD|FAMILY|ECO|RELAX|DELUXE|SUITE|SUPERIOR|BUNGALOW|STD|SINGLE|DOUBLE|TRIPLE|ECONOMY|COMFORT|PREMIUM|CLUB|GARDEN|SEA VIEW|POOL|APARTMENT)[\w\s().,\/-]*?(?:BB|HB|FB|AI|UAI|RO|AO))/i);
      if (roomMatch) roomType = roomMatch[1].trim();

      if (priceRub && currentHotel) {
        offers.push({ agency, hotelName: currentHotel, roomType, priceRub });
      }
    }
    return offers;
  }, agencyRulesStr, targetDate);

  await page.close();
  console.log(`  ${results.length} teklif bulundu.`);
  for (const o of results) {
    console.log(`    [${o.agency}] ${o.hotelName} | ${o.roomType} | ${o.priceRub} RUB`);
  }
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
    } else if (offer.agency !== 'BILINMEYEN') {
      groups[key].rivals.push({ agency: offer.agency, price: offer.priceRub });
    }
  }

  for (const [key, data] of Object.entries(groups)) {
    if (!data.peninsula || data.rivals.length === 0) continue;
    const cheapest = data.rivals.reduce((a, b) => a.price < b.price ? a : b);
    const rivalAhead = cheapest.price < data.peninsula;
    const wasAhead = prevState[key] === true;
    newState[key] = rivalAhead;

    if (rivalAhead && !wasAhead) {
      const diff = data.peninsula - cheapest.price;
      alerts.push({ checkIn, hotel: data.hotelName, room: data.roomType, peninsulaPrice: data.peninsula, cheapestAgency: cheapest.agency, cheapestPrice: cheapest.price, diff });
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
  if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
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
