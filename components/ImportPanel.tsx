"use client";

import { useMemo, useState } from "react";
import { formatClock, formatDay, sameDay } from "@/lib/format";
import { parseIcs, type IcsOccurrence, type IcsResult } from "@/lib/ics";
import type { BusyRow } from "@/lib/types";
import { Section } from "./SchedulePanels";

export const IMPORT_DAYS = 30;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

export type ImportItem = { key: string; title: string; start: number; end: number };
export type ImportOutcome = { inserted: number; existing: number } | { error: string };

type Props = {
  busy: BusyRow[];
  loadImportedKeys: (from: number) => Promise<Set<string> | null>;
  onImport: (items: ImportItem[]) => Promise<ImportOutcome>;
  onRemoveImported: () => Promise<number | null>;
};

type Preview = IcsResult & { fileName: string; duplicates: Set<string> };

export default function ImportPanel({ busy, loadImportedKeys, onImport, onRemoveImported }: Props) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [keepTitles, setKeepTitles] = useState(true);
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [inputKey, setInputKey] = useState(0);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    setErr(null);
    setDone(null);
    setPreview(null);
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) return setErr("That file is larger than 5 MB. Export a single calendar instead.");
    setReading(true);
    try {
      const text = await file.text();
      const from = Date.now();
      const result = parseIcs(text, from, from + IMPORT_DAYS * 24 * 3600_000);
      // Duplicates: imported before (same event key), or the exact same time is already blocked
      const keys = (await loadImportedKeys(from)) ?? new Set<string>();
      const blockedTimes = new Set(busy.map((b) => `${Date.parse(b.starts_at)}|${Date.parse(b.ends_at)}`));
      const duplicates = new Set(
        result.occurrences.filter((o) => keys.has(o.key) || blockedTimes.has(`${o.start}|${o.end}`)).map((o) => o.key),
      );
      setPreview({ ...result, fileName: file.name, duplicates });
      setSelected(new Set(result.occurrences.filter((o) => defaultOn(o, duplicates)).map((o) => o.key)));
    } catch (error) {
      setErr(error instanceof Error ? error.message : "This file could not be read.");
    } finally {
      setReading(false);
    }
  }

  function toggle(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function reset() {
    setPreview(null);
    setSelected(new Set());
    setInputKey((k) => k + 1);
  }

  async function confirm() {
    if (!preview) return;
    const items = preview.occurrences
      .filter((o) => selected.has(o.key))
      .map((o) => ({ key: o.key, title: keepTitles ? o.title : "Busy", start: o.start, end: o.end }));
    if (items.length === 0) return setErr("Select at least one event to import.");
    setErr(null);
    setSaving(true);
    const result = await onImport(items);
    setSaving(false);
    if ("error" in result) return setErr(result.error);
    setDone(
      `Imported ${result.inserted} event${result.inserted === 1 ? "" : "s"} as busy time` +
        (result.existing ? ` (${result.existing} already existed and ${result.existing === 1 ? "was" : "were"} skipped)` : "") +
        ". Click Replan to move study sessions around them.",
    );
    reset();
  }

  async function removeAll() {
    if (!window.confirm("Remove all upcoming events you imported from calendar files? Events you added by hand stay.")) return;
    setErr(null);
    const count = await onRemoveImported();
    if (count !== null) setDone(`Removed ${count} imported event${count === 1 ? "" : "s"}.`);
  }

  const groups = useMemo(() => {
    const out: { day: number; items: IcsOccurrence[] }[] = [];
    for (const o of preview?.occurrences ?? []) {
      const last = out[out.length - 1];
      if (last && sameDay(o.start, new Date(last.day))) last.items.push(o);
      else out.push({ day: o.start, items: [o] });
    }
    return out;
  }, [preview]);

  const total = preview?.occurrences.length ?? 0;

  return (
    <Section title="Import calendar" summary=".ics file">
      <p className="hint" style={{ marginBottom: 12 }}>
        Copy the next {IMPORT_DAYS} days of classes and plans from Google Calendar or Outlook as busy time. This is a
        one-time import, not a live sync: import again when your calendar changes.
      </p>
      <details className="howto">
        <summary>How do I get an .ics file?</summary>
        <ul>
          <li>
            <strong>Google Calendar</strong> (web): Settings → Import &amp; export → Export. Unzip the download and pick the
            calendar&apos;s .ics file.
          </li>
          <li>
            <strong>Outlook</strong> (desktop): File → Save Calendar. Outlook on the web can publish a calendar as an ICS
            link: open the link to download the file.
          </li>
        </ul>
        <p className="hint">The file is read in your browser. Only the events you confirm are saved, privately to your account.</p>
      </details>

      <label className="file-drop">
        <input key={inputKey} type="file" accept=".ics,text/calendar" onChange={onFile} disabled={reading || saving} />
        <span className="file-drop-title">{reading ? "Reading…" : preview ? preview.fileName : "Choose an .ics file"}</span>
        <span className="hint">Max 5 MB</span>
      </label>

      {preview && (
        <div className="import-preview">
          <div className="import-head">
            <div>
              <strong>
                {total} event{total === 1 ? "" : "s"} in the next {IMPORT_DAYS} days
              </strong>
              <span className="hint">
                {" "}
                · {selected.size} selected
                {preview.calendarName ? ` · ${preview.calendarName}` : ""}
              </span>
            </div>
            {total > 0 && (
              <div className="import-bulk">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setSelected(new Set(preview.occurrences.filter((o) => !preview.duplicates.has(o.key)).map((o) => o.key)))}
                >
                  Select all
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSelected(new Set())}>
                  None
                </button>
              </div>
            )}
          </div>

          {[...preview.warnings, ...(preview.skipped ? [`${preview.skipped} cancelled or zero-length event${preview.skipped === 1 ? " was" : "s were"} left out.`] : [])].map((w) => (
            <p className="notice" key={w}>
              {w}
            </p>
          ))}

          {total === 0 ? (
            <p className="empty">
              No events between now and {IMPORT_DAYS} days from now
              {preview.eventCount ? ` (the file has ${preview.eventCount} events, all outside that range)` : ""}.
            </p>
          ) : (
            <div className="import-list" role="group" aria-label="Events to import">
              {groups.map((g) => (
                <div key={g.day} className="import-day">
                  <div className="import-day-label">{formatDay(g.day)}</div>
                  {g.items.map((o) => {
                    const dup = preview.duplicates.has(o.key);
                    return (
                      <label className={`import-row${dup ? " dup" : ""}`} key={o.key}>
                        <input type="checkbox" className="check" checked={selected.has(o.key)} onChange={() => toggle(o.key)} />
                        <span className="import-time">{o.allDay ? "All day" : `${formatClock(o.start)}–${formatClock(o.end)}`}</span>
                        <span className="import-title">{o.title}</span>
                        <span className="import-tags">
                          {dup && <span className="badge badge-neutral">Already added</span>}
                          {o.recurring && <span className="badge badge-neutral">Repeats</span>}
                          {o.free && <span className="badge badge-neutral">Shown as free</span>}
                          {o.warning && (
                            <span className="badge badge-warn" title={o.warning}>
                              Check repeat
                            </span>
                          )}
                        </span>
                      </label>
                    );
                  })}
                </div>
              ))}
            </div>
          )}

          {total > 0 && (
            <>
              <label className="check-line">
                <input type="checkbox" className="check" checked={keepTitles} onChange={(e) => setKeepTitles(e.target.checked)} />
                <span>Save event titles (turn off to save them only as &ldquo;Busy&rdquo;)</span>
              </label>
              <p className="hint">All-day events and events shown as free start unselected, since they rarely block study time.</p>
              <div className="import-actions">
                <button type="button" className="btn btn-primary" onClick={confirm} disabled={saving || selected.size === 0}>
                  {saving ? "Importing…" : `Import ${selected.size} as busy`}
                </button>
                <button type="button" className="btn btn-ghost" onClick={reset} disabled={saving}>
                  Cancel
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {done && (
        <p className="notice" role="status" style={{ marginTop: 12 }}>
          {done}
        </p>
      )}
      {err && (
        <p className="error" role="alert" style={{ marginTop: 12 }}>
          {err}
        </p>
      )}

      <button type="button" className="btn btn-ghost btn-sm" style={{ marginTop: 12 }} onClick={removeAll}>
        Remove imported events
      </button>
    </Section>
  );
}

function defaultOn(o: IcsOccurrence, duplicates: Set<string>): boolean {
  return !o.allDay && !o.free && !duplicates.has(o.key);
}
