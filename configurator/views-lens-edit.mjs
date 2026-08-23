//
// views-lens-edit.mjs — MIDI editing inside the LENS workspace
// (design_handoff_lens_midi_editing: 1a edit-mode-in-place as the primary UX,
// 1c's non-destructive op stack as the data model + EDITS inspector, 1b's
// focused lane editor as the drill-in). views-lens.mjs branches into this
// module when lens.edit.on; everything here follows the same contract:
// UI state in the store, imperative DOM only for in-flight drags (window
// pointermove/pointerup, throttled store updates, final op on release), one
// in-edit undo step per completed gesture.
//
// The op stack itself is NOT part of docs, so it gets its own undo stack
// (edit.opsUndo, ⌘Z routes here while editing — see lensEditUndo) and its own
// persistence: localStorage `proxi2.lensEdits` keyed `takeId#hash`, so unsaved
// work survives a reload or an accidental take/tab switch, and dies naturally
// when the take is re-recorded (hash moves).
//
import { h } from "./ui.mjs";
import { applyOps, mkOp, opLabel, buildPanels, stepAfterPath, timeTicks,
         fmtTick, valueAt, tableRows } from "./lens-model.mjs";
import { writeTakeSMF } from "./smf.mjs";
import { joinPerfData, rewriteSidecarId, isValidTakeId, fmtMs } from "./perf.mjs";

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const clamp127 = (v) => clamp(Math.round(v), 0, 127);
const ed = (store) => store.state.lens.edit;

// ── op-stack persistence (localStorage, keyed takeId#hash) ──────────────────
const LS_EDITS = "proxi2.lensEdits";
function loadAllEdits() {
  try { return JSON.parse(localStorage.getItem(LS_EDITS)) ?? {}; } catch { return {}; }
}
function persistOps(key, ops) {
  const all = loadAllEdits();
  if (ops?.length) all[key] = ops; else delete all[key];
  // keep the map from growing unboundedly: stale hashes die with their takes,
  // but cap at 20 keys just in case (oldest keys are arbitrary — fine).
  const keys = Object.keys(all);
  for (const k of keys.slice(0, Math.max(0, keys.length - 20))) delete all[k];
  localStorage.setItem(LS_EDITS, JSON.stringify(all));
}

// ── enter / exit / mutate the op stack ──────────────────────────────────────
export function enterEdit(ctx, id, hash) {
  const key = `${id}#${hash}`;
  ctx.store.update((s) => {
    s.lens.edit = { ...s.lens.edit, on: true, key,
      ops: loadAllEdits()[key] ?? [], opsUndo: [], rev: ed(ctx.store).rev + 1,
      sel: null, win: null, focusedLane: null, preview: null };
  });
}

export function exitEdit(ctx) {           // DONE — keeps unsaved ops (persisted)
  ctx.store.update((s) => {
    Object.assign(s.lens.edit, { on: false, sel: null, win: null, focusedLane: null, preview: null });
  });
}

// Take switched or re-saved under the same edit session: re-key the stack and
// pull whatever ops were persisted for the new take. Called from the RENDER
// path (buildLiveTake), so it mutates state directly WITHOUT store.update —
// a notify here would recurse the render loop. The view built right after
// reads the fresh state, so nothing is stale.
export function syncEditKey(store, id, hash) {
  const e = ed(store);
  const key = `${id}#${hash}`;
  if (e.key === key) return;
  Object.assign(e, { key, ops: loadAllEdits()[key] ?? [], opsUndo: [],
    rev: e.rev + 1, sel: null, win: null, focusedLane: null, preview: null });
}

// Every completed gesture = exactly one in-edit undo step + a toast.
// coalesce: fold into the previous op when it's the same kind on the same ids
// (nudge clusters — ten ▲ clicks shouldn't be ten ops).
export function pushOp(ctx, op, { coalesce = false, toast = null } = {}) {
  const { store } = ctx;
  store.update((s) => {
    const e = s.lens.edit;
    const last = e.ops[e.ops.length - 1];
    if (coalesce && last && !last.bypassed && last.kind === "move" && op.kind === "move" &&
        JSON.stringify(last.params.ids) === JSON.stringify(op.params.ids)) {
      last.params.dt = +(last.params.dt + op.params.dt).toFixed(4);
      last.params.dv = (last.params.dv ?? 0) + (op.params.dv ?? 0);
    } else {
      e.opsUndo.push(structuredClone(e.ops));
      if (e.opsUndo.length > 100) e.opsUndo.shift();
      e.ops = [...e.ops, op];
    }
    e.preview = null;
    e.rev++;
    persistOps(e.key, e.ops);
  });
  store.showToast({ msg: toast ?? `edit: ${opLabel(op).name.toLowerCase()}`, undoable: false });
}

function mutateOps(ctx, fn) {
  ctx.store.update((s) => {
    const e = s.lens.edit;
    e.opsUndo.push(structuredClone(e.ops));
    fn(e);
    e.rev++;
    persistOps(e.key, e.ops);
  });
}

export const removeOp = (ctx, id) =>
  mutateOps(ctx, (e) => { e.ops = e.ops.filter((o) => o.id !== id); });
export const toggleBypass = (ctx, id) =>
  mutateOps(ctx, (e) => { e.ops = e.ops.map((o) => o.id === id ? { ...o, bypassed: !o.bypassed } : o); });
export const reorderOps = (ctx, fromId, beforeId) =>
  mutateOps(ctx, (e) => {
    const ops = e.ops.filter((o) => o.id !== fromId);
    const moved = e.ops.find((o) => o.id === fromId);
    ops.splice(ops.findIndex((o) => o.id === beforeId), 0, moved);
    e.ops = ops;
  });

