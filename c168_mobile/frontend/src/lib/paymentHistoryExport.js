import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import { buildApiUrl } from "../utils/apiUrl.js";
import { orderCurrencyCodesForCompany } from "./currencyOrder.js";
import { formatPaymentHistoryMoney, formatRateForHistoryDisplay, getHistoryRemark } from "./transactionFormat.js";
import MoneyDecimal from "./money/moneyDecimal.js";

/* ---------------------------------------------------------------------------------------
 * CJK font for PDF export — desktop parity (5554c6921a / 82eb85d220 "PDF font size when got
 * chinese word become thinner prob", d9f2e3e845 / 0d2499e032 colour).
 * jsPDF's built-in helvetica has no CJK glyphs, so Chinese product/description/remark cells
 * came out broken. Ported from
 * frontend/src/pages/transaction/lib/paymentHistoryMemberReportExport.js (two apps share no
 * source), with two phone-specific adjustments:
 *   - the font is fetched *only* when a report actually contains CJK (the file is ~34MB, which
 *     is not something to pull on mobile data for an all-English report);
 *   - only the Regular face is registered — the phone's table does not bold CJK cells, so the
 *     desktop's extra static Bold file would be dead weight. CJK cells are forced to style
 *     "normal" instead, which jsPDF would otherwise look up and fail on.
 * jsPDF subsets the embedded font (a 2-row report lands at ~0.8MB, not 34MB).
 * ------------------------------------------------------------------------------------- */
const PDF_FALLBACK_FONT_FAMILY = "helvetica";
const PDF_CJK_FONT_FAMILY = "NotoSansCJKsc";
const PDF_CJK_FONT_FILE = "NotoSansCJKsc-VF.ttf";
const PDF_CJK_FONT_URLS = [
  "https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/Variable/TTF/NotoSansCJKsc-VF.ttf",
  "https://cdn.jsdelivr.net/gh/notofonts/noto-cjk@main/Sans/Variable/TTF/NotoSansCJKsc-VF.ttf",
];
let pdfCjkFontBase64Promise = null;

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function fetchPdfFontBase64(urls) {
  for (const url of urls) {
    try {
      const res = await fetch(url, { credentials: "omit", cache: "force-cache" });
      if (!res.ok) continue;
      const dataUrl = await blobToDataUrl(await res.blob());
      const payload = dataUrl.split(",")[1] || "";
      if (payload) return payload;
    } catch {
      /* try next URL */
    }
  }
  throw new Error("Unable to load font for PDF export");
}

function addFontToVfsOnce(doc, file, base64) {
  const hasFile = typeof doc.existsFileInVFS === "function" ? doc.existsFileInVFS(file) : false;
  if (!hasFile) doc.addFileToVFS(file, base64);
}

/** Registers the CJK faces on this doc; returns the family name, or null when unavailable. */
async function ensurePdfExportFont(doc) {
  try {
    if (!pdfCjkFontBase64Promise) pdfCjkFontBase64Promise = fetchPdfFontBase64(PDF_CJK_FONT_URLS);
    let base64 = "";
    try {
      base64 = await pdfCjkFontBase64Promise;
    } catch {
      pdfCjkFontBase64Promise = null;
      throw new Error("CJK font fetch failed");
    }
    addFontToVfsOnce(doc, PDF_CJK_FONT_FILE, base64);
    doc.addFont(PDF_CJK_FONT_FILE, PDF_CJK_FONT_FAMILY, "normal");
    return PDF_CJK_FONT_FAMILY;
  } catch {
    return null;
  }
}

function hasCjkText(value) {
  const text = String(value || "");
  if (!text) return false;
  return /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(text);
}

function setPdfFontForText(doc, text, cjkFontFamily, style = "normal") {
  const family = cjkFontFamily && hasCjkText(text) ? cjkFontFamily : PDF_FALLBACK_FONT_FAMILY;
  doc.setFont(family, style);
}

async function parseJsonResponse(text) {
  try {
    return JSON.parse(text || "{}");
  } catch {
    return {};
  }
}

export function formatDmyFromYmd(ymd) {
  const [y, m, d] = String(ymd || "").split("-");
  if (!y || !m || !d) return "";
  return `${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}/${y}`;
}

export function ymdRangeToDmy(dateFromYmd, dateToYmd) {
  return {
    dateFrom: formatDmyFromYmd(dateFromYmd),
    dateTo: formatDmyFromYmd(dateToYmd),
  };
}

