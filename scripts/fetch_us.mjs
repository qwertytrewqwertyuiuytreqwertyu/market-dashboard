import fs from "node:fs";
import * as XLSX from "xlsx";

/* ---------------- utilities ---------------- */

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

function fmt(x, d = 2) {
  return x == null ? "" : Number(x).toFixed(d);
}

function fmtPct(x) {
  return x == null ? "" : `${Number(x).toFixed(2)}%`;
}

function fmtTril(x) {
  return x == null ? "" : `${Number(x).toFixed(2)} T USD`;
}

/* ---------------- DAUM API ---------------- */

async function fetchDaumGlobal(code) {
  const url = `https://finance.daum.net/api/quote/${code}`;
  const res = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0",
      "referer": `https://finance.daum.net/global/quotes/${code}`
    }
  });

  if (!res.ok) return null;

  const js = await res.json();
  const d = js?.data ?? js;

  const current = toNum(d?.tradePrice ?? d?.closePrice ?? d?.price);
  const change = toNum(d?.changePrice ?? d?.change);
  const date = (d?.tradeDate ?? d?.date ?? "").toString();

  if (current == null || change == null) return null;

  const prev = current - change;
  const pct = prev !== 0 ? ((current / prev - 1) * 100) : null;

  return { current, prev, change, pct, date };
}

/* ---------------- NASDAQ Market Cap ---------------- */

async function fetchNasdaqTotalTril() {
  const res = await fetch(
    "https://api.nasdaq.com/api/screener/stocks?download=true",
    {
      headers: {
        "user-agent": "Mozilla/5.0",
        "referer": "https://www.nasdaq.com/market-activity/stocks/screener",
        "origin": "https://www.nasdaq.com"
      }
    }
  );

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

/* ---------------- S&P 500 Market Cap (Download Excel Direct) ---------------- */

async function fetchSP500TotalTril() {
  const res = await fetch(
    "https://www.financecharts.com/screener/sp-500?download=1",
    {
      headers: {
        "user-agent": "Mozilla/5.0",
        "referer": "https://www.financecharts.com/screener/sp-500"
      }
    }
  );

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
      const m = v.replace(/\s+/g, "").match(/^\$?([0-9,.]+)([TBM])$/i);
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

/* ---------------- MAIN ---------------- */

(async () => {
  const now = kstNow();

  const sp = await fetchDaumGlobal("US.SP500");
  const nq = await fetchDaumGlobal("US.COMP");

  const spCap = await fetchSP500TotalTril();
  const nqCap = await fetchNasdaqTotalTril();

  const rows = [];

  if (sp) {
    rows.push({
      type: "us_index",
      code: "S&P 500",
      date: sp.date,
      value: fmt(sp.current),
      prev_value: fmt(sp.prev),
      change: fmt(sp.change),
      change_pct: fmtPct(sp.pct),
      market_cap: fmtTril(spCap),
      asof_kst: `${now} | FinanceCharts download`,
      fetched_at_kst: now
    });
  }

  if (nq) {
    rows.push({
      type: "us_index",
      code: "NASDAQ Composite",
      date: nq.date,
      value: fmt(nq.current),
      prev_value: fmt(nq.prev),
      change: fmt(nq.change),
      change_pct: fmtPct(nq.pct),
      market_cap: fmtTril(nqCap),
      asof_kst: `${now} | Nasdaq Screener download`,
      fetched_at_kst: now
    });
  }

  const payload = { updated_at: now, rows };
  fs.writeFileSync("docs/us.json", JSON.stringify(payload, null, 2));
  console.log(payload);
})();
