import fs from "node:fs";
import { chromium } from "playwright";

/* =========================
   TIME (KST)
========================= */
function kstNow() {
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return d.toISOString().replace("T", " ").slice(0, 19);
}

/* =========================
   UTIL
========================= */
function parseNumber(text) {
  if (!text) return null;
  const m = String(text).match(/(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d{2,}(?:\.\d+)?)/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}
function fmt(n) {
  return n == null ? "" : n.toFixed(2);
}
function fmtPct(n) {
  return n == null ? "" : n.toFixed(2) + "%";
}

/* =========================
   KRX: KOSPI/KOSDAQ market cap
   - Uses KRX "data" site tables via DOM scan (more stable than main page section hunting)
========================= */
async function fetchKRXMarketCaps(page) {
  // KRX data portal entry (your cited site)
  await page.goto("https://data.krx.co.kr/contents/MDC/MAIN/main/index.cmd", { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);

  // Try to locate the "상장종목 현황" table by scanning all tables
  const caps = await page.evaluate(() => {
    const norm = s => (s || "").replace(/\s+/g, " ").trim();

    const tables = Array.from(document.querySelectorAll("table"));
    let found = null;

    for (const tb of tables) {
      const t = norm(tb.innerText);
      // very broad: must include these tokens
      if (t.includes("상장종목") && t.includes("KOSPI") && t.includes("KOSDAQ") && t.includes("시가총액")) {
        found = tb;
        break;
      }
      // fallback pattern
      if (t.includes("KOSPI") && t.includes("KOSDAQ") && t.includes("시가총액")) {
        found = tb;
        break;
      }
    }

    if (!found) return { KOSPI: "", KOSDAQ: "" };

    const rows = Array.from(found.querySelectorAll("tr")).map(tr =>
      Array.from(tr.querySelectorAll("th,td")).map(td => norm(td.innerText))
    );

    // find header row containing KOSPI/KOSDAQ
    const header = rows.find(r => r.includes("KOSPI") && r.includes("KOSDAQ")) || [];
    const iKOSPI = header.findIndex(x => x === "KOSPI");
    const iKOSDAQ = header.findIndex(x => x === "KOSDAQ");

    // find row containing "시가총액"
    const capRow = rows.find(r => r.some(x => x.includes("시가총액")));
    if (!capRow) return { KOSPI: "", KOSDAQ: "" };

    return {
      KOSPI: (iKOSPI >= 0 ? capRow[iKOSPI] : "") || "",
      KOSDAQ: (iKOSDAQ >= 0 ? capRow[iKOSDAQ] : "") || ""
    };
  });

  return caps; // {KOSPI, KOSDAQ}
}

/* =========================
   DAUM INDEX (2 recent business days)
========================= */
async function fetchDaumIndex(page, code, url, caps) {
  await page.goto(url, { waitUntil: "networkidle" });

  const rows = await page.$$eval("#boxDailyHistory table tr", trs =>
    trs
      .map(tr =>
        Array.from(tr.querySelectorAll("td")).map(td => (td.innerText || "").trim())
      )
      .filter(r => r[0] && /^\d{2}\.\d{2}\.\d{2}$/.test(r[0]))
  );

  // force recent business day sort: YY.MM.DD string works lexicographically
  rows.sort((a, b) => (a[0] < b[0] ? 1 : -1));
  const cur = rows[0];
  const prev = rows[1];

  const curClose = parseNumber(cur?.[1]);
  const prevClose = parseNumber(prev?.[1]);

  const change = (curClose != null && prevClose != null) ? (curClose - prevClose) : null;
  const pct = (curClose != null && prevClose != null && prevClose !== 0) ? ((curClose / prevClose - 1) * 100) : null;

  const mcap = caps?.[code] || "";

  return [
    {
      type: "index",
      code,
      date: cur?.[0] || "",
      value: cur?.[1] || "",
      prev_value: prev?.[1] || "",
      change: fmt(change),
      change_pct: fmtPct(pct),
      market_cap: mcap,
      asof_kst: "KRX 직전영업일",
      fetched_at_kst: kstNow()
    },
    {
      type: "index",
      code,
      date: prev?.[0] || "",
      value: prev?.[1] || "",
      prev_value: "",
      change: "",
      change_pct: "",
      market_cap: "",
      asof_kst: "KRX 직전영업일",
      fetched_at_kst: kstNow()
    }
  ];
}

/* =========================
   KR STOCK
   - Current price: stable
   - Previous close: search "전일종가" area + multiple fallbacks
========================= */
async function fetchDaumStock(page, stock) {
  const url = `https://finance.daum.net/quotes/${stock.code}#home`;
  await page.goto(url, { waitUntil: "networkidle" });

  const current = await page.evaluate(() => {
    const norm = s => (s || "").replace(/\s+/g, " ").trim();
    const el =
      document.querySelector(".currentStk strong") ||
      document.querySelector(".currentStk .price") ||
      document.querySelector(".currentStk em") ||
      document.querySelector(".currentStk");
    if (!el) return "";
    const t = norm(el.textContent);
    const m = t.match(/(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d{4,}(?:\.\d+)?)/);
    return m ? m[1] : "";
  });

  // Robust previous close extraction
  const prevClose = await page.evaluate(() => {
    const norm = s => (s || "").replace(/\s+/g, " ").trim();

    const labels = ["전일종가", "전일", "전일가", "전일가격"];
    let labelEl = null;

    for (const lab of labels) {
      labelEl = Array.from(document.querySelectorAll("*"))
        .find(el => norm(el.textContent) === lab || norm(el.textContent).includes(lab));
      if (labelEl) break;
    }
    if (!labelEl) return "";

    // Search within nearest container first
    const container = labelEl.closest("li, tr, dl, div, section") || labelEl.parentElement;
    if (!container) return "";

    const t = norm(container.innerText || container.textContent || "");

    // Extract the FIRST "real price-like" number in that container after the label text
    const idx = t.indexOf("전일");
    const slice = idx >= 0 ? t.slice(idx) : t;

    const m = slice.match(/(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d{4,}(?:\.\d+)?)/);
    return m ? m[1] : "";
  });

  const curNum = parseNumber(current);
  const prevNum = parseNumber(prevClose);

  const change = (curNum != null && prevNum != null) ? (curNum - prevNum) : null;
  const pct = (curNum != null && prevNum != null && prevNum !== 0) ? ((curNum / prevNum - 1) * 100) : null;

  return {
    type: "stock",
    code: stock.name,
    date: "",
    value: current,
    prev_value: prevClose,
    change: fmt(change),
    change_pct: fmtPct(pct),
    market_cap: "",
    asof_kst: kstNow(),
    fetched_at_kst: kstNow()
  };
}

/* =========================
   CSV
========================= */
function csvEscape(v) {
  const s = (v ?? "").toString();
  return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCSV(rows) {
  const header = ["type","code","date","value","prev_value","change","change_pct","market_cap","asof_kst","fetched_at_kst"];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(header.map(h => csvEscape(r[h])).join(","));
  }
  return lines.join("\n") + "\n";
}

/* =========================
   MAIN
========================= */
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ userAgent: "Mozilla/5.0" });

  const rows = [];

  // 1) KRX market cap
  const caps = await fetchKRXMarketCaps(page);

  // 2) Daum indices
  rows.push(...(await fetchDaumIndex(page, "KOSPI", "https://finance.daum.net/domestic/kospi", caps)));
  rows.push(...(await fetchDaumIndex(page, "KOSDAQ", "https://finance.daum.net/domestic/kosdaq", caps)));

  // 3) KR stocks (fixed order)
  const STOCKS = [
    { code: "A064350", name: "Hyundai Rotem" },
    { code: "A012450", name: "Hanwha Aerospace" },
    { code: "A047810", name: "Korea Aerospace Industries" },
    { code: "A079550", name: "LIG Nex1" },
    { code: "A068240", name: "다원시스" },
    { code: "A005380", name: "Hyundai Motor Company" },
    { code: "A000270", name: "Kia" },
    { code: "A012330", name: "Hyundai Mobis" },
    { code: "A086280", name: "Hyundai Glovis" },
    { code: "A307950", name: "Hyundai AutoEver" },
    { code: "A011210", name: "Hyundai Wia" },
    { code: "A005930", name: "Samsung Electronics" },
    { code: "A000660", name: "SK Hynix" }
  ];

  for (const s of STOCKS) {
    rows.push(await fetchDaumStock(page, s));
  }

  await browser.close();

  // 4) Merge US rows
  let usRows = [];
  try {
    const us = JSON.parse(fs.readFileSync("docs/us.json", "utf-8"));
    usRows = Array.isArray(us.rows) ? us.rows : [];
  } catch {
    usRows = [];
  }
  rows.push(...usRows);

  // 5) Write outputs
  const out = { updated_at: kstNow(), rows };
  fs.writeFileSync("docs/data.json", JSON.stringify(out, null, 2), "utf-8");
  fs.writeFileSync("docs/data.csv", toCSV(rows), "utf-8");

  console.log("Updated docs/data.json and docs/data.csv");
})();
