import fs from "node:fs";
import { chromium } from "playwright";

/** ---------- time ---------- */
function kstTimestamp() {
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return d.toISOString().replace("T", " ").slice(0, 19);
}

/** ---------- parsing helpers ---------- */
function parseYYMMDD(d) {
  // "25.09.24" -> Date(2025-09-24)
  const m = (d || "").match(/^(\d{2})\.(\d{2})\.(\d{2})$/);
  if (!m) return null;
  const yy = Number(m[1]);
  const mm = Number(m[2]);
  const dd = Number(m[3]);
  const yyyy = (yy < 70) ? 2000 + yy : 1900 + yy;
  return new Date(Date.UTC(yyyy, mm - 1, dd));
}

function numFromText(s) {
  if (!s) return null;
  const t = String(s).replace(/,/g, "");
  const n = Number(t);
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

/** ---------- KR stock market cap normalization ----------
 * - For 다원시스 only: show as "xxxx 억원"
 * - Others: show as "xx.xx 조원"
 * Input raw can be like "3조 4,512억", "8,230억"
 */
function normalizeMarketCapKR(rawText, companyName) {
  if (!rawText) return "";

  const tMatch = rawText.match(/([\d,\.]+)\s*조/);
  const eMatch = rawText.match(/([\d,\.]+)\s*억/);

  let trillion = 0;
  let eok = 0;

  if (tMatch) trillion = parseFloat(tMatch[1].replace(/,/g, ""));
  if (eMatch) eok = parseFloat(eMatch[1].replace(/,/g, ""));

  // total in 억원: 1조 = 10,000억
  const totalEok = trillion * 10000 + eok;

  if (!Number.isFinite(totalEok) || totalEok <= 0) return "";

  if (companyName === "다원시스") {
    return totalEok.toLocaleString("ko-KR") + " 억원";
  }
  const totalTrillion = totalEok / 10000;
  return totalTrillion.toFixed(2) + " 조원";
}

/** ---------- CSV ---------- */
function csvEscape(v) {
  const s = (v ?? "").toString();
  return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCSV(rows) {
  const header = [
    "type","code",
    "date","value","prev_value","change","change_pct",
    "market_cap","trade_value","personal","foreign","institution",
    "asof_kst","fetched_at_kst"
  ];
  const lines = [header.join(",")];
  for (const r of rows) lines.push(header.map(k => csvEscape(r[k])).join(","));
  return lines.join("\n") + "\n";
}

/** ---------- KRX: KOSPI/KOSDAQ market cap from “상장종목 현황” ---------- */
async function fetchKrxIndexMarketCaps(page) {
  const url = "https://data.krx.co.kr/contents/MDC/MAIN/main.jspx";
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);

  const result = await page.evaluate(() => {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();

    const titleEl = Array.from(document.querySelectorAll("*"))
      .find(el => norm(el.textContent) === "상장종목 현황" || norm(el.textContent).includes("상장종목 현황"));
    if (!titleEl) return { KOSPI: "", KOSDAQ: "", asof: "" };

    const container = titleEl.closest("section, div, article") || titleEl.parentElement || document.body;

    // try to capture any “기준/갱신” text near section
    let asof = "";
    const candidates = Array.from(container.querySelectorAll("*"))
      .map(el => norm(el.textContent))
      .filter(t => t && t.length <= 80 && (t.includes("기준") || t.includes("갱신") || t.includes("업데이트")));
    if (candidates.length) asof = candidates[0];

    const tables = Array.from(container.querySelectorAll("table"));
    const searchTables = tables.length ? tables : Array.from(document.querySelectorAll("table"));

    const candidate = searchTables.find(tb => {
      const t = norm(tb.innerText);
      return t.includes("KOSPI") && t.includes("KOSDAQ");
    });
    if (!candidate) return { KOSPI: "", KOSDAQ: "", asof };

    const trs = Array.from(candidate.querySelectorAll("tr"));
    const headerRow = trs.find(r => norm(r.innerText).includes("KOSPI") && norm(r.innerText).includes("KOSDAQ"));
    if (!headerRow) return { KOSPI: "", KOSDAQ: "", asof };

    const headerCells = Array.from(headerRow.querySelectorAll("th,td"))
      .map(td => norm(td.innerText || td.textContent));
    const iKospi = headerCells.findIndex(x => x === "KOSPI");
    const iKosdaq = headerCells.findIndex(x => x === "KOSDAQ");

    const capRow = trs.find(r => norm(r.innerText).includes("시가총액"));
    if (!capRow) return { KOSPI: "", KOSDAQ: "", asof };

    const cells = Array.from(capRow.querySelectorAll("th,td"))
      .map(td => norm(td.innerText || td.textContent));

    return {
      KOSPI: (iKospi >= 0 && cells[iKospi]) ? cells[iKospi] : "",
      KOSDAQ: (iKosdaq >= 0 && cells[iKosdaq]) ? cells[iKosdaq] : "",
      asof
    };
  });

  return result; // {KOSPI, KOSDAQ, asof}
}

/** ---------- Daum KR indices (KOSPI/KOSDAQ) ---------- */
async function fetchDaumIndex2Days(page, code, url, krxCaps, fetchedAtKst) {
  await page.goto(url, { waitUntil: "networkidle" });

  // extract top rows from daily history table
  const rows = await page.$$eval("#boxDailyHistory table tr", trs =>
    trs.slice(0, 15).map(tr => Array.from(tr.querySelectorAll("td")).map(td => (td.innerText || "").trim()))
  );

  // keep only date rows
  const data = rows
    .filter(r => r?.[0] && /^\d{2}\.\d{2}\.\d{2}$/.test(r[0]))
    .map(r => ({ raw: r, dt: (r[0] ? r[0] : null) }))
    .map(x => ({ raw: x.raw, dateObj: (() => {
      const m = x.raw[0]?.match(/^(\d{2})\.(\d{2})\.(\d{2})$/);
      if (!m) return null;
      const yy = Number(m[1]); const mm = Number(m[2]); const dd = Number(m[3]);
      const yyyy = (yy < 70) ? 2000 + yy : 1900 + yy;
      return new Date(Date.UTC(yyyy, mm - 1, dd));
    })() }))
    .filter(x => x.dateObj)
    .sort((a,b) => b.dateObj - a.dateObj)   // ✅ force most recent business date
    .slice(0, 2)
    .map(x => x.raw);

  const curClose = numFromText(data?.[0]?.[1]);
  const prevClose = numFromText(data?.[1]?.[1]);
  const chg = (curClose != null && prevClose != null) ? (curClose - prevClose) : null;
  const pct = (curClose != null && prevClose != null && prevClose !== 0) ? ((curClose / prevClose - 1) * 100) : null;

  const marketCap =
    code === "KOSPI"  ? (krxCaps.KOSPI || "") :
    code === "KOSDAQ" ? (krxCaps.KOSDAQ || "") : "";

  const asof = (krxCaps.asof && krxCaps.asof.length) ? krxCaps.asof : fetchedAtKst;

  const out = [];

  if (data[0]) {
    out.push({
      type: "index",
      code,
      date: data[0][0],
      value: data[0][1],
      prev_value: data[1] ? data[1][1] : "",
      change: chg == null ? "" : fmtNum(chg, 2),
      change_pct: pct == null ? "" : fmtPct(pct),
      market_cap: marketCap,
      trade_value: data[0][5] || "",
      personal: data[0][6] || "",
      foreign: data[0][7] || "",
      institution: data[0][8] || "",
      asof_kst: asof,
      fetched_at_kst: fetchedAtKst
    });
  }

  if (data[1]) {
    out.push({
      type: "index",
      code,
      date: data[1][0],
      value: data[1][1],
      prev_value: "",
      change: "",
      change_pct: "",
      market_cap: "",
      trade_value: "",
      personal: "",
      foreign: "",
      institution: "",
      asof_kst: asof,
      fetched_at_kst: fetchedAtKst
    });
  }

  return out;
}

/** ---------- Daum KR stocks (current + previous close + market cap) ---------- */
async function fetchDaumKrStock(page, stock, fetchedAtKst) {
  const url = `https://finance.daum.net/quotes/${stock.code}#home`;
  await page.goto(url, { waitUntil: "networkidle" });

  // current price
  const priceText = await page.$eval(".currentStk", el => el.innerText).then(t => {
    const m = (t ?? "").match(/([0-9]{1,3}(?:,[0-9]{3})*(?:\.\d+)?)/);
    return m ? m[1] : "";
  }).catch(() => "");

  // previous close (전일종가)
  const prevCloseText = await page.evaluate(() => {
    const norm = s => (s || "").replace(/\s+/g, " ").trim();
    const labelEl = Array.from(document.querySelectorAll("*"))
      .find(el => norm(el.textContent) === "전일종가" || norm(el.textContent).includes("전일종가"));
    if (!labelEl) return "";
    const box = labelEl.closest("li, tr, dl, div") || labelEl.parentElement;
    if (!box) return "";
    const texts = Array.from(box.querySelectorAll("*")).map(x => norm(x.textContent)).filter(Boolean);
    const i = texts.findIndex(x => x.includes("전일종가"));
    return (i >= 0 && texts[i + 1]) ? texts[i + 1] : "";
  });

  // market cap raw (시가총액)
  const rawMarketCap = await page.evaluate(() => {
    const norm = s => (s || "").replace(/\s+/g, " ").trim();
    const labelEl = Array.from(document.querySelectorAll("*"))
      .find(el => norm(el.textContent) === "시가총액" || norm(el.textContent).includes("시가총액"));
    if (!labelEl) return "";
    const box = labelEl.closest("li, tr, dl, div") || labelEl.parentElement;
    if (!box) return "";
    const texts = Array.from(box.querySelectorAll("*")).map(x => norm(x.textContent)).filter(Boolean);
    const i = texts.findIndex(x => x.includes("시가총액"));
    return (i >= 0 && texts[i + 1]) ? texts[i + 1] : "";
  });

  const cur = numFromText(priceText);
  const prev = numFromText(prevCloseText);

  const chg = (cur != null && prev != null) ? (cur - prev) : null;
  const pct = (cur != null && prev != null && prev !== 0) ? ((cur / prev - 1) * 100) : null;

  return [{
    type: "stock",
    code: stock.name, // display name (ordered)
    date: "",
    value: priceText,
    prev_value: prevCloseText,
    change: chg == null ? "" : fmtNum(chg, 2),
    change_pct: pct == null ? "" : fmtPct(pct),
    market_cap: normalizeMarketCapKR(rawMarketCap, stock.name),
    trade_value: "",
    personal: "",
    foreign: "",
    institution: "",
    asof_kst: fetchedAtKst,
    fetched_at_kst: fetchedAtKst
  }];
}

/** ---------- MAIN ---------- */
(async () => {
  const fetchedAtKst = kstTimestamp();

  const browser = await chromium.launch();
  const page = await browser.newPage({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
  });

  const rows = [];

  // 1) KRX index market caps
  const krxCaps = await fetchKrxIndexMarketCaps(page);

  // 2) KR indices (Daum) + forced recent-day sort + current/prev/%calc
  rows.push(...await fetchDaumIndex2Days(page, "KOSPI",  "https://finance.daum.net/domestic/kospi",  krxCaps, fetchedAtKst));
  rows.push(...await fetchDaumIndex2Days(page, "KOSDAQ", "https://finance.daum.net/domestic/kosdaq", krxCaps, fetchedAtKst));

  // 3) KR stocks (order EXACTLY as requested)
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
    rows.push(...await fetchDaumKrStock(page, s, fetchedAtKst));
  }

  await browser.close();

  // 4) Merge US rows from docs/us.json (daily)
  let usRows = [];
  try {
    const us = JSON.parse(fs.readFileSync("docs/us.json", "utf-8"));
    usRows = Array.isArray(us.rows) ? us.rows : [];
  } catch {
    usRows = [];
  }
  rows.push(...usRows);

  // 5) Write outputs
  const payload = { updated_at: fetchedAtKst, rows };
  fs.writeFileSync("docs/data.json", JSON.stringify(payload, null, 2), "utf-8");
  fs.writeFileSync("docs/data.csv", toCSV(rows), "utf-8");

  console.log("Updated docs/data.json & docs/data.csv rows:", rows.length);
})();
