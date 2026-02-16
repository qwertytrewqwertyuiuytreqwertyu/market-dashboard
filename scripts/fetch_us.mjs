import fs from "node:fs";
import { chromium } from "playwright";

/** ---------- time ---------- */
function kstTimestamp() {
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return d.toISOString().replace("T", " ").slice(0, 19);
}

/** ---------- helpers ---------- */
function numFromTextAny(s) {
  if (!s) return null;
  const m = String(s).match(/(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+\.\d+|\d{4,})/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}
function fmtNum(x, decimals = 2) {
  if (x == null || !Number.isFinite(x)) return "";
  return x.toFixed(decimals);
}
function fmtPct(x) {
  if (x == null || !Number.isFinite(x)) return "";
  return x.toFixed(2) + "%";
}
function fmtTrillionUSD(x) {
  if (x == null || !Number.isFinite(x)) return "";
  return `${x.toFixed(2)} T USD`;
}

/** ---------- Daum global index (DOM-based with “전일지수”) ---------- */
async function fetchDaumGlobalIndexWithPrev(page, label, url, fetchedAtKst) {
  await page.goto(url, { waitUntil: "networkidle" });

  // Current: pick a reliable “big number” from the quote header area using DOM text (not full-page scan)
  const curText = await page.evaluate(() => {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();

    // Try common quote containers first
    const root =
      document.querySelector("main") ||
      document.querySelector("#__next") ||
      document.querySelector("#wrap") ||
      document.body;

    const t = norm(root?.innerText || "");
    const m = t.match(/(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+\.\d+|\d{4,})/);
    return m ? m[1] : "";
  });
  const cur = numFromTextAny(curText);

  // Previous: find “전일지수” and extract numeric value near it (DOM walk)
  const prevBlockText = await page.evaluate(() => {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
    const labelText = "전일지수";

    const labelEl = Array.from(document.querySelectorAll("*"))
      .find(el => norm(el.textContent) === labelText || norm(el.textContent).includes(labelText));
    if (!labelEl) return "";

    const container = labelEl.closest("li, tr, dl, div, section") || labelEl.parentElement;
    if (!container) return "";

    // return text after label if possible
    const t = norm(container.innerText || container.textContent || "");
    const i = t.indexOf(labelText);
    return i >= 0 ? t.slice(i + labelText.length) : t;
  });
  const prev = numFromTextAny(prevBlockText);

  // If the “전일지수” block contains a date, store it in date column
  const prevDateMatch = String(prevBlockText || "").match(/(\d{4}\.\d{2}\.\d{2}|\d{2}\.\d{2}\.\d{2})/);
  const prevDate = prevDateMatch ? prevDateMatch[1] : "";

  const chg = (cur != null && prev != null) ? (cur - prev) : null;
  const pct = (cur != null && prev != null && prev !== 0) ? ((cur / prev - 1) * 100) : null;

  return {
    type: "us_index",
    code: label,
    date: prevDate,
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

/** ---------- NASDAQ total market cap (sum like “download csv F column”) ----------
 * Nasdaq’s screener data is served from api.nasdaq.com.
 * We sum r.marketCap across rows (USD) and convert to trillion.
 */
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

/** ---------- S&P 500 total market cap (FinanceCharts: “download excel D column”) ----------
 * We read the table and sum the Market Cap column (4th column typically).
 * Values are like "$4.46T" / "$435.6B" etc → convert to USD → sum → trillion.
 */
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

  const { marketCaps, asofText } = await page.evaluate(() => {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
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
      // D column logic: Name, Ticker, Sector, Market Cap (index 3)
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

/** ---------- MAIN ---------- */
(async () => {
  const fetchedAtKst = kstTimestamp();

  const browser = await chromium.launch();
  const page = await browser.newPage({ userAgent: "Mozilla/5.0" });

  // 1) Index levels from Daum global quotes
  const spx = await fetchDaumGlobalIndexWithPrev(
    page,
    "S&P 500",
    "https://finance.daum.net/global/quotes/US.SP500",
    fetchedAtKst
  );

  const comp = await fetchDaumGlobalIndexWithPrev(
    page,
    "NASDAQ Composite",
    "https://finance.daum.net/global/quotes/US.COMP",
    fetchedAtKst
  );

  // 2) Market cap add-ons (daily)
  // S&P500 total market cap (FinanceCharts)
  try {
    const sp = await fetchFinanceChartsSP500TotalMarketCapTrillionUSD(page);
    spx.market_cap = fmtTrillionUSD(sp.trillion);
    if (sp.asofText) spx.asof_kst = `${spx.asof_kst} | FinanceCharts: ${sp.asofText}`;
  } catch {
    spx.market_cap = "";
  }

  // NASDAQ total market cap (Nasdaq screener)
  try {
    const nasTril = await fetchNasdaqTotalMarketCapTrillionUSD();
    comp.market_cap = fmtTrillionUSD(nasTril);
    // asof remains fetchedAtKst (daily snapshot)
  } catch {
    comp.market_cap = "";
  }

  await browser.close();

  const payload = {
    updated_at: fetchedAtKst,
    rows: [spx, comp]
  };

  fs.writeFileSync("docs/us.json", JSON.stringify(payload, null, 2), "utf-8");
  console.log("Updated docs/us.json rows:", payload.rows.length);
})();
