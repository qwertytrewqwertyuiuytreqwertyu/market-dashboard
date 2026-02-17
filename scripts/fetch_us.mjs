import fs from "node:fs";
import * as XLSX from "xlsx";

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

function extractNextData(html) {
  const m = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

function findBestQuote(nextData, min, max) {
  // 목표: current + change(전일비) + date
  const CUR_KEYS = ["tradePrice", "currentPrice", "price", "closePrice", "lastPrice", "indexValue"];
  const CHG_KEYS = ["changePrice", "change", "netChange", "changeValue"];
  const DATE_KEYS = ["tradeDate", "date"];

  const isIdx = (n) => n != null && Number.isFinite(n) && n >= min && n <= max;
  const isChg = (n) => n != null && Number.isFinite(n) && Math.abs(n) <= 5000;

  const pick = (obj, keys, pred) => {
    for (const k of keys) {
      if (obj && Object.prototype.hasOwnProperty.call(obj, k)) {
        const n = toNum(obj[k]);
        if (pred(n)) return n;
      }
    }
    return null;
  };

  let best = { score: -1, current: null, change: null, date: "" };

  const stack = [nextData];
  const seen = new Set();
  let steps = 0;

  while (stack.length && steps < 200000) {
    const node = stack.pop();
    steps++;
    if (!node || typeof node !== "object") continue;
    if (seen.has(node)) continue;
    seen.add(node);

    const current = pick(node, CUR_KEYS, isIdx);
    const change = pick(node, CHG_KEYS, isChg);

    let date = "";
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

    // 더 신뢰되는 패턴: current가 중간값, change가 비교적 작은 값
    if (current != null && current >= min + 200 && current <= max) score += 2;
    if (change != null && Math.abs(change) <= 500) score += 2;

    if (score > best.score) best = { score, current, change, date };

    if (Array.isArray(node)) {
      for (const x of node) stack.push(x);
    } else {
      for (const v of Object.values(node)) {
        if (v && typeof v === "object") stack.push(v);
      }
    }
  }

  return { current: best.current, change: best.change, date: best.date };
}

/* ---------- 1) Daum US index (manual download HTML -> __NEXT_DATA__) ---------- */

async function fetchDaumGlobalFromHtml(code) {
  const url = `https://finance.daum.net/global/quotes/${code}`;
  const res = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0",
      "accept": "text/html,*/*",
      "referer": url
    }
  });

  if (!res.ok) return null;

  const html = await res.text();
  const nextData = extractNextData(html);
  if (!nextData) return null;

  const guard = (code === "US.SP500") ? { min: 1000, max: 20000 } : { min: 1000, max: 60000 };
  const q = findBestQuote(nextData, guard.min, guard.max);

  if (q.current == null || q.change == null) return null;

  const prev = q.current - q.change;
  const pct = prev !== 0 ? ((q.current / prev - 1) * 100) : null;

  return { date: q.date || "", current: q.current, prev, change: q.change, pct };
}

/* ---------- 2) NASDAQ Total Market Cap (download dataset sum) ---------- */

async function fetchNasdaqTotalTril() {
  const res = await fetch("https://api.nasdaq.com/api/screener/stocks?download=true", {
    headers: {
      "user-agent": "Mozilla/5.0",
      "referer": "https://www.nasdaq.com/market-activity/stocks/screener",
      "origin": "https://www.nasdaq.com"
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

/* ---------- 3) S&P 500 Total Market Cap (FinanceCharts download=1 Excel) ---------- */

async function fetchSP500TotalTril() {
  const res = await fetch("https://www.financecharts.com/screener/sp-500?download=1", {
    headers: {
      "user-agent": "Mozilla/5.0",
      "referer": "https://www.financecharts.com/screener/sp-500",
      "accept": "*/*"
    }
  });

  if (!res.ok) return null;

  const buf = Buffer.from(await res.arrayBuffer());

  // 차단되면 HTML이 내려와서 XLSX가 throw -> caller에서 null 처리
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

  const sp = await fetchDaumGlobalFromHtml("US.SP500");
  const nq = await fetchDaumGlobalFromHtml("US.COMP");

  let spCap = null;
  let nqCap = null;

  try { spCap = await fetchSP500TotalTril(); } catch { spCap = null; }
  try { nqCap = await fetchNasdaqTotalTril(); } catch { nqCap = null; }

  const rows = [
    {
      type: "us_index",
      code: "S&P 500",
      date: sp?.date ?? "",
      value: fmt(sp?.current),
      prev_value: fmt(sp?.prev),
      change: fmt(sp?.change),
      change_pct: fmtPct(sp?.pct),
      market_cap: fmtTril(spCap),
      asof_kst: spCap != null ? `${now} | FinanceCharts download` : `${now} | FinanceCharts download (failed)`,
      fetched_at_kst: now
    },
    {
      type: "us_index",
      code: "NASDAQ Composite",
      date: nq?.date ?? "",
      value: fmt(nq?.current),
      prev_value: fmt(nq?.prev),
      change: fmt(nq?.change),
      change_pct: fmtPct(nq?.pct),
      market_cap: fmtTril(nqCap),
      asof_kst: nqCap != null ? `${now} | Nasdaq Screener download` : `${now} | Nasdaq Screener download (failed)`,
      fetched_at_kst: now
    }
  ];

  const payload = { updated_at: now, rows };
  fs.writeFileSync("docs/us.json", JSON.stringify(payload, null, 2), "utf-8");
  console.log(payload);
})();
