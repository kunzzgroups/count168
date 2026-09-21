/**
 * Bundled ES module port of legacy `js/date-range-picker.js` — attaches `window.MaintenanceDateRangePicker`,
 * `window.changeMonth`, `window.selectQuickRange`, `window.toggleQuickSelectDropdown` for DOM markup (#date-range-picker, #calendar-popup, …).
 */
const CALENDAR_POPUP_ID = "calendar-popup";
/** Remember original parent when portaling #calendar-popup to document.body. */
const calendarPopupHomeParent = new WeakMap();
/** Bank Process 顶栏：药丸与日历 dropdown 统一宽度下限（须容纳完整 dd/mm/yyyy - dd/mm/yyyy） */
const BANK_TOOLBAR_CALENDAR_MIN_PX = 292;
const BANK_TOOLBAR_DATE_RANGE_SAMPLE = "01/01/2026 - 31/12/2026";

function measureBankToolbarTextWidth(text, referenceEl) {
  if (typeof document === "undefined") return 0;
  const probe = document.createElement("span");
  probe.setAttribute("aria-hidden", "true");
  probe.style.cssText =
    "position:absolute;left:-9999px;top:0;visibility:hidden;white-space:nowrap;pointer-events:none;";
  if (referenceEl) {
    const cs = getComputedStyle(referenceEl);
    probe.style.font = cs.font;
    probe.style.letterSpacing = cs.letterSpacing;
  }
  probe.textContent = text;
  document.body.appendChild(probe);
  const width = probe.offsetWidth;
  probe.remove();
  return width;
}

function getBankToolbarUnifiedBlockWidth() {
  if (typeof window === "undefined") return BANK_TOOLBAR_CALENDAR_MIN_PX;
  const viewportCap = Math.max(1, window.innerWidth - 24);

  const picker = document.querySelector(
    ".bank-process-toolbar-primary .transaction-date-range-group .date-range-picker",
  );
  if (!picker) {
    return Math.min(BANK_TOOLBAR_CALENDAR_MIN_PX, viewportCap);
  }

  const display = picker.querySelector("#date-range-display");
  const displayText = (display?.textContent || "").trim() || BANK_TOOLBAR_DATE_RANGE_SAMPLE;
  const textW = measureBankToolbarTextWidth(displayText, display);

  const pickerStyle = getComputedStyle(picker);
  const padX =
    (parseFloat(pickerStyle.paddingLeft) || 0) + (parseFloat(pickerStyle.paddingRight) || 0);
  const gap = parseFloat(pickerStyle.columnGap || pickerStyle.gap) || 0;

  const icon = picker.querySelector(".fa-calendar-alt");
  const iconW = icon ? Math.ceil(icon.getBoundingClientRect().width) : 34;

  const clearBtn = picker.querySelector(".process-list-date-clear");
  const clearVisible = clearBtn && getComputedStyle(clearBtn).display !== "none";
  const clearW = clearVisible ? Math.ceil(clearBtn.getBoundingClientRect().width) : 0;

  const chevron = picker.querySelector(".transaction-date-range-chevron");
  const chevronW = chevron ? Math.ceil(chevron.getBoundingClientRect().width) : 10;

  const flexChildren = 1 + (clearW ? 1 : 0) + (chevronW ? 1 : 0);
  const gaps = gap * Math.max(0, flexChildren);

  const needed = Math.ceil(iconW + textW + clearW + chevronW + gaps + padX + 2);
  return Math.min(Math.max(BANK_TOOLBAR_CALENDAR_MIN_PX, needed), viewportCap);
}

function getCalendarPopupNodes() {
  if (typeof document === "undefined") return [];
  return [...document.querySelectorAll(`[id="${CALENDAR_POPUP_ID}"]`)];
}

/** Prefer the open popup, otherwise the in-page copy tied to the active picker. */
function resolveCalendarPopup(pickerEl) {
  const popups = getCalendarPopupNodes();
  if (!popups.length) return null;

  const openPopup = popups.find(isCalendarPopupVisuallyOpen);
  if (openPopup) return openPopup;

  const pageRoot = pickerEl?.closest?.(
    ".ec-page-shell__content, .dashboard-container, .transaction-container, .container, main, #root",
  );
  const inPagePopup = pageRoot?.querySelector?.(`#${CALENDAR_POPUP_ID}`);
  if (inPagePopup) return inPagePopup;

  const treePopup = popups.find((popup) => popup.parentElement !== document.body);
  return treePopup || popups[0];
}

function dedupeStaleCalendarPopups(preferredPopup) {
  const popups = getCalendarPopupNodes();
  if (popups.length <= 1) return preferredPopup || popups[0] || null;

  const keep =
    preferredPopup && popups.includes(preferredPopup)
      ? preferredPopup
      : popups.find((popup) => popup.parentElement !== document.body) || popups[0];

  popups.forEach((popup) => {
    if (popup === keep) return;
    hideCalendarPopupElement(popup);
    popup.remove();
  });
  return keep;
}

export function isMaintenanceCalendarOpen() {
  return getCalendarPopupNodes().some(isCalendarPopupVisuallyOpen);
}

function isCalendarPopupVisuallyOpen(popup) {
  if (!popup) return false;
  if (popup.getAttribute("data-open") === "true") return true;
  const inlineDisplay = popup.style.display;
  if (inlineDisplay && inlineDisplay !== "none") return true;
  return getComputedStyle(popup).display !== "none";
}

function hideCalendarPopupElement(popup) {
  if (!popup) return;
  popup.removeAttribute("data-open");
  popup.setAttribute("aria-hidden", "true");
  popup.classList.remove("calendar-popup--match-anchor", "calendar-popup--above-export-modal");
  popup.style.display = "none";

  const home = calendarPopupHomeParent.get(popup);
  if (home?.isConnected && popup.parentElement === document.body) {
    home.appendChild(popup);
    calendarPopupHomeParent.delete(popup);
  }
}

/** Close popup and remove body-portal copies left after SPA route changes. */
export function resetMaintenanceCalendarPopupOnNavigation() {
  if (typeof document === "undefined") return;

  getCalendarPopupNodes().forEach((popup) => {
    hideCalendarPopupElement(popup);
    if (popup.parentElement === document.body) {
      popup.remove();
    }
  });

  document.body.removeAttribute("data-calendar-open");
  document.body.style.removeProperty("--bank-toolbar-date-width");
  const bankFooter = document.getElementById("calendar-popup-bank-footer");
  if (bankFooter) bankFooter.style.display = "none";
}

