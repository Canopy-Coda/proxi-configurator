//
// lens-model.mjs — the exploded, rig-aware lane model behind the LENS tab.
// DOM-free and dependency-free (node runs it for tests). It is the
// configurator port of daw-lens/lens.mjs' data core: resolve a MIDI event
// stream through the rig into per-pedal panels with one named lane per
// control, and turn each lane's stepwise CC history into a step-after SVG
// path. The daw-lens page keeps its own imperative copy for now; converging
// the two onto this module is deferred (see views-lens.mjs header).
//
// Chart form (dataviz method): CC data is stepwise change-over-time →
// step-after lines, one series per lane (small multiples; the lane label
// carries identity, no legend). Series color #3987e5 is validated against the
// companion surfaces; pedal header bands wear the pedal's own library colors
// (domain data — never themed).
//

// ── rig resolution ──────────────────────────────────────────────────────────
// rig doc + pedalsById → Map(midiChannel → binding). A binding carries the
// pedal's presentation (name/colors) and a control map (cc → {label, detail,
// order}) built in the same control order the device screens use: normal
// encoders, footswitches, hidden encoders, dip switches.
export function buildBindings(rig, pedalsById) {
  const bindings = new Map();
  (rig?.instances ?? []).forEach((inst, i) => {
    const pedal = pedalsById[inst.pedalId];
    const controls = new Map();
    let order = 0;
    const add = (cc, label, detail) => {
      if (cc > 0 && label && !controls.has(cc)) controls.set(cc, { label, detail, order: order++ });
    };
    if (pedal) {
      for (const e of pedal.encoders?.normal ?? [])
        if (e.type !== "inactive") add(e.cc, e.label || e.position, `CC ${e.cc} · ${e.position}`);
      for (const side of ["left", "right"]) {
        const f = pedal.footswitches?.[side];
        if (f) add(f.cc, f.label || `FS ${side}`, `CC ${f.cc} · footswitch`);
      }
      for (const e of pedal.encoders?.hidden ?? [])
        if (e.type !== "inactive") add(e.cc, e.label, `CC ${e.cc} · hidden ${e.position}`);
      for (const bank of pedal.dipSwitchBanks ?? [])
        for (const sw of bank.switches ?? []) add(sw.cc, sw.label, `CC ${sw.cc} · dip ${bank.label}`);
    }
    bindings.set(inst.midiChannel, {
      instanceId: inst.instanceId,
      pedal,
      name: pedal?.name ?? inst.instanceId,
      bg: pedal?.backgroundColor ?? "#333945",
      fg: pedal?.labelColor ?? "#d8dce4",
      order: i,
      controls,
    });
  });
  return bindings;
}

// ── event model ─────────────────────────────────────────────────────────────
// events: [{ t (seconds), ch, type:'cc'|'pc'|'note'|'other', cc?, value?,
// program? }] → sorted array of panels. A panel is one pedal instance (or a
// raw "not in rig" channel); a lane is one control's CC history.
export function buildPanels(events, bindings) {
  const panels = new Map(); // key → panel

  const getPanel = (ch) => {
    const b = bindings.get(ch);
    const key = b ? b.instanceId : `ch${ch}`;
    let p = panels.get(key);
    if (!p) {
      p = b
        ? { key, bound: true, name: b.name, inst: b.instanceId, ch,
            bg: b.bg, fg: b.fg, order: b.order, lanes: new Map(), notes: 0, other: 0 }
        : { key, bound: false, name: `Channel ${ch}`, inst: null, ch,
            bg: null, fg: null, order: 100 + ch, lanes: new Map(), notes: 0, other: 0 };
      panels.set(key, p);
    }
    return p;
  };

  for (const e of events) {
    if (e.type === "cc" || e.type === "pc") {
      const panel = getPanel(e.ch);
      const b = bindings.get(e.ch);
      let laneKey, label, detail, order, cc;
      if (e.type === "pc") {
        laneKey = "pc"; label = "PROGRAM"; detail = "program change"; order = 9000; cc = null;
      } else {
        const ctrl = b?.controls.get(e.cc);
        laneKey = `cc${e.cc}`; cc = e.cc;
        label = ctrl?.label ?? `CC ${e.cc}`;
        detail = ctrl?.detail ?? (b ? `CC ${e.cc} · unmapped` : `CC ${e.cc}`);
        order = ctrl?.order ?? 1000 + e.cc;
      }
      let lane = panel.lanes.get(laneKey);
      if (!lane) panel.lanes.set(laneKey, (lane = { key: laneKey, label, detail, cc, order, events: [], last: null }));
      const v = e.type === "pc" ? e.program : e.value;
      lane.events.push(e.id != null ? { t: e.t, v, id: e.id } : { t: e.t, v });
      lane.last = v;
    } else if (e.type === "note" || e.type === "noteOn" || e.type === "noteOff") {
      getPanel(e.ch).notes++;
    } else {
      getPanel(e.ch).other++;
    }
  }

  // Lanes sort by CC ascending within a panel (PROGRAM, cc === null, sinks to
  // the bottom). Panels keep rig order here; the LENS view applies the user's
  // drag order on top.
  const byCc = (a, b) => (a.cc == null) - (b.cc == null) || a.cc - b.cc;
  return [...panels.values()]
    .sort((a, b) => a.order - b.order)
    .map((p) => ({ ...p, lanes: [...p.lanes.values()].sort(byCc) }));
}

