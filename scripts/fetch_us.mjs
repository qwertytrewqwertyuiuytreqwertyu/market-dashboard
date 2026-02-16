import fs from "node:fs";
import { chromium } from "playwright";

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
function fmtTrillionUSD(x) {
  if (x == null || !Number.isFinite(x)) return "";
  return `${x.toFixed(2)} T USD`;
}

/**
 * "Index-like" number extractor:
 * - skip date-like YYYY.MM(.DD)
 * - take first realistic index number
 */
function pickBestIndexNumber(text) {
  const s = (text || "").replace(/\s+/g, " ").trim();
  const tokens = s.match(/(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d{4,}(?:\.\d+)?|\d+\.\d+)/g) || [];
  const cands = [];
  for (const tok of tokens) {
    const t = tok.replace(/,/g, "");
    if (/^\d{4}\.\d{2}(\.\d{2})?$/.test(t)) continue; // date-like
    const n = Number(t);
    if (!Number.isFinite(n)) continue;
    if (n < 100) continue;
    cands.push(n);
  }
  if (!cands.length) return null;
  for (const n of cands) {
    if (n >= 500 && n <= 100000) return n;
  }
  return Math.max(...cands);
}

async function getDaumGlobalCurrentText(page) {
  return await page.evaluate(() => {
    const norm = s => (s || "").replace(/\s+/g, " ").trim();
    const roots = [
      document.querySelector("main"),
      document.querySelector("#__next"),
      document.querySelector("#wrap"),
      document.body
    ].filter(Boolean);

    for (const r of roots) {
      const header = r.querySelector("header");
      if (header) {
        const t = norm(header.innerText);
        if (t) return t;
      }
      const sec = r.querySelector("section");
      if (sec) {
        const t = norm(sec.innerText);
        if (t) return t;
      }
      const t = norm(r.innerText);
      if (t) return t.slice(0, 1500);
    }
    return "";
  });
}

async function getDaumGlobalPrevText(page) {
  return await page.evaluate(() => {
    const norm = s => (s || "").replace(/\s+/g, " ").trim();
    const labelText = "전일지수";
    const labelEl = Array.from(document.querySelectorAll("*"))
      .find(el => norm(el.textContent) === labelText || norm(el.textContent).includes(labelText));
    if (!labelEl) return "";

    const container =
      labelEl.closest("li, tr, dl, div, section") ||
      labelEl.parentElement ||
      document.body;

    const t = norm(container.innerText || container.textContent || "");
    return t.slice(0, 800);
  });
}

async function fetchDaumGlobalIndex(page, label, url, fetchedAtKst) {
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);

  const currentText = await getDaumGlobalCurrentText(page);
  const prevText = await getDaumGlobalPrevText(page);

  const cur = pickBestIndexNumber(currentText);

  let prev = null;
  if (prevText) {
    const idx = prevText.indexOf("전일지수");
    const after = idx >= 0 ? prevText.slice(idx + "전일지수".length) : prevText;
    prev = pickBestIndexNumber(after);
  }

  // guardrail: if prev is absurd vs cur, drop it
  if (cur != null && prev != null) {
    if (prev > cur * 10 || prev < cur / 10) prev = null;
  }

  const chg = (cur != null && prev != null) ? (cur - prev) : null;
  const pct = (cur != null && prev != null && prev !== 0) ? ((cur / prev - 1) * 100) : null;

  return {
    type: "us_index",
    code: label,
    date: "",
    value: cur == null ? "" : fmtNum(cur, 2),
    prev_value: prev == null ? "" : fmtNum(prev, 2),
    change: chg == null ? "" : fmtNum(chg, 2),
    change_pct: pct == null ? "" : fmtPct(pct),
    market_cap: "",
    asof_kst: fetchedAtKst,
    fetched_at_kst: fetchedAtKst
  };
}