export function closeMaintenanceCalendarPopup() {
  let closed = false;
  getCalendarPopupNodes().forEach((popup) => {
    if (!isCalendarPopupVisuallyOpen(popup)) return;
    hideCalendarPopupElement(popup);
    closed = true;
  });
  if (!closed) return;
  document.body.removeAttribute("data-calendar-open");
  document.body.style.removeProperty("--bank-toolbar-date-width");
  const bankFooter = document.getElementById("calendar-popup-bank-footer");
  if (bankFooter) bankFooter.style.display = "none";
}

function isCalendarDismissIgnoredTarget(target) {
  if (!target?.closest) return false;
  return !!(
    target.closest(".date-range-picker") ||
    target.closest(`#${CALENDAR_POPUP_ID}`) ||
    target.closest(".transaction-calendar-presets") ||
    target.closest(".transaction-calendar-preset") ||
    target.closest(".transaction-calendar-panel") ||
    target.closest(".report-date-range-picker-container") ||
    target.closest(".transaction-payment-history-export-modal") ||
    target.closest(".bank-form-day-picker") ||
    target.closest(".bank-form-datepicker-wrap") ||
    target.closest(".form-datepicker-wrap")
  );
}

function isPointerInsideCalendarPopup(event) {
  const popups = getCalendarPopupNodes();
  if (!popups.length) return false;
  const path = typeof event.composedPath === "function" ? event.composedPath() : [];
  if (popups.some((popup) => path.includes(popup))) return true;
  return isCalendarDismissIgnoredTarget(event.target);
}

export function bindMaintenanceCalendarDismissListeners() {
  if (typeof window === "undefined" || window.__maintenanceCalendarDismissBound) return;
  window.__maintenanceCalendarDismissBound = true;

  const dismissIfOpen = () => {
    if (isMaintenanceCalendarOpen()) closeMaintenanceCalendarPopup();
  };

  const onPointerDown = (e) => {
    if (!isMaintenanceCalendarOpen()) return;
    if (!isPointerInsideCalendarPopup(e)) closeMaintenanceCalendarPopup();
  };

  const passiveCapture = { capture: true, passive: true };
  window.addEventListener("scroll", dismissIfOpen, passiveCapture);
  document.addEventListener("scroll", dismissIfOpen, passiveCapture);
  window.addEventListener("wheel", dismissIfOpen, passiveCapture);
  document.addEventListener("touchmove", dismissIfOpen, passiveCapture);
  document.addEventListener("pointerdown", onPointerDown, { capture: true });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") dismissIfOpen();
  });
  document.addEventListener("click", (e) => {
    const dropdown = document.getElementById("quick-select-dropdown");
    const inToggle =
      e.target.closest?.(".quick-select-dropdown-toggle") || e.target.closest?.("#quick-select-dropdown");
    if (dropdown && !inToggle) dropdown.classList.remove("show");
  });
}

bindMaintenanceCalendarDismissListeners();

let initialized = false;