// Flat, time-sorted event rows across a take's lanes — the inspector's
// "THIS TAKE" table (daw-lens table view). [{ t, ch, cc, label, v, bg, id? }]
// (id rides along when the source rows carried one — the edit table needs it).
export function tableRows(panels) {
  const rows = [];
  for (const p of panels)
    for (const lane of p.lanes)
      for (const e of lane.events)
        rows.push({ t: e.t, ch: p.ch, cc: lane.cc, label: lane.label, v: e.v, bg: p.bg, id: e.id });
  return rows.sort((a, b) => a.t - b.t);
}

// ── step-after path ─────────────────────────────────────────────────────────
// A lane's CC events → an SVG path `d` string over a viewBox W×H. Step-after
// because a CC holds its value until the next change. Values map 0..127 to the
// full height (pad inset top/bottom). Meant for a non-scaling stroke inside a
// preserveAspectRatio="none" viewBox, so W/H are nominal.
// `endT` (default x1) is the draw/clip point: events past it are dropped and the
// last value is held out to X(endT) instead of the full width. Time maps on the
// [x0, x1] scale regardless, so the series stays aligned with the grid/axis while
// a recording draws only up to its playhead.
export function stepAfterPath(events, x0, x1, W = 1000, H = 44, pad = 4, endT = x1) {
  const span = x1 - x0 || 1;
  const X = (t) => (((t - x0) / span) * W).toFixed(1);
  const Y = (v) => (H - pad - (v / 127) * (H - 2 * pad)).toFixed(1);
  let d = "", pen = null;
  for (const e of events) {
    if (e.t <= x0) { pen = e.v; continue; } // carry the last value from before the window
    if (e.t > endT) break;
    d += d === ""
      ? (pen === null ? `M${X(e.t)} ${Y(e.v)}` : `M0 ${Y(pen)} H${X(e.t)} V${Y(e.v)}`)
      : ` H${X(e.t)} V${Y(e.v)}`;
    pen = e.v;
  }
  if (pen !== null) d = (d === "" ? `M0 ${Y(pen)}` : d) + ` H${endT >= x1 ? W : X(endT)}`;
  return d;
}

// ── time axis ───────────────────────────────────────────────────────────────
export function timeTicks(x0, x1) {
  const span = x1 - x0;
  const step = [0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300].find((s) => span / s <= 8) ?? 600;
  const ticks = [];
  for (let t = Math.ceil(x0 / step) * step; t <= x1 + 1e-9; t += step) ticks.push(+t.toFixed(4));
  return ticks;
}
export const fmtTick = (t) =>
  t >= 60 ? `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, "0")}` : `${+t.toFixed(2)}s`;

// ── SMF → normalized events ─────────────────────────────────────────────────
// parseSMF() output (daw-lens/smf.mjs shape) → the {t, ch, type, ...} rows
// buildPanels ingests. seconds → t; note/other collapse to counts.
export function eventsFromSMF(parsed) {
  return parsed.events.map((e) => {
    if (e.type === "cc") return { t: e.seconds, ch: e.ch, type: "cc", cc: e.cc, value: e.value };
    if (e.type === "pc") return { t: e.seconds, ch: e.ch, type: "pc", program: e.program };
    if (e.type === "noteOn" || e.type === "noteOff") return { t: e.seconds, ch: e.ch, type: "note" };
    return { t: e.seconds, ch: e.ch, type: "other" };
  });
}