export function revertOps(ctx) {
  const e = ed(ctx.store);
  if (e.ops.length && !confirm(`Discard ${e.ops.length} pending edit${e.ops.length === 1 ? "" : "s"}?`)) return;
  mutateOps(ctx, (x) => { x.ops = []; });
  ctx.store.update((s) => { s.lens.edit.sel = null; });
}

// ⌘Z while editing pops the op stack instead of the doc undo. → handled?
export function lensEditUndo(store) {
  const e = ed(store);
  if (!e.on || !e.opsUndo.length) return false;
  store.update((s) => {
    const x = s.lens.edit;
    x.ops = x.opsUndo.pop();
    x.rev++;
    x.sel = null;
    persistOps(x.key, x.ops);
  });
  store.showToast({ msg: "undid edit", undoable: false });
  return true;
}

// ── derived: the edited take (memoized by key/rev/preview) ──────────────────
let memo = { k: null, out: null };
export function editedTake(store, entry) {
  const e = ed(store);
  const k = `${e.key}#${e.rev}#${e.previewRev}`;
  if (memo.k !== k) {
    const ops = e.preview ? [...e.ops, e.preview] : e.ops;
    memo = { k, out: applyOps(entry.editRows, ops, entry.durationS) };
  }
  return memo.out;
}

// Which lanes the stack touches (ghost series + `edited` pills), and whether a
// take-level op (trim) is active — active ops only; bypassed don't count.
export function touchedLanes(ops) {
  const lanes = new Set();
  let take = false;
  for (const op of ops) {
    if (op.bypassed) continue;
    if (op.target === "take") take = true;
    else if (op.target?.cc != null) lanes.add(`${op.target.ch}:${op.target.cc}`);
  }
  return { lanes, take };
}

// ids of the edited rows inside a lane range — selections resolve to ids at
// gesture time so later ops (and the delete button) have stable targets.
function idsInRange(rows, ch, cc, t0, t1) {
  return rows.filter((e) => e.type === "cc" && e.ch === ch && e.cc === cc &&
    e.t >= t0 - 1e-9 && e.t <= t1 + 1e-9).map((e) => e.id);
}

export const laneOfSel = (panels, sel) => {
  if (!sel) return null;
  for (const p of panels) for (const l of p.lanes)
    if (p.ch === sel.ch && l.cc === sel.cc) return { panel: p, lane: l };
  return null;
};

// control label for a lane target ("MODIFY · CC 17") from the bindings map
function targetLabel(bindings, target) {
  if (target === "take") return "take";
  const b = bindings.get(target.ch);
  const ctrl = b?.controls.get(target.cc);
  return `${ctrl?.label ?? `CC ${target.cc}`} · CC ${target.cc}`;
}
const targetColor = (bindings, target) =>
  target === "take" ? "var(--muted)" : (bindings.get(target.ch)?.bg ?? "var(--hint)");

// ── zoom window ─────────────────────────────────────────────────────────────
export const winOf = (store, lenS) => {
  const w = ed(store).win;
  const t0 = clamp(w?.t0 ?? 0, 0, lenS);
  const t1 = clamp(w?.t1 ?? lenS, t0 + 0.05, lenS || t0 + 0.05);
  return { t0, t1 };
};

function setWin(ctx, lenS, t0, t1) {
  const span = Math.max(t1 - t0, Math.min(0.25, lenS));
  t0 = clamp(t0, 0, lenS - span);
  t1 = t0 + span;
  ctx.store.update((s) => {
    s.lens.edit.win = span >= lenS - 1e-6 ? null : { t0, t1 };
  });
}

export function zoomAt(ctx, lenS, centerT, factor) {
  const { t0, t1 } = winOf(ctx.store, lenS);
  const span = clamp((t1 - t0) / factor, Math.min(0.25, lenS), lenS);
  const f = (centerT - t0) / (t1 - t0 || 1);
  setWin(ctx, lenS, centerT - f * span, centerT + (1 - f) * span);
}

// Wheel on the lane area: horizontal wheel/trackpad pans, ⌘/ctrl-wheel
// (pinch) zooms at the cursor. Plain vertical wheel is left alone so the
// page still scrolls in edit mode.
export function editWheel(ctx, e, geo) {
  const lenS = geo.lengthS;
  if (!lenS) return;
  const horizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY);
  if (!(e.ctrlKey || e.metaKey) && !horizontal) return;
  e.preventDefault();
  const rect = e.currentTarget.getBoundingClientRect();
  const frac = clamp((e.clientX - rect.left - gutterPx(e.currentTarget)) /
    Math.max(rect.width - gutterPx(e.currentTarget), 1), 0, 1);
  const t = geo.x0 + frac * (geo.x1 - geo.x0);
  if (e.ctrlKey || e.metaKey) {
    zoomAt(ctx, lenS, t, Math.exp(-e.deltaY / 180));
  } else {
    const d = e.deltaX / rect.width * (geo.x1 - geo.x0);
    setWin(ctx, lenS, geo.x0 + d, geo.x1 + d);
  }
}
// the label+value gutter eats the left of the lane rows; approximate from the
// CSS var so wheel-zoom centers on the time under the cursor
function gutterPx(el) {
  const v = getComputedStyle(el).getPropertyValue("--lens-gutter");
  return (parseFloat(v) || 168) + 48;
}

