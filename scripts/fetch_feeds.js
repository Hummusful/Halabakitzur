// Node 18+ (ב־GitHub Actions יש Node 20) – ESM נתמך. להריץ: `node scripts/fetch_feeds.js`
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

// === הגדרות ===
const INPUT_LIST = resolve("feeds.txt");
const OUT_DIR = resolve("data");
const OUT_FILE = resolve("data/feeds.json");
const CONCURRENCY = 6;             // אל תעלה – דפדפנים/פרוקסי מוגבלים בכל מקרה
const TIMEOUT_MS = 9000;           // timeout לבקשה
const RETRIES = 1;                 // רה־טריי אחד
const PER_FEED_LIMIT = 40;         // כמה פריטים להשאיר מכל פיד לפני האיחוד
const GLOBAL_LIMIT = 400;          // כמה פריטים בסה״כ בקובץ המוגמר
const USER_AGENT = "RSS-Aggregator/1.0 (+github-actions; contact=maintainer@example)";

// === עזרים ===
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const stripHtml = (s="") => s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
const decodeEntities = (s="") => s
  .replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">")
  .replace(/&quot;/g,'"').replace(/&#39;/g,"'");

async function fetchWithTimeout(url, { timeout = TIMEOUT_MS, headers = {} } = {}) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': USER_AGENT, ...headers } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally { clearTimeout(id); }
}

async function tryFetch(url) {
  let lastErr;
  for (let i=0; i<=RETRIES; i++) {
    try {
      return await fetchWithTimeout(url);
    } catch (e) {
      lastErr = e;
      if (i < RETRIES) await sleep(500 + i*500);
    }
  }
  throw lastErr;
}

function parseXmlItems(xml) {
  // החילוץ מינימלי ועובד טוב לרוב ה־RSS/Atom
  const out = [];
  // RSS <item>
  const items = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
  for (const block of items) {
    const get = (tag) => (block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\/${tag}>`, "i")) || [,''])[1];
    const encUrl = (block.match(/<enclosure[^>]*url="([^"]+)"[^>]*>/i) || [,''])[1];
    const mContent = (block.match(/<media:content[^>]*url="([^"]+)"[^>]*>/i) || [,''])[1];
    out.push({
      title: decodeEntities(stripHtml(get('title')) || '(ללא כותרת)'),
      link: decodeEntities(stripHtml(get('link'))) || decodeEntities(stripHtml(get('guid'))) || '#',
      pubDate: decodeEntities(stripHtml(get('pubDate')||get('dc:date')||'')),
      summary: decodeEntities(stripHtml(get('description')||'')),
      image: mContent || encUrl || ''
    });
  }
  // Atom <entry>
  const entries = xml.match(/<entry[\s\S]*?<\/entry>/gi) || [];
  for (const block of entries) {
    const get = (tag) => (block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\/${tag}>`, "i")) || [,''])[1];
    const href = (block.match(/<link[^>]*?href="([^"]+)"/i) || [,''])[1];
    const mContent = (block.match(/<media:content[^>]*url="([^"]+)"[^>]*>/i) || [,''])[1];
    out.push({
      title: decodeEntities(stripHtml(get('title')) || '(ללא כותרת)'),
      link: decodeEntities(stripHtml(href || get('id') || '#')),
      pubDate: decodeEntities(stripHtml(get('updated')||get('published')||'')),
      summary: decodeEntities(stripHtml(get('summary')||get('content')||'')),
      image: mContent || ''
    });
  }
  return out;
}

function normalizeDate(s) { const d = new Date(s); return isNaN(d) ? 0 : d.getTime(); }
function host(u) { try { return new URL(u).host.replace(/^www\./,''); } catch { return ''; } }

async function fetchFeed(url) {
  const xml = await tryFetch(url);
  const items = parseXmlItems(xml).slice(0, PER_FEED_LIMIT);
  return items;
}

async function pool(arr, limit, fn) {
  const queue = arr.slice();
  const results = [];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      try { results.push(await fn(item)); } catch (e) { console.error('Feed failed:', item, e.message); }
    }
  });
  await Promise.all(workers);
  return results.flat();
}

async function main() {
  const feedList = readFileSync(INPUT_LIST, 'utf8')
    .split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));

  const items = await pool(feedList, CONCURRENCY, fetchFeed);

  // דה־דופליקציה: לפי (host + title) או לינק
  const seen = new Set();
  const uniq = [];
  for (const it of items) {
    const key = (it.link && it.link !== '#') ? `L|${it.link}` : `T|${host(it.link)}|${it.title}`;
    if (seen.has(key)) continue; seen.add(key); uniq.push(it);
  }

  // מיון ולימיט גלובלי
  uniq.sort((a,b) => normalizeDate(b.pubDate) - normalizeDate(a.pubDate));
  const final = uniq.slice(0, GLOBAL_LIMIT);

  // כתיבה
  mkdirSync(OUT_DIR, { recursive: true });
  const payload = { updatedAt: new Date().toISOString(), count: final.length, items: final };
  writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2), 'utf8');
  console.log(`Wrote ${OUT_FILE} with ${payload.count} items at ${payload.updatedAt}`);
}

main().catch(err => { console.error(err); process.exit(1); });