export function ensureMaintenanceDateRangePicker() {
  bindMaintenanceCalendarDismissListeners();
  if (initialized && window.MaintenanceDateRangePicker?.init) return;

  let calendarStartDate = null;
  let calendarEndDate = null;
  let isSelectingRange = false;
  /** Bank Process：打开日历 / 重选过程中暂存已提交范围，防止 display 被清空 */
  let stashedCommittedRange = null;
  let calendarCurrentDate = new Date();
  let calendarViewMode = "days";
  let monthLabels = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  let config = {
    dateFromId: "date_from",
    dateToId: "date_to",
    /** Visible span id for the “search” / primary date-range bar (Capture Date, etc.). */
    rangeDisplayId: "date-range-display",
    onChange: null,
    allowEmpty: false,
    placeholder: "Select date range",
    /** Shown after user picked start date and before end date (range selection). */
    selectEndDateHint: "Select end date",
    clearDateLabel: "Clear",
    monthLabels,
  };

  /** Which hidden inputs + display span the shared #calendar-popup edits (multi-trigger support). */
  let activeRangeBinding = {
    dateFromId: "date_from",
    dateToId: "date_to",
    displayId: "date-range-display",
    hidePresets: false,
    /** Show one date text when range start equals end (add / rate transaction pickers). */
    collapseSingleDisplay: false,
    hideClear: false,
  };

  function setActiveRangeBindingFromTrigger(pickerEl) {
    const el = pickerEl?.closest?.(".date-range-picker") || pickerEl;
    if (!el || !el.classList?.contains("date-range-picker")) return;
    activeRangeBinding = {
      dateFromId: el.dataset.drpFrom || config.dateFromId,
      dateToId: el.dataset.drpTo || config.dateToId,
      displayId: el.dataset.drpDisplay || config.rangeDisplayId || "date-range-display",
      hidePresets: el.dataset.drpHidePresets === "true",
      collapseSingleDisplay: el.dataset.drpCollapseSingle === "true",
      hideClear: el.dataset.drpHideClear === "true",
    };
  }

  /** Bind the shared singleton to the page's own Capture Date picker (falls back to bare defaults). */
  function bindActiveRangeToCaptureDatePicker() {
    const toolbarPicker =
      document.querySelector(".bank-process-toolbar-primary .date-range-picker#date-range-picker") ||
      document.getElementById("date-range-picker");
    if (toolbarPicker) {
      setActiveRangeBindingFromTrigger(toolbarPicker);
      return true;
    }
    activeRangeBinding = {
      dateFromId: config.dateFromId,
      dateToId: config.dateToId,
      displayId: config.rangeDisplayId || "date-range-display",
      hidePresets: false,
      collapseSingleDisplay: false,
      hideClear: false,
    };
    return false;
  }

  /** Modal unmount can leave binding pointing at removed hidden inputs — fall back to toolbar / defaults. */
  function ensureActiveBindingTargets() {
    const fromId = activeRangeBinding?.dateFromId;
    const toId = activeRangeBinding?.dateToId;
    if (fromId && toId && document.getElementById(fromId) && document.getElementById(toId)) {
      return;
    }
    bindActiveRangeToCaptureDatePicker();
  }

  function notifyActivePickerChanged() {
    const picker = document.querySelector(
      `.date-range-picker[data-drp-from="${activeRangeBinding.dateFromId}"]`,
    );
    picker?.dispatchEvent(new CustomEvent("ec:date-changed", { bubbles: true }));
  }

  function runOnChange() {
    if (typeof config.onChange === "function") config.onChange();
    notifyActivePickerChanged();
  }

  function formatDateDisplay(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${day}/${month}/${year}`;
  }

  function formatRangeDisplayText(fromText, toText) {
    if (!fromText) return config.placeholder || "Select date range";
    if (!toText) return fromText;
    /* Capture Date / report filters: always show full range (legacy transaction.php behaviour). */
    return `${fromText} - ${toText}`;
  }

  function stashCommittedRangeFromHidden(binding) {
    const b = binding || activeRangeBinding;
    const fv = document.getElementById(b.dateFromId)?.value?.trim();
    const tv = document.getElementById(b.dateToId)?.value?.trim();
    stashedCommittedRange = fv && tv ? { from: fv, to: tv } : null;
  }

  function paintStashedCommittedRange(binding) {
    if (!stashedCommittedRange?.from || !stashedCommittedRange?.to) return false;
    const b = binding || activeRangeBinding;
    const display = document.getElementById(b.displayId);
    if (!display) return false;
    const fd = parseDmy(stashedCommittedRange.from);
    const td = parseDmy(stashedCommittedRange.to);
    if (!fd || !td) return false;
    const collapse = collapseSingleDisplayForBinding(b);
    const a = formatDateDisplay(fd);
    const c = formatDateDisplay(td);
    display.textContent =
      collapse && stashedCommittedRange.from === stashedCommittedRange.to ? a : formatRangeDisplayText(a, c);
    return true;
  }

  function hasCommittedRangeInHidden(binding) {
    const b = binding || activeRangeBinding;
    const fv = document.getElementById(b.dateFromId)?.value?.trim();
    const tv = document.getElementById(b.dateToId)?.value?.trim();
    return !!(fv && tv);
  }

  function syncPickerSelectedRangeClass(displayIdOverride) {
    const display = document.getElementById(displayIdOverride || activeRangeBinding.displayId);
    const picker =
      display?.closest?.(".date-range-picker") ||
      document.querySelector(
        `.date-range-picker[data-drp-display="${activeRangeBinding.displayId}"]`,
      );
    if (!picker || !display) return;
    const placeholder = config.placeholder || "Select date range";
    picker.classList.toggle("has-selected-range", display.textContent.trim() !== placeholder);
  }

  /** Bank Process 顶栏：药丸宽度 = 日历 dropdown 宽度（未选/已选一致） */
  function syncBankToolbarDatePillWidth() {
    const picker = document.querySelector(
      ".bank-process-toolbar-primary .transaction-date-range-group .date-range-picker",
    );
    if (!picker) return;

    const width = getBankToolbarUnifiedBlockWidth();
    document.documentElement.style.setProperty("--bank-toolbar-date-pill-width", `${width}px`);
  }

  let bankToolbarDatePillResizeBound = false;
  function bindBankToolbarDatePillResize() {
    if (bankToolbarDatePillResizeBound || typeof window === "undefined") return;
    bankToolbarDatePillResizeBound = true;
    let resizeTimer = null;
    window.addEventListener("resize", () => {
      if (resizeTimer) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        syncBankToolbarDatePillWidth();
      }, 120);
    });
  }

  function updateDateRangeDisplay(displayIdOverride) {
    const display = document.getElementById(displayIdOverride || activeRangeBinding.displayId);
    if (!display) return;

    if (config.preserveDisplayUntilCommit) {
      if (hasCommittedRangeInHidden()) {
        stashCommittedRangeFromHidden(activeRangeBinding);
        paintDisplayFromDomHiddens(activeRangeBinding);
        syncPickerSelectedRangeClass(displayIdOverride);
        syncBankToolbarDatePillWidth();
        return;
      }
      if (paintStashedCommittedRange(activeRangeBinding)) {
        syncPickerSelectedRangeClass(displayIdOverride);
        syncBankToolbarDatePillWidth();
        return;
      }
      if (isSelectingRange || (calendarStartDate && !calendarEndDate)) {
        display.textContent = config.placeholder || "Select date range";
        syncPickerSelectedRangeClass(displayIdOverride);
        syncBankToolbarDatePillWidth();
        return;
      }
    }

    if (calendarStartDate && calendarEndDate) {
      const a = formatDateDisplay(calendarStartDate);
      const b = formatDateDisplay(calendarEndDate);
      display.textContent =
        activeRangeBinding.collapseSingleDisplay && a === b ? a : formatRangeDisplayText(a, b);
    } else if (calendarStartDate) {
      const hint = config.selectEndDateHint || "Select end date";
      display.textContent = `${formatDateDisplay(calendarStartDate)} - ${hint}`;
    } else {
      display.textContent = config.placeholder || "Select date range";
    }
    syncPickerSelectedRangeClass(displayIdOverride);
    syncBankToolbarDatePillWidth();
  }

  function setWeekdaysVisible(visible) {
    const weekdays = document.querySelector("#calendar-popup .calendar-weekdays");
    if (weekdays) weekdays.style.display = visible ? "" : "none";
  }

  function updateHeaderTriggerActive(activeMode) {
    const monthControl = document.getElementById("calendar-month-select");
    const yearControl = document.getElementById("calendar-year-select");
    if (monthControl) monthControl.classList.toggle("is-active", activeMode === "months");
    if (yearControl) yearControl.classList.toggle("is-active", activeMode === "years");
  }

  function setMonthControlValue(monthIndex) {
    const monthControl = document.getElementById("calendar-month-select");
    if (!monthControl) return;
    monthControl.value = String(monthIndex);
    if (monthControl.tagName !== "SELECT") {
      monthControl.textContent = config.monthLabels[monthIndex] || "";
    }
  }

  function setYearControlValue(year) {
    const yearControl = document.getElementById("calendar-year-select");
    if (!yearControl) return;
    yearControl.value = String(year);
    if (yearControl.tagName !== "SELECT") {
      yearControl.textContent = String(year);
    }
  }

  function collapseSingleDisplayForBinding(binding) {
    const b = binding || activeRangeBinding;
    if (b.collapseSingleDisplay) return true;
    if (!b?.displayId) return false;
    const pick = document.querySelector(`[data-drp-display="${b.displayId}"]`);
    return pick?.dataset?.drpCollapseSingle === "true";
  }

  function paintDisplayFromDomHiddens(binding) {
    const b = binding || activeRangeBinding;
    const display = document.getElementById(b.displayId);
    if (!display) return;
    const fv = document.getElementById(b.dateFromId)?.value?.trim();
    const tv = document.getElementById(b.dateToId)?.value?.trim();
    const collapse = collapseSingleDisplayForBinding(b);
    const fd = parseDmy(fv);
    const td = parseDmy(tv);
    if (fd && td) {
      const a = formatDateDisplay(fd);
      const c = formatDateDisplay(td);
      display.textContent = collapse && fv === tv ? a : formatRangeDisplayText(a, c);
    } else if (fd) {
      display.textContent = formatDateDisplay(fd);
    } else {
      display.textContent = config.placeholder || "Select date range";
    }
    syncPickerSelectedRangeClass(b.displayId);
  }

  function syncToHiddenInputs() {
    ensureActiveBindingTargets();
    const fromEl = document.getElementById(activeRangeBinding.dateFromId);
    const toEl = document.getElementById(activeRangeBinding.dateToId);
    if (fromEl) fromEl.value = calendarStartDate ? formatDateDisplay(calendarStartDate) : "";
    if (toEl) toEl.value = calendarEndDate ? formatDateDisplay(calendarEndDate) : "";
  }

  function parseDmy(val) {
    const m = String(val || "").trim().match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
    if (!m) return null;
    const d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
    if (Number.isNaN(d.getTime())) return null;
    d.setHours(0, 0, 0, 0);
    return d;
  }

  function getQuickRangeDates(range) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let startDate = null;
    let endDate = null;
    if (range === "today") {
      startDate = new Date(today);
      endDate = new Date(today);
    } else if (range === "yesterday") {
      const d = new Date(today);
      d.setDate(d.getDate() - 1);
      startDate = d;
      endDate = d;
    } else if (range === "thisWeek") {
      const dayMon0 = (today.getDay() + 6) % 7;
      startDate = new Date(today);
      startDate.setDate(today.getDate() - dayMon0);
      endDate = new Date(today);
    } else if (range === "lastWeek") {
      const dayMon0 = (today.getDay() + 6) % 7;
      endDate = new Date(today);
      endDate.setDate(today.getDate() - dayMon0 - 1);
      startDate = new Date(endDate);
      startDate.setDate(endDate.getDate() - 6);
    } else if (range === "thisMonth") {
      startDate = new Date(today.getFullYear(), today.getMonth(), 1);
      endDate = new Date(today);
    } else if (range === "lastMonth") {
      startDate = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      endDate = new Date(today.getFullYear(), today.getMonth(), 0);
    } else if (range === "thisYear") {
      startDate = new Date(today.getFullYear(), 0, 1);
      endDate = new Date(today);
    } else if (range === "lastYear") {
      const y = today.getFullYear() - 1;
      startDate = new Date(y, 0, 1);
      endDate = new Date(y, 11, 31);
    }
    if (!startDate || !endDate) return null;
    startDate.setHours(0, 0, 0, 0);
    endDate.setHours(0, 0, 0, 0);
    return { startDate, endDate };
  }

  function updateQuickPresetActive(activeKey) {
    document.querySelectorAll(".transaction-calendar-preset[data-period-key]").forEach((btn) => {
      const isActive = activeKey && btn.getAttribute("data-period-key") === activeKey;
      btn.classList.toggle("is-active", !!isActive);
      btn.setAttribute("aria-pressed", isActive ? "true" : "false");
    });
  }

  function bindTransactionCalendarPresetButtons() {
    const popup = document.getElementById(CALENDAR_POPUP_ID);
    if (!popup) return;
    popup.querySelectorAll(".transaction-calendar-preset[data-period-key]").forEach((btn) => {
      if (btn.dataset.drpPresetBound === "1") return;
      btn.dataset.drpPresetBound = "1";
      btn.addEventListener(
        "click",
        (e) => {
          e.preventDefault();
          e.stopPropagation();
          const key = btn.getAttribute("data-period-key");
          if (key) setQuickRange(key);
        },
        { capture: true },
      );
    });
  }

  function inferCalendarNavDelta(btn) {
    const declared = Number(btn?.dataset?.drpNavDelta);
    if (declared === -1 || declared === 1) return declared;

    const icon = btn?.querySelector?.("i");
    if (icon?.classList?.contains("fa-chevron-left")) return -1;
    if (icon?.classList?.contains("fa-chevron-right")) return 1;

    const header = btn?.closest?.(".calendar-header");
    const siblings = header ? [...header.querySelectorAll(".calendar-nav-btn")] : [];
    const idx = siblings.indexOf(btn);
    if (idx === 0) return -1;
    if (idx === siblings.length - 1) return 1;
    return 0;
  }

  /**
   * React-rendered popup is moved to document.body at runtime (non-React portal).
   * Native listeners keep nav arrows working after that move.
   */
  function bindCalendarNavButtons() {
    const popup = document.getElementById(CALENDAR_POPUP_ID);
    if (!popup) return;
    popup.querySelectorAll(".calendar-nav-btn").forEach((btn) => {
      if (btn.dataset.drpNavBound === "1") return;
      btn.dataset.drpNavBound = "1";
      btn.addEventListener(
        "click",
        (e) => {
          e.preventDefault();
          e.stopPropagation();
          const delta = inferCalendarNavDelta(btn);
          if (!delta) return;
          changeMonth(delta);
        },
        { capture: true },
      );
    });
  }

  function detectMatchingQuickRange() {
    if (!calendarStartDate || !calendarEndDate) return "";
    const keys = ["today", "yesterday", "thisWeek", "lastWeek", "thisMonth", "lastMonth", "thisYear", "lastYear"];
    const startTime = calendarStartDate.getTime();
    const endTime = calendarEndDate.getTime();
    return keys.find((key) => {
      const range = getQuickRangeDates(key);
      return range && range.startDate.getTime() === startTime && range.endDate.getTime() === endTime;
    }) || "";
  }

  /** Same as legacy: refresh internal range from hidden #date_from / #date_to when opening the popup. */
  function syncRangeStateFromHiddenInputs() {
    const fromEl = document.getElementById(activeRangeBinding.dateFromId);
    const toEl = document.getElementById(activeRangeBinding.dateToId);
    const fromDate = fromEl ? parseDmy(fromEl.value) : null;
    const toDate = toEl ? parseDmy(toEl.value) : null;
    if (fromDate && toDate) {
      calendarStartDate = new Date(fromDate);
      calendarEndDate = new Date(toDate);
    } else if (fromDate) {
      calendarStartDate = new Date(fromDate);
      calendarEndDate = new Date(fromDate);
    } else if (!config.allowEmpty) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      calendarStartDate = new Date(today);
      calendarEndDate = new Date(today);
    } else {
      calendarStartDate = null;
      calendarEndDate = null;
    }
    if (calendarStartDate) calendarStartDate.setHours(0, 0, 0, 0);
    if (calendarEndDate) calendarEndDate.setHours(0, 0, 0, 0);
    isSelectingRange = false;
  }

  function highlightPreviewRange(hoverDate) {
    const days = document.querySelectorAll("#calendar-popup .calendar-day");
    if (!calendarStartDate || calendarEndDate) return;
    const startTime = calendarStartDate.getTime();
    const hoverTime = hoverDate.getTime();
    const yearSelect = document.getElementById("calendar-year-select");
    const monthSelect = document.getElementById("calendar-month-select");
    if (!yearSelect || !monthSelect) return;
    const year = Number(yearSelect.value);
    const month = Number(monthSelect.value);
    days.forEach((day) => {
      day.classList.remove("preview-range", "preview-end");
      const dayText = parseInt(day.textContent, 10);
      if (!dayText) return;
      let dayDate;
      if (day.classList.contains("other-month")) {
        if (dayText > 20) {
          dayDate = new Date(year, month - 1, dayText);
        } else {
          dayDate = new Date(year, month + 1, dayText);
        }
      } else {
        dayDate = new Date(year, month, dayText);
      }
      dayDate.setHours(0, 0, 0, 0);
      const dayTime = dayDate.getTime();
      const minTime = Math.min(startTime, hoverTime);
      const maxTime = Math.max(startTime, hoverTime);
      if (dayTime > minTime && dayTime < maxTime) day.classList.add("preview-range");
      else if (dayTime === hoverTime && dayTime !== startTime) day.classList.add("preview-end");
    });
  }

  function initCalendar() {
    const today = new Date();
    if (!calendarStartDate && !config.allowEmpty) {
      calendarStartDate = new Date(today);
      calendarStartDate.setHours(0, 0, 0, 0);
      calendarEndDate = new Date(today);
      calendarEndDate.setHours(0, 0, 0, 0);
    }
    isSelectingRange = !!(calendarStartDate && !calendarEndDate);
    if (calendarStartDate) {
      calendarCurrentDate = new Date(calendarStartDate.getFullYear(), calendarStartDate.getMonth(), 1);
    } else {
      calendarCurrentDate = new Date(today.getFullYear(), today.getMonth(), 1);
    }
    const yearSelect = document.getElementById("calendar-year-select");
    if (yearSelect && yearSelect.tagName === "SELECT") {
      yearSelect.innerHTML = "";
      const currentYear = today.getFullYear();
      for (let year = 2022; year <= currentYear + 1; year += 1) {
        const option = document.createElement("option");
        option.value = String(year);
        option.textContent = String(year);
        if (year === calendarCurrentDate.getFullYear()) option.selected = true;
        yearSelect.appendChild(option);
      }
    }
    setMonthControlValue(calendarCurrentDate.getMonth());
    setYearControlValue(calendarCurrentDate.getFullYear());
    updateDateRangeDisplay();
    updateQuickPresetActive(detectMatchingQuickRange());
  }

  function renderMonthPicker() {
    const daysContainer = document.getElementById("calendar-days");
    const yearSelect = document.getElementById("calendar-year-select");
    if (!daysContainer || !yearSelect) return;
    calendarViewMode = "months";
    updateHeaderTriggerActive("months");
    setWeekdaysVisible(false);
    daysContainer.classList.remove("calendar-year-grid");
    daysContainer.classList.add("calendar-month-grid");
    daysContainer.innerHTML = "";
    const currentMonth = Number(document.getElementById("calendar-month-select")?.value ?? calendarCurrentDate.getMonth());
    config.monthLabels.forEach((label, monthIndex) => {
      const monthButton = document.createElement("button");
      monthButton.type = "button";
      monthButton.className = "calendar-month-option";
      if (monthIndex === currentMonth) monthButton.classList.add("is-active");
      monthButton.textContent = label;
      monthButton.addEventListener("click", (e) => {
        e.stopPropagation();
        calendarCurrentDate = new Date(Number(yearSelect.value), monthIndex, 1);
        setMonthControlValue(monthIndex);
        renderCalendar();
      });
      daysContainer.appendChild(monthButton);
    });
  }

  function getYearBounds() {
    const currentYear = new Date().getFullYear();
    return { minYear: 2022, maxYear: currentYear + 1 };
  }

  function renderYearPicker() {
    const daysContainer = document.getElementById("calendar-days");
    const yearControl = document.getElementById("calendar-year-select");
    if (!daysContainer || !yearControl) return;
    calendarViewMode = "years";
    updateHeaderTriggerActive("years");
    setWeekdaysVisible(false);
    daysContainer.classList.remove("calendar-month-grid");
    daysContainer.classList.add("calendar-year-grid");
    daysContainer.innerHTML = "";
    const { minYear, maxYear } = getYearBounds();
    const selectedYear = Number(yearControl.value) || calendarCurrentDate.getFullYear();
    const rangeStart = Math.max(minYear, Math.min(selectedYear - 3, maxYear - 7));
    const rangeEnd = Math.min(maxYear, rangeStart + 7);
    for (let year = rangeStart; year <= rangeEnd; year += 1) {
      const yearButton = document.createElement("button");
      yearButton.type = "button";
      yearButton.className = "calendar-year-option";
      if (year === selectedYear) yearButton.classList.add("is-active");
      yearButton.textContent = String(year);
      yearButton.addEventListener("click", (e) => {
        e.stopPropagation();
        calendarCurrentDate = new Date(year, calendarCurrentDate.getMonth(), 1);
        setYearControlValue(year);
        renderCalendar();
      });
      daysContainer.appendChild(yearButton);
    }
  }

  function renderCalendar() {
    calendarViewMode = "days";
    updateHeaderTriggerActive("");
    setWeekdaysVisible(true);
    const yearSelect = document.getElementById("calendar-year-select");
    const monthSelect = document.getElementById("calendar-month-select");
    if (!yearSelect || !monthSelect) return;
    const year = Number(yearSelect.value);
    const month = Number(monthSelect.value);
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const prevLastDay = new Date(year, month, 0);
    const firstDayWeek = firstDay.getDay();
    const lastDate = lastDay.getDate();
    const prevLastDate = prevLastDay.getDate();
    const daysContainer = document.getElementById("calendar-days");
    if (!daysContainer) return;
    daysContainer.classList.remove("calendar-month-grid", "calendar-year-grid");
    daysContainer.innerHTML = "";

    function createDayElement(day, y, m, isOtherMonth) {
      const dayElement = document.createElement("div");
      dayElement.className = "calendar-day";
      dayElement.textContent = String(day);
      const date = new Date(y, m, day);
      date.setHours(0, 0, 0, 0);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      if (isOtherMonth) dayElement.classList.add("other-month");
      if (date.getTime() === today.getTime() && !isOtherMonth) dayElement.classList.add("today");

      if (calendarStartDate) {
        const startTime = calendarStartDate.getTime();
        const currentTime = date.getTime();
        if (calendarEndDate) {
          const endTime = calendarEndDate.getTime();
          if (currentTime === startTime && currentTime === endTime) dayElement.classList.add("selected", "start-date", "end-date");
          else if (currentTime === startTime) dayElement.classList.add("start-date");
          else if (currentTime === endTime) dayElement.classList.add("end-date");
          else if (currentTime > startTime && currentTime < endTime) dayElement.classList.add("in-range");
        } else if (currentTime === startTime) {
          dayElement.classList.add("start-date", "selecting");
        }
      }

      dayElement.addEventListener("click", (e) => {
        e.stopPropagation();
        selectDate(date);
      });
      dayElement.addEventListener("mouseenter", () => {
        if (isSelectingRange && calendarStartDate && !calendarEndDate) highlightPreviewRange(date);
      });
      return dayElement;
    }

    for (let i = firstDayWeek - 1; i >= 0; i -= 1) {
      daysContainer.appendChild(createDayElement(prevLastDate - i, year, month - 1, true));
    }
    for (let day = 1; day <= lastDate; day += 1) {
      daysContainer.appendChild(createDayElement(day, year, month, false));
    }
    const totalCells = daysContainer.children.length;
    const remainingCells = totalCells % 7 === 0 ? 0 : 7 - (totalCells % 7);
    for (let day = 1; day <= remainingCells; day += 1) {
      daysContainer.appendChild(createDayElement(day, year, month + 1, true));
    }
  }

  function changeMonth(delta) {
    const monthSelect = document.getElementById("calendar-month-select");
    const yearSelect = document.getElementById("calendar-year-select");
    if (calendarViewMode === "months") {
      const { minYear, maxYear } = getYearBounds();
      const currentYear = Number(yearSelect?.value) || calendarCurrentDate.getFullYear();
      const nextYear = Math.min(maxYear, Math.max(minYear, currentYear + delta));
      calendarCurrentDate.setFullYear(nextYear);
      setYearControlValue(nextYear);
      renderMonthPicker();
      return;
    }
    if (calendarViewMode === "years") {
      const { minYear, maxYear } = getYearBounds();
      const currentYear = Number(yearSelect?.value) || calendarCurrentDate.getFullYear();
      const nextYear = Math.min(maxYear, Math.max(minYear, currentYear + delta * 8));
      calendarCurrentDate.setFullYear(nextYear);
      setYearControlValue(nextYear);
      renderYearPicker();
      return;
    }
    calendarCurrentDate.setMonth(calendarCurrentDate.getMonth() + delta);
    if (monthSelect) setMonthControlValue(calendarCurrentDate.getMonth());
    setYearControlValue(calendarCurrentDate.getFullYear());
    renderCalendar();
  }

  function bindDateRangePickers() {
    document.querySelectorAll(".date-range-picker").forEach((pick) => {
      if (pick.dataset.reactDatePickerBound === "true") return;
      pick.onclick = (e) => {
        e.stopPropagation();
        toggleCalendar(pick);
      };
    });
  }

  function togglePicker(pickerEl) {
    toggleCalendar(pickerEl);
  }

  function selectDate(date) {
    if (!calendarStartDate || (calendarStartDate && calendarEndDate)) {
      if (config.preserveDisplayUntilCommit) {
        stashCommittedRangeFromHidden(activeRangeBinding);
      }
      calendarStartDate = new Date(date);
      calendarEndDate = null;
      isSelectingRange = true;
      updateQuickPresetActive("");
      if (activeRangeBinding.collapseSingleDisplay) {
        calendarEndDate = new Date(date);
        isSelectingRange = false;
        syncToHiddenInputs();
        updateDateRangeDisplay();
        updateQuickPresetActive("");
        runOnChange();
        closeMaintenanceCalendarPopup();
        renderCalendar();
        return;
      }
    } else {
      if (date.getTime() < calendarStartDate.getTime()) {
        calendarEndDate = new Date(calendarStartDate);
        calendarStartDate = new Date(date);
      } else {
        calendarEndDate = new Date(date);
      }
      isSelectingRange = false;
      syncToHiddenInputs();
      updateDateRangeDisplay();
      updateQuickPresetActive(detectMatchingQuickRange());
      runOnChange();
      stashedCommittedRange = null;
      closeMaintenanceCalendarPopup();
    }
    renderCalendar();
    updateDateRangeDisplay();
  }

  function toggleCalendar(pickerEl) {
    const picker = pickerEl?.closest?.(".date-range-picker") || pickerEl || document.getElementById("date-range-picker");
    if (pickerEl || picker) setActiveRangeBindingFromTrigger(picker || pickerEl);
    ensureActiveBindingTargets();

    const popup = dedupeStaleCalendarPopups(resolveCalendarPopup(picker));
    if (!popup || !picker) return;

    const presets = document.querySelector(".transaction-calendar-presets");
    if (presets) {
      presets.style.display = activeRangeBinding.hidePresets ? "none" : "";
      presets.setAttribute("aria-hidden", activeRangeBinding.hidePresets ? "true" : "false");
    }

    if (popup.classList.contains("calendar-popup--transaction-range")) {
      popup.classList.toggle("calendar-popup--no-presets", !!activeRangeBinding.hidePresets);
    }

    if (!isMaintenanceCalendarOpen()) {
      if (config.preserveDisplayUntilCommit) {
        stashCommittedRangeFromHidden(activeRangeBinding);
      }
      syncRangeStateFromHiddenInputs();
      // Escape ancestor stacking contexts (e.g. Member Win/Loss filter bar isolation).
      if (popup.parentElement !== document.body) {
        calendarPopupHomeParent.set(popup, popup.parentElement);
        popup.dataset.drpPortal = "true";
        document.body.appendChild(popup);
      }
      popup.classList.toggle(
        "calendar-popup--above-export-modal",
        !!picker.closest?.(".transaction-payment-history-export-modal"),
      );
      let rect = picker.getBoundingClientRect();
      let barWidth = rect.width;
      const bankWrap =
        picker.closest(".bank-form-datepicker-wrap") || picker.closest(".form-datepicker-wrap");
      const bankListDateAnchor = picker.closest(
        ".bank-process-toolbar-primary .transaction-date-range-group",
      );
      const matchToolbarDateAnchor = !!bankListDateAnchor && !!activeRangeBinding.hidePresets;
      const shell = picker.closest(".report-outlined-shell");
      if (bankWrap) {
        rect = bankWrap.getBoundingClientRect();
        barWidth = rect.width;
      } else if (matchToolbarDateAnchor) {
        const anchorEl =
          picker.closest(".report-outlined-shell") ||
          (picker.classList?.contains("date-range-picker") ? picker : bankListDateAnchor);
        rect = anchorEl.getBoundingClientRect();
        syncBankToolbarDatePillWidth();
        const blockWidth = getBankToolbarUnifiedBlockWidth();
        document.body.style.setProperty("--bank-toolbar-date-width", `${blockWidth}px`);
        barWidth = blockWidth;
      } else if (shell) {
        rect = shell.getBoundingClientRect();
        barWidth = rect.width;
      } else {
        const parent = picker.parentElement;
        if (parent) {
          const parentRect = parent.getBoundingClientRect();
          if (
            parent.classList &&
            (parent.classList.contains("transaction-capture-date-row") || parent.classList.contains("transaction-date-range-group"))
          ) {
            barWidth = parentRect.width;
          } else if (parentRect.width > barWidth) {
            barWidth = parentRect.width;
          }
        }
      }
      if (popup.classList.contains("calendar-popup--transaction-range")) {
        const matchOutlinedShell = !!shell && !bankWrap;
        const showPresets = !activeRangeBinding.hidePresets;
        const popupWidth = Math.min(Math.max(window.innerWidth * 0.22, 316), 336);
        const useAnchorWidth =
          bankWrap || matchToolbarDateAnchor || (matchOutlinedShell && !showPresets);
        if (useAnchorWidth) {
          const anchorWidth = Math.max(1, Math.round(barWidth));
          popup.classList.add("calendar-popup--match-anchor");
          const popupLeft =
            matchToolbarDateAnchor || matchOutlinedShell
              ? Math.max(12, Math.min(rect.left, window.innerWidth - anchorWidth - 12))
              : rect.left;
          popup.style.left = `${popupLeft}px`;
          popup.style.width = `${anchorWidth}px`;
          popup.style.minWidth = `${anchorWidth}px`;
          popup.style.maxWidth = `${anchorWidth}px`;
        } else {
          popup.classList.remove("calendar-popup--match-anchor");
          const maxLeft = window.innerWidth - popupWidth - 12;
          popup.style.left = `${Math.max(12, Math.min(rect.left, maxLeft))}px`;
          popup.style.width = "";
          popup.style.minWidth = "";
          popup.style.maxWidth = "calc(100vw - 24px)";
        }
      } else {
        popup.classList.remove("calendar-popup--match-anchor");
        popup.style.left = `${rect.left}px`;
        popup.style.width = `${barWidth}px`;
        popup.style.minWidth = "";
        popup.style.maxWidth = "";
      }
      popup.style.top = `${rect.bottom + 8}px`;
      popup.style.boxSizing = "border-box";
      popup.setAttribute("data-open", "true");
      popup.setAttribute("aria-hidden", "false");
      popup.style.display = "block";
      document.body.setAttribute("data-calendar-open", "true");
      bindTransactionCalendarPresetButtons();
      bindCalendarNavButtons();
      initCalendar();
      renderCalendar();
      updateCalendarClearFooter();
      if (config.preserveDisplayUntilCommit) {
        paintDisplayFromDomHiddens(activeRangeBinding);
      }
    } else {
      if (config.preserveDisplayUntilCommit) {
        syncRangeStateFromHiddenInputs();
        paintDisplayFromDomHiddens(activeRangeBinding);
      }
      closeMaintenanceCalendarPopup();
    }
  }

  function updateCalendarClearFooter() {
    const wrap = document.getElementById("calendar-popup-clear-wrap");
    const btn = document.getElementById("calendar-popup-clear-btn");
    if (!wrap || !btn) return;
    const show = !!activeRangeBinding.collapseSingleDisplay && !activeRangeBinding.hideClear;
    wrap.style.display = show ? "flex" : "none";
    wrap.setAttribute("aria-hidden", show ? "false" : "true");
    btn.textContent = config.clearDateLabel || "Clear";
    const fromEl = document.getElementById(activeRangeBinding.dateFromId);
    const hasValue = !!(fromEl?.value?.trim());
    btn.disabled = !hasValue;
  }

  function bindCalendarClearFooterOnce() {
    const btn = document.getElementById("calendar-popup-clear-btn");
    if (!btn || btn.dataset.bound === "1") return;
    btn.dataset.bound = "1";
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      clearSelection(true);
    });
  }

  function clearSelection(triggerOnChange) {
    calendarStartDate = null;
    calendarEndDate = null;
    isSelectingRange = false;
    stashedCommittedRange = null;
    syncToHiddenInputs();
    updateDateRangeDisplay();
    updateQuickPresetActive("");
    renderCalendar();
    updateCalendarClearFooter();
    closeMaintenanceCalendarPopup();
    if (triggerOnChange !== false) runOnChange();
  }

  let quickRangeGuard = { key: "", at: 0 };

  function setQuickRange(range) {
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    if (quickRangeGuard.key === range && now - quickRangeGuard.at < 80) return;
    quickRangeGuard = { key: range, at: now };

    ensureActiveBindingTargets();
    const quickRange = getQuickRangeDates(range);
    if (!quickRange) {
      return;
    }
    if (activeRangeBinding.collapseSingleDisplay) {
      const singleDate = new Date(quickRange.endDate);
      singleDate.setHours(0, 0, 0, 0);
      calendarStartDate = singleDate;
      calendarEndDate = new Date(singleDate);
    } else {
      calendarStartDate = quickRange.startDate;
      calendarEndDate = quickRange.endDate;
    }
    isSelectingRange = false;
    calendarCurrentDate = new Date(calendarStartDate.getFullYear(), calendarStartDate.getMonth(), 1);
    setMonthControlValue(calendarCurrentDate.getMonth());
    setYearControlValue(calendarCurrentDate.getFullYear());
    syncToHiddenInputs();
    updateDateRangeDisplay();
    updateQuickPresetActive(range);
    renderCalendar();
    runOnChange();
    closeMaintenanceCalendarPopup();
    const qd = document.getElementById("quick-select-dropdown");
    if (qd) qd.classList.remove("show");
  }

  window.changeMonth = changeMonth;
  window.selectQuickRange = setQuickRange;
  window.toggleQuickSelectDropdown = function toggleQuickSelectDropdown() {
    const dropdown = document.getElementById("quick-select-dropdown");
    if (dropdown) dropdown.classList.toggle("show");
  };
  window.MaintenanceDateRangePicker = {
    bindPickers: bindDateRangePickers,
    togglePicker,
    setLocaleStrings(partial) {
      if (!partial || typeof partial !== "object") return;
      config = { ...config, ...partial };
      if (partial.monthLabels) {
        monthLabels = partial.monthLabels;
        const popup = document.getElementById("calendar-popup");
        if (isMaintenanceCalendarOpen()) {
          renderCalendar();
        }
      }
      updateDateRangeDisplay(config.rangeDisplayId || "date-range-display");
      if (partial.clearDateLabel) {
        const btn = document.getElementById("calendar-popup-clear-btn");
        if (btn) btn.textContent = partial.clearDateLabel;
      }
      updateCalendarClearFooter();
    },
    getActiveRangeBinding() {
      return { ...activeRangeBinding };
    },
    /** Update the visible range text from DOM hidden inputs (e.g. after React writes #add_tx_date_*). */
    refreshInputsDisplay(binding) {
      const b = binding || activeRangeBinding;
      if (hasCommittedRangeInHidden(b)) {
        syncRangeStateFromHiddenInputs();
      }
      updateDateRangeDisplay(b.displayId);
    },
    syncBankToolbarDatePillWidth,
    init(options) {
      if (options) {
        config = { ...config, ...options };
        if (options.monthLabels) {
          monthLabels = options.monthLabels;
        }
      }
      /*
       * init() means a page is (re)taking over this shared singleton — any preserveDisplayUntilCommit
       * stash left over from whichever page/binding used it last is stale here and must not leak forward
       * (e.g. Dashboard's committed range bleeding into Bank Process's toolbar on SPA route switch, even
       * though calendarStartDate/hidden inputs below correctly resolve to this page's own blank state).
       */
      stashedCommittedRange = null;
      isSelectingRange = false;
      activeRangeBinding = {
        dateFromId: config.dateFromId,
        dateToId: config.dateToId,
        displayId: config.rangeDisplayId || "date-range-display",
        hidePresets: false,
        collapseSingleDisplay: false,
      };

      const fromEl = document.getElementById(config.dateFromId);
      const toEl = document.getElementById(config.dateToId);
      const fromDate = parseDmy(fromEl?.value);
      const toDate = parseDmy(toEl?.value);
      if (fromDate) {
        calendarStartDate = fromDate;
        calendarEndDate = toDate || new Date(fromDate);
      } else if (!config.allowEmpty) {
        const t = new Date();
        t.setHours(0, 0, 0, 0);
        calendarStartDate = new Date(t);
        calendarEndDate = new Date(t);
      } else {
        calendarStartDate = null;
        calendarEndDate = null;
      }
      syncToHiddenInputs();
      updateDateRangeDisplay();

      bindDateRangePickers();
      bindTransactionCalendarPresetButtons();
      bindCalendarNavButtons();
      bindBankToolbarDatePillResize();
      requestAnimationFrame(() => {
        syncBankToolbarDatePillWidth();
      });
      const monthSelect = document.getElementById("calendar-month-select");
      const yearSelect = document.getElementById("calendar-year-select");
      if (monthSelect) {
        if (monthSelect.tagName === "SELECT") {
          monthSelect.onchange = renderCalendar;
        } else {
          monthSelect.onclick = (e) => {
            e.stopPropagation();
            if (calendarViewMode === "months") renderCalendar();
            else renderMonthPicker();
          };
        }
      }
      if (yearSelect) {
        if (yearSelect.tagName === "SELECT") {
          yearSelect.onchange = renderCalendar;
        } else {
          yearSelect.onclick = (e) => {
            e.stopPropagation();
            if (calendarViewMode === "years") renderCalendar();
            else renderYearPicker();
          };
        }
      }
    },
    clear() {
      clearSelection(true);
    },
    clearForPicker(pickerEl) {
      setActiveRangeBindingFromTrigger(pickerEl);
      clearSelection(true);
    },
    /**
     * Force the shared picker singleton + Capture Date DOM to a DMY range.
     * Needed for SPA soft-refresh: remount alone does not clear module closure state.
     */
    commitRangeToDmy(fromDmy, toDmy, { triggerOnChange = false } = {}) {
      const fromDate = parseDmy(fromDmy);
      if (!fromDate) return false;
      const toDate = parseDmy(toDmy || fromDmy) || new Date(fromDate);
      fromDate.setHours(0, 0, 0, 0);
      toDate.setHours(0, 0, 0, 0);
      // This API is only ever used for Capture Date — force-bind to its own picker so a
      // previously-focused single-date picker (e.g. Transaction Date, which collapses a
      // same-day range to one date) can't leak its ids or display-collapse setting here.
      bindActiveRangeToCaptureDatePicker();
      calendarStartDate = fromDate;
      calendarEndDate = toDate;
      isSelectingRange = false;
      stashedCommittedRange = null;
      syncToHiddenInputs();
      updateDateRangeDisplay(activeRangeBinding.displayId || config.rangeDisplayId || "date-range-display");
      updateQuickPresetActive(detectMatchingQuickRange());
      if (triggerOnChange) runOnChange();
      return true;
    },
    getDateFrom() {
      return document.getElementById(config.dateFromId)?.value || "";
    },
    getDateTo() {
      return document.getElementById(config.dateToId)?.value || "";
    },
    closePopup: closeMaintenanceCalendarPopup,
    isOpen: isMaintenanceCalendarOpen,
  };

  bindCalendarClearFooterOnce();

  initialized = true;
}

/** Soft-refresh helper: pin Capture Date singleton/DOM to today (or given DMY). */
export function commitMaintenanceDateRangeToDmy(fromDmy, toDmy, options) {
  ensureMaintenanceDateRangePicker();
  return window.MaintenanceDateRangePicker?.commitRangeToDmy?.(fromDmy, toDmy, options) === true;
}