// ── the edit toolbar (1a: selection chip · op buttons · zoom cluster) ───────
export function editToolbar(ctx, view) {
  const { store } = ctx;
  const e = ed(store);
  const sel = e.sel;
  const hasRange = sel?.t0 != null;
  const geo = view.geo;
  const lenS = geo.lengthS;
  const edited = view.edit?.edited;

  const chip = hasRange && h("span.lens-selchip",
    h("span.lens-sq", { style: { background: view.edit?.selColor ?? "var(--accent)" } }),
    `${view.edit?.selLabel ?? `CC ${sel.cc}`} · ${(+sel.t0.toFixed(1))}–${(+sel.t1.toFixed(1))}s · ${sel.ids.length} event${sel.ids.length === 1 ? "" : "s"}`);

  const rangeOp = (kind, params, toast) => () => {
    pushOp(ctx, mkOp(kind, { ch: sel.ch, cc: sel.cc }, { t0: sel.t0, t1: sel.t1 }, params), { toast });
  };
  const opBtn = (label, title, enabled, onclick) =>
    h("button.lens-ebtn", { disabled: !enabled, title, onclick }, label);

  const trimWin = geo.showTrim && (geo.trimA > 0.05 || geo.trimB < lenS - 0.05);

  const ops = h("div.lens-etools",
    opBtn("⌫ delete", "delete the selected events", hasRange && sel.ids.length, () => {
      pushOp(ctx, mkOp("delete", { ch: sel.ch, cc: sel.cc }, { t0: sel.t0, t1: sel.t1 }, { ids: sel.ids }),
        { toast: `deleted ${sel.ids.length} events` });
      store.update((s) => { s.lens.edit.sel = { ...sel, t0: null, t1: null, ids: [] }; });
    }),
    opBtn("⇕ scale", "scale the selection about 64 (or drag the band vertically)", hasRange, () => {
      const k = parseFloat(prompt("scale factor (about value 64):", "0.8"));
      if (Number.isFinite(k) && k > 0) rangeOp("scale", { k, center: 64 }, `scale ×${k}`)();
    }),
    opBtn("≈ smooth", "smooth the selection (60 ms window average)", hasRange,
      rangeOp("smooth", { windowMs: 60 }, "smoothed selection")),
    opBtn("⋯ thin", "drop redundant intermediate steps (±1)", hasRange,
      rangeOp("thin", { epsilon: 1 }, "thinned selection")),
    opBtn("+ insert", "insert an event (or double-click a lane)", !!sel, () => {
      const t = hasRange ? (sel.t0 + sel.t1) / 2 : (geo.x0 + geo.x1) / 2;
      const lane = edited ? edited.rows.filter((r) => r.type === "cc" && r.ch === sel.ch && r.cc === sel.cc) : [];
      const v = valueAt(lane.map((r) => ({ t: r.t, v: r.value })), t) ?? 64;
      pushOp(ctx, mkOp("insert", { ch: sel.ch, cc: sel.cc }, null, { t, v }), { toast: "inserted event" });
    }),
    opBtn("✂ trim", trimWin ? "trim the take to the dock's trim window (adds a TRIM op)"
      : "drag the dock's trim handles first, then trim to that window", !!trimWin, () => {
      pushOp(ctx, mkOp("trim", "take", null, { t0: geo.trimA, t1: geo.trimB, was: lenS }),
        { toast: `trim to ${(+geo.trimA.toFixed(1))}–${(+geo.trimB.toFixed(1))}s` });
    }));

  const pct = Math.round(lenS / Math.max(geo.x1 - geo.x0, 1e-6) * 100);
  const zoom = h("div.lens-ezoom",
    h("button.lens-zbtn", { title: "zoom out", onclick: () => zoomAt(ctx, lenS, (geo.x0 + geo.x1) / 2, 1 / 1.5) }, "−"),
    h("button.lens-zbtn", { title: "zoom in", onclick: () => zoomAt(ctx, lenS, (geo.x0 + geo.x1) / 2, 1.5) }, "+"),
    h("span.lens-zread", {}, `${pct}% · ${(+geo.x0.toFixed(1))}–${(+geo.x1.toFixed(1))}s`),
    h("button.lens-ebtn", { title: "fit the whole take", onclick: () => store.update((s) => { s.lens.edit.win = null; }) }, "FIT"));

  return h("div.lens-etoolbar", chip || h("span.lens-ehint", {}, "click a lane to select · drag empty space for a range"), ops, zoom);
}

// ── lane gestures (shared by 1a lanes and the 1b focus canvas) ──────────────
// One pointerdown entry decides: point drag (move an event), band gesture
// (scale ⇕ / offset ⌥⇕ / move-in-time ⇄ on the selection), or a fresh range
// select. All imperative + morph-safe: window listeners, throttled store
// updates, exactly one op pushed on release.
const PAD = 4;

function chartFrame(chartEl, geo) {
  const rect = chartEl.getBoundingClientRect();
  const span = geo.x1 - geo.x0 || 1;
  return {
    rect, span,
    tAt: (cx) => geo.x0 + clamp((cx - rect.left) / rect.width, 0, 1) * span,
    vAt: (cy) => clamp127(127 * (1 - (cy - rect.top - PAD) / Math.max(rect.height - 2 * PAD, 1))),
    dtPerPx: span / rect.width,
    dvPerPx: 127 / Math.max(rect.height - 2 * PAD, 1),
  };
}

function dragLoop({ onMove, onUp, throttleMs = 40 }) {
  let last = 0;
  const move = (ev) => {
    const now = performance.now();
    if (now - last < throttleMs) return;
    last = now;
    onMove(ev);
  };
  const up = (ev) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
    onUp(ev);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
}

const setPreview = (store, op) => store.update((s) => {
  s.lens.edit.preview = op;
  s.lens.edit.previewRev++;
});
const clearPreview = (store) => store.update((s) => { s.lens.edit.preview = null; });

