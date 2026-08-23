//
// model.mjs — pure domain helpers: control-path resolution, cell display
// resolution (inheritance chain: cell → rig instance → pedal doc → control),
// name-bar runs, ids. No DOM, no transport — node-testable.
//
// Resolution chain per contract-v2 §2.1: layout cells reference rig
// instances (never pedals or raw channels, except the raw-CC escape hatch).
//

export const ROWS = 3, COLS = 6;
const POS_ROWS = ["top", "middle", "bottom"];
const POS_COLS = ["Left", "Center", "Right"];

// "normal.topLeft" → the control object in a pedal doc; also
// "hidden.*", "footswitch.left|right", "dip.<bank>.<switch>".
export function controlAt(pedal, path) {
  if (!pedal || !path) return null;
  const seg = path.split(".");
  if (seg[0] === "normal" || seg[0] === "hidden")
    return pedal.encoders[seg[0]]?.find((e) => e.position === seg[1]) ?? null;
  if (seg[0] === "footswitch") return pedal.footswitches?.[seg[1]] ?? null;
  if (seg[0] === "dip")
    return pedal.dipSwitchBanks?.[Number(seg[1])]?.switches?.[Number(seg[2])] ?? null;
  return null;
}

// The pedal's 9 normal-page positions in shelf/grid order.
export function pagePositions() {
  const out = [];
  for (const r of POS_ROWS) for (const c of POS_COLS) out.push(`${r}${c}`);
  return out;
}

