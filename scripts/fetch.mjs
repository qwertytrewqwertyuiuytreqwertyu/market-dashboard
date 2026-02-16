import fs from "node:fs";
import { chromium } from "playwright";

/* ===== time ===== */
function kstNow() {
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return d.toISOString().replace("T", " ").slice(0, 19);
}

/* ===== util ===== */
function parseNumber(text) {
  if (!text) return null;
  const m = String(text).match(/(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d{2,}(?:\.\d+)?)/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}
function fmt(n) { return n == null ? "" : n.toFixed(2); }
function fmtPct(n) { return n == null ? "" : n.toFixed(2) + "%"; }

function csvEscape(v) {
  const s = (v ?? "").toString();
  return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCSV(rows) {
  const header = ["type","code","date","value","prev_value","change","change_pct","market_cap","asof_kst","fetched_at_kst"];
  const lines = [header.join(",")];
  for (const r of rows) lines.push(header.map(h => csvEscape(r[h])).join(","));
  return lines.join("\n") + "\n";
}

/* ===== KRX caps (best-effort; can be blank if KRX blocks DOM) ===== */
async function fetchKRXMarketCaps(page) {
  await page.goto("https://data.krx.co.kr/contents/MDC/MAIN/main/index.cmd", { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);

  return await page.evaluate(() => {
    const norm = s => (s || "").replace(/\s+/g, " ").trim();
    const tables = Array.from(document.querySelectorAll("table"));

    let tb = null;
    for (const t of tables) {
      const txt = norm(t.innerText);
      if (txt.includes("KOSPI") && txt.includes("KOSDAQ") && txt.includes("시가총액")) { tb = t; break; }
    }
    if (!tb) return { KOSPI: "", KOSDAQ: "" };

    const rows = Array.from(tb.querySelectorAll("tr")).map(tr =>
      Array.from(tr.querySelectorAll("th,td")).map(td => norm(td.innerText))
    );

    const header = rows.find(r => r.includes("KOSPI") && r.includes("KOSDAQ")) || [];
    const iKOSPI = header.findIndex(x => x === "KOSPI");
    const iKOSDAQ = header.findIndex(x => x === "KOSDAQ");

    const capRow = rows.find(r => r.some(x => x.includes("시가총액")));
    if (!capRow) return { KOSPI: "", KOSDAQ: "" };

    return {
      KOSPI: (iKOSPI >= 0 ? capRow[iKOSPI] : "") || "",
      KOSDAQ: (iKOSDAQ >= 0 ? capRow[iKOSDAQ] : "") || ""
    };
  });
}

/* ===== Daum index (2 recent days) ===== */
async function fetchDaumIndex(page, code, url, caps) {
  await page.goto(url, { waitUntil: "networkidle" });

  const rows = await page.$$eval("#boxDailyHistory table tr", trs =>
    trs
      .map(tr => Array.from(tr.querySelectorAll("td")).map(td => (td.innerText || "").trim()))
      .filter(r => r[0] && /^\d{2}\.\d{2}\.\d{2}$/.test(r[0]))
  );

  rows.sort((a, b) => (a[0] < b[0] ? 1 : -1));
  const cur = rows[0];
  const prev = rows[1];

  const curClose = parseNumber(cur?.[1]);
  const prevClose = parseNumber(prev?.[1]);
  const change = (curClose != null && prevClose != null) ? (curClose - prevClose) : null;
  const pct = (curClose != null && prevClose != null && prevClose !== 0) ? ((curClose / prevClose - 1) * 100) : null;

  const fetchedAt = kstNow();

  return [
    {
      type: "index",
      code,
      date: cur?.[0] || "",
      value: cur?.[1] || "",
      prev_value: prev?.[1] || "",
      change: fmt(change),
      change_pct: fmtPct(pct),
      market_cap: caps?.[code] || "",
      asof_kst: "KRX 직전영업일",
      fetched_at_kst: fetchedAt
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
      fetched_at_kst: fetchedAt
    }
  ];
}

/* ===== Daum KR stock ===== */
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

    const box = labelEl.closest("li, tr, dl, div, section") || labelEl.parentElement;
    if (!box) return "";

    const t = norm(box.innerText || box.textContent || "");
    const m = t.match(/(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d{4,}(?:\.\d+)?)/);
    return m ? m[1] : "";
  });

  const curNum = parseNumber(current);
  const prevNum = parseNumber(prevClose);
  const change = (curNum != null && prevNum != null) ? (curNum - prevNum) : null;
  const pct = (curNum != null && prevNum != null && prevNum !== 0) ? ((curNum / prevNum - 1) * 100) : null;

  const fetchedAt = kstNow();

  return {
    type: "stock",
    code: stock.name,
    date: "",
    value: current,
    prev_value: prevClose,
    change: fmt(change),
    change_pct: fmtPct(pct),
    market_cap: "",
    asof_kst: fetchedAt,
    fetched_at_kst: fetchedAt
  };
}

/* ===== MAIN ===== */
(async () => {
  const rows = [];

  // 0) Read US rows FIRST (guarantee merge)
  let usRows = [];
  try {
    const us = JSON.parse(fs.readFileSync("docs/us.json", "utf-8"));
    usRows = Array.isArray(us?.rows) ? us.rows : [];
  } catch {
    usRows = [];
  }
  console.log("US rows merged:", usRows.length);

  const browser = await chromium.launch();
  const page = await browser.newPage({ userAgent: "Mozilla/5.0" });

  const caps = await fetchKRXMarketCaps(page);

  rows.push(...(await fetchDaumIndex(page, "KOSPI",  "https://finance.daum.net/domestic/kospi",  caps)));
  rows.push(...(await fetchDaumIndex(page, "KOSDAQ", "https://finance.daum.net/domestic/kosdaq", caps)));

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

  for (const s of STOCKS) rows.push(await fetchDaumStock(page, s));

  await browser.close();

  // 4) Append US rows at the end
  rows.push(...usRows);

  const out = { updated_at: kstNow(), rows };

  fs.writeFileSync("docs/data.json", JSON.stringify(out, null, 2), "utf-8");
  fs.writeFileSync("docs/data.csv", toCSV(rows), "utf-8");

  console.log("Total rows written:", rows.length);
})();
