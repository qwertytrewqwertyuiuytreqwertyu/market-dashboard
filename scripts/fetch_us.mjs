import fs from "node:fs";
import { chromium } from "playwright";

function kstNow() {
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return d.toISOString().replace("T", " ").slice(0, 19);
}

function toNum(x) {
  if (x == null) return null;
  const s = String(x).replace(/[^\d.-]/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function fmtNum(x, d = 2) {
  return x == null ? "" : Number(x).toFixed(d);
}
function fmtPct(x) {
  return x == null ? "" : `${Number(x).toFixed(2)}%`;
}
function fmtTrillionUSD(x) {
  return x == null ? "" : `${Number(x).toFixed(2)} T USD`;
}

/**
 * Daum global quote:
 * - Prefer API endpoints
 * - If API lacks fields, fallback to scraping the page's __NEXT_DATA__ JSON
 *
 * We want: current(value), change, change_pct, date
 * Then compute prev = current - change
 */
async function fetchDaumGlobal(code /* US.SP500 / US.COMP */) {
  const referer = `https://finance.daum.net/global/quotes/${code}`;
  const headers = {
    accept: "application/json, text/plain, */*",
    "user-agent": "Mozilla/5.0",
    referer
  };

  const apiCandidates = [
    `https://finance.daum.net/api/quotes/${code}`,
    `https://finance.daum.net/api/quote/${code}`,
    `https://finance.daum.net/api/global/quotes/${code}`,
    `https://finance.daum.net/api/global/quote/${code}`,
  ];

  const pick = (obj, keys) => {
    for (const k of keys) {
      if (obj && k in obj) {
        const n = toNum(obj[k]);
        if (n != null) return n;
      }
    }
    return null;
  };

  // --- 1) Try API first
  for (const url of apiCandidates) {
    try {
      const res = await fetch(url, { headers });
      if (!res.ok) continue;
      const js = await res.json();
      const root = js?.data ?? js;

      const current =
        pick(root, ["tradePrice", "currentPrice", "price", "closePrice", "lastPrice", "indexValue"]) ??
        pick(root?.quote, ["tradePrice", "currentPrice", "price", "closePrice", "lastPrice", "indexValue"]);

      // change could be absolute diff (e.g., +3.41) stored as "changePrice" etc.
      const change =
        pick(root, ["changePrice", "change", "netChange", "changeValue"]) ??
        pick(root?.quote, ["changePrice", "change", "netChange", "changeValue"]);

      // percent could be 0.05 OR 0.05% OR -0.22 etc.
      let pct =
        pick(root, ["changeRate", "changePercent", "percentChange", "changePct"]) ??
        pick(root?.quote, ["changeRate", "changePercent", "percentChange", "changePct"]);

      // Some APIs store percent as "0.05" meaning 0.05% (already percent), others store 0.0005. We won't rely on it.
      // We'll compute pct from current & prev if possible after prev is computed.

      const date = (root?.tradeDate ?? root?.date ?? root?.quote?.tradeDate ?? root?.quote?.date ?? "").toString();

      if (current != null && change != null) {
        return { current, change, pct, date, used: "api" };
      }

      // If API gives current but no change, we still might fallback to __NEXT_DATA__
      if (current != null) {
        // keep going to fallback
        break;
      }
    } catch {}
  }

  // --- 2) Fallback: scrape __NEXT_DATA__ with Playwright (fast, no DOM clicking)
  const browser = await chromium.launch();
  const page = await browser.newPage({ userAgent: "Mozilla/5.0" });
  await page.goto(referer, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);

  const html = await page.content();
  await browser.close();

  const m = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return { current: null, change: null, pct: null, date: "", used: "none" };

  let next;
  try { next = JSON.parse(m[1]); } catch { return { current: null, change: null, pct: null, date: "", used: "none" }; }

  // Traverse and find a "quote-like" object with indexValue + change + changeRate
  const CUR_KEYS = ["tradePrice", "currentPrice", "price", "closePrice", "lastPrice", "indexValue"];
  const CHG_KEYS = ["changePrice", "change", "netChange", "changeValue"];
  const PCT_KEYS = ["changeRate", "changePercent", "percentChange", "changePct"];
  const DATE_KEYS = ["tradeDate", "date"];

  let best = { score: -1, current: null, change: null, pct: null, date: "" };

  const stack = [next];
  const seen = new Set();

  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    if (seen.has(node)) continue;
    seen.add(node);

    const current = pick(node, CUR_KEYS);
    const change = pick(node, CHG_KEYS);

    let pct = null;
    for (const k of PCT_KEYS) {
      if (node && k in node) {
        // pct could be "0.05" or "0.05%" or -0.22
        const v = node[k];
        if (typeof v === "string") {
          const n = toNum(v);
          if (n != null) { pct = n; break; }
        } else {
          const n = toNum(v);
          if (n != null) { pct = n; break; }
        }
      }
    }

    const date = (node?.tradeDate ?? node?.date ?? "").toString();

    let score = 0;
    if (current != null) score += 3;
    if (change != null) score += 3;
    if (pct != null) score += 1;
    if (date) score += 1;

    // prefer realistic ranges
    if (current != null && current >= 1000 && current <= 60000) score += 2;
    if (change != null && Math.abs(change) <= 5000) score += 1;

    if (score > best.score) best = { score, current, change, pct, date };

    if (Array.isArray(node)) {
      for (const x of node) stack.push(x);
    } else {
      for (const v of Object.values(node)) if (v && typeof v === "object") stack.push(v);
    }
  }

  return { current: best.current, change: best.change, pct: best.pct, date: best.date, used: "next_data" };
}

// NASDAQ market cap (your “download csv sum column F” definition)
async function fetchNasdaqDownloadTotalMarketCapTrillionUSD() {
  const url = "https://api.nasdaq.com/api/screener/stocks?download=true";
  const res = await fetch(url, {
    headers: {
      accept: "application/json, text/plain, */*",
      "user-agent": "Mozilla/5.0",
      referer: "https://www.nasdaq.com/market-activity/stocks/screener",
      origin: "https://www.nasdaq.com",
    },
  });
  if (!res.ok) throw new Error(`Nasdaq download failed: ${res.status}`);
  const js = await res.json();
  const rows = js?.data?.rows ?? [];

  let sum = 0;
  for (const r of rows) {
    const v = Number(String(r.marketCap ?? "").replace(/,/g, ""));
    if (Number.isFinite(v)) sum += v;
  }
  return sum / 1e12;
}

function buildRow(label, fetchedAtKst, data, marketCapTril = null) {
  const current = data.current;
  const change = data.change;

  // prev = current - change
  const prev = (current != null && change != null) ? (current - change) : null;

  // compute pct from current/prev (more reliable than whatever API gives)
  const pct = (current != null && prev != null && prev !== 0) ? ((current / prev - 1) * 100) : null;

  return {
    type: "us_index",
    code: label,
    date: data.date || "",
    value: current == null ? "" : fmtNum(current, 2),
    prev_value: prev == null ? "" : fmtNum(prev, 2),
    change: change == null ? "" : fmtNum(change, 2),
    change_pct: pct == null ? "" : fmtPct(pct),
    market_cap: marketCapTril == null ? "" : fmtTrillionUSD(marketCapTril),
    asof_kst: fetchedAtKst,
    fetched_at_kst: fetchedAtKst
  };
}

(async () => {
  const fetchedAtKst = kstNow();

  const sp = await fetchDaumGlobal("US.SP500");
  const nq = await fetchDaumGlobal("US.COMP");

  // market cap: only NASDAQ per your definition
  let nasTril = null;
  try { nasTril = await fetchNasdaqDownloadTotalMarketCapTrillionUSD(); } catch {}

  const spRow = buildRow("S&P 500", fetchedAtKst, sp, null);
  const nqRow = buildRow("NASDAQ Composite", fetchedAtKst, nq, nasTril);

  // add annotation on NASDAQ cap source
  if (nqRow.market_cap) nqRow.asof_kst = `${nqRow.asof_kst} | Nasdaq Screener download`;

  const payload = { updated_at: fetchedAtKst, rows: [spRow, nqRow] };
  fs.writeFileSync("docs/us.json", JSON.stringify(payload, null, 2), "utf-8");

  console.log("US CHECK:", payload.rows);
})();