// ── LIVE: rolling monitor buffer → trailing-window events ────────────────────
// The store's monitorEvents is a newest-first, wall-clock CC log
// ([{ t: <ms>, channel, cc, value }, …]). Map the last `windowS` seconds of it
// into the {t, ch, type} rows buildPanels ingests, on a window whose right edge
// is `now`: t is seconds-relative-to-now (0 = now, −windowS = the left edge),
// so events march leftward as they age. Emitted oldest-first (ascending t) so
// each lane's events land in stepAfterPath's expected order.
export function liveWindowEvents(monitorEvents, now, windowS = 30) {
  const events = [];
  for (let i = monitorEvents.length - 1; i >= 0; i--) {
    const e = monitorEvents[i];
    const t = (e.t - now) / 1000;
    if (t < -windowS) continue;               // outside the trailing window
    events.push({ t, ch: e.channel, type: "cc", cc: e.cc, value: e.value });
  }
  return events;
}

// ── LIVE TAKE: rolling monitor buffer → a recording timeline ─────────────────
// While the device records, the take draws in real time. The device reports its
// recording position (posMs, the elapsed take length); the actual CC values ride
// the store's rolling monitorEvents log (newest-first wall-clock ms). Anchor the
// take's t=0 at the recording start (nowMs − posMs) and map each event to its
// take-relative second: t = (e.t − (nowMs − posMs)) / 1000. Events from before
// the record began (t < 0) drop out; the rest emit oldest-first (ascending t) in
// the {t, ch, type} shape buildPanels ingests. The playhead sits at the live
// edge (posMs/1000), so valueAt(lane, pos) reads the latest value.
export function recTakeEvents(monitorEvents, nowMs, posMs) {
  const startMs = nowMs - posMs;
  const posS = posMs / 1000;
  const events = [];
  for (let i = monitorEvents.length - 1; i >= 0; i--) {
    const e = monitorEvents[i];
    const t = (e.t - startMs) / 1000;
    if (t < 0) continue;                 // before the take began
    events.push({ t: Math.min(t, posS), ch: e.channel, type: "cc", cc: e.cc, value: e.value });
  }
  return events;
}

// The value a lane holds at time `t` — the step-after value under the playhead.
// events are the ascending [{t, v}] a buildPanels lane carries. Returns the last
// value at or before `t`; before the first event, its value; empty → null.
export function valueAt(events, t) {
  if (!events?.length) return null;
  let v = events[0].v;
  for (const e of events) { if (e.t <= t) v = e.v; else break; }
  return v;
}

