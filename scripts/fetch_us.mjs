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

function pickIndex(text) {
  // pick first index-looking number (>= 100), skip YYYY.MM
  const s = (text || "").replace(/\s+/g, " ").trim();
  const tokens =
    s.match(/(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d{4,}(?:\.\d+)?|\d+\.\d+)/g) || [];
  const cands = [];
  for (const tok of tokens) {
    const t = tok.replace(/,/g, "");
    if (/^\d{4}\.\d{2}(\.\d{2})?$/.test(t)) continue;
    const n = Number(t);
    if (!Number.isFinite(n) || n < 100) continue;
    cands.push(n);
  }
  if (!cands.length) return null;
  // prefer realistic index ranges
  for (const n of cands) if (n >= 1000 && n <= 100000) return n;
  for (const n of cands) if (n >= 500 && n <= 100000) return n;
  return cands[0];
}

async function fetchDaumIndexExact(page, label, url, fetchedAtKst) {
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);

  // current: try to target only the main quote box by limiting to the first "section"
  const currentText = await page.evaluate(() => {
    const norm = s => (s || "").replace(/\s+/g, " ").trim();
    const root =
      document.querySelector("main") ||
      document.querySelector("#__next") ||
      document.querySelector("#wrap") ||
      document.body;

    // Prefer: first section that contains "전일지수" (often quote card area)
    const secs = Array.from(root.querySelectorAll("section"));
    for (const s of secs) {
      const t = norm(s.innerText);
      if (t.includes("전일지수") || t.includes("전일")) return t;
    }
    // fallback: header + small slice
    const header = root.querySelector("header");
    if (header) return norm(header.innerText);
    return norm(root.innerText).slice(0, 1200);
  });

  // prev: STRICTLY from the "전일지수" container
  const prevText = await page.evaluate(() => {
    const norm = s => (s || "").replace(/\s+/g, " ").trim();
    const labelText = "전일지수";

    const labelEl = Array.from(document.querySelectorAll("*"))
      .find(el => norm(el.textContent) === labelText || norm(el.textContent).includes(labelText));
    if (!labelEl) return "";

    // try sibling first (often the value is next to label)
    const parent = labelEl.parentElement;
    if (parent) {
      const sibText = norm(parent.innerText || "");
      if (sibText) return sibText.slice(0, 300);
    }

    const box =
      labelEl.closest("li, tr, dl, div, section") ||
      labelEl.parentElement ||
      document.body;

    return norm(box.innerText || "").slice(0, 500);
  });

  const cur = pickIndex(currentText);

  let prev = null;
  if (prevText) {
    const idx = prevText.indexOf("전일지수");
    const after = idx >= 0 ? prevText.slice(idx + "전일지수".length) : prevText;
    prev = pickIndex(after);
  }

  // guardrail: drop absurd prev
  if (cur != null && prev != null) {
    if (prev > cur * 1.5 || prev < cur * 0.5) prev = null;
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

/* ===== NASDAQ Screener download total market cap (your CSV method) ===== */
async function fetchNasdaqDownloadTotalMarketCapTrillionUSD() {
  const url = "https://api.nasdaq.com/api/screener/stocks?download=true";
  const res = await fetch(url, {
    headers: {
      accept: "application/json, text/plain, */*",
      "user-agent": "Mozilla/5.0",
      referer: "https://www.nasdaq.com/market-activity/stocks/screener",
      origin: "https://www.nasdaq.com"
    }
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

/* ===== FinanceCharts S&P500 market cap (robust: wait + scroll + multi-table hunt) ===== */
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

  // wait longer; site is often lazy-loaded
  await page.waitForTimeout(2500);
  await page.mouse.wheel(0, 2500);
  await page.waitForTimeout(1200);

  const res = await page.evaluate(() => {
    const norm = s => (s || "").replace(/\s+/g, " ").trim();
    const body = norm(document.body?.innerText || "");
    const asofMatch = body.match(/Last updated\s+([A-Za-z]{3}\s+\d{1,2},\s+\d{4})/);
    const asofText = asofMatch ? `Last updated ${asofMatch[1]}` : "";

    const tables = Array.from(document.querySelectorAll("table"));

    // find any table that has a "Market Cap" header
    let target = null;
    for (const tb of tables) {
      const th = Array.from(tb.querySelectorAll("th")).map(x => norm(x.innerText));
      if (th.includes("Market Cap")) {
        target = tb;
        break;
      }
    }

    if (!target) return { marketCaps: [], asofText, debug: "no table with Market Cap header" };

    const th = Array.from(target.querySelectorAll("th")).map(x => norm(x.innerText));
    const iCap = th.findIndex(x => x === "Market Cap");
    if (iCap < 0) return { marketCaps: [], asofText, debug: "Market Cap header not found index" };

    const rows = Array.from(target.querySelectorAll("tbody tr"));
    const marketCaps = rows.map(tr => {
      const tds = Array.from(tr.querySelectorAll("td")).map(td => norm(td.innerText));
      return tds[iCap] || "";
    }).filter(Boolean);

    return { marketCaps, asofText, debug: `rows=${marketCaps.length}` };
  });

  let sumUsd = 0;
  for (const mc of res.marketCaps) {
    const n = parseUsdWithUnitToNumber(mc);
    if (Number.isFinite(n)) sumUsd += n;
  }

  return { trillion: sumUsd / 1e12, asofText: res.asofText, debug: res.debug };
}

(async () => {
  const fetchedAtKst = kstNow();

  const browser = await chromium.launch();
  const page = await browser.newPage({ userAgent: "Mozilla/5.0" });

  // Daum indices
  const spx = await fetchDaumIndexExact(page, "S&P 500", "https://finance.daum.net/global/quotes/US.SP500", fetchedAtKst);
  const comp = await fetchDaumIndexExact(page, "NASDAQ Composite", "https://finance.daum.net/global/quotes/US.COMP", fetchedAtKst);

  // S&P 500 market cap
  try {
    const sp = await fetchFinanceChartsSP500TotalMarketCapTrillionUSD(page);
    if (sp.trillion > 0) spx.market_cap = fmtTrillionUSD(sp.trillion);
    if (sp.asofText) spx.asof_kst = `${spx.asof_kst} | FinanceCharts: ${sp.asofText}`;
    console.log("SP500 MC DEBUG:", sp.debug, "tril=", sp.trillion);
  } catch (e) {
    console.log("SP500 MC ERROR:", String(e));
    spx.market_cap = "";
  }

  // NASDAQ market cap (download dataset sum)
  try {
    const nasTril = await fetchNasdaqDownloadTotalMarketCapTrillionUSD();
    comp.market_cap = fmtTrillionUSD(nasTril);
    comp.asof_kst = `${comp.asof_kst} | Nasdaq Screener download`;
  } catch (e) {
    console.log("NASDAQ MC ERROR:", String(e));
    comp.market_cap = "";
  }

  await browser.close();

  const payload = { updated_at: fetchedAtKst, rows: [spx, comp] };
  fs.writeFileSync("docs/us.json", JSON.stringify(payload, null, 2), "utf-8");

  console.log("US CHECK:", payload.rows.map(r => [r.code, r.value, r.prev_value, r.change_pct, r.market_cap, r.asof_kst]));
})();
