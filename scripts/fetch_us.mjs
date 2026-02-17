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
function calc(cur, prev) {
  if (cur == null || prev == null || prev === 0) return { chg: null, pct: null };
  const chg = cur - prev;
  const pct = (cur / prev - 1) * 100;
  return { chg, pct };
}

/* ------------------------------
   Daum API (best-effort)
-------------------------------- */
async function daumApiQuote(code) {
  const candidates = [
    `https://finance.daum.net/api/quotes/${code}`,
    `https://finance.daum.net/api/quote/${code}`,
    `https://finance.daum.net/api/global/quotes/${code}`,
    `https://finance.daum.net/api/global/quote/${code}`,
  ];

  const headers = {
    accept: "application/json, text/plain, */*",
    "user-agent": "Mozilla/5.0",
    referer: `https://finance.daum.net/global/quotes/${code}`,
  };

  const pick = (obj, keys) => {
    for (const k of keys) {
      if (obj && k in obj) {
        const n = toNum(obj[k]);
        if (n != null) return n;
      }
    }
    return null;
  };

  for (const url of candidates) {
    try {
      const res = await fetch(url, { headers });
      if (!res.ok) continue;
      const js = await res.json();
      const root = js?.data ?? js;

      const cur =
        pick(root, ["tradePrice", "currentPrice", "price", "closePrice", "lastPrice", "indexValue"]) ??
        pick(root?.quote, ["tradePrice", "currentPrice", "price", "closePrice", "lastPrice", "indexValue"]);

      const prev =
        pick(root, ["prevTradePrice", "prevPrice", "previousPrice", "prevClosePrice", "prevIndexValue", "yesterdayPrice"]) ??
        pick(root?.quote, ["prevTradePrice", "prevPrice", "previousPrice", "prevClosePrice", "prevIndexValue", "yesterdayPrice"]);

      const date = (root?.tradeDate ?? root?.date ?? root?.quote?.tradeDate ?? root?.quote?.date ?? "").toString();

      if (cur != null) return { ok: true, cur, prev, date };
    } catch {}
  }
  return { ok: false, cur: null, prev: null, date: "" };
}