// One value per ch:cc lane at time `t` — the ✦ SNAP capture (views-lens dock).
// panels = buildPanels output; PROGRAM lanes (cc === null) and lanes with no
// held value are skipped. Returns the DEVICE-tab snapshot `values` shape.
export function snapshotValuesAt(panels, t) {
  const values = [];
  const seen = new Set();
  for (const p of panels ?? []) for (const l of p.lanes) {
    if (l.cc == null) continue;
    const key = `${p.ch}:${l.cc}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const v = valueAt(l.events, t);
    if (v != null) values.push({ channel: p.ch, cc: l.cc, value: v });
  }
  return values;
}

// ── take editing: a non-destructive op stack (design_handoff_lens_midi_editing)
// Edits are named operations layered over the original take, not point
// mutations. Gestures create ops; applyOps() replays the ordered stack over
// the parsed rows; nothing on the SD card changes until the user flattens.
//
// Row shape: the normalized {t, ch, type, cc?, value?, …} rows buildPanels
// ingests, PLUS a stable `id` (withIds assigns them once at parse). Ops that
// name specific events (delete / move) reference these ids, so they survive
// re-sorts and upstream ops; range ops (scale / offset / smooth / thin) name a
// lane {ch, cc} + a time range instead. Non-cc rows (notes, pitch bend…) pass
// through every op untouched except TRIM, which cuts and re-times everything —
// the save path re-encodes them byte-faithfully.
//
// applyOps(rows, ops, lenS) → { rows, lenS }: pure, order-dependent, bypassed
// ops skipped. All value math clamps 0–127 and rounds; time never goes < 0.

const clamp127 = (v) => Math.max(0, Math.min(127, Math.round(v)));

// Assign stable event ids (parse order). Call ONCE on the base rows; ops keep
// ids through every transform, and insert ops mint their own.
export function withIds(rows) {
  return rows.map((e, i) => ({ ...e, id: `e${i}` }));
}

// parseSMF() → LOSSLESS edit rows: every event keeps its full smf-read
// vocabulary ({type: cc|pc|noteOn|noteOff|pitchBend|other, …}) so the save
// path can re-encode byte-faithfully (eventsFromSMF collapses notes to counts
// — display-only, never feed it to writeTakeSMF). t = seconds; ids assigned.
export function editRowsFromSMF(parsed) {
  return withIds(parsed.events.map(({ seconds, tick, track, ...e }) => ({ t: seconds, ...e })));
}

let opSeq = 0;
export function mkOp(kind, target, range, params = {}) {
  return { id: `op${Date.now().toString(36)}-${opSeq++}`, kind, target, range, params, bypassed: false };
}

const inLane = (e, tg) => e.type === "cc" && e.ch === tg.ch && e.cc === tg.cc;
const inRange = (e, r) => !r || (e.t >= r.t0 - 1e-9 && e.t <= r.t1 + 1e-9);
const hits = (e, op) => inLane(e, op.target) && inRange(e, op.range);
const byTime = (a, b) => a.t - b.t;

function applyOne(rows, op, lenS) {
  switch (op.kind) {
    case "scale": {
      const { k = 1, center = 64 } = op.params;
      return { lenS, rows: rows.map((e) => hits(e, op)
        ? { ...e, value: clamp127(center + (e.value - center) * k) } : e) };
    }
    case "offset": {
      const { dv = 0 } = op.params;
      return { lenS, rows: rows.map((e) => hits(e, op)
        ? { ...e, value: clamp127(e.value + dv) } : e) };
    }
    case "smooth": {
      // time-window moving average over the lane's events in range
      const { windowMs = 60 } = op.params;
      const half = windowMs / 2000;
      const lane = rows.filter((e) => hits(e, op)).sort(byTime);
      const avg = new Map();
      for (const e of lane) {
        let sum = 0, n = 0;
        for (const o of lane) if (Math.abs(o.t - e.t) <= half + 1e-9) { sum += o.value; n++; }
        avg.set(e.id, clamp127(sum / n));
      }
      return { lenS, rows: rows.map((e) => avg.has(e.id) ? { ...e, value: avg.get(e.id) } : e) };
    }
    case "thin": {
      // drop redundant intermediate steps: keep the first event, every event
      // that moves > epsilon from the last kept, and the range's final event
      const { epsilon = 1 } = op.params;
      const lane = rows.filter((e) => hits(e, op)).sort(byTime);
      const drop = new Set();
      let last = null;
      lane.forEach((e, i) => {
        if (i === 0 || i === lane.length - 1 || Math.abs(e.value - last) > epsilon) last = e.value;
        else drop.add(e.id);
      });
      return { lenS, rows: rows.filter((e) => !drop.has(e.id)) };
    }
    case "delete": {
      const ids = new Set(op.params.ids ?? []);
      return { lenS, rows: rows.filter((e) => !ids.has(e.id)) };
    }
    case "move": {
      const ids = new Set(op.params.ids ?? []);
      const { dt = 0, dv = 0 } = op.params;
      return { lenS, rows: rows.map((e) => ids.has(e.id)
        ? { ...e, t: Math.max(0, Math.min(lenS, e.t + dt)),
            ...(e.type === "cc" ? { value: clamp127(e.value + dv) } : {}) } : e)
        .sort(byTime) };  // move keeps per-lane time ordering
    }
    case "insert": {
      const { t, v } = op.params;
      const row = { id: op.id, t: Math.max(0, Math.min(lenS, t)),
        ch: op.target.ch, type: "cc", cc: op.target.cc, value: clamp127(v) };
      return { lenS, rows: [...rows, row].sort(byTime) };
    }
    case "trim": {
      // take-level: cut to [t0, t1], re-time to 0, carry each cc lane's held
      // value at t0 in as a synthetic t=0 event (so the lane doesn't go dark)
      const { t0 = 0, t1 = lenS } = op.params;
      const kept = rows.filter((e) => e.t >= t0 - 1e-9 && e.t <= t1 + 1e-9)
        .map((e) => ({ ...e, t: Math.max(0, e.t - t0) }));
      const carries = [];
      const seen = new Set();
      for (const e of rows) {
        if (e.type !== "cc" || e.t >= t0 - 1e-9) continue;
        seen.add(`${e.ch}:${e.cc}`); // last write before t0 wins (rows are sorted)
      }
      for (const key of seen) {
        const [ch, cc] = key.split(":").map(Number);
        const first = kept.find((e) => e.type === "cc" && e.ch === ch && e.cc === cc);
        if (first && first.t < 1e-9) continue;   // lane already opens at 0
        let v = null;
        for (const e of rows) { if (e.type === "cc" && e.ch === ch && e.cc === cc && e.t < t0 - 1e-9) v = e.value; }
        carries.push({ id: `${op.id}:v0:${key}`, t: 0, ch, type: "cc", cc, value: v });
      }
      return { lenS: Math.max(t1 - t0, 0.001), rows: [...carries, ...kept].sort(byTime) };
    }
    default:
      return { lenS, rows };
  }
}

export function applyOps(rows, ops, lenS) {
  let acc = { rows, lenS };
  for (const op of ops ?? []) {
    if (op.bypassed) continue;
    acc = applyOne(acc.rows, op, acc.lenS);
  }
  return acc;
}

// Presentation helpers for the EDITS stack / summary lines.
const fmtT = (t) => `${(+t.toFixed(1))}s`;
export function opLabel(op) {
  const r = op.range ? `${fmtT(op.range.t0)}–${fmtT(op.range.t1)}` : "";
  switch (op.kind) {
    case "scale": return { name: "SCALE", detail: `${r} · ×${(+op.params.k.toFixed(2))} about ${op.params.center ?? 64}` };
    case "offset": return { name: "OFFSET", detail: `${r} · ${op.params.dv >= 0 ? "+" : ""}${op.params.dv}` };
    case "smooth": return { name: "SMOOTH", detail: `${r} · ${op.params.windowMs ?? 60}ms window` };
    case "thin": return { name: "THIN", detail: `${r} · ±${op.params.epsilon ?? 1}` };
    case "delete": return { name: "DELETE", detail: `${(op.params.ids ?? []).length} event${(op.params.ids ?? []).length === 1 ? "" : "s"} removed` };
    case "move": return { name: "MOVE", detail: `${(op.params.ids ?? []).length} event${(op.params.ids ?? []).length === 1 ? "" : "s"} · ${op.params.dt >= 0 ? "+" : ""}${(+op.params.dt.toFixed(2))}s${op.params.dv ? ` · ${op.params.dv >= 0 ? "+" : ""}${op.params.dv}` : ""}` };
    case "insert": return { name: "INSERT", detail: `${fmtT(op.params.t)} · value ${op.params.v}` };
    case "trim": return { name: "TRIM", detail: `${fmtT(op.params.t0)}–${fmtT(op.params.t1)} (was ${op.params.was != null ? fmtT(op.params.was) : "?"})` };
    default: return { name: op.kind.toUpperCase(), detail: "" };
  }
}

// ── SIM: a scripted stand-in performance ────────────────────────────────────
// Deterministic (sine-driven, no RNG) so it is stable across re-renders and
// tests. Sweeps the first few controls of every bound channel over `durS`
// seconds at `hz` samples/s, plus one alien channel of unmapped traffic to
// exercise the raw-view path. Returns { events, durationS }.
export function simEvents(bindings, { durS = 42, hz = 12 } = {}) {
  const events = [];
  const chans = [...bindings.entries()].sort((a, b) => a[1].order - b[1].order);
  const steps = Math.round(durS * hz);
  for (let s = 0; s <= steps; s++) {
    const t = s / hz;
    chans.forEach(([ch, b], ci) => {
      const ccs = [...b.controls.keys()].slice(0, 3);
      ccs.forEach((cc, li) => {
        const phase = ci * 1.7 + li * 2.3;
        const freq = 0.18 + li * 0.11;
        // one control per channel steps (discrete), the rest sweep smoothly
        const value = li === ccs.length - 1 && ccs.length > 1
          ? [0, 64, 127][Math.floor(s / 20 + phase) % 3]
          : Math.round(63.5 + 63.5 * Math.sin(t * freq * Math.PI + phase));
        events.push({ t, ch, type: "cc", cc, value });
      });
    });
    // alien channel 16, unmapped CC 90 — proves the "not in rig — raw" path
    if (s % 8 === 0) events.push({ t, ch: 16, type: "cc", cc: 90, value: (s * 7) % 128 });
  }
  events.sort((a, b) => a.t - b.t);
  return { events, durationS: durS };
}
