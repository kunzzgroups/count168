import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import DataCaptureGrid from "./DataCaptureGrid.jsx";
import GroupOnlyTableSizeControl from "./GroupOnlyTableSizeControl.jsx";
import SimpleSelect from "../../../components/SimpleSelect.jsx";
import { CAPTURE_TYPE_OPTIONS } from "../lib/dataCaptureFormRules.js";
import { callDataCaptureRuntime } from "../lib/dataCaptureRuntime.js";
import { useDataCaptureGridViewportFit } from "../hooks/useDataCaptureGridViewportFit.js";

function captureTypeLabel(opt, t) {
  if (opt === "1.Text") return t("captureTypeText");
  if (opt === "2.Format") return t("captureTypeFormat");
  if (opt === "CITIBET") return t("captureTypeCitibet");
  if (opt === "4.RETURN") return t("captureTypeReturn");
  return opt;
}

function TableExpandIcon({ expanded }) {
  if (expanded) {
    return (
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
        <path
          fill="currentColor"
          d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"
        />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path
        fill="currentColor"
        d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"
      />
    </svg>
  );
}

/**
 * Bottom section: capture type, grid, submit.
 */
export default function DataCaptureTableSection({
  t,
  captureType,
  citibetMode = false,
  formatGridReady = false,
  hideCaptureTypeSelector = false,
  groupOnlyTable = false,
  /** Process "Save Data Capture Table" on → show Delete Draft (clear whole table). */
  saveDataCaptureTableEnabled = false,
  onCaptureTypeChange,
  submitDisabled = true,
  isSubmitting = false,
  onSubmit,
  onReset,
  engineReady = false,
}) {
  const tableAreaRef = useRef(null);
  const [tableExpanded, setTableExpanded] = useState(false);
  useDataCaptureGridViewportFit(groupOnlyTable, engineReady, tableAreaRef);

  const toggleTableExpanded = useCallback(() => {
    setTableExpanded((prev) => !prev);
  }, []);

  // Toggle on pointerdown (not click): clicking this button blurs the active
  // grid cell, which can reflow the grid between mousedown/mouseup and swallow
  // the click. Reacting on pointerdown makes a single tap/click reliable.
  const handleExpandPointerDown = useCallback(
    (event) => {
      if (event.button != null && event.button !== 0) return;
      event.preventDefault();
      toggleTableExpanded();
    },
    [toggleTableExpanded],
  );

  const handleExpandKeyDown = useCallback(
    (event) => {
      if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
        event.preventDefault();
        toggleTableExpanded();
      }
    },
    [toggleTableExpanded],
  );

  useEffect(() => {
    document.body.classList.toggle("datacapture-table-expanded", tableExpanded);
    return () => document.body.classList.remove("datacapture-table-expanded");
  }, [tableExpanded]);

  useEffect(() => {
    if (!tableExpanded) return undefined;
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        setTableExpanded(false);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [tableExpanded]);

  const captureTypeOptions = useMemo(
    () =>
      CAPTURE_TYPE_OPTIONS.filter(
        (opt) =>
          // Hidden from the dropdown for now (paste handling / auto-detect / saved snapshots still support them):
          // opt !== "2.Format" && opt !== "CITIBET"
          opt !== "2.Format" && opt !== "CITIBET",
      ).map((opt) => ({ value: opt, label: captureTypeLabel(opt, t) })),
    [t],
  );

  const formatPasteMode = captureType === "2.Format" && !formatGridReady;
  const containerClass = [
    "excel-table-container",
    groupOnlyTable ? "excel-table-container--group-only" : "",
    citibetMode ? "citibet-mode" : "",
    captureType === "1.Text" ? "capture-type-text" : "",
    captureType === "2.Format" ? "capture-type-format" : "",
    formatPasteMode ? "format-paste-mode" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const gridBody = (
    <>
      <DataCaptureGrid engineReady={engineReady} />
      <div id="tablePreviewFormat" className="table-preview-format" style={{ display: "none" }}>
        <iframe
          id="tablePreviewFrameFormat"
          className="table-preview-frame-format"
          title="Format Table Preview"
        />
      </div>
      <div
        id="pasteAreaFormat"
        className="paste-area-format"
        style={{ display: "none" }}
        contentEditable
        suppressContentEditableWarning
        data-placeholder="在此直接粘贴整张表格（支持Excel/Sheets复制的表格格式）..."
      />
    </>
  );

  return (
    <div className="bottom-section">
      <div className={containerClass}>
        <div
          className={`excel-table-header dc-table-header-bar${hideCaptureTypeSelector ? " dc-table-header-bar--group-only" : ""}`.trim()}
        >
          <div className="dc-table-header-main">
            <span className="dc-table-header-title">{t("dataCaptureTable")}</span>
            {hideCaptureTypeSelector ? (
              <>
                <button
                  type="button"
                  className="btn btn-cancel dc-table-header-reset-btn"
                  onClick={() => onReset?.()}
                >
                  {t("reset")}
                </button>
                {saveDataCaptureTableEnabled ? (
                  <button
                    type="button"
                    className="btn btn-cancel dc-table-header-delete-btn"
                    disabled={!engineReady}
                    title={t("deleteDraftTitle")}
                    onClick={() => callDataCaptureRuntime("deleteDraftClearTable")}
                  >
                    {t("deleteDraft")}
                  </button>
                ) : null}
              </>
            ) : null}
          </div>
          {!hideCaptureTypeSelector ? (
            <div className="dc-table-header-controls">
              <SimpleSelect
                id="dataCaptureTypeSelector"
                className="data-capture-type-selector"
                value={captureType}
                onChange={(v) => onCaptureTypeChange(v)}
                options={captureTypeOptions}
                includeEmptyOption={false}
                forcePortal
                portalDropdownClassName="dc-process-select-portal"
                ariaLabel={t("captureFormatAria")}
              />
              <button type="button" className="btn btn-cancel" onClick={() => onReset?.()}>
                {t("reset")}
              </button>
              {saveDataCaptureTableEnabled ? (
                <button
                  type="button"
                  className="btn btn-cancel dc-table-header-delete-btn"
                  disabled={!engineReady}
                  title={t("deleteDraftTitle")}
                  onClick={() => callDataCaptureRuntime("deleteDraftClearTable")}
                >
                  {t("deleteDraft")}
                </button>
              ) : null}
            </div>
          ) : null}
          {hideCaptureTypeSelector ? (
            <GroupOnlyTableSizeControl t={t} engineReady={engineReady} />
          ) : null}
          <button
            type="button"
            className="dc-table-expand-btn"
            aria-pressed={tableExpanded}
            title={tableExpanded ? t("tableCollapse") : t("tableExpand")}
            aria-label={tableExpanded ? t("tableCollapse") : t("tableExpand")}
            onPointerDown={handleExpandPointerDown}
            onKeyDown={handleExpandKeyDown}
          >
            <TableExpandIcon expanded={tableExpanded} />
          </button>
        </div>
        <div className="excel-table-scroll-body" ref={tableAreaRef}>
          {gridBody}
        </div>
      </div>

      <div className="form-actions">
        <button
          id="dataCaptureSubmitBtn"
          type="button"
          className="btn btn-save"
          disabled={submitDisabled || isSubmitting}
          style={{
            opacity: submitDisabled || isSubmitting ? 0.6 : 1,
            cursor: submitDisabled || isSubmitting ? "not-allowed" : "pointer",
          }}
          onClick={() => {
            void onSubmit?.();
          }}
        >
          {isSubmitting ? t("submitting") : t("submit")}
        </button>
      </div>
    </div>
  );
}
