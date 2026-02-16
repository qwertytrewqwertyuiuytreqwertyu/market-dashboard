import fs from "node:fs";
import { chromium } from "playwright";

function kstNow() {
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return d.toISOString().replace("T", " ").slice(0, 19);
}

function pickIndexNumber(text) {
  // Reject YYYY.MM patterns and pick the first "index-like" number:
  // - must be >= 100 (indices), and
  // - must not look like 2026.02 or 2026.02.13 (date-ish)
  if (!text) return null;
  const tokens = String(text).match(/(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+\.\d+|\d{3,})/g);
  if (!tokens) return null;

  for (const tok of tokens) {
    const t = tok.replace(/,/g, "");
    // Skip date-ish patterns like 2026.02 or 2026.02.13
    if (/^\d{4}\.\d{2}(\.\d{2})?$/.test(t)) continue;

    const n = Number(t);
    if (Number.isFinite(n) && n >= 100) return n;
  }
  return null;
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

/** DOM-based fetch of current index + previous index (전일지수) */
async function fetchDaumGlobalIndex(page, label, url, fetchedAtKst) {
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);

  // 1) current index: prefer the main quote header area
  const current = await page.evaluate(() => {
    const norm = s => (s || "").replace(/\s+/g, " ").trim();
    // try common containers
    const main =
      document.querySelector("main") ||
      document.querySelector("#__next") ||
      document.querySelector("#wrap") ||
      document.body;

    // Prefer a small region: top area often contains the quote
    const header =
      main.querySelector("header") ||
      main.querySelector("section") ||
      main;

    return norm(header?.innerText || "");
  });

  const cur = pickIndexNumber(current);

  // 2) previous index: find "전일지수" label and extract the numeric next to it
  const prevBlock = await page.evaluate(() => {
    const norm = s => (s || "").replace(/\s+/g, " ").trim();
    const labelText = "전일지수";

    const labelEl = Array.from(document.querySelectorAll("*"))
      .find(el => norm(el.textContent) === labelText || norm(el.textContent).includes(labelText));
    if (!labelEl) return "";

    const container = labelEl.closest("li, tr, dl, div, section") || labelEl.parentElement || document.body;
    return norm(container.innerText || container.textContent || "");
  });

  // Try to extract a number AFTER the "전일지수" word
  let prev = null;
  if (prevBlock) {
    const idx = prevBlock.indexOf("전일지수");
    const after = idx >= 0 ? prevBlock.slice(idx + "전일지수".length) : prevBlock;
    prev = pickIndexNumber(after);
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
    trade_value: "",
    personal: "",
    foreign: "",
    institution: "",
    asof_kst: fetchedAtKst,
    fetched_at_kst: fetchedAtKst
  };
}

/** NASDAQ total market cap (Nasdaq screener API) */
async function fetchNasdaqTotalMarketCapTrillionUSD() {
  const url = "https://api.nasdaq.com/api/screener/stocks?download=true&exchange=nasdaq";
  const res = await fetch(url, {
    headers: {
      "accept": "application/json, text/plain, */*",
      "user-agent": "Mozilla/5.0",
      "referer": "https://www.nasdaq.com/market-activity/stocks/screener",
      "origin": "https://www.nasdaq.com"
    }
  });
  if (!res.ok) throw new Error(`Nasdaq API failed: ${res.status}`);
  const js = await res.json();
  const rows = js?.data?.rows ?? [];

  let sum = 0;
  for (const r of rows) {
    const v = Number(String(r.marketCap ?? "").replace(/,/g, ""));
    if (Number.isFinite(v)) sum += v;
  }
  return sum / 1e12;
}

/** FinanceCharts S&P 500 market cap (sum Market Cap column) */
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
  const url = "https://www.financecharts.com/screener/sp-500";
  await page.goto(url, { waitUntil: "networkidle" });
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
      return tds[3] || ""; // Market Cap column
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

(async () => {
  const fetchedAtKst = kstNow();

  const browser = await chromium.launch();
  const page = await browser.newPage({ userAgent: "Mozilla/5.0" });

  const spx = await fetchDaumGlobalIndex(page, "S&P 500", "https://finance.daum.net/global/quotes/US.SP500", fetchedAtKst);
  const comp = await fetchDaumGlobalIndex(page, "NASDAQ Composite", "https://finance.daum.net/global/quotes/US.COMP", fetchedAtKst);

  try {
    const sp = await fetchFinanceChartsSP500TotalMarketCapTrillionUSD(page);
    spx.market_cap = fmtTrillionUSD(sp.trillion);
    if (sp.asofText) spx.asof_kst = `${spx.asof_kst} | FinanceCharts: ${sp.asofText}`;
  } catch {
    spx.market_cap = "";
  }

  try {
    const nasTril = await fetchNasdaqTotalMarketCapTrillionUSD();
    comp.market_cap = fmtTrillionUSD(nasTril);
  } catch {
    comp.market_cap = "";
  }

  await browser.close();

  const payload = { updated_at: fetchedAtKst, rows: [spx, comp] };
  fs.writeFileSync("docs/us.json", JSON.stringify(payload, null, 2), "utf-8");
  console.log("Updated docs/us.json");
})();