/* ------------------------------
   Daum DOM fallback (label-based, improved prev extraction)
-------------------------------- */
async function daumDomQuote(page, code) {
  await page.goto(`https://finance.daum.net/global/quotes/${code}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);

  // current: from "현재지수" block
  const curStr = await page.evaluate(() => {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
    const label = "현재지수";
    const el = Array.from(document.querySelectorAll("*"))
      .find(x => norm(x.textContent) === label || norm(x.textContent).includes(label));
    if (!el) return null;

    const box = el.closest("dl, li, div, section, article") || el.parentElement;
    if (!box) return null;

    const t = norm(box.innerText || "");
    const idx = t.indexOf(label);
    const after = idx >= 0 ? t.slice(idx + label.length) : t;
    const m = after.match(/(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+))/);
    return m ? m[1] : null;
  });

  const cur = toNum(curStr);

  // prev: choose number in "전일지수" container closest to current (prevents huge wrong numbers)
  const prev = await page.evaluate((curVal) => {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
    const label = "전일지수";
    const el = Array.from(document.querySelectorAll("*"))
      .find(x => norm(x.textContent) === label || norm(x.textContent).includes(label));
    if (!el) return null;

    const box = el.closest("dl, li, div, section, article") || el.parentElement;
    if (!box) return null;

    // extract ALL numbers inside that box
    const txt = norm(box.innerText || "");
    const nums = (txt.match(/(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+))/g) || [])
      .map(s => Number(s.replace(/,/g, "")))
      .filter(n => Number.isFinite(n) && n >= 100 && n <= 200000);

    if (!nums.length) return null;
    if (!Number.isFinite(curVal)) return nums[0];

    // pick number closest to current (prev should be near current)
    let best = nums[0];
    let bestDiff = Math.abs(nums[0] - curVal);
    for (const n of nums) {
      const d = Math.abs(n - curVal);
      if (d < bestDiff) { best = n; bestDiff = d; }
    }
    return best;
  }, cur);

  // date (best-effort)
  const date = await page.evaluate(() => {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
    const body = norm(document.body?.innerText || "");
    const m =
      body.match(/\b(\d{8})\b/) || // 20260213 같은 형태도 잡힘
      body.match(/\b(\d{4}\.\d{2}\.\d{2})\b/) ||
      body.match(/\b(\d{2}\.\d{2}\.\d{2})\b/);
    return m ? m[1] : "";
  });

  return { cur, prev: toNum(prev), date };
}

/* ------------------------------
   Market cap helpers
-------------------------------- */
function parseUsdWithUnitToNumber(s) {
  if (!s) return null;
  const t = String(s).replace(/\s+/g, "").replace("$", "");
  const m = t.match(/^([0-9,.]+)([TBM])$/i) || t.match(/^([0-9,.]+)$/);
  if (!m) return null;

  const val = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(val)) return null;

  const unit = (m[2] || "").toUpperCase();
  if (unit === "T") return val * 1e12;
  if (unit === "B") return val * 1e9;
  if (unit === "M") return val * 1e6;
  return val;
}

async function fetchFinanceChartsSP500TotalMarketCapTrillionUSD(page) {
  await page.goto("https://www.financecharts.com/screener/sp-500", { waitUntil: "networkidle" });
  await page.waitForTimeout(2500);

  const { marketCaps, asofText } = await page.evaluate(() => {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
    const body = norm(document.body?.innerText || "");
    const asofMatch = body.match(/Last updated\s+([A-Za-z]{3}\s+\d{1,2},\s+\d{4})/);
    const asofText = asofMatch ? `Last updated ${asofMatch[1]}` : "";

    const tables = Array.from(document.querySelectorAll("table"));
    let target = null;
    for (const tb of tables) {
      const th = Array.from(tb.querySelectorAll("th")).map((x) => norm(x.innerText));
      if (th.includes("Market Cap")) { target = tb; break; }
    }
    if (!target) return { marketCaps: [], asofText };

    const th = Array.from(target.querySelectorAll("th")).map((x) => norm(x.innerText));
    const iCap = th.findIndex((x) => x === "Market Cap");
    if (iCap < 0) return { marketCaps: [], asofText };

    const rows = Array.from(target.querySelectorAll("tbody tr"));
    const marketCaps = rows.map(tr => {
      const tds = Array.from(tr.querySelectorAll("td")).map(td => norm(td.innerText));
      return tds[iCap] || "";
    }).filter(Boolean);

    return { marketCaps, asofText };
  });

  let sumUsd = 0;
  for (const mc of marketCaps) {
    const n = parseUsdWithUnitToNumber(mc);
    if (Number.isFinite(n)) sumUsd += n;
  }
  return { trillion: sumUsd / 1e12, asofText };
}

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

/* ------------------------------
   Main
-------------------------------- */
async function fetchDaumIndex(code, fetchedAtKst, page) {
  const api = await daumApiQuote(code);
  let cur = api.ok ? api.cur : null;
  let prev = api.ok ? api.prev : null;
  let date = api.ok ? api.date : "";

  if (cur == null || prev == null) {
    const dom = await daumDomQuote(page, code);
    cur = cur ?? dom.cur;
    prev = prev ?? dom.prev;
    date = date || dom.date || "";
  }

  const guard =
    code === "US.SP500"
      ? (n) => n != null && n >= 1000 && n <= 20000
      : (n) => n != null && n >= 1000 && n <= 60000;

  if (!guard(cur)) cur = null;
  if (!guard(prev)) prev = null;

  const { chg, pct } = calc(cur, prev);

  return {
    type: "us_index",
    code: code === "US.SP500" ? "S&P 500" : "NASDAQ Composite",
    date: date || "",
    value: cur == null ? "" : fmtNum(cur, 2),
    prev_value: prev == null ? "" : fmtNum(prev, 2),
    change: chg == null ? "" : fmtNum(chg, 2),
    change_pct: pct == null ? "" : fmtPct(pct),
    market_cap: "",
    asof_kst: fetchedAtKst,
    fetched_at_kst: fetchedAtKst,
  };
}

(async () => {
  const fetchedAtKst = kstNow();

  const browser = await chromium.launch();
  const page = await browser.newPage({ userAgent: "Mozilla/5.0" });

  const spx = await fetchDaumIndex("US.SP500", fetchedAtKst, page);
  const comp = await fetchDaumIndex("US.COMP", fetchedAtKst, page);

  try {
    const sp = await fetchFinanceChartsSP500TotalMarketCapTrillionUSD(page);
    if (sp.trillion > 0) spx.market_cap = fmtTrillionUSD(sp.trillion);
    if (sp.asofText) spx.asof_kst = `${spx.asof_kst} | FinanceCharts: ${sp.asofText}`;
  } catch {}

  try {
    const nasTril = await fetchNasdaqDownloadTotalMarketCapTrillionUSD();
    comp.market_cap = fmtTrillionUSD(nasTril);
    comp.asof_kst = `${comp.asof_kst} | Nasdaq Screener download`;
  } catch {}

  await browser.close();

  const payload = { updated_at: fetchedAtKst, rows: [spx, comp] };
  fs.writeFileSync("docs/us.json", JSON.stringify(payload, null, 2), "utf-8");

  console.log("US RESULT:", payload.rows);
})();
