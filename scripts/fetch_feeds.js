// דרישות: node18+ (יש ב-GitHub Actions)
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

// פונקציית timeout ל-fetch
async function fetchWithTimeout(url, ms = 8000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "RSS-Aggregator/1.0 (+github)" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(id);
  }
}

// פרסינג XML -> אובייקטים פשוטים, בלי חצי עולם של ספריות:
// טריק פשוט: מושכים כותרות/לינקים/תאריכים עם regex בסיסי (עובד טוב לרוב הפידים)
// אם תרצה דיוק/שדות מתקדמים, אפשר לעבור לגרסה עם ספרייה כמו fast-xml-parser.
function parseBasicRSS(xml) {
  const items = [];
  // RSS
  const rssItems = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  for (const block of rssItems) {
    const get = (tag) => (block.match(new RegExp(`<${tag}.*?>([\\s\\S]*?)<\\/${tag}>`, "i")) || [,""])[1].trim();
    items.push({
      title: decode(get("title")),
      link: decode(get("link")),
      pubDate: decode(get("pubDate")) || decode(get("dc:date")) || "",
      summary: stripHtml(decode(get("description"))).slice(0, 280)
    });
  }
  // ATOM
  const atomEntries = xml.match(/<entry>[\s\S]*?<\/entry>/g) || [];
  for (const block of atomEntries) {
    const get = (tag) => (block.match(new RegExp(`<${tag}.*?>([\\s\\S]*?)<\\/${tag}>`, "i")) || [,""])[1].trim();
    const linkHref = (block.match(/<link[^>]*?href="([^"]+)"/i) || [,""])[1];
    items.push({
      title: decode(get("title")),
      link: decode(linkHref || get("id")),
      pubDate: decode(get("updated")) || decode(get("published")) || "",
      summary: stripHtml(decode(get("summary")) || decode(get("content"))).slice(0, 280)
    });
  }
  return items;
}

function stripHtml(s) { return s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim(); }
function decode(s) { return s.replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&#39;/g,"'"); }

async function main() {
  const feedList = readFileSync(resolve("feeds.txt"), "utf8")
    .split("\n")
    .map(l => l.trim())
    .filter(l => l && !l.startsWith("#"));

  // הגבלת מקביליות ל-6 כדי לא להיחנק
  const concurrency = 6;
  const results = [];
  const queue = [...feedList];

  async function worker() {
    while (queue.length) {
      const url = queue.shift();
      try {
        const xml = await fetchWithTimeout(url, 8000);
        const items = parseBasicRSS(xml).slice(0, 20);
        results.push(...items);
      } catch (e) {
        console.error("Feed failed:", url, e.message);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, feedList.length) }, worker));

  // מיון לפי תאריך אם יש, אחרת לפי סדר
  results.sort((a, b) => (new Date(b.pubDate).getTime() || 0) - (new Date(a.pubDate).getTime() || 0));

  const payload = {
    updatedAt: new Date().toISOString(),
    count: results.length,
    items: results.slice(0, 300) // לא נעמיס
  };

  mkdirSync(resolve("data"), { recursive: true });
  writeFileSync(resolve("data/feeds.json"), JSON.stringify(payload, null, 2), "utf8");
  console.log("Wrote data/feeds.json with", payload.count, "items");
}

await main();