export function laneGesture(ctx, e, ch, lane, geo, edited) {
  const { store } = ctx;
  if (e.button !== 0) return;
  const chartEl = e.currentTarget;
  const f = chartFrame(chartEl, geo);
  const sel = ed(store).sel;
  const downT = f.tAt(e.clientX), downV = f.vAt(e.clientY);
  const downX = e.clientX, downY = e.clientY;

  // 1) a point → drag moves that one event in both axes; click selects it
  const pt = e.target.closest?.("[data-pt]");
  if (pt) {
    e.preventDefault(); e.stopPropagation();
    const id = pt.dataset.pt;
    let moved = false, dt = 0, dv = 0;
    dragLoop({
      onMove: (ev) => {
        dt = (ev.clientX - downX) * f.dtPerPx;
        dv = -(ev.clientY - downY) * f.dvPerPx;
        if (Math.abs(ev.clientX - downX) + Math.abs(ev.clientY - downY) > 3) moved = true;
        if (moved) setPreview(store, mkOp("move", { ch, cc: lane.cc }, null, { ids: [id], dt, dv: Math.round(dv) }));
      },
      onUp: () => {
        clearPreview(store);
        if (moved) pushOp(ctx, mkOp("move", { ch, cc: lane.cc }, null, { ids: [id], dt: +dt.toFixed(4), dv: Math.round(dv) }),
          { toast: "moved event" });
        else store.update((s) => { s.lens.edit.sel = { ch, cc: lane.cc, t0: null, t1: null, ids: [id] }; });
      },
    });
    return;
  }

  e.preventDefault();

  // 2) inside the current range band → a gesture ON the selection
  const inBand = sel && sel.ch === ch && sel.cc === lane.cc && sel.t0 != null &&
    downT >= sel.t0 && downT <= sel.t1;
  if (inBand) {
    let axis = null; // 'v' (scale/offset) or 't' (move)
    let final = null;
    dragLoop({
      onMove: (ev) => {
        const dx = ev.clientX - downX, dy = ev.clientY - downY;
        if (!axis && Math.abs(dx) + Math.abs(dy) > 5) axis = Math.abs(dy) >= Math.abs(dx) ? "v" : "t";
        if (!axis) return;
        if (axis === "v" && ev.altKey) {
          final = mkOp("offset", { ch, cc: lane.cc }, { t0: sel.t0, t1: sel.t1 },
            { dv: Math.round(-dy * f.dvPerPx) });
        } else if (axis === "v") {
          final = mkOp("scale", { ch, cc: lane.cc }, { t0: sel.t0, t1: sel.t1 },
            { k: +Math.exp(-dy / 120).toFixed(2), center: 64 });
        } else {
          final = mkOp("move", { ch, cc: lane.cc }, null, { ids: sel.ids, dt: +(dx * f.dtPerPx).toFixed(4), dv: 0 });
        }
        setPreview(store, final);
      },
      onUp: () => {
        clearPreview(store);
        if (final) pushOp(ctx, final, { toast: `${opLabel(final).name.toLowerCase()} on selection` });
      },
    });
    return;
  }

  // 3) empty space → drag a fresh time-range selection on this lane
  let t1 = downT;
  dragLoop({
    onMove: (ev) => {
      t1 = f.tAt(ev.clientX);
      store.update((s) => {
        s.lens.edit.sel = { ch, cc: lane.cc, t0: Math.min(downT, t1), t1: Math.max(downT, t1), ids: [] };
      });
    },
    onUp: () => {
      store.update((s) => {
        const x = s.lens.edit;
        if (Math.abs(t1 - downT) < 0.02) {           // a click: select the lane
          x.sel = { ch, cc: lane.cc, t0: null, t1: null, ids: [] };
        } else {
          const a = Math.min(downT, t1), b = Math.max(downT, t1);
          x.sel = { ch, cc: lane.cc, t0: a, t1: b, ids: idsInRange(edited.rows, ch, lane.cc, a, b) };
        }
      });
    },
  });
}

export function laneDblClick(ctx, e, ch, lane, geo) {
  const f = chartFrame(e.currentTarget, geo);
  pushOp(ctx, mkOp("insert", { ch, cc: lane.cc }, null, { t: f.tAt(e.clientX), v: f.vAt(e.clientY) }),
    { toast: "inserted event" });
}

