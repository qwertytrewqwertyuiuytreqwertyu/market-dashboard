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

// ------------------------------
// 1) Daum GLOBAL: API-first (best)
// ------------------------------
async function daumApiQuote(code /* e.g., US.SP500 */) {
  // Daum finance는 종종 내부 API를 사용합니다.
  // 환경/시점에 따라 경로가 달라질 수 있어 후보를 여러 개 시도합니다.
  const candidates = [
    `https://finance.daum.net/api/quotes/${code}`,
    `https://finance.daum.net/api/quote/${code}`,
    `https://finance.daum.net/api/global/quotes/${code}`,
    `https://finance.daum.net/api/global/quote/${code}`,
  ];

  const headers = {
    "accept": "application/json, text/plain, */*",
    "user-agent": "Mozilla/5.0",
    "referer": `https://finance.daum.net/global/quotes/${code}`,
  };

  for (const url of candidates) {
    try {
      const res = await fetch(url, { headers });
      if (!res.ok) continue;
      const js = await res.json();

      // 구조가 환경마다 달라서 “가능성 높은 키들”을 넓게 커버
      // current: tradePrice / price / closePrice / currentPrice / indexValue 등
      // prev: prevTradePrice / prevPrice / previousPrice / prevClosePrice / prevIndexValue 등
      const pick = (obj, keys) => {
        for (const k of keys) {
          if (obj && k in obj) {
            const n = toNum(obj[k]);
            if (n != null) return n;
          }
        }
        return null;
      };

      // js.data 형태 / js 자체가 데이터인 형태 모두 대응
      const root = js?.data ?? js;

      const cur =
        pick(root, ["tradePrice", "currentPrice", "price", "closePrice", "lastPrice", "indexValue"]) ??
        pick(root?.quote, ["tradePrice", "currentPrice", "price", "closePrice", "lastPrice", "indexValue"]);

      const prev =
        pick(root, ["prevTradePrice", "prevPrice", "previousPrice", "prevClosePrice", "prevIndexValue", "yesterdayPrice"]) ??
        pick(root?.quote, ["prevTradePrice", "prevPrice", "previousPrice", "prevClosePrice", "prevIndexValue", "yesterdayPrice"]);

      // date는 있으면 넣고 없으면 공란
      const date =
        (root?.tradeDate ?? root?.date ?? root?.quote?.tradeDate ?? root?.quote?.date ?? "").toString();

      if (cur != null) {
        return { ok: true, cur, prev, date };
      }
    } catch {
      // try next candidate
    }
  }
  return { ok: false, cur: null, prev: null, date: "" };
}

