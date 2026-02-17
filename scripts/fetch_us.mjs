import fs from "node:fs";
import { chromium } from "playwright";
import * as XLSX from "xlsx";

/* ---------- utils ---------- */
function kstNow() {
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return d.toISOString().replace("T", " ").slice(0, 19);
}
function fmtNum(x, d = 2) {
  if (x == null || !Number.isFinite(x)) return "";
  return x.toFixed(d);
}
function fmtPct(x) {
  if (x == null || !Number.isFinite(x)) return "";
  return x.toFixed(2) + "%";
}
function fmtTril(x) {
  if (x == null || !Number.isFinite(x)) return "";
  return x.toFixed(2) + " T USD";
}
function toNumLoose(v) {
  if (v == null) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/,/g, "").replace(/[^\d.-]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
function safe(obj, path) {
  try {
    return path.split(".").reduce((a, k) => (a && k in a ? a[k] : undefined), obj);
  } catch {
    return undefined;
  }
}

/* ---------- 1) Daum (Playwright -> __NEXT_DATA__) ---------- */
/**
 * We ONLY rely on page HTML (__NEXT_DATA__), not Daum API.
 * Extract:
 * - current index value
 * - change (day-over-day absolute)
 * - date (if present)
 * prev = current - change
 * pct = (current/prev - 1) * 100
 */
function extractNextDataJSON(html) {
  const m = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

function findBestQuoteInNextData(nextData, guardMin, guardMax) {
  if (!nextData || typeof nextData !== "object") return { current: null, change: null, date: "" };

  const CUR_KEYS = ["tradePrice", "currentPrice", "price", "closePrice", "lastPrice", "indexValue"];
  const CHG_KEYS = ["changePrice", "change", "netChange", "changeValue"];
  const DATE_KEYS = ["tradeDate", "date"];

  const isIdx = (n) => n != null && Number.isFinite(n) && n >= guardMin && n <= guardMax;
  const isChg = (n) => n != null && Number.isFinite(n) && Math.abs(n) <= 5000;

  let best = { score: -1, current: null, change: null, date: "" };

  const stack = [nextData];
  const seen = new Set();
  let steps = 0;

  while (stack.length && steps < 250000) {
    const node = stack.pop();
    steps++;

    if (!node || typeof node !== "object") continue;
    if (seen.has(node)) continue;
    seen.add(node);

    // pick current/change/date from this node
    let current = null;
    let change = null;
    let date = "";

    for (const k of CUR_KEYS) {
      const n = toNumLoose(node[k]);
      if (isIdx(n)) current = n;
    }
    for (const k of CHG_KEYS) {
      const n = toNumLoose(node[k]);
      if (isChg(n)) change = n;
    }
    for (const k of DATE_KEYS) {
      const v = node?.[k];
      if (typeof v === "string" || typeof v === "number") date = String(v);
    }

    let score = 0;
    if (current != null) score += 5;
    if (change != null) score += 4;
    if (date) score += 1;

    // prefer quote-like objects: current in realistic range, change small
    if (current != null && current >= (guardMin + 200) && current <= guardMax) score += 2;
    if (change != null && Math.abs(change) <= 500) score += 1;

    if (score > best.score) best = { score, current, change, date };

    // traverse
    if (Array.isArray(node)) {
      for (const x of node) stack.push(x);
    } else {
      for (const v of Object.values(node)) {
        if (v && typeof v === "object") stack.push(v);
      }
    }
  }

  return { current: best.current, change: best.change, date: best.date || "" };
}

async function fetchDaumGlobalByPage(page, code) {
  const url = `https://finance.daum.net/global/quotes/${code}`;
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);

  const html = await page.content();
  const next = extractNextDataJSON(html);

  // Guard ranges
  const guard =
    code === "US.SP500" ? { min: 1000, max: 20000 } : { min: 1000, max: 60000 };

  const { current, change, date } = findBestQuoteInNextData(next, guard.min, guard.max);

  const prev = current != null && change != null ? (current - change) : null;
  const pct = current != null && prev != null && prev !== 0 ? ((current / prev - 1) * 100) : null;

  return { current, prev, change, pct, date };
}

/* ---------- 2) NASDAQ market cap (download dataset sum) ---------- */
async function fetchNasdaqTotalTril() {
  const url = "https://api.nasdaq.com/api/screener/stocks?download=true";
  const res = await fetch(url, {
    headers: {
      accept: "application/json, text/plain, */*",
      "user-agent": "Mozilla/5.0",
      referer: "https://www.nasdaq.com/market-activity/stocks/screener",
      origin: "https://www.nasdaq.com",
    },
  });
  if (!res.ok) return null;

  const js = await res.json();
  const rows = js?.data?.rows ?? [];

  let sum = 0;
  for (const r of rows) {
    const v = Number(String(r.marketCap ?? "").replace(/,/g, ""));
    if (Number.isFinite(v)) sum += v;
  }
  return sum / 1e12;
}

/* ---------- 3) S&P500 market cap (FinanceCharts download=1 Excel) ---------- */
async function fetchSP500TotalTril() {
  const url = "https://www.financecharts.com/screener/sp-500?download=1";
  const res = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0",
      referer: "https://www.financecharts.com/screener/sp-500",
      accept: "*/*",
    },
  });
  if (!res.ok) return null;

  const buf = Buffer.from(await res.arrayBuffer());
  // If blocked and HTML comes back, XLSX.read will throw -> catch outside
  const wb = XLSX.read(buf, { type: "buffer" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true });
  if (!rows || rows.length < 2) return null;

  const header = rows[0].map((x) => String(x ?? "").toLowerCase());
  const capIdx = header.findIndex((h) => h.includes("market cap"));
  if (capIdx < 0) return null;

  let sumUsd = 0;

  for (let i = 1; i < rows.length; i++) {
    const v = rows[i]?.[capIdx];
    if (typeof v === "number" && Number.isFinite(v)) {
      sumUsd += v;
    } else if (typeof v === "string") {
      const s = v.replace(/\s+/g, "");
      const m = s.match(/^\$?([0-9,.]+)([TBM])$/i);
      if (!m) continue;
      const num = Number(m[1].replace(/,/g, ""));
      const unit = m[2].toUpperCase();
      if (!Number.isFinite(num)) continue;
      if (unit === "T") sumUsd += num * 1e12;
      if (unit === "B") sumUsd += num * 1e9;
      if (unit === "M") sumUsd += num * 1e6;
    }
  }

  return sumUsd / 1e12;
}

