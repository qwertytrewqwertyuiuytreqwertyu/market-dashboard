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

/* ---------- 1) Daum US index (capture XHR JSON via Playwright) ---------- */
/**
 * Why this works:
 * - Daum often renders values via XHR after page load.
 * - Instead of parsing HTML, we wait for the JSON API response inside the browser.
 */
async function fetchDaumGlobalViaXHR(page, code) {
  const pageUrl = `https://finance.daum.net/global/quotes/${code}`;

  const isTarget = (url) =>
    url.includes("finance.daum.net/api/") &&
    (url.includes(`/quote/${code}`) || url.includes(`/quotes/${code}`) || url.includes(code));

  // Wait for the first matching JSON response after navigation
  const respPromise = page.waitForResponse(
    (r) => {
      const url = r.url();
      return isTarget(url) && r.status() === 200;
    },
    { timeout: 20000 }
  );

  await page.goto(pageUrl, { waitUntil: "domcontentloaded" });

  let js;
  try {
    const resp = await respPromise;
    js = await resp.json();
  } catch {
    return null;
  }

  const d = js?.data ?? js;

  // Common Daum fields
  const current = toNum(d?.tradePrice ?? d?.closePrice ?? d?.price ?? d?.indexValue);
  const change = toNum(d?.changePrice ?? d?.change ?? d?.changeValue);
  const date = String(d?.tradeDate ?? d?.date ?? "");

  if (current == null || change == null) return null;

  const prev = current - change;
  const pct = prev !== 0 ? ((current / prev - 1) * 100) : null;

  return { date, current, prev, change, pct };
}

/* ---------- 2) NASDAQ total market cap (download sum) ---------- */
async function fetchNasdaqTotalTril() {
  const res = await fetch("https://api.nasdaq.com/api/screener/stocks?download=true", {
    headers: {
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

/* ---------- 3) S&P500 total market cap (FinanceCharts download) ---------- */
async function fetchSP500TotalTril() {
  const res = await fetch("https://www.financecharts.com/screener/sp-500?download=1", {
    headers: {
      "user-agent": "Mozilla/5.0",
      referer: "https://www.financecharts.com/screener/sp-500",
    },
  });
  if (!res.ok) return null;

  const buf = Buffer.from(await res.arrayBuffer());
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

  // Daum values (via XHR capture)
  try {
    const browser = await chromium.launch();
    const page = await browser.newPage({ userAgent: "Mozilla/5.0" });

    const sp = await fetchDaumGlobalViaXHR(page, "US.SP500");
    if (sp) {
      spRow.date = sp.date;
      spRow.value = fmt(sp.current);
      spRow.prev_value = fmt(sp.prev);
      spRow.change = fmt(sp.change);
      spRow.change_pct = fmtPct(sp.pct);
    }

    const nq = await fetchDaumGlobalViaXHR(page, "US.COMP");
    if (nq) {
      nqRow.date = nq.date;
      nqRow.value = fmt(nq.current);
      nqRow.prev_value = fmt(nq.prev);
      nqRow.change = fmt(nq.change);
      nqRow.change_pct = fmtPct(nq.pct);
    }

    await browser.close();
  } catch {
    // keep blanks if Daum blocks, but file still writes
  }

  // Market caps (download style)
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

  const payload = { updated_at: now, rows: [spRow, nqRow] };
  fs.writeFileSync("docs/us.json", JSON.stringify(payload, null, 2), "utf-8");
  console.log(payload);
})();
