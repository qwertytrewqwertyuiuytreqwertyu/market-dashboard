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
  const m = text.match(/(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d{4,}(?:\.\d+)?)/);
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
   KRX INDEX MARKET CAP
========================= */
async function fetchKRXMarketCaps(page) {
  await page.goto("https://data.krx.co.kr/contents/MDC/MAIN/main.jspx", {
    waitUntil: "networkidle"
  });

  await page.waitForTimeout(1500);

  return await page.evaluate(() => {
    const norm = s => (s || "").replace(/\s+/g, " ").trim();

    const tables = Array.from(document.querySelectorAll("table"));
    let target = null;

    for (const tb of tables) {
      const t = norm(tb.innerText);
      if (t.includes("KOSPI") && t.includes("KOSDAQ") && t.includes("시가총액")) {
        target = tb;
        break;
      }
    }

    if (!target) {
      return { KOSPI: "", KOSDAQ: "" };
    }

    const rows = Array.from(target.querySelectorAll("tr"));
    const headerRow = rows.find(r => {
      const t = norm(r.innerText);
      return t.includes("KOSPI") && t.includes("KOSDAQ");
    });

    const headers = headerRow
      ? Array.from(headerRow.querySelectorAll("th,td")).map(td => norm(td.innerText))
      : [];

    const iKospi = headers.findIndex(x => x === "KOSPI");
    const iKosdaq = headers.findIndex(x => x === "KOSDAQ");

    const capRow = rows.find(r => norm(r.innerText).includes("시가총액"));
    if (!capRow) return { KOSPI: "", KOSDAQ: "" };

    const cells = Array.from(capRow.querySelectorAll("th,td")).map(td =>
      norm(td.innerText)
    );

    return {
      KOSPI: cells[iKospi] || "",
      KOSDAQ: cells[iKosdaq] || ""
    };
  });
}

/* =========================
   DAUM INDEX (2 recent days)
========================= */
async function fetchDaumIndex(page, code, url, marketCaps) {
  await page.goto(url, { waitUntil: "networkidle" });

  const rows = await page.$$eval("#boxDailyHistory table tr", trs =>
    trs
      .map(tr =>
        Array.from(tr.querySelectorAll("td")).map(td =>
          (td.innerText || "").trim()
        )
      )
      .filter(r => r[0] && /^\d{2}\.\d{2}\.\d{2}$/.test(r[0]))
  );

  rows.sort((a, b) => (a[0] < b[0] ? 1 : -1));
  const cur = rows[0];
  const prev = rows[1];

  const curClose = parseNumber(cur?.[1]);
  const prevClose = parseNumber(prev?.[1]);

  const change = curClose != null && prevClose != null
    ? curClose - prevClose
    : null;

  const pct = curClose != null && prevClose != null && prevClose !== 0
    ? (curClose / prevClose - 1) * 100
    : null;

  return [
    {
      type: "index",
      code,
      date: cur?.[0] || "",
      value: cur?.[1] || "",
      prev_value: prev?.[1] || "",
      change: fmt(change),
      change_pct: fmtPct(pct),
      market_cap: marketCaps[code] || "",
      asof_kst: "KRX 직전영업일"
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
      asof_kst: "KRX 직전영업일"
    }
  ];
}

/* =========================
   DAUM STOCK
========================= */
async function fetchDaumStock(page, stock) {
  const url = `https://finance.daum.net/quotes/${stock.code}#home`;
  await page.goto(url, { waitUntil: "networkidle" });

  const current = await page.evaluate(() => {
    const norm = s => (s || "").replace(/\s+/g, " ").trim();
    const el =
      document.querySelector(".currentStk strong") ||
      document.querySelector(".currentStk .price") ||
      document.querySelector(".currentStk");
    if (!el) return "";
    const t = norm(el.innerText);
    const m = t.match(/(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d{4,}(?:\.\d+)?)/);
    return m ? m[1] : "";
  });

  const prevClose = await page.evaluate(() => {
    const norm = s => (s || "").replace(/\s+/g, " ").trim();
    const label = Array.from(document.querySelectorAll("*")).find(
      el => norm(el.textContent).includes("전일종가")
    );
    if (!label) return "";
    const box = label.closest("li, tr, dl, div") || label.parentElement;
    if (!box) return "";
    const t = norm(box.innerText);
    const m = t.match(/(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d{4,}(?:\.\d+)?)/);
    return m ? m[1] : "";
  });

  const curNum = parseNumber(current);
  const prevNum = parseNumber(prevClose);

  const change = curNum != null && prevNum != null
    ? curNum - prevNum
    : null;

  const pct = curNum != null && prevNum != null && prevNum !== 0
    ? (curNum / prevNum - 1) * 100
    : null;

  return {
    type: "stock",
    code: stock.name,
    date: "",
    value: current,
    prev_value: prevClose,
    change: fmt(change),
    change_pct: fmtPct(pct),
    market_cap: "",
    asof_kst: kstNow()
  };
}

/* =========================
   CSV
========================= */
function toCSV(rows) {
  const header = [
    "type",
    "code",
    "date",
    "value",
    "prev_value",
    "change",
    "change_pct",
    "market_cap",
    "asof_kst"
  ];
  const lines = [header.join(",")];

  for (const r of rows) {
    lines.push(header.map(h => `"${r[h] || ""}"`).join(","));
  }

  return lines.join("\n");
}

/* =========================
   MAIN
========================= */
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  const rows = [];

  const caps = await fetchKRXMarketCaps(page);

  rows.push(
    ...(await fetchDaumIndex(
      page,
      "KOSPI",
      "https://finance.daum.net/domestic/kospi",
      caps
    ))
  );

  rows.push(
    ...(await fetchDaumIndex(
      page,
      "KOSDAQ",
      "https://finance.daum.net/domestic/kosdaq",
      caps
    ))
  );

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

  const output = {
    updated_at: kstNow(),
    rows
  };

  fs.writeFileSync("docs/data.json", JSON.stringify(output, null, 2));
  fs.writeFileSync("docs/data.csv", toCSV(rows));

  console.log("Updated successfully.");
})();