/* ---------- MAIN ---------- */
(async () => {
  const now = kstNow();

  // Always create BOTH rows (even if blanks) so rows never becomes []
  const spRow = {
    type: "us_index",
    code: "S&P 500",
    date: "",
    value: "",
    prev_value: "",
    change: "",
    change_pct: "",
    market_cap: "",
    asof_kst: now,
    fetched_at_kst: now,
  };

  const nqRow = {
    type: "us_index",
    code: "NASDAQ Composite",
    date: "",
    value: "",
    prev_value: "",
    change: "",
    change_pct: "",
    market_cap: "",
    asof_kst: now,
    fetched_at_kst: now,
  };

  // Daum quotes from page (__NEXT_DATA__)
  try {
    const browser = await chromium.launch();
    const page = await browser.newPage({ userAgent: "Mozilla/5.0" });

    const sp = await fetchDaumGlobalByPage(page, "US.SP500");
    spRow.date = sp.date || "";
    spRow.value = sp.current == null ? "" : fmtNum(sp.current, 2);
    spRow.prev_value = sp.prev == null ? "" : fmtNum(sp.prev, 2);
    spRow.change = sp.change == null ? "" : fmtNum(sp.change, 2);
    spRow.change_pct = sp.pct == null ? "" : fmtPct(sp.pct);

    const nq = await fetchDaumGlobalByPage(page, "US.COMP");
    nqRow.date = nq.date || "";
    nqRow.value = nq.current == null ? "" : fmtNum(nq.current, 2);
    nqRow.prev_value = nq.prev == null ? "" : fmtNum(nq.prev, 2);
    nqRow.change = nq.change == null ? "" : fmtNum(nq.change, 2);
    nqRow.change_pct = nq.pct == null ? "" : fmtPct(nq.pct);

    await browser.close();
  } catch {
    // keep blanks, but rows remain present
  }

  // Market caps (download style)
  try {
    const spTril = await fetchSP500TotalTril();
    if (spTril != null) {
      spRow.market_cap = fmtTril(spTril);
      spRow.asof_kst = `${spRow.asof_kst} | FinanceCharts download`;
    }
  } catch {
    // leave blank
  }

  try {
    const nqTril = await fetchNasdaqTotalTril();
    if (nqTril != null) {
      nqRow.market_cap = fmtTril(nqTril);
      nqRow.asof_kst = `${nqRow.asof_kst} | Nasdaq Screener download`;
    }
  } catch {
    // leave blank
  }

  const payload = {
    updated_at: now,
    rows: [spRow, nqRow],
  };

  fs.writeFileSync("docs/us.json", JSON.stringify(payload, null, 2), "utf-8");
  console.log(payload);
})();