export async function fetchPaymentHistoryExportCurrencies(accountId, companyId, signal, groupId = "") {
  const id = Number(accountId) || 0;
  const cid = Number(companyId) || 0;
  const gid = String(groupId || "").trim();
  if (!id || (!cid && !gid)) return [];
  const params = new URLSearchParams({
    action: "get_account_currencies",
    account_id: String(id),
    ...(gid ? { group_id: gid } : { company_id: String(cid) }),
  });
  const res = await fetch(buildApiUrl(`api/accounts/account_currency_api.php?${params}`), {
    credentials: "include",
    cache: "no-store",
    signal,
  });
  const json = await parseJsonResponse(await res.text());
  if (!json?.success || !Array.isArray(json.data)) return [];
  const codes = json.data
    .map((row) => String(row.currency_code || row.code || "").trim().toUpperCase())
    .filter(Boolean);
  return orderCurrencyCodesForCompany(codes, cid || 0, signal);
}

export async function fetchMemberReportHistory({
  accountId,
  companyId,
  groupId = "",
  dateFrom,
  dateTo,
  currency,
  signal,
}) {
  const id = Number(accountId) || 0;
  const cid = Number(companyId) || 0;
  const gid = String(groupId || "").trim();
  if (!id || (!cid && !gid)) throw new Error("Account or company is missing");
  const params = new URLSearchParams({
    account_id: String(id),
    date_from: String(dateFrom),
    date_to: String(dateTo),
    ...(gid ? { group_id: gid } : { company_id: String(cid) }),
    currency: String(currency || "").trim().toUpperCase(),
    member_view: "1",
  });
  const res = await fetch(buildApiUrl(`api/transactions/history_api.php?${params}&_t=${Date.now()}`), {
    credentials: "include",
    cache: "no-store",
    signal,
  });
  const json = await parseJsonResponse(await res.text());
  if (!json?.success) {
    throw new Error(json?.error || json?.message || "History request failed");
  }
  if (Array.isArray(json.data?.history)) return json.data.history;
  if (Array.isArray(json.data)) return json.data;
  return [];
}

export function resolveExportCurrenciesDefault(scopeCurrency, currencies) {
  const list = Array.isArray(currencies) ? currencies : [];
  if (!list.length) return { isAllSelected: true, codes: [] };
  if (list.length === 1) return { isAllSelected: false, codes: [list[0]] };
  const raw = String(scopeCurrency || "").trim().toUpperCase();
  if (!raw || raw === "ALL") return { isAllSelected: true, codes: [] };
  const parts = raw.split(",").map((c) => c.trim()).filter(Boolean);
  const matched = parts.filter((p) => list.includes(p));
  if (!matched.length || matched.length === list.length) return { isAllSelected: true, codes: [] };
  return { isAllSelected: false, codes: matched };
}

export function exportCurrencyCodes(isAllSelected, selectedCurrencies, availableCurrencies) {
  const list = Array.isArray(availableCurrencies) ? availableCurrencies : [];
  if (!list.length) return [];
  if (list.length === 1) {
    const code = list[0];
    return (selectedCurrencies || []).includes(code) ? [code] : [];
  }
  if (isAllSelected) return [...list];
  return (selectedCurrencies || []).filter((c) => list.includes(c));
}

