/** Text transforms applied to captured grid before summary rows are built. */

import {
  isExactRemoveWordChip,
  parseRemoveWordChips,
  removeWordChipBody,
} from "../../../lib/removeWordChips.js";

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Default: contain (substring).
 * Exact (`=WORD`): ASCII alnum/`_` neighbors block a match so short codes
 * (XX123) do not carve into longer ones (XX1234). Words joined by spaces count
 * as one phrase, so `=TOTAL` leaves `GRAND TOTAL` alone. CJK neighbors do not block.
 */
function buildRemoveWordRegex(word, exact) {
  if (exact) {
    return new RegExp(
      `(?<![A-Za-z0-9_]\\s*)${escapeRegex(word)}(?!\\s*[A-Za-z0-9_])`,
      "gi",
    );
  }
  return new RegExp(escapeRegex(word), "gi");
}

export function applyTextTransformations(text, removeWord, replaceWordFrom, replaceWordTo) {
  if (!text || typeof text !== "string") return text;

  let result = text;

  if (removeWord && removeWord.trim() !== "") {
    const wordsToRemove = parseRemoveWordChips(removeWord).sort(
      (a, b) => removeWordChipBody(b).length - removeWordChipBody(a).length,
    );
    wordsToRemove.forEach((chip) => {
      const word = removeWordChipBody(chip);
      if (!word) return;
      result = result.replace(buildRemoveWordRegex(word, isExactRemoveWordChip(chip)), "");
    });
  }

  if (replaceWordFrom && replaceWordFrom.trim() !== "" && replaceWordTo !== undefined) {
    const replaceRegex = new RegExp(escapeRegex(replaceWordFrom.trim()), "gi");
    result = result.replace(replaceRegex, replaceWordTo);
  }

  return result.trim();
}

export function applyTransformationsToTableData(tableData, removeWord, replaceWordFrom, replaceWordTo) {
  const transformedData = JSON.parse(JSON.stringify(tableData));

  if (transformedData.rows?.length > 0) {
    transformedData.rows.forEach((row) => {
      row.forEach((cell) => {
        if (cell.type === "data" && cell.value) {
          cell.value = applyTextTransformations(
            cell.value,
            removeWord,
            replaceWordFrom,
            replaceWordTo
          );
        }
      });
    });
  }

  return transformedData;
}

/** Normalize process metadata from capturedProcessData localStorage blob. */
export function parseSummaryProcessMeta(processData) {
  if (!processData || typeof processData !== "object") {
    return { processId: null, processCode: null, processData: null };
  }

  const processCodeRaw = processData.processCode ?? processData.process_code ?? "";
  let processCode =
    typeof processCodeRaw === "string" && processCodeRaw.trim() !== ""
      ? processCodeRaw.trim().toUpperCase()
      : null;

  const rawProcess =
    processData.process ?? processData.processId ?? processData.process_id ?? null;
  const parsed = rawProcess != null ? Number.parseInt(String(rawProcess), 10) : Number.NaN;
  const processId = Number.isFinite(parsed) && parsed > 0 ? parsed : null;

  if (
    !processCode &&
    rawProcess != null &&
    typeof rawProcess === "string" &&
    !Number.isFinite(Number(rawProcess))
  ) {
    processCode = String(rawProcess).trim().toUpperCase() || null;
  }

  const normalized = { ...processData };
  if (processId != null) normalized.process = processId;
  if (processCode) {
    normalized.processCode = processCode;
    if (processId == null) normalized.process = processCode;
  }

  return { processId, processCode, processData: normalized };
}

export function formatSummaryProcessDescriptions(processData) {
  if (!processData) return "-";
  if (Array.isArray(processData.descriptions) && processData.descriptions.length > 0) {
    return processData.descriptions.join(", ");
  }
  return "-";
}

export function formatSummaryProcessCurrency(processData) {
  if (!processData) return "-";
  const value = processData.currencyName || processData.currency;
  return value != null && String(value).trim() !== "" ? String(value).trim() : "-";
}
