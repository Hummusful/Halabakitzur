import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(cors());

const TTL_MS = Number(process.env.CACHE_TTL_MS || 120_000);
const MAX_SIZE = Number(process.env.CACHE_MAX || 200);
const cache = new Map(); // key -> { t, body }

// ניקוי קאש בסיסי
function setCache(key, body) {
  if (cache.size >= MAX_SIZE) {
    // מחיקת הערך הישן ביותר
    const firstKey = cache.keys().next().value;
    cache.delete(firstKey);
  }
  cache.set(key, { t: Date.now(), body });
}

function getCache(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.t > TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.body;
}

// פרוקסי: /proxy?url=https://example.com/feed.xml
app.get("/proxy", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: "missing url param" });

  try {
    const key = url;
    const cached = getCache(key);
    if (cached) {
      return res.json({ contents: cached, cached: true });
    }

    const r = await fetch(url, {
      // חשוב לכמה אתרים שמבקשים user-agent
      headers: { "user-agent": "rss-proxy/1.0 (+heroku)" },
      timeout: 15000
    });
    if (!r.ok) return res.status(r.status).json({ error: `upstream ${r.status}` });

    const text = await r.text();
    setCache(key, text);
    res.json({ contents: text, cached: false });
  } catch (e) {
    res.status(502).json({ error: String(e) });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log("listening on", port));