// Perceived luminance 0..1 of a #rrggbb color.
export function luminance(hex) {
  if (!/^#[0-9a-f]{6}$/i.test(hex ?? "")) return 0.5;
  const n = parseInt(hex.slice(1), 16);
  return (0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
}

// Ink color for a pedal's text on the black device screen: its labelColor
// when that reads on black, else its backgroundColor (e.g. Reverse Mode C's
// black labelColor renders as the tan background color instead — matches the
// design mocks and the firmware's on-glass rendering).
export function screenInk(pedal) {
  if (!pedal) return "#e8e6e1";
  return luminance(pedal.labelColor) >= 0.25 ? pedal.labelColor : pedal.backgroundColor;
}

// ── Resolution ─────────────────────────────────────────────────────────────

export function instanceById(rig, instanceId) {
  return rig.instances.find((i) => i.instanceId === instanceId) ?? null;
}

// One binding → everything the UI needs to draw/describe it. Returns
// { ok, instance, pedal, control, cc, channel, label } — ok:false when the
// reference doesn't resolve (broken refs degrade, never brick: contract §6).
export function resolveBinding(binding, rig, pedalsById) {
  const t = binding?.target ?? {};
  if (t.raw) {
    return { ok: true, raw: true, cc: t.raw.cc, channel: t.raw.channel,
             label: `CC ${t.raw.cc}`, instance: null, pedal: null, control: null };
  }
  if (t.performance) {               // §4.3 performance-action target
    return { ok: true, perf: t.performance, cc: null, channel: null,
             label: t.performance.id, instance: null, pedal: null, control: null };
  }
  const instance = instanceById(rig, t.instance);
  const pedal = instance ? pedalsById[instance.pedalId] : null;
  const control = pedal ? controlAt(pedal, t.control) : null;
  if (!control) return { ok: false, instance, pedal, control: null, label: "?" };
  return {
    ok: true, instance, pedal, control,
    cc: control.cc, channel: instance.midiChannel,
    label: control.label ?? "",
  };
}

// A full encoder/footswitch/omniport cell → display model. `live` is the CC
// state map { "<channel>:<cc>": value } (may be empty).
export function resolveCell(cell, rig, pedalsById, live = {}) {
  if (!cell) return null;
  const bindings = (cell.bindings ?? []).map((b) => ({
    ...resolveBinding(b, rig, pedalsById),
    transform: b.transform ?? {},
    on: b.on, off: b.off,
  }));
  const first = bindings[0];
  const label = cell.label ?? first?.label ?? "?";
  const labelOverridden = cell.label != null && cell.label !== first?.label;
  const colorOverridden = cell.color != null;
  const pedal = first?.pedal ?? null;
  const value = first?.ok && first.control
    ? live[`${first.channel}:${first.cc}`] ?? first.control.defaultValue ?? 0
    : live[`${first?.channel}:${first?.cc}`] ?? 0;
  return {
    cell, bindings, pedal, label, labelOverridden, colorOverridden,
    macro: bindings.length > 1,
    broken: bindings.some((b) => !b.ok),
    interaction: cell.interaction ?? "knob",
    mode: cell.mode,                                    // footswitch cells
    color: cell.color ?? pedal?.backgroundColor ?? "#33373d",
    ink: cell.color ?? (pedal ? screenInk(pedal) : "#e8e6e1"),
    value,
    // discrete positions: the layout cell's explicit override (required for
    // raw-target toggles) wins over the control's own
    positions: cell.positions ?? controlPositions(first?.control),
    style: first?.control?.style ?? "toggle",
    ranges: first?.control?.ranges ?? null,
    detents: first?.control?.detents ?? null,
    highlight: first?.control?.highlightColor ?? null,
  };
}

// The labeled range (contract: contiguous, inclusive min/max) a value falls
// in, or null. Used by the mirror/faceplate bars and the on-glass firmware
// view alike: in-range values fill only the range's segment of the bar and
// read out the range label (falling back to the number when unlabeled).
export function rangeForValue(ranges, value) {
  if (!ranges?.length) return null;
  return ranges.find((r) => value >= r.min && value <= r.max) ?? null;
}

// The detent sitting exactly at a value, or null. Detents draw as tick marks
// on the bar; a value parked on a labeled one reads out that label.
export function detentForValue(detents, value) {
  return detents?.find((d) => d.value === value) ?? null;
}

// Readout for a positions control at a value: the nearest position's label,
// falling back to the position index — the same rule the firmware draws.
export function positionLabel(positions, value) {
  if (!positions?.length) return null;
  const i = positionIndex(positions, value);
  return positions[i].label || String(i);
}

// ── Discrete positions (toggles + arcade buttons) ──────────────────────────
// The v2 shape is an ordered `positions` array [{value, label?, color?}]
// (2..MAX_POSITIONS=8); the legacy `toggle` {left,center,right} object is
// still accepted from old custom-pedal docs (degrade rule) and normalized
// here. Positions enumerate the ONLY legal values a control sends — unlike
// ranges, which annotate a continuous sweep.

export function controlPositions(control) {
  if (!control) return null;
  if (control.positions?.length) return control.positions;
  const t = control.toggle;
  if (!t) return null;
  return [t.left, t.center, t.right].filter(Boolean);
}

// ── Target picking (design_handoff_add_target_picker) ─────────────────────
// Every control of the rig as a picker option, with a pickable/reason flag
// per picker kind — the popover TEACHES kind rules instead of silently
// filtering (the old behavior). kind:
//   'encoder' | 'expression' → continuous cells: knobs/toggles pickable,
//                              fs/dips dimmed (switch-type)
//   'switch'  → toggle/momentary/cycle footswitches: fs/dips pickable,
//               encoder-page controls dimmed (need CC set mode)
//   'scene'   → CC-set slots: everything pickable (a scene sets absolute
//               values)
// Inactive encoder positions ride along (pickable:false, inactive:true) so
// panes can mirror the shelf's 3×3 grid, `—` gaps included.

export const PICK_REASON = {
  needsCCSet: "knobs need CC set mode",
  switchType: "switch-type target — bind to a footswitch or CC set",
};

function pickReason(kind, place) {           // place: 'enc' | 'fs' | 'dip'
  if (kind === "scene") return null;
  if (kind === "switch") return place === "enc" ? PICK_REASON.needsCCSet : null;
  return place === "enc" ? null : PICK_REASON.switchType;   // encoder/expression
}

export function targetOptions(rig, pedalsById, kind) {
  const out = [];
  for (const inst of rig.instances) {
    const pedal = pedalsById[inst.pedalId];
    if (!pedal) continue;
    for (const page of ["normal", "hidden"])
      for (const pos of pagePositions()) {
        const ctl = controlAt(pedal, `${page}.${pos}`);
        if (!ctl || ctl.type === "inactive") {
          out.push({ inst, pedal, path: `${page}.${pos}`, page, label: "",
                     ctl: null, inactive: true, pickable: false, reason: "inactive" });
          continue;
        }
        const reason = pickReason(kind, "enc");
        out.push({ inst, pedal, path: `${page}.${pos}`, page, label: ctl.label,
                   ctl, pickable: !reason, reason });
      }
    for (const side of ["left", "right"]) {
      const fs = pedal.footswitches?.[side];
      if (!fs) continue;
      const reason = pickReason(kind, "fs");
      out.push({ inst, pedal, path: `footswitch.${side}`, fs: true,
                 label: fs.label, ctl: fs, pickable: !reason, reason });
    }
    (pedal.dipSwitchBanks ?? []).forEach((bank, bi) =>
      bank.switches.forEach((sw, si) => {
        const reason = pickReason(kind, "dip");
        out.push({ inst, pedal, path: `dip.${bi}.${si}`, bank: bank.label, bankIndex: bi,
                   label: sw.label, ctl: sw, pickable: !reason, reason });
      }));
  }
  return out;
}

// A library-pedal snapshot bound to a rig instance → CC-set scene bindings
// ({target, on} per value). Unknown/inactive paths skip — same degrade rule
// as snapshotCCs. The picker expands snapshots AT BIND TIME (decision in the
// handoff): the result is ordinary scene rows, editable like any other.
export function snapshotSceneBindings(pedal, instance, snapshot) {
  const out = [];
  for (const [path, value] of Object.entries(snapshot?.values ?? {})) {
    const ctl = controlAt(pedal, path);
    if (ctl && ctl.type !== "inactive")
      out.push({ target: { instance: instance.instanceId, control: path }, on: value });
  }
  return out;
}

// A user-captured scene (docs.snapshots: values [{channel, cc, value}]) →
// CC-set bindings. Values are raw channel/cc — they were captured from live
// wire state, not through the resolution chain.
export function userSceneBindings(snapshot) {
  return (snapshot?.values ?? []).map((v) => ({
    target: { raw: { channel: v.channel, cc: v.cc } }, on: v.value,
  }));
}

// True when a cell's binding list already targets this instance+control (or
// the same raw ch/cc, or the same performance id+action). A knob can't
// usefully drive the same target twice, so drops and the add-target picker
// both use this to refuse duplicates. Raw/perf targets compare by their own
// identity — before 2026-07-16 any two non-instance targets compared equal
// (undefined === undefined), which never bit because only instance targets
// were ever checked.
export function targetsEqual(t, target) {
  if (!t || !target) return false;
  if (target.raw) return t.raw?.channel === target.raw.channel && t.raw?.cc === target.raw.cc;
  if (target.performance)
    return t.performance?.id === target.performance.id
      && t.performance?.action === target.performance.action;
  return !t.raw && !t.performance
    && t.instance === target.instance && t.control === target.control;
}

export function bindingsHaveTarget(bindings, target) {
  if (!target) return false;
  return (bindings ?? []).some((b) => targetsEqual(b?.target, target));
}

// Index of the position nearest to a value (0 when positions are absent).
export function positionIndex(positions, value) {
  if (!positions?.length) return 0;
  let best = 0;
  positions.forEach((p, i) => {
    if (Math.abs(p.value - value) < Math.abs(positions[best].value - value)) best = i;
  });
  return best;
}

// ── Layout pages (layout.hidden — contract §9.4, live 2026-07-16) ──────────
// A layout has two pages: MAIN (the top-level encoders/footswitches arrays)
// and HIDDEN (layout.hidden, same shapes, both arrays optional — absent =
// empty). Omniports never flip pages (an expression pedal doesn't change
// function mid-sweep), so they stay top-level only.

export const PAGE_MAIN = "main";
export const PAGE_HIDDEN = "hidden";

const emptyEnc = () => Array(ROWS * COLS).fill(null);
const emptyFsw = () => [null, null, null, null];

// Read access to a page's cell arrays. Hidden reads never materialize
// layout.hidden — absent arrays come back as fresh all-null arrays.
export function pageArrays(layout, page) {
  if (page !== PAGE_HIDDEN)
    return { encoders: layout.encoders, footswitches: layout.footswitches };
  return {
    encoders: layout.hidden?.encoders ?? emptyEnc(),
    footswitches: layout.hidden?.footswitches ?? emptyFsw(),
  };
}

// Write access: same, but materializes layout.hidden on demand so mutations
// land in the stored document. Pair with pruneHiddenPage so an untouched
// hidden page never bloats the doc (or moves its content hash).
export function ensurePageArrays(layout, page) {
  if (page !== PAGE_HIDDEN)
    return { encoders: layout.encoders, footswitches: layout.footswitches };
  layout.hidden ??= {};
  layout.hidden.encoders ??= emptyEnc();
  layout.hidden.footswitches ??= emptyFsw();
  return { encoders: layout.hidden.encoders, footswitches: layout.hidden.footswitches };
}

// Drop layout.hidden again when every hidden cell is null — keeps documents
// (and their FNV hashes) identical to their pre-hidden-page selves.
export function pruneHiddenPage(layout) {
  const hid = layout?.hidden;
  if (!hid) return;
  const gone = (a) => !a || a.every((c) => c === null);
  if (gone(hid.encoders)) delete hid.encoders;
  if (gone(hid.footswitches)) delete hid.footswitches;
  if (!hid.encoders && !hid.footswitches) delete layout.hidden;
}

// True when the layout carries anything on its hidden page.
export function hiddenPageUsed(layout) {
  const hid = layout?.hidden;
  if (!hid) return false;
  return (hid.encoders ?? []).some(Boolean) || (hid.footswitches ?? []).some(Boolean);
}

// The layout as seen from one page: same identity/omniports, that page's
// cell arrays. A render-side READ view — mutations go through
// ensurePageArrays on the stored doc, never through this copy.
export function pageView(layout, page) {
  if (page !== PAGE_HIDDEN) return layout;
  return { ...layout, ...pageArrays(layout, PAGE_HIDDEN), page: PAGE_HIDDEN };
}

// Every binding in a layout — both pages, omniports (aux sub-cells too).
// The one walker for "who references what" questions (instance usage,
// instance renames): a binding on the hidden page or inside an aux pair
// counts exactly like any other.
export function layoutAllBindings(layout) {
  const cells = [
    ...layout.encoders, ...layout.footswitches, ...layout.omniports,
    ...(layout.hidden?.encoders ?? []), ...(layout.hidden?.footswitches ?? []),
  ];
  return cells.flatMap((c) => !c ? []
    : c.aux ? c.aux.flatMap((s) => s?.bindings ?? []) : c.bindings ?? []);
}

// Does the layout bind this instance anywhere — either page, omniports too?
export function layoutBindsInstance(layout, instanceId) {
  return layoutAllBindings(layout).some((b) => b.target?.instance === instanceId);
}

// ── Hidden-counterpart drop plans (the "also update hidden?" prompt) ───────
// Dropping a pedal's NORMAL-page content onto the MAIN page can mirror the
// same shape onto the layout's hidden page, using the pedal's own hidden
// controls at the SAME positions (v1 / Chase Bliss: the hidden function
// lives under the knob it shadows). Pure planners — the caller applies.

// One planned hidden-page encoder write: bind the pedal's hidden.<position>
// control, or clear the cell when the pedal has none there (the group-stamp
// claim rule, applied to both pages).
function hiddenEncoderWrite(pedal, instanceId, position, index) {
  const ctl = controlAt(pedal, `hidden.${position}`);
  const active = ctl && ctl.type !== "inactive";
  return {
    index,
    cell: active ? {
      interaction: ctl.type === "toggle" ? "toggle" : "knob",
      bindings: [{ target: { instance: instanceId, control: `hidden.${position}` } }],
    } : null,
    active: !!active,
  };
}

// Plan for a single-chip drop of `normal.<pos>` landing on encoder `index`.
// Returns null when the pedal has no live hidden counterpart there — no
// prompt in that case.
export function hiddenChipPlan(pedal, instanceId, control, index) {
  const seg = control?.split?.(".") ?? [];
  if (seg[0] !== "normal") return null;               // hidden/fs/dip drags never prompt
  const w = hiddenEncoderWrite(pedal, instanceId, seg[1], index);
  if (!w.active) return null;
  return { encoders: [w], footswitches: [], count: 1 };
}

// Plan for a handle (row/col/grid) or header-half drop: every landed member
// mirrors its position onto the hidden page (clears where the pedal has no
// hidden control there). Returns null when nothing active would land —
// prompting to stamp all-clears would be noise.
export function hiddenGroupPlan(pedal, instanceId, targets, fsSlots = []) {
  const encoders = targets
    .filter((t) => t.index != null)
    .map((t) => hiddenEncoderWrite(pedal, instanceId, t.position, t.index));
  // Header drops carry the pedal's footswitches; the pedal has no separate
  // hidden stomp functions, so the hidden page gets the same bindings — the
  // stomps keep working while the hidden page is shown (v1 behavior).
  const footswitches = fsSlots
    .filter((s) => pedal.footswitches?.[s.side])
    .map((s) => ({
      index: s.index,
      cell: {
        mode: "toggle",
        bindings: [{ target: { instance: instanceId, control: `footswitch.${s.side}` }, on: 127, off: 0 }],
      },
    }));
  const count = encoders.filter((w) => w.active).length;
  if (count === 0) return null;
  return { encoders, footswitches, count };
}

// Apply a plan to the stored layout doc (inside a store.mutate).
export function applyHiddenPlan(layout, plan) {
  const a = ensurePageArrays(layout, PAGE_HIDDEN);
  for (const w of plan.encoders) a.encoders[w.index] = w.cell;
  for (const w of plan.footswitches) a.footswitches[w.index] = w.cell;
  pruneHiddenPage(layout);
}

// ── Sources shelf (design_handoff_layouts_shelf_restructure, option 1b) ────
// The LAYOUTS left pane's per-pedal counts, collapse defaults, and the drop
// results for the new draggable rows (dips, snapshots, performances, raw CC).
// Pure — the shelf render and drop handlers in views-layouts.mjs call these.

// What a pedal contributes to the shelf: active knobs per page, footswitch
// sides, total dip switches. Drives the collapsed-card summary line and
// which inner sections render at all.
export function pedalShelfCounts(pedal) {
  const active = (page) => pagePositions().filter((pos) => {
    const ctl = controlAt(pedal, `${page}.${pos}`);
    return ctl && ctl.type !== "inactive";
  }).length;
  return {
    knobs: active("normal"),
    hidden: active("hidden"),
    fs: ["left", "right"].filter((s) => pedal.footswitches?.[s]).length,
    dips: (pedal.dipSwitchBanks ?? []).reduce((n, b) => n + (b.switches?.length ?? 0), 0),
  };
}

// "9 knobs · 7 hidden · 2 fs · 16 dips" — zero-count parts drop out
// (knobs always shows: a pedal with none is still a pedal).
export function shelfSummary(c) {
  const parts = [`${c.knobs} knobs`];
  if (c.hidden) parts.push(`${c.hidden} hidden`);
  if (c.fs) parts.push(`${c.fs} fs`);
  if (c.dips) parts.push(`${c.dips} dips`);
  return parts.join(" · ");
}

// A pedal card's open flags with the handoff defaults filled in: card,
// hidden and footswitches open; dips closed. Stored overrides win.
export function shelfOpenFor(shelfOpen, instanceId) {
  return { card: true, hidden: true, fs: true, dips: false,
           ...(shelfOpen?.pedals?.[instanceId] ?? {}) };
}

// A snapshot row dropped on a footswitch: flip the switch to CC-set mode and
// merge the scene in — values already bound stay put (same dedupe as the
// picker's onSnapshot path). Returns the replacement cell, or null when
// every value is already there (caller toasts instead of mutating).
export function sceneDropCell(existing, sceneBindings) {
  const fresh = sceneBindings.filter((sb) => !bindingsHaveTarget(existing?.bindings, sb.target));
  if (!fresh.length) return null;
  return existing
    ? { ...existing, mode: "send", bindings: [...existing.bindings, ...fresh] }
    : { mode: "send", bindings: fresh };
}

// ── Handle-drag groups (design_handoff_drop_zones, round 3) ────────────────
// A shelf-card handle carries a group of the pedal's normal-page controls:
// ⋯ a row of 3, ⋮ a column of 3, ∷ the whole 3×3. Members are (rowOff,
// colOff) offsets from the group's top-left knob plus the pedal control
// position each one carries.

export function groupMembers(kind, idx = 0) {
  const out = [];
  const push = (rowOff, colOff, r, c) =>
    out.push({ rowOff, colOff, position: `${POS_ROWS[r]}${POS_COLS[c]}` });
  if (kind === "row") for (let c = 0; c < 3; c++) push(0, c, idx, c);
  else if (kind === "col") for (let r = 0; r < 3; r++) push(r, 0, r, idx);
  else for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) push(r, c, r, c);
  return out;
}

// Anchor a group's top-left member on encoder `anchor`. Members that would
// land past the device's right edge or below the bottom row get index: null
// — they are clipped, never wrapped; the drop applies only what fits.
export function groupTargets(anchor, members) {
  const row = Math.floor(anchor / COLS), col = anchor % COLS;
  return members.map((m) => {
    const r = row + m.rowOff, c = col + m.colOff;
    return { ...m, index: r < ROWS && c < COLS ? r * COLS + c : null };
  });
}

// Header drag → device half: the pedal's 3×3 normal grid onto that half's
// nine encoders (the side-by-side generator's placement). half: 0 = left
// (columns 0-2), 1 = right (columns 3-5). Nothing can clip.
export function halfTargets(half) {
  return groupMembers("grid").map((m) => ({
    ...m, index: m.rowOff * COLS + half * 3 + m.colOff,
  }));
}

// The pedal's footswitches ride along with a header drop (the generator's
// fs placement): the left half owns FS1/FS2, the right half FS3/FS4.
export function halfFootswitchSlots(half) {
  return [
    { index: half * 2, side: "left" },
    { index: half * 2 + 1, side: "right" },
  ];
}

// ── Name-bar runs ──────────────────────────────────────────────────────────
// One bar per run of adjacent same-pedal columns. For a display carrying two
// bands, a column's pedal comes from the top band's cell, falling back to
// the bottom band's (band↔row orientation is unverified until F3 — keep
// flippable). Returns [{span, pedal|null}].
export function nameBarRuns(colPedals) {
  const runs = [];
  for (const pedal of colPedals) {
    const last = runs[runs.length - 1];
    if (last && last.key === (pedal?.id ?? null)) last.span++;
    else runs.push({ key: pedal?.id ?? null, pedal, span: 1 });
  }
  return runs;
}

// Column-wise pedal owners for a set of resolved cell rows (arrays of
// resolved cells or null), e.g. [row1Cells, row2Cells].
export function columnPedals(rows, cols = COLS) {
  const out = [];
  for (let c = 0; c < cols; c++) {
    let pedal = null;
    for (const row of rows) { pedal = row?.[c]?.pedal ?? pedal; if (pedal) break; }
    out.push(pedal);
  }
  return out;
}

// ── Documents ──────────────────────────────────────────────────────────────

// A blank user-defined pedal (same shape as a pedal-library entry — the
// standalone format/formatVersion fields ride on at PUT time, v2.mjs). All
// encoders start inactive (the library's inactive convention: cc 0, black
// colors); the editor activates them one by one. Active encoders keep the
// pedal-level colors (color = white knob body, like the library's pedals).
export function newCustomPedal({ id, name, backgroundColor = "#4A4E57", labelColor = "#E8E6E1" }) {
  const map = () => pagePositions().map((position) => ({
    position, type: "inactive", cc: 0, defaultValue: 0,
    label: "", labelColor: "#000000", color: "#000000", highlightColor: "#000000",
  }));
  return {
    id, name, backgroundColor, labelColor,
    encoders: { normal: map(), hidden: map() },
    footswitches: {
      left: { label: "LEFT", cc: 103, defaultValue: 0 },
      right: { label: "RIGHT", cc: 102, defaultValue: 0 },
    },
    dipSwitchBanks: [],
  };
}

// ── Live-state helpers (mirror interaction, monitor, snapshot) ─────────────

// Master 0..127 → a binding's wire value through its transform (same math
// as the omniport heel→toe preview and the firmware's encoder mapping).
export function transformValue(transform, v) {
  const t = transform ?? {};
  const lo = t.min ?? 0, hi = t.max ?? 127;
  const pos = Math.max(0, Math.min(127, v)) / 127;
  return Math.round(t.invert ? hi - (hi - lo) * pos : lo + (hi - lo) * pos);
}

// Resolve "who is channel ch / CC cc" against the rig — for the CC monitor.
// Returns { instance, pedal, label } for the first match, or null.
export function ccOwner(rig, pedalsById, channel, cc) {
  for (const inst of rig.instances) {
    if (inst.midiChannel !== channel) continue;
    const pedal = pedalsById[inst.pedalId];
    if (!pedal) continue;
    for (const page of ["normal", "hidden"])
      for (const e of pedal.encoders[page])
        if (e.type !== "inactive" && e.cc === cc)
          return { instance: inst, pedal, label: e.label };
    for (const side of ["left", "right"])
      if (pedal.footswitches[side].cc === cc)
        return { instance: inst, pedal, label: pedal.footswitches[side].label };
    for (const bank of pedal.dipSwitchBanks ?? [])
      for (const sw of bank.switches)
        if (sw.cc === cc)
          return { instance: inst, pedal, label: `${sw.label} (dip)` };
  }
  return null;
}

// A pedal snapshot ("START HERE") → concrete CC sends for one rig instance.
// Unknown/inactive control paths are skipped (a snapshot from a newer
// library rev must not brick an older one — same degrade rule as bindings).
export function snapshotCCs(pedal, instance, snapshot) {
  const out = [];
  for (const [path, value] of Object.entries(snapshot?.values ?? {})) {
    const ctl = controlAt(pedal, path);
    if (ctl && ctl.type !== "inactive")
      out.push({ channel: instance.midiChannel, cc: ctl.cc, value });
  }
  return out;
}

// Everything a .mid snapshot should carry: the current (live ?? default)
// value of every settable control in the rig — encoders on both pages and
// dip switches. Footswitches are momentary actions, not state — skipped.
export function snapshotEvents(rig, pedalsById, live = {}) {
  const out = [];
  const seen = new Set();
  const push = (channel, cc, fallback) => {
    const key = `${channel}:${cc}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ channel, cc, value: live[key] ?? fallback ?? 0 });
  };
  for (const inst of rig.instances) {
    const pedal = pedalsById[inst.pedalId];
    if (!pedal) continue;
    for (const page of ["normal", "hidden"])
      for (const e of pedal.encoders[page])
        if (e.type !== "inactive") push(inst.midiChannel, e.cc, e.defaultValue);
    for (const bank of pedal.dipSwitchBanks ?? [])
      for (const sw of bank.switches) push(inst.midiChannel, sw.cc, sw.defaultValue);
  }
  return out;
}

// Capture candidates for a new user snapshot: every settable control in the
// rig — encoders on both pages, footswitches, dip switches — grouped in rig
// order per instance, deduped by channel:cc. Everything starts selected;
// the editor is for carving away what a scene shouldn't touch.
export function rigCaptureItems(rig, pedalsById, live = {}) {
  const items = [];
  const seen = new Set();
  for (const inst of rig.instances) {
    const pedal = pedalsById[inst.pedalId];
    if (!pedal) continue;
    const push = (cc, fallback, label) => {
      const key = `${inst.midiChannel}:${cc}`;
      if (seen.has(key)) return;
      seen.add(key);
      items.push({
        key, channel: inst.midiChannel, cc,
        value: live[key] ?? fallback ?? 0,
        label,
        group: inst.instanceId,
        color: pedal.backgroundColor ?? "#33373d",
        selected: true,
      });
    };
    for (const page of ["normal", "hidden"])
      for (const e of pedal.encoders[page])
        if (e.type !== "inactive")
          push(e.cc, e.defaultValue, page === "hidden" ? `${e.label} (hidden)` : e.label);
    for (const side of ["left", "right"]) {
      const fs = pedal.footswitches?.[side];
      if (fs) push(fs.cc, fs.defaultValue, fs.label);
    }
    for (const bank of pedal.dipSwitchBanks ?? [])
      for (const sw of bank.switches) push(sw.cc, sw.defaultValue, `${sw.label} (dip)`);
  }
  return items;
}

// ── Config export / import (backup + sharing) ──────────────────────────────
// One self-contained JSON file: everything authored in this browser. Custom
// pedals ride along because layouts are useless without them; library pedals
// don't (every install has the library).

export function exportedConfig(docs) {
  return {
    format: "proxi-config", formatVersion: 1,
    exportedAt: new Date().toISOString(),
    pedals: docs.pedals ?? [],
    rig: docs.rig,
    layouts: docs.layouts,
    settings: docs.settings,
    snapshots: docs.snapshots ?? [],
  };
}

// Parse + shape-check an exported config. Returns a docs set or throws with
// a human-readable reason. Only structural integrity is enforced here —
// dangling references degrade in the UI, never brick (contract §6).
export function parseConfigImport(text) {
  let c;
  try { c = JSON.parse(text); } catch { throw new Error("not a JSON file"); }
  if (c?.format !== "proxi-config")
    throw new Error("not a Proxi config export (no format: \"proxi-config\")");
  if (c.formatVersion !== 1)
    throw new Error(`unsupported formatVersion ${c.formatVersion}`);
  if (!Array.isArray(c.rig?.instances)) throw new Error("bad rig document");
  const layouts = c.layouts ?? [];
  for (const l of layouts) {
    if (!l?.id || l.encoders?.length !== ROWS * COLS
        || l.footswitches?.length !== 4 || l.omniports?.length !== 2)
      throw new Error(`bad layout document "${l?.id ?? "?"}"`);
  }
  const pedals = c.pedals ?? [];
  if (!Array.isArray(pedals) || pedals.some((p) => !p?.id || !p.encoders || !p.footswitches))
    throw new Error("bad custom-pedal document");
  const snapshots = c.snapshots ?? [];
  if (!Array.isArray(snapshots)
      || snapshots.some((s) => !s?.id || !s.name || !Array.isArray(s.values)))
    throw new Error("bad snapshot entry");
  return {
    pedals, layouts, snapshots,
    rig: c.rig,
    settings: c.settings
      ?? { format: "proxi-settings", formatVersion: 1, id: "settings", layoutOrder: [] },
  };
}

export function emptyLayout(id, name) {
  return {
    format: "proxi-layout", formatVersion: 1, id, name,
    encoders: Array(ROWS * COLS).fill(null),
    footswitches: [null, null, null, null],
    omniports: [null, null],
  };
}

export function uniqueId(base, taken) {
  const slug = (base.replace(/[^A-Za-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "x").slice(0, 28);
  const t = new Set(taken);
  let id = slug;
  for (let n = 2; t.has(id); n++) id = `${slug.slice(0, 26)}-${n}`;
  return id;
}

// Cell coordinates for toasts/inspector: index → "R2 · C3".
export const cellName = (i) => `R${Math.floor(i / COLS) + 1} · C${(i % COLS) + 1}`;
export const cellNameShort = (i) => `R${Math.floor(i / COLS) + 1}·C${(i % COLS) + 1}`;

// ── RIG board insertion-line drop math (design_handoff_rig_restructure) ─────
// A drag hovers row `rowIdx`; `before` = pointer in the row's top half. The
// insertion point sits in the gap the line is drawn in.

// Library-pedal drop → index to splice the new instance in at.
export function insertionIndex(rowIdx, before) {
  return before ? rowIdx : rowIdx + 1;
}

// Row reorder → post-removal splice index, or null when the line would sit
// adjacent to the dragged row itself (a no-op — no line is shown either).
export function reorderTarget(dragIdx, rowIdx, before) {
  const t = insertionIndex(rowIdx, before);
  if (t === dragIdx || t === dragIdx + 1) return null;
  return dragIdx < t ? t - 1 : t;
}

// ── Bank switcher walk math (design_handoff_bank_switching) ────────────────
// The footswitch walk over settings.layoutOrder, ALWAYS wrapping at the ends
// (last → first — deliberately no flag for this). Returns null for an empty
// order; an unknown/absent currentId anchors at position 0, matching the
// "first layout wins" fallback everywhere else in the app. n/prevN/nextN are
// 1-based bank numbers for display.
export function bankNeighbors(order, currentId) {
  const m = order.length;
  if (!m) return null;
  const i = Math.max(0, order.indexOf(currentId));
  const p = (i - 1 + m) % m, x = (i + 1) % m;
  return {
    index: i, n: i + 1, count: m,
    prevId: order[p], prevN: p + 1,
    nextId: order[x], nextN: x + 1,
  };
}