/** FinanceCharts S&P500 market cap (sum Market Cap column) */
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
  await page.waitForTimeout(800);

  const { marketCaps, asofText } = await page.evaluate(() => {
    const norm = s => (s || "").replace(/\s+/g, " ").trim();
    const body = norm(document.body?.innerText || "");
    const asofMatch = body.match(/Last updated\s+([A-Za-z]{3}\s+\d{1,2},\s+\d{4})/);
    const asofText = asofMatch ? `Last updated ${asofMatch[1]}` : "";

    const tables = Array.from(document.querySelectorAll("table"));
    const target = tables.find(tb => {
      const th = Array.from(tb.querySelectorAll("th")).map(x => norm(x.innerText));
      return th.includes("Market Cap") && (th.includes("Ticker") || th.includes("Symbol"));
    });
    if (!target) return { marketCaps: [], asofText };

    const rows = Array.from(target.querySelectorAll("tbody tr"));
    const marketCaps = rows.map(tr => {
      const tds = Array.from(tr.querySelectorAll("td")).map(td => norm(td.innerText));
      // FinanceCharts table shown: Market Cap is column 4 in view (index 3)
      return tds[3] || "";
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

/**
 * NASDAQ market cap (match your Excel method):
 * - use Nasdaq screener download dataset (the same dataset behind "Download CSV")
 * - sum the MarketCap field across ALL rows (equivalent to summing column F in the CSV)
 */
async function fetchNasdaqDownloadTotalMarketCapTrillionUSD() {
  // NOTE: no exchange filter => aligns with "download CSV then sum column F" unless you apply filters on site.
  const url = "https://api.nasdaq.com/api/screener/stocks?download=true";
  const res = await fetch(url, {
    headers: {
      accept: "application/json, text/plain, */*",
      "user-agent": "Mozilla/5.0",
      referer: "https://www.nasdaq.com/market-activity/stocks/screener",
      origin: "https://www.nasdaq.com"
    }
  });
  if (!res.ok) throw new Error(`Nasdaq screener download failed: ${res.status}`);
  const js = await res.json();
  const rows = js?.data?.rows ?? [];

  let sum = 0;
  for (const r of rows) {
    const v = Number(String(r.marketCap ?? "").replace(/,/g, ""));
    if (Number.isFinite(v)) sum += v;
  }
  return sum / 1e12;
}

(async () => {
  const fetchedAtKst = kstNow();

  const browser = await chromium.launch();
  const page = await browser.newPage({ userAgent: "Mozilla/5.0" });

  // Indices (Daum)
  const spx = await fetchDaumGlobalIndex(page, "S&P 500", "https://finance.daum.net/global/quotes/US.SP500", fetchedAtKst);
  const comp = await fetchDaumGlobalIndex(page, "NASDAQ Composite", "https://finance.daum.net/global/quotes/US.COMP", fetchedAtKst);

  // S&P 500 market cap (FinanceCharts)
  try {
    const sp = await fetchFinanceChartsSP500TotalMarketCapTrillionUSD(page);
    spx.market_cap = fmtTrillionUSD(sp.trillion);
    if (sp.asofText) spx.asof_kst = `${spx.asof_kst} | FinanceCharts: ${sp.asofText}`;
  } catch {
    spx.market_cap = "";
  }

  // NASDAQ total market cap (Nasdaq download dataset, Excel-compatible sum)
  try {
    const nasTril = await fetchNasdaqDownloadTotalMarketCapTrillionUSD();
    comp.market_cap = fmtTrillionUSD(nasTril);
    comp.asof_kst = `${comp.asof_kst} | Nasdaq Screener download`;
  } catch {
    comp.market_cap = "";
  }

  await browser.close();

  const payload = { updated_at: fetchedAtKst, rows: [spx, comp] };
  fs.writeFileSync("docs/us.json", JSON.stringify(payload, null, 2), "utf-8");

  console.log("US CHECK:", payload.rows.map(r => [r.code, r.value, r.prev_value, r.change_pct, r.market_cap, r.asof_kst]));
})();