// ── edit-mode lane row (1a): points on the selected lane, band, ghost ───────
// Replaces views-lens laneRow while editing. `ghost` = the ORIGINAL lane's
// events (same hue, low opacity) drawn under the edit when the stack touches
// this lane.
export function editLaneRow(ctx, p, lane, geo, ticks, ghost, edited) {
  const { store } = ctx;
  const sel = ed(store).sel;
  const isSelLane = sel && sel.ch === p.ch && sel.cc === lane.cc;
  const expanded = !!isSelLane;
  const W = 1000, H = expanded ? 136 : 44;
  const span = geo.x1 - geo.x0 || 1;
  const pctOfT = (t) => ((t - geo.x0) / span * 100);

  const grid = ticks.map((t) => {
    const x = (((t - geo.x0) / span) * W).toFixed(1);
    return `<line x1="${x}" y1="0" x2="${x}" y2="${H}" class="lens-grid" vector-effect="non-scaling-stroke"/>`;
  }).join("");
  const midY = (H - PAD - (64 / 127) * (H - 2 * PAD)).toFixed(1);
  const mid = `<line x1="0" y1="${midY}" x2="${W}" y2="${midY}" class="lens-mid" stroke-dasharray="2 5" vector-effect="non-scaling-stroke"/>`;
  const ghostD = ghost ? stepAfterPath(ghost, geo.x0, geo.x1, W, H, PAD) : "";
  const d = stepAfterPath(lane.events, geo.x0, geo.x1, W, H, PAD);
  const svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${grid}${mid}` +
    (ghostD ? `<path d="${ghostD}" class="lens-series ghost" vector-effect="non-scaling-stroke"/>` : "") +
    (d ? `<path d="${d}" class="lens-series" vector-effect="non-scaling-stroke"/>` : "") + `</svg>`;

  // points (selected lane only): absolutely-positioned dots, id-tagged for the
  // gesture hit-test; selected events wear the accent fill
  const selIds = new Set(isSelLane ? sel.ids : []);
  const points = expanded ? lane.events
    .filter((ev) => ev.t >= geo.x0 - 1e-9 && ev.t <= geo.x1 + 1e-9 && ev.id != null)
    .map((ev) => h("span.lens-pt", {
      dataset: { pt: ev.id, key: `pt-${ev.id}` },
      class: selIds.has(ev.id) ? "on" : "",
      style: { left: `${pctOfT(ev.t).toFixed(2)}%`,
               top: `${(100 - PAD / H * 100 - (ev.v / 127) * (100 - 2 * PAD / H * 100)).toFixed(2)}%` },
    })) : [];

  const band = isSelLane && sel.t0 != null &&
    h("div.lens-selband", { style: {
      left: `${clamp(pctOfT(sel.t0), 0, 100).toFixed(2)}%`,
      width: `${clamp(pctOfT(sel.t1) - pctOfT(sel.t0), 0, 100).toFixed(2)}%` } });

  const hint = expanded && sel.t0 != null &&
    h("div.lens-lanehint", {}, "⇕ drag to move values · ⇄ shift in time · ⌫ delete");

  const val = valueAt(lane.events, geo.valueT);
  const touched = ghost != null;

  return h("div.lens-lane", { class: expanded ? "xl" : "", dataset: { key: `lane-${p.key}-${lane.key}` } },
    h("div.lens-lane-label", {
      title: "click to focus this lane (big editor)",
      onclick: () => store.update((s) => { s.lens.edit.focusedLane = { ch: p.ch, cc: lane.cc }; }),
    },
      h("span.lens-lane-name", {}, lane.label, touched && h("span.lens-oppill", {}, "op")),
      h("span.lens-lane-cc", {}, lane.detail)),
    h("div.lens-lane-val", { style: { color: geo.headShown ? geo.headColor : "var(--text-2)" } },
      val == null ? "" : String(val)),
    h("div.lens-lane-chart", {
      onpointerdown: (e) => laneGesture(ctx, e, p.ch, lane, geo, edited),
      ondblclick: (e) => laneDblClick(ctx, e, p.ch, lane, geo),
    },
      h("div.lens-lane-svg", { innerHTML: svg }),
      band, hint, points,
      geo.headShown && h("div.lens-lane-head", {
        style: { left: `${clamp(pctOfT(geo.playheadS), 0, 100).toFixed(2)}%`, background: geo.headColor } })));
}

// ── inspector: editable THIS TAKE value cell (1a) ───────────────────────────
// Click a value → inline number input (0–127, Enter commits one op, Esc
// cancels); ✕ deletes the event. Value change rides a move op (dt 0).
export function editValueCell(ctx, r) {
  const commit = (e) => {
    const v = clamp127(parseInt(e.target.value, 10));
    if (!Number.isFinite(v) || v === r.v) { e.target.value = String(r.v); return; }
    pushOp(ctx, mkOp("move", { ch: r.ch, cc: r.cc }, null, { ids: [r.id], dt: 0, dv: v - r.v }),
      { toast: `${r.label} → ${v}` });
  };
  return [
    h("input.lens-tt-edit", {
      type: "number", min: 0, max: 127, value: String(r.v),
      dataset: { focusKey: `tt-${r.id}` },
      onchange: commit,
      onkeydown: (e) => { if (e.key === "Escape") { e.target.value = String(r.v); e.target.blur(); } },
    }),
    h("button.lens-tt-x", {
      title: "delete this event",
      onclick: () => pushOp(ctx, mkOp("delete", { ch: r.ch, cc: r.cc }, null, { ids: [r.id] }),
        { toast: `deleted ${r.label} event` }),
    }, "✕"),
  ];
}

// ── inspector: the EDITS op stack (1c) ──────────────────────────────────────
let opDragId = null;

export function editsSection(ctx, view, bindings) {
  const { store } = ctx;
  const e = ed(store);
  const open = store.state.lens.editsOpen ?? true;
  const entry = view.edit?.entry;

  const head = h("div.lens-sec-head", {
    onclick: () => store.update((s) => { s.lens.editsOpen = !(s.lens.editsOpen ?? true); }),
  },
    h("span.lens-sec-caret", {}, open ? "▾" : "▸"),
    h("span.lens-sec-title", {}, "EDITS"),
    h("span.lens-sec-count", {}, `${e.ops.length} op${e.ops.length === 1 ? "" : "s"} · non-destructive`));

  const card = (op) => {
    const l = opLabel(op);
    return h("div.lens-opcard", {
      class: op.bypassed ? "off" : "",
      dataset: { key: `op-${op.id}` },
      draggable: true,
      ondragstart: () => { opDragId = op.id; },
      ondragover: (ev) => { if (opDragId && opDragId !== op.id) ev.preventDefault(); },
      ondrop: (ev) => {
        ev.preventDefault();
        if (opDragId && opDragId !== op.id) reorderOps(ctx, opDragId, op.id);
        opDragId = null;
      },
    },
      h("span.lens-grip", { title: "drag to reorder" }, "⋮⋮"),
      h("span.lens-sq", { style: { background: targetColor(bindings, op.target) } }),
      h("div.lens-opcard-lines",
        h("div.lens-opcard-top",
          h("span.lens-opcard-name", {}, l.name),
          h("span.lens-opcard-target", {}, targetLabel(bindings, op.target))),
        h("span.lens-opcard-detail", {}, l.detail)),
      h("button.lens-opeye", {
        class: op.bypassed ? "" : "on",
        title: op.bypassed ? "bypassed — click to re-enable" : "active — click to bypass",
        onclick: () => toggleBypass(ctx, op.id),
      }, op.bypassed ? "–" : "●"),
      h("button.lens-opx", { title: "remove this op", onclick: () => removeOp(ctx, op.id) }, "✕"));
  };

  const b = (fn) => async (ev) => {
    const btn = ev.target.closest("button");
    if (btn) btn.disabled = true;
    try { await fn(); } catch (err) { store.log("Lens", err.message); }
    if (btn) btn.disabled = false;
  };

  const body = open ? h("div.lens-edits-body",
    e.ops.length
      ? e.ops.map(card)
      : h("span.pane-footnote", {}, "no edits yet — drag on a lane, drag points, or edit values in the table"),
    e.ops.length > 0 && h("span.pane-footnote", {},
      "drag a range on any lane, then pull ⇕ to scale, ⌥⇕ to offset · ops re-order and toggle · the original stays on the SD card until you flatten."),
    h("div.lens-edits-actions",
      h("button.lens-esave", {
        disabled: !e.ops.length || !entry,
        onclick: b(() => saveEdits(ctx, view, bindings, { copy: false })),
      }, "FLATTEN & SAVE"),
      h("button.lens-ebtn", {
        disabled: !e.ops.length || !entry,
        onclick: b(() => saveEdits(ctx, view, bindings, { copy: true })),
      }, "SAVE AS COPY"))) : null;

  return h("div.lens-sec.lens-sec-edits", head, body);
}

// ── save: flatten ops → SMF → sidecar → PUT → reload ────────────────────────
// Save = overwrite in place (the user's chosen model). SAVE AS COPY rewrites
// the sidecar id to a fresh one first. The manifest refresh after perfPutData
// moves the hash, which invalidates the takeCache entry AND re-keys the edit
// session (syncEditKey) — the fresh key has no persisted ops, so the stack
// comes back empty over the flattened take.
export async function saveEdits(ctx, view, bindings, { copy = false } = {}) {
  const { store, linkApi } = ctx;
  const e = ed(store);
  const entry = view.edit.entry;
  const { rows, lenS } = applyOps(entry.editRows, e.ops, entry.durationS);

  const mid = writeTakeSMF(rows, lenS);
  const lenMs = Math.max(Math.round(lenS * 1000), 1);

  // rebuild the sidecar lanes from the flattened rows (importMid's shape)
  const lanes = [];
  for (const p of buildPanels(rows, bindings)) for (const l of p.lanes) {
    if (l.cc == null) continue;
    lanes.push({ channel: p.ch, cc: l.cc, v0: l.events[0]?.v ?? 0, label: l.label,
      color: p.bg || "#FFFFFF", instanceId: p.inst || "", events: l.events.length,
      controlId: "" });
  }

  const sidecar = { ...entry.sidecar, len: lenMs, w0: 0, w1: lenMs, lanes };
  let id = sidecar.id;
  if (copy) {
    const newId = prompt(`save edited copy as (a-z, 0-9, dashes):`, `${id}-edit`);
    if (!newId) return;
    if (!isValidTakeId(newId)) throw new Error(`bad take id: ${newId}`);
    if (store.state.link.manifest?.performances?.[newId] &&
        !confirm(`"${newId}" exists — overwrite it?`)) return;
    sidecar.id = id = newId;
  }

  await linkApi.perfPutData(joinPerfData(sidecar, mid));
  await linkApi.perfLoad(id);
  persistOps(e.key, []);                       // this key's work is flattened
  store.update((s) => {
    Object.assign(s.lens.edit, { ops: [], opsUndo: [], sel: null, preview: null, rev: e.rev + 1 });
    s.lens.selectedTakeId = id;
  });
  store.log("Lens", `${copy ? `saved edited copy "${id}"` : `flattened ${e.ops.length} edits into "${id}"`} · ${fmtMs(lenMs)}`);
}

// ── keyboard (wired once): Esc clears / exits focus, ⌫ deletes selection ────
let keysWired = false;
export function wireEditKeys(ctx) {
  if (keysWired) return;
  keysWired = true;
  document.addEventListener("keydown", (e) => {
    const st = ctx.store.state;
    if (st.view !== "lens" || !st.lens.edit.on) return;
    const el = document.activeElement;
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
    if (e.key === "Escape") {
      ctx.store.update((s) => {
        if (s.lens.edit.focusedLane) s.lens.edit.focusedLane = null;
        else s.lens.edit.sel = null;
      });
    } else if ((e.key === "Backspace" || e.key === "Delete")) {
      const sel = st.lens.edit.sel;
      if (sel?.ids?.length) {
        e.preventDefault();
        pushOp(ctx, mkOp("delete", { ch: sel.ch, cc: sel.cc }, sel.t0 != null ? { t0: sel.t0, t1: sel.t1 } : null,
          { ids: sel.ids }), { toast: `deleted ${sel.ids.length} event${sel.ids.length === 1 ? "" : "s"}` });
        ctx.store.update((s) => { s.lens.edit.sel = { ...sel, t0: null, t1: null, ids: [] }; });
      }
    }
  });
}

// ── 1b: the focused lane editor ─────────────────────────────────────────────
// Click a lane's label in edit mode → the whole center becomes that one
// control, big. The left pane repurposes into the lane list; the inspector
// table filters to the lane (views-lens thisTakeSection handles that).

const unfocus = (ctx) => ctx.store.update((s) => { s.lens.edit.focusedLane = null; });
const focusLane = (ctx, ch, cc) => ctx.store.update((s) => {
  s.lens.edit.focusedLane = { ch, cc };
  s.lens.edit.sel = null;
});

export function focusedLeftPane(ctx, view, takes, sel) {
  const { store } = ctx;
  const e = ed(store);
  const focused = e.focusedLane;
  const panels = view.panels;
  const touched = view.edit.touched;
  const laneCount = panels.reduce((n, p) => n + p.lanes.length, 0);
  const b = (fn) => async (ev) => {
    const btn = ev.target.closest("button");
    if (btn) btn.disabled = true;
    try { await fn(); } catch (err) { store.log("Lens", err.message); }
    if (btn) btn.disabled = false;
  };

  const rows = panels.flatMap((p) => p.lanes.map((l) => {
    const isFocused = p.ch === focused.ch && l.cc === focused.cc;
    const edited = touched.lanes.has(`${p.ch}:${l.cc}`);
    return h("div.lens-take-row", {
      class: isFocused ? "on" : "",
      dataset: { key: `flane-${p.key}-${l.key}` },
      onclick: () => focusLane(ctx, p.ch, l.cc),
    },
      h("span.lens-sq", { style: { background: p.bg ?? "var(--hint)" } }),
      h("div.lens-take-lines",
        h("span.lens-take-rowname", {}, l.label),
        h("span.lens-take-rowmeta", {},
          `CC ${l.cc ?? "—"} · ${p.name} · ${l.events.length} event${l.events.length === 1 ? "" : "s"}`)),
      edited && h("span.lens-editedpill", {}, "edited"));
  }));

  const summary = e.ops.slice(-6).map((op) =>
    h("span.lens-esum-line", { dataset: { key: `esum-${op.id}` } },
      `${targetLabel(view.bindings, op.target)} — ${opLabel(op).name.toLowerCase()}`));

  return h("aside.lens-card.lens-left",
    h("div.lens-pane-head",
      h("button.lens-backlink", { onclick: () => unfocus(ctx) }, "‹ takes"),
      h("span.lens-pane-title", {}, view.name),
      h("span.lens-pane-count", {}, `${laneCount} lanes`)),
    h("div.lens-left-body",
      h("span.lens-tiny-label", {}, "LANES · click to focus"),
      h("div.lens-take-list", rows)),
    h("div.lens-meta",
      h("span.lens-tiny-label", {}, "EDITS IN THIS TAKE"),
      e.ops.length ? summary : h("span.pane-footnote", {}, "none yet"),
      h("div.lens-meta-actions",
        h("button.lens-esave", {
          disabled: !e.ops.length,
          onclick: b(() => saveEdits(ctx, view, view.bindings, { copy: false })),
        }, "SAVE"),
        h("button.lens-mbtn", { disabled: !e.ops.length, onclick: () => revertOps(ctx) }, "revert all"))));
}

export function focusedCenter(ctx, view) {
  const { store } = ctx;
  const e = ed(store);
  const ref = view.edit.focusedRef;
  const geo = view.geo;
  if (!ref) {          // lane vanished (all events deleted) → drop back out
    queueMicrotask(() => unfocus(ctx));
    return h("div.lens-center-body", h("div.lens-center-empty.sm", "lane is empty — leaving focus…"));
  }
  const { panel: p, lane } = ref;
  const sel = e.sel;
  const isSelLane = sel && sel.ch === p.ch && sel.cc === lane.cc;
  const edited = view.edit.edited;
  const touched = view.edit.touched.lanes.has(`${p.ch}:${lane.cc}`);
  const ghost = view.edit.ghosts.get(`${p.key}|${lane.key}`);

  // big canvas: 48px value gutter + plot; W/H nominal for the svg
  const W = 1000, H = 380;
  const span = geo.x1 - geo.x0 || 1;
  const ticks = timeTicks(geo.x0, geo.x1);
  const pctOfT = (t) => ((t - geo.x0) / span * 100);
  const yPct = (v) => (100 - PAD / H * 100 - (v / 127) * (100 - 2 * PAD / H * 100));

  const guides = [32, 64, 96].map((v) => {
    const y = (H - PAD - (v / 127) * (H - 2 * PAD)).toFixed(1);
    return `<line x1="0" y1="${y}" x2="${W}" y2="${y}" class="lens-guide${v === 64 ? " mid" : ""}" stroke-dasharray="3 6" vector-effect="non-scaling-stroke"/>`;
  }).join("");
  const grid = ticks.map((t) => {
    const x = (((t - geo.x0) / span) * W).toFixed(1);
    return `<line x1="${x}" y1="0" x2="${x}" y2="${H}" class="lens-grid" vector-effect="non-scaling-stroke"/>`;
  }).join("");
  const ghostD = ghost ? stepAfterPath(ghost, geo.x0, geo.x1, W, H, PAD) : "";
  const d = stepAfterPath(lane.events, geo.x0, geo.x1, W, H, PAD);
  const svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${grid}${guides}` +
    (ghostD ? `<path d="${ghostD}" class="lens-series ghost" vector-effect="non-scaling-stroke"/>` : "") +
    (d ? `<path d="${d}" class="lens-series" vector-effect="non-scaling-stroke"/>` : "") + `</svg>`;

  const selIds = new Set(isSelLane ? sel.ids : []);
  const points = lane.events
    .filter((ev) => ev.t >= geo.x0 - 1e-9 && ev.t <= geo.x1 + 1e-9 && ev.id != null)
    .map((ev) => h("span.lens-pt.big", {
      dataset: { pt: ev.id, key: `fpt-${ev.id}` },
      class: selIds.has(ev.id) ? "on" : "",
      style: { left: `${pctOfT(ev.t).toFixed(2)}%`, top: `${yPct(ev.v).toFixed(2)}%` },
    }));

  const band = isSelLane && sel.t0 != null &&
    h("div.lens-selband", { style: {
      left: `${clamp(pctOfT(sel.t0), 0, 100).toFixed(2)}%`,
      width: `${clamp(pctOfT(sel.t1) - pctOfT(sel.t0), 0, 100).toFixed(2)}%` } });
  const hint = isSelLane && sel.t0 != null &&
    h("div.lens-lanehint", {}, `${sel.ids.length} selected · ⇕ scale about center · ⌥⇕ offset`);

  // nudge cluster: ◀▶ = one grid step in time, ▲▼ = value ±1 (⇧ = ±10)
  const step = ticks.length > 1 ? ticks[1] - ticks[0] : span / 10;
  const nudge = (dt, dv) => (ev) => {
    if (!sel?.ids?.length) return;
    const mul = ev.shiftKey ? 10 : 1;
    pushOp(ctx, mkOp("move", { ch: p.ch, cc: lane.cc }, null,
      { ids: sel.ids, dt: +dt.toFixed(4), dv: dv * mul }),
      { coalesce: true, toast: "nudged" });
  };
  const nbtn = (label, title, dt, dv) =>
    h("button.lens-zbtn", { disabled: !sel?.ids?.length, title, onclick: nudge(dt, dv) }, label);

  const axis = h("div.lens-ftimeaxis",
    ticks.map((t) => h("span.lens-ta-tick",
      { style: { left: `${pctOfT(t).toFixed(2)}%` } }, fmtTick(t))));

  const minimap = h("div.lens-minimap",
    h("span.lens-tiny-label", {}, "ALL LANES · click to switch focus"),
    view.panels.flatMap((mp) => mp.lanes.map((ml) => {
      const on = mp.ch === p.ch && ml.cc === lane.cc;
      const md = stepAfterPath(ml.events, 0, geo.lengthS, 600, 12, 1);
      return h("div.lens-mm-row", {
        class: on ? "on" : "",
        dataset: { key: `mm-${mp.key}-${ml.key}` },
        onclick: () => focusLane(ctx, mp.ch, ml.cc),
      },
        h("span.lens-mm-label",
          h("span.lens-sq", { style: { background: mp.bg ?? "var(--hint)" } }),
          `${ml.label} · CC ${ml.cc ?? "—"}`),
        h("div.lens-mm-chart", { innerHTML:
          `<svg viewBox="0 0 600 12" preserveAspectRatio="none">` +
          (md ? `<path d="${md}" class="lens-series mm${on ? " on" : ""}" vector-effect="non-scaling-stroke"/>` : "") +
          `</svg>` }));
    })));

  return h("div.lens-center-body.focused", { onwheel: (ev) => editWheel(ctx, ev, geo) },
    h("div.lens-fhead",
      h("span.lens-sq.lg", { style: { background: p.bg ?? "var(--hint)" } }),
      h("span.lens-fname", {}, lane.label),
      h("span.lens-fmeta", {}, `CC ${lane.cc ?? "—"} · ${p.name} · ch ${p.ch}`),
      touched && h("span.lens-badge.amber", {}, "EDITED"),
      h("button.lens-hbtn", { title: "back to all lanes (Esc)", onclick: () => unfocus(ctx) }, "‹ all lanes")),
    h("span.lens-fstatus", {},
      `${lane.events.length} events · drag points · drag empty space to select a range · double-click to insert`),
    h("div.lens-fcanvas",
      h("div.lens-fgutter", [127, 96, 64, 32, 0].map((v) =>
        h("span.lens-fglabel", { style: { top: `${yPct(v).toFixed(2)}%` } }, String(v)))),
      h("div.lens-fplot", {
        onpointerdown: (ev) => laneGesture(ctx, ev, p.ch, lane, geo, edited),
        ondblclick: (ev) => laneDblClick(ctx, ev, p.ch, lane, geo),
      },
        h("div.lens-lane-svg", { innerHTML: svg }),
        band, hint, points,
        geo.headShown && h("div.lens-lane-head", {
          style: { left: `${clamp(pctOfT(geo.playheadS), 0, 100).toFixed(2)}%`, background: geo.headColor } }))),
    h("div.lens-fops",
      axis,
      h("div.lens-fnudge",
        h("span.lens-tiny-label", {}, "nudge"),
        nbtn("◀", "earlier by one grid step (selection)", -step, 0),
        nbtn("▶", "later by one grid step (selection)", step, 0),
        nbtn("▲", "value +1 (⇧ +10)", 0, 1),
        nbtn("▼", "value −1 (⇧ −10)", 0, -1))),
    minimap);
}