// -----------------------------------------------------
// 2) Daum GLOBAL: Playwright DOM fallback (label-based)
//    (전체 숫자 훑기 금지 / “현재지수/전일지수” 주변만)
// -----------------------------------------------------
async function daumDomQuote(page, code) {
  await page.goto(`https://finance.daum.net/global/quotes/${code}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);

  // “현재지수” 라벨이 있는 박스에서 숫자 1개 추출
  const cur = await page.evaluate(() => {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();

    function extractAround(label) {
      // label을 포함하는 가장 가까운 컨테이너에서 숫자 찾기
      const all = Array.from(document.querySelectorAll("*"));
      const el = all.find((x) => norm(x.textContent) === label);
      if (!el) return null;
      const box = el.closest("dl, li, div, section, article") || el.parentElement;
      if (!box) return null;
      const txt = norm(box.innerText);
      // label 이후 텍스트에서 숫자 하나만 (6,836.17 같은)
      const after = txt.split(label).slice(1).join(" ");
      const m = after.match(/(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+))/);
      return m ? m[1] : null;
    }

    return extractAround("현재지수") || extractAround("현재") || null;
  });

  const prev = await page.evaluate(() => {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();

    function extractAround(label) {
      const all = Array.from(document.querySelectorAll("*"));
      const el = all.find((x) => norm(x.textContent) === label || norm(x.textContent).includes(label));
      if (!el) return null;
      const box = el.closest("dl, li, div, section, article") || el.parentElement;
      if (!box) return null;
      const txt = norm(box.innerText);
      const idx = txt.indexOf(label);
      const after = idx >= 0 ? txt.slice(idx + label.length) : txt;
      const m = after.match(/(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+))/);
      return m ? m[1] : null;
    }

    return extractAround("전일지수") || extractAround("전일") || null;
  });

  // 날짜(있으면)
  const date = await page.evaluate(() => {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
    const body = norm(document.body?.innerText || "");
    // Daum이 날짜를 표기하는 형태가 다양해서, 있으면 잡고 없으면 공란
    const m =
      body.match(/\b(\d{4}\.\d{2}\.\d{2})\b/) ||
      body.match(/\b(\d{2}\.\d{2}\.\d{2})\b/);
    return m ? m[1] : "";
  });

  return { cur: toNum(cur), prev: toNum(prev), date };
}

// ------------------------------
// 3) Market cap helpers
// ------------------------------
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

// FinanceCharts S&P500 (download excel sum column D) — 페이지에서 “Market Cap” 합산 추출
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
      if (th.includes("Market Cap")) {
        target = tb;
        break;
      }
    }
    if (!target) return { marketCaps: [], asofText };

    const th = Array.from(target.querySelectorAll("th")).map((x) => norm(x.innerText));
    const iCap = th.findIndex((x) => x === "Market Cap");
    if (iCap < 0) return { marketCaps: [], asofText };

    const rows = Array.from(target.querySelectorAll("tbody tr"));
    const marketCaps = rows
      .map((tr) => {
        const tds = Array.from(tr.querySelectorAll("td")).map((td) => norm(td.innerText));
        return tds[iCap] || "";
      })
      .filter(Boolean);

    return { marketCaps, asofText };
  });

  let sumUsd = 0;
  for (const mc of marketCaps) {
    const n = parseUsdWithUnitToNumber(mc);
    if (Number.isFinite(n)) sumUsd += n;
  }
  return { trillion: sumUsd / 1e12, asofText };
}

// Nasdaq screener download (your “download csv sum column F” definition)
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

// ------------------------------
// 4) Main
// ------------------------------
async function fetchDaumIndex(code, fetchedAtKst, page) {
  // 1) API 먼저
  const api = await daumApiQuote(code);
  let cur = api.ok ? api.cur : null;
  let prev = api.ok ? api.prev : null;
  let date = api.ok ? api.date : "";

  // 2) API 실패/prev 공란이면 DOM fallback
  if (cur == null || prev == null) {
    const dom = await daumDomQuote(page, code);
    cur = cur ?? dom.cur;
    prev = prev ?? dom.prev;
    date = date || dom.date || "";
  }

  // 3) sanity (S&P500이면 1000~20000 범위, NASDAQ comp면 1000~50000 범위)
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

  // Daum: 반드시 user가 준 소스(US.SP500 / US.COMP)로 “현재지수/전일지수” 가져오기
  const spx = await fetchDaumIndex("US.SP500", fetchedAtKst, page);
  const comp = await fetchDaumIndex("US.COMP", fetchedAtKst, page);

  // S&P500 market cap: FinanceCharts 합산 (가능하면 채움)
  try {
    const sp = await fetchFinanceChartsSP500TotalMarketCapTrillionUSD(page);
    if (sp.trillion > 0) spx.market_cap = fmtTrillionUSD(sp.trillion);
    if (sp.asofText) spx.asof_kst = `${spx.asof_kst} | FinanceCharts: ${sp.asofText}`;
  } catch {
    // leave blank
  }

  // NASDAQ market cap: Nasdaq screener download 합산 (너가 말한 방식)
  try {
    const nasTril = await fetchNasdaqDownloadTotalMarketCapTrillionUSD();
    comp.market_cap = fmtTrillionUSD(nasTril);
    comp.asof_kst = `${comp.asof_kst} | Nasdaq Screener download`;
  } catch {
    // leave blank
  }

  await browser.close();

  const payload = { updated_at: fetchedAtKst, rows: [spx, comp] };
  fs.writeFileSync("docs/us.json", JSON.stringify(payload, null, 2), "utf-8");

  console.log("US RESULT:", payload.rows);
})();
