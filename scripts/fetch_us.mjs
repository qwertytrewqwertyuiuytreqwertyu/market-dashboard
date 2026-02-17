import fs from "node:fs";
import * as XLSX from "xlsx";
import { chromium } from "playwright";

/* ---------- utils ---------- */

function kstNow() {
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return d.toISOString().replace("T", " ").slice(0, 19);
}

function toNum(v) {
  if (v == null) return null;
  const n = Number(String(v).replace(/,/g, "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function fmt(x, d = 2) {
  return x == null ? "" : Number(x).toFixed(d);
}
function fmtPct(x) {
  return x == null ? "" : Number(x).toFixed(2) + "%";
}
function fmtTril(x) {
  return x == null ? "" : Number(x).toFixed(2) + " T USD";
}

/* ---------- Daum (Playwright) ---------- */
/**
 * Pulls index value and change from Daum GLOBAL quote pages using browser context.
 * Then prev = current - change, pct computed from prev/current.
 */
async function fetchDaumGlobalViaPlaywright(page, code) {
  const url = `https://finance.daum.net/global/quotes/${code}`;
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);

  const html = await page.content();

  const m = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return null;

  let next;
  try {
    next = JSON.parse(m[1]);
  } catch {
    return null;
  }

  // DFS search for a best matching object with:
  // current in plausible range, change in plausible range
  const guard = code === "US.SP500"
    ? { min: 1000, max: 20000 }
    : { min: 1000, max: 60000 };

  const CUR_KEYS = ["indexValue", "tradePrice", "currentPrice", "lastPrice", "closePrice", "price"];
  const CHG_KEYS = ["changePrice", "change", "netChange", "changeValue"];
  const DATE_KEYS = ["tradeDate", "date"];

  const isIdx = (n) => n != null && Number.isFinite(n) && n >= guard.min && n <= guard.max;
  const isChg = (n) => n != null && Number.isFinite(n) && Math.abs(n) <= 5000;

  let best = { score: -1, current: null, change: null, date: "" };
  const stack = [next];
  const seen = new Set();
  let steps = 0;

  while (stack.length && steps < 250000) {
    const node = stack.pop();
    steps++;

    if (!node || typeof node !== "object") continue;
    if (seen.has(node)) continue;
    seen.add(node);

    let current = null;
    let change = null;
    let date = "";

    for (const k of CUR_KEYS) {
      const n = toNum(node[k]);
      if (isIdx(n)) current = n;
    }
    for (const k of CHG_KEYS) {
      const n = toNum(node[k]);
      if (isChg(n)) change = n;
    }
    for (const k of DATE_KEYS) {
      const v = node?.[k];
      if (typeof v === "string" || typeof v === "number") {
        date = String(v);
        break;
      }
    }

    let score = 0;
    if (current != null) score += 6;
    if (change != null) score += 6;
    if (date) score += 1;
    if (current != null && current >= guard.min + 200 && current <= guard.max) score += 2;
    if (change != null && Math.abs(change) <= 500) score += 2;

    if (score > best.score) best = { score, current, change, date };

    if (Array.isArray(node)) {
      for (const x of node) stack.push(x);
    } else {
      for (const v of Object.values(node)) if (v && typeof v === "object") stack.push(v);
    }
  }

  if (best.current == null || best.change == null) return null;

  const prev = best.current - best.change;
  const pct = prev !== 0 ? ((best.current / prev - 1) * 100) : null;

  return {
    date: best.date || "",
    current: best.current,
    prev,
    change: best.change,
    pct
  };
}

/* ---------- NASDAQ market cap (download sum) ---------- */
async function fetchNasdaqTotalTril() {
  const res = await fetch("https://api.nasdaq.com/api/screener/stocks?download=true", {
    headers: {
      "user-agent": "Mozilla/5.0",
      referer: "https://www.nasdaq.com/market-activity/stocks/screener",
      origin: "https://www.nasdaq.com"
    }
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

/* ---------- S&P500 market cap (FinanceCharts download Excel) ---------- */
async function fetchSP500TotalTril() {
  const res = await fetch("https://www.financecharts.com/screener/sp-500?download=1", {
    headers: {
      "user-agent": "Mozilla/5.0",
      referer: "https://www.financecharts.com/screener/sp-500"
    }
  });
  if (!res.ok) return null;

  const buf = Buffer.from(await res.arrayBuffer());
  const wb = XLSX.read(buf, { type: "buffer" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true });

  if (!rows || rows.length < 2) return null;

  const header = rows[0].map(x => String(x ?? "").toLowerCase());
  const capIdx = header.findIndex(h => h.includes("market cap"));
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

  // Always output both rows (never empty)
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
    fetched_at_kst: now
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
    fetched_at_kst: now
  };

  // 1) Daum values via Playwright (fixes your blank value/prev/change/%)
  try {
    const browser = await chromium.launch();
    const page = await browser.newPage({ userAgent: "Mozilla/5.0" });

    const sp = await fetchDaumGlobalViaPlaywright(page, "US.SP500");
    if (sp) {
      spRow.date = sp.date;
      spRow.value = fmt(sp.current);
      spRow.prev_value = fmt(sp.prev);
      spRow.change = fmt(sp.change);
      spRow.change_pct = fmtPct(sp.pct);
    }

    const nq = await fetchDaumGlobalViaPlaywright(page, "US.COMP");
    if (nq) {
      nqRow.date = nq.date;
      nqRow.value = fmt(nq.current);
      nqRow.prev_value = fmt(nq.prev);
      nqRow.change = fmt(nq.change);
      nqRow.change_pct = fmtPct(nq.pct);
    }

    await browser.close();
  } catch {
    // keep blanks if Daum ever fails, but rows still exist
  }

  // 2) Market caps via downloads
  try {
    const spCap = await fetchSP500TotalTril();
    if (spCap != null) {
      spRow.market_cap = fmtTril(spCap);
      spRow.asof_kst = `${spRow.asof_kst} | FinanceCharts download`;
    } else {
      spRow.asof_kst = `${spRow.asof_kst} | FinanceCharts download (failed)`;
    }
  } catch {
    spRow.asof_kst = `${spRow.asof_kst} | FinanceCharts download (failed)`;
  }

  try {
    const nqCap = await fetchNasdaqTotalTril();
    if (nqCap != null) {
      nqRow.market_cap = fmtTril(nqCap);
      nqRow.asof_kst = `${nqRow.asof_kst} | Nasdaq Screener download`;
    } else {
      nqRow.asof_kst = `${nqRow.asof_kst} | Nasdaq Screener download (failed)`;
    }
  } catch {
    nqRow.asof_kst = `${nqRow.asof_kst} | Nasdaq Screener download (failed)`;
  }

  const payload = {
    updated_at: now,
    rows: [spRow, nqRow]
  };

  fs.writeFileSync("docs/us.json", JSON.stringify(payload, null, 2), "utf-8");
  console.log(payload);
})();