// ── dock VIEW region (the zoom window on the scrub bar; drag to pan) ────────
export function viewRegion(ctx, geo) {
  const lenS = geo.lengthS || 1;
  const { store } = ctx;
  const w = ed(store).win;
  if (!w) return null;
  const left = clamp(w.t0 / lenS * 100, 0, 100);
  const width = clamp((w.t1 - w.t0) / lenS * 100, 0, 100 - left);
  return h("div.lens-viewregion", {
    title: "the edit zoom window — drag to pan",
    style: { left: `${left.toFixed(2)}%`, width: `${width.toFixed(2)}%` },
    onpointerdown: (e) => {
      e.preventDefault(); e.stopPropagation();
      const track = e.currentTarget.closest("[data-scrubtrack]");
      if (!track) return;
      const rect = track.getBoundingClientRect();
      const span = w.t1 - w.t0;
      const grabT = clamp((e.clientX - rect.left) / rect.width, 0, 1) * lenS - w.t0;
      dragLoop({
        onMove: (ev) => {
          const t0 = clamp((ev.clientX - rect.left) / rect.width, 0, 1) * lenS - grabT;
          setWin(ctx, lenS, t0, t0 + span);
        },
        onUp: () => {},
      });
    },
  }, h("span.lens-viewregion-label", {}, "VIEW"));
}