export function buildMemberReportFilename({ accountCode, currencies, dateFrom, dateTo }) {
  const code = String(accountCode || "account").replace(/[^\w.-]+/g, "_");
  const ccy = (currencies || []).join("-") || "ALL";
  const from = String(dateFrom || "").replace(/\//g, "");
  const to = String(dateTo || "").replace(/\//g, "");
  return `${code}_${ccy}_${from}-${to}.pdf`;
}

function productCell(row) {
  if (row?.is_bank_process_transaction) return row.card_owner || "-";
  return row?.product || "-";
}

function descriptionCell(row) {
  if (row?.row_type === "bf") return "OPENING BALANCE";
  const desc = String(row?.description || "").trim();
  if (desc.toUpperCase() === "OPENING BALANCE") return "OPENING BALANCE";
  return (desc || "-").toUpperCase();
}

function computeTotals(rows) {
  let wl = MoneyDecimal.toDecimal("0", 0);
  let cr = MoneyDecimal.toDecimal("0", 0);
  let closing = MoneyDecimal.toDecimal("0", 0);
  for (const row of rows || []) {
    try {
      wl = wl.plus(MoneyDecimal.toDecimal(String(row.win_loss ?? "0").replace(/,/g, "") || "0", 0));
    } catch {
      /* skip */
    }
    try {
      cr = cr.plus(MoneyDecimal.toDecimal(String(row.cr_dr ?? "0").replace(/,/g, "") || "0", 0));
    } catch {
      /* skip */
    }
    if (row.balance != null && String(row.balance).trim() !== "" && row.balance !== "-") {
      try {
        closing = MoneyDecimal.toDecimal(String(row.balance).replace(/,/g, "") || "0", 0);
      } catch {
        /* keep previous */
      }
    }
  }
  return {
    totalWinLoss: formatPaymentHistoryMoney(wl.toString()),
    totalCrDr: formatPaymentHistoryMoney(cr.toString()),
    closingBalance: formatPaymentHistoryMoney(closing.toString()),
  };
}

function rowToCells(row) {
  return [
    row?.date || "-",
    productCell(row),
    row?.rate && row.rate !== "-" ? formatRateForHistoryDisplay(row.rate) : "-",
    formatPaymentHistoryMoney(row?.win_loss),
    formatPaymentHistoryMoney(row?.cr_dr),
    formatPaymentHistoryMoney(row?.balance),
    descriptionCell(row),
    getHistoryRemark(row),
  ];
}

/**
 * Client-side PDF download — same APIs as desktop member report export.
 */
export async function downloadMemberReportPdf({
  sections,
  accountCode,
  accountName,
  dateFrom,
  dateTo,
  filename,
  title = "WIN/LOSE REPORT",
}) {
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const list = Array.isArray(sections) ? sections : [];
  /* Only pull the ~34MB CJK font when a cell actually needs it; null = render with helvetica. */
  const needsCjkFont = list.some((section) =>
    (Array.isArray(section?.rows) ? section.rows : []).some((row) =>
      rowToCells(row).some((cell) => hasCjkText(cell)),
    ),
  );
  const cjkFontFamily = needsCjkFont ? await ensurePdfExportFont(doc) : null;
  const pageW = doc.internal.pageSize.getWidth();
  const marginX = 10;
  const headers = ["Date", "Product", "Rate", "W/L", "Cr/Dr", "Bal.", "Desc.", "Remark"];

  list.forEach((section, idx) => {
    if (idx > 0) doc.addPage();
    const currency = String(section.currency || "").toUpperCase();
    const rows = Array.isArray(section.rows) ? section.rows : [];
    const totals = computeTotals(rows);
    const meta = `${accountCode || ""}${accountName ? ` (${accountName})` : ""} · ${dateFrom} – ${dateTo} · ${currency}`;

    const titleText = String(title || "WIN/LOSE REPORT").toUpperCase();
    setPdfFontForText(doc, titleText, cjkFontFamily, "bold");
    doc.setFontSize(13);
    doc.setTextColor(0, 44, 73);
    doc.text(titleText, marginX, 14);
    setPdfFontForText(doc, meta, cjkFontFamily, "normal");
    doc.setFontSize(9);
    doc.setTextColor(71, 85, 105);
    doc.text(meta, marginX, 20);

    autoTable(doc, {
      startY: 24,
      margin: { left: marginX, right: marginX, top: 24, bottom: 14 },
      head: [headers],
      body: rows.map(rowToCells),
      foot: [
        [
          { content: "TOTAL", colSpan: 3, styles: { fontStyle: "bold", halign: "left" } },
          totals.totalWinLoss,
          totals.totalCrDr,
          totals.closingBalance,
          { content: "", colSpan: 2 },
        ],
      ],
      showFoot: "lastPage",
      theme: "grid",
      /* Desktop parity: Chinese cells need the embedded CJK face, otherwise they come out broken. */
      didParseCell: (hookData) => {
        if (!cjkFontFamily) return;
        const cellText = Array.isArray(hookData.cell?.text)
          ? hookData.cell.text.join(" ")
          : String(hookData.cell?.raw || "");
        if (!hasCjkText(cellText)) return;
        hookData.cell.styles.font = cjkFontFamily;
        /* Only a Regular CJK face is registered, so never ask jsPDF for its bold. */
        hookData.cell.styles.fontStyle = "normal";
        /* Wrapped Chinese needs a little more line height than the Latin default. */
        hookData.cell.styles.lineHeight = 1.08;
      },
      styles: {
        font: PDF_FALLBACK_FONT_FAMILY,
        fontSize: 7.5,
        cellPadding: 1.1,
        overflow: "linebreak",
        valign: "middle",
      },
      headStyles: {
        fillColor: [0, 44, 73],
        textColor: 255,
        fontStyle: "bold",
        fontSize: 7.5,
      },
      footStyles: {
        fillColor: [241, 245, 249],
        /* Desktop parity (0d2499e032): black, so CJK glyphs coming from the embedded font
           are not tinted dark-slate. */
        textColor: [0, 0, 0],
        fontStyle: "bold",
      },
      columnStyles: {
        0: { cellWidth: 18 },
        1: { cellWidth: 22 },
        2: { cellWidth: 14 },
        3: { cellWidth: 18, halign: "right" },
        4: { cellWidth: 18, halign: "right" },
        5: { cellWidth: 18, halign: "right" },
        6: { cellWidth: 28 },
        7: { cellWidth: "auto" },
      },
    });
  });

  doc.save(filename || "payment-history.pdf");
}
