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

// ---------- Robust extraction from Next.js __NEXT_DATA__ ----------
function extractNextDataJSON(html) {
  const m = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

// Traverse JSON and pick best candidates for index current/prev
function findIndexInNextData(nextData) {
  if (!nextData || typeof nextData !== "object") return { cur: null, prev: null };

  const isNum = (v) => typeof v === "number" && Number.isFinite(v);

  // Daum global index usually around 500~100000
  const isIndexLike = (n) => isNum(n) && n >= 100 && n <= 200000;

  // keys we’ll accept (varies by backend/state shape)
  const CUR_KEYS = ["tradePrice", "currentPrice", "price", "closePrice", "lastPrice", "indexValue"];
  const PREV_KEYS = ["prevTradePrice", "prevPrice", "previousPrice", "prevClosePrice", "prevIndexValue", "yesterdayPrice"];

  let best = { cur: null, prev: null, score: -1 };

  // iterative traversal to avoid recursion depth issues
  const stack = [nextData];
  const seen = new Set();
  let steps = 0;

  while (stack.length && steps < 200000) {
    const node = stack.pop();
    steps++;

    if (!node || (typeof node !== "object")) continue;

    // Avoid infinite loops on circular refs (unlikely but safe)
    if (seen.has(node)) continue;
    seen.add(node);

    // If this looks like a quote object, score it
    let cur = null;
    let prev = null;

    for (const k of CUR_KEYS) {
      if (k in node && isIndexLike(node[k])) cur = node[k];
    }
    for (const k of PREV_KEYS) {
      if (k in node && isIndexLike(node[k])) prev = node[k];
    }

    // Some structures store strings like "6836.17"
    if (cur == null) {
      for (const k of CUR_KEYS) {
        const v = node[k];
        if (typeof v === "string") {
          const n = Number(v.replace(/,/g, ""));
          if (isIndexLike(n)) cur = n;
        }
      }
    }
    if (prev == null) {
      for (const k of PREV_KEYS) {
        const v = node[k];
        if (typeof v === "string") {
          const n = Number(v.replace(/,/g, ""));
          if (isIndexLike(n)) prev = n;
        }
      }
    }

    // Score: prefer having both cur & prev, and in realistic ranges
    let score = 0;
    if (cur != null) score += 2;
    if (prev != null) score += 2;
    if (cur != null && cur >= 500 && cur <= 100000) score += 1;
    if (prev != null && prev >= 500 && prev <= 100000) score += 1;

    // If prev is absurd relative to cur, discard prev
    if (cur != null && prev != null) {
      if (prev > cur * 1.5 || prev < cur * 0.5) prev = null;
    }

    // Keep best
    if (score > best.score) {
      best = { cur, prev, score };
      // Early exit if strong match
      if (best.score >= 6) break;
    }

    // Continue traversal
    if (Array.isArray(node)) {
      for (const x of node) stack.push(x);
    } else {
      for (const v of Object.values(node)) {
        if (v && typeof v === "object") stack.push(v);
      }
    }
  }

  return { cur: best.cur, prev: best.prev };
}

// ---------- Fallback DOM parsing (only if NextData fails) ----------
function pickIndexFromText(text) {
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
  for (const n of cands) if (n >= 500 && n <= 200000) return n;
  return cands[0];
}

async function fetchDaumGlobalIndex(page, label, url, fetchedAtKst) {
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);

  const html = await page.content();
  const nextData = extractNextDataJSON(html);
  let { cur, prev } = findIndexInNextData(nextData);

  // Fallback if NextData didn’t work
  if (cur == null) {
    const currentText = await page.evaluate(() => {
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
      const root = document.querySelector("main") || document.body;
      const t = norm(root.innerText || "");
      return t.slice(0, 2000);
    });
    cur = pickIndexFromText(currentText);
  }

  if (prev == null) {
    const prevText = await page.evaluate(() => {
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
      const labelText = "전일지수";
      const el = Array.from(document.querySelectorAll("*"))
        .find(x => norm(x.textContent) === labelText || norm(x.textContent).includes(labelText));
      if (!el) return "";
      const box = el.closest("li, tr, dl, div, section") || el.parentElement || document.body;
      return norm(box.innerText || "").slice(0, 600);
    });
    const idx = prevText.indexOf("전일지수");
    const after = idx >= 0 ? prevText.slice(idx + "전일지수".length) : prevText;
    prev = pickIndexFromText(after);
  }

  // Guardrail: prev absurd => null
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

// ---------- Market cap helpers ----------
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
  await page.mouse.wheel(0, 2500);
  await page.waitForTimeout(1200);

  const { marketCaps, asofText } = await page.evaluate(() => {
    const norm = s => (s || "").replace(/\s+/g, " ").trim();
    const body = norm(document.body?.innerText || "");
    const asofMatch = body.match(/Last updated\s+([A-Za-z]{3}\s+\d{1,2},\s+\d{4})/);
    const asofText = asofMatch ? `Last updated ${asofMatch[1]}` : "";

    const tables = Array.from(document.querySelectorAll("table"));
    let target = null;
    for (const tb of tables) {
      const th = Array.from(tb.querySelectorAll("th")).map(x => norm(x.innerText));
      if (th.includes("Market Cap")) { target = tb; break; }
    }
    if (!target) return { marketCaps: [], asofText };

    const th = Array.from(target.querySelectorAll("th")).map(x => norm(x.innerText));
    const iCap = th.findIndex(x => x === "Market Cap");
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

// NASDAQ market cap (match your “download CSV sum column F” method)
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

// ---------- main ----------
(async () => {
  const fetchedAtKst = kstNow();

  const browser = await chromium.launch();
  const page = await browser.newPage({ userAgent: "Mozilla/5.0" });

  const spx = await fetchDaumGlobalIndex(page, "S&P 500", "https://finance.daum.net/global/quotes/US.SP500", fetchedAtKst);
  const comp = await fetchDaumGlobalIndex(page, "NASDAQ Composite", "https://finance.daum.net/global/quotes/US.COMP", fetchedAtKst);

  // S&P500 market cap
  try {
    const sp = await fetchFinanceChartsSP500TotalMarketCapTrillionUSD(page);
    if (sp.trillion > 0) spx.market_cap = fmtTrillionUSD(sp.trillion);
    if (sp.asofText) spx.asof_kst = `${spx.asof_kst} | FinanceCharts: ${sp.asofText}`;
  } catch {
    spx.market_cap = "";
  }

  // NASDAQ market cap (your CSV-sum definition)
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
