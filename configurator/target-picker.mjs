//
// target-picker.mjs — the unified add-target picker
// (design_handoff_add_target_picker, option 1b "anchored popover"). One
// `+ add target` entry row per inspector section replaces the flat
// <select>, the collapsed PERFORMANCE / RAW CC sections, and adds snapshot
// binding (new). The popover browses every source: rig instances,
// performances, snapshots, raw CC.
//
// State contract (the 2026-07-13 morph rule): ALL popover state lives in
// store.state.inspForm — pickerOpen / pickerRail / pickerQuery (+ the reused
// perfAction / perfTake / rawCh / rawCC). The inspector re-morphs on every
// store notify, so DOM-held state and per-render closured nodes go stale.
// Positioning is imperative (anchor rect → fixed left/top, recomputed after
// every morph via rAF and on scroll/resize) — the only DOM the render
// doesn't own.
//
import { h } from "./ui.mjs";
import {
  targetOptions, bindingsHaveTarget, targetsEqual,
  snapshotSceneBindings, userSceneBindings,
} from "./model.mjs";

// PERFORMANCE: bind a stored take to this control (contract §4.3, F6).
// Encoders get all three actions (spin scrubs, click fires); footswitches
// get trigger/toggle (there's nothing to sweep); expression is scrub-only
// (heel→toe IS the sweep).
export const PERF_ACTION_HINT = {
  toggle: "click/press loops it on · off",
  trigger: "click/press fires it once, no loop",
  scrub: "spin (or heel→toe) sweeps the playhead, sending MIDI",
};

export const PERF_ACTIONS = {
  encoder: ["toggle", "trigger", "scrub"],
  expression: ["scrub"],
  switch: ["toggle", "trigger"],
  scene: ["toggle", "trigger"],
};

const TAKE_ID_RE = /^[a-zA-Z0-9-]{1,32}$/;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v) || 0));

const isPhone = () => window.matchMedia("(max-width: 740px)").matches;

// ── Global handlers (module singletons — never stacked) ────────────────────

let openStore = null;      // non-null while a popover is open
const closePicker = () => openStore?.update((s) => {
  s.inspForm.pickerOpen = false;
  s.inspForm.pickerReplace = null;
});
const onKeydown = (e) => { if (e.key === "Escape") closePicker(); };
const onPointerdown = (e) => {
  // binding rows re-target the open popover (replace mode) — don't close first
  if (e.target.closest?.(".tp-pop, .add-target-entry, .tp-changeable")) return;
  closePicker();
};
const onReanchor = () => {
  // crossing the 740px breakpoint while open: the float/inline choice is
  // baked into the rendered class — force a re-render so it's re-decided
  const pop = document.querySelector(".tp-pop");
  if (pop && pop.classList.contains("tp-float") === isPhone()) openStore?.update(() => {});
  else positionLive();
};

function syncGlobalHandlers(store, open) {
  if (open && !openStore) {
    document.addEventListener("keydown", onKeydown);
    document.addEventListener("pointerdown", onPointerdown, true);
    window.addEventListener("resize", onReanchor);
    document.addEventListener("scroll", onReanchor, true);
  } else if (!open && openStore) {
    document.removeEventListener("keydown", onKeydown);
    document.removeEventListener("pointerdown", onPointerdown, true);
    window.removeEventListener("resize", onReanchor);
    document.removeEventListener("scroll", onReanchor, true);
  }
  openStore = open ? store : null;
}

// ── Imperative positioning (desktop float; phone renders in flow) ──────────
// Resolves LIVE nodes at call time (morph retains first-render DOM), floats
// the popover left of the entry row over the layout card, clamps to the
// viewport, and points the arrow at the anchor.

function positionLive() {
  const pop = document.querySelector(".tp-pop.tp-float");
  // replace mode anchors to the binding row being changed, add mode to the entry
  const entry = document.querySelector(".tp-changing")
    ?? document.querySelector(".add-target-entry.open");
  if (!pop || !entry) return;
  const r = entry.getBoundingClientRect();
  const w = pop.offsetWidth || 520, hgt = pop.offsetHeight || 430;
  const top = clamp(r.top + r.height / 2 - 130, 12, Math.max(12, window.innerHeight - hgt - 12));
  pop.style.left = `${Math.max(12, r.left - w - 14)}px`;
  pop.style.top = `${top}px`;
  const arrow = pop.querySelector(".tp-arrow");
  if (arrow) arrow.style.top = `${clamp(r.top + r.height / 2 - top - 5, 14, hgt - 24)}px`;
}

// ── Option filtering ────────────────────────────────────────────────────────

const matches = (q, ...texts) =>
  !q || texts.some((t) => (t ?? "").toLowerCase().includes(q));

// ── Chips ───────────────────────────────────────────────────────────────────

function chip(o, { cell, onTarget, cls }) {
  if (o.inactive) return h(`div.tp-chip.${cls}.inactive`, {}, "—");
  const label = o.label || "⇵";                 // unlabeled toggles (tooltip carries CC)
  const target = { instance: o.inst.instanceId, control: o.path };
  if (bindingsHaveTarget(cell?.bindings, target))
    return h(`div.tp-chip.${cls}.bound`, { title: "already bound to this cell" }, `✓ ${label}`);
  if (!o.pickable)
    return h(`div.tp-chip.${cls}.dim`, { title: o.reason }, label);
  return h(`div.tp-chip.${cls}`, {
    title: `${o.label || "unlabeled toggle"} · CC ${o.ctl.cc} — click to bind`,
    onclick: () => onTarget(target),
  }, label);
}

function chipGrid(options, ctx2) {
  return h("div.tp-grid", options.map((o) => chip(o, { ...ctx2, cls: "tp-knob" })));
}

function chipRow(options, ctx2, cls) {
  return h("div.tp-chip-row", options.map((o) => chip(o, { ...ctx2, cls })));
}

// ── Panes ───────────────────────────────────────────────────────────────────

function pedalPane(inst, opts, cfg, q) {
  const { kind } = cfg;
  const mine = opts.filter((o) => o.inst === inst);
  const enc = (page) => mine.filter((o) => o.page === page)
    .filter((o) => o.inactive ? !q : matches(q, o.label));
  const fs = mine.filter((o) => o.fs && matches(q, o.label));
  const banks = [...new Set(mine.filter((o) => o.bank != null).map((o) => o.bankIndex))]
    .map((bi) => ({
      label: mine.find((o) => o.bankIndex === bi).bank,
      sw: mine.filter((o) => o.bankIndex === bi && matches(q, o.label)),
    }))
    .filter((b) => b.sw.length);
  const normal = enc("normal"), hidden = enc("hidden");
  const hasHidden = hidden.some((o) => !o.inactive);
  const ctx2 = { cell: cfg.cell, onTarget: cfg.onTarget };

  const switchFirst = kind === "switch" || kind === "scene";
  const knobNote = kind === "switch" && h("span.tp-dim-note", {}, " — need CC set mode");
  const swNote = (kind === "encoder" || kind === "expression")
    && h("span.tp-dim-note", {}, " — switch things; pick a footswitch or CC set");

  const knobSections = [
    normal.length > 0 && h("div.tp-sec-label", {}, "KNOBS", knobNote),
    normal.length > 0 && chipGrid(normal, ctx2),
    hasHidden && hidden.length > 0 && h("div.tp-sec-label", {}, "HIDDEN", knobNote),
    hasHidden && hidden.length > 0 && chipGrid(hidden, ctx2),
  ];
  const switchSections = [
    fs.length > 0 && h("div.tp-sec-label", {}, "FOOTSWITCHES", swNote),
    fs.length > 0 && chipRow(fs, ctx2, "tp-fs"),
    banks.map((b) => [
      h("div.tp-sec-label", {}, `DIP · ${b.label}`),
      chipRow(b.sw, ctx2, "tp-dip"),
    ]),
  ];

  const footnote = kind === "switch"
    ? h("div.tp-footnote", {}, "a toggle footswitch flips switch-like things. switch to ",
        h("span.tp-em", {}, "CC set"), " mode to send knob values too.")
    : null;

  return [
    h("div.tp-pane-head",
      h("span.tp-pane-name", {}, inst.name ?? inst.instanceId),
      h("span.tp-pane-ch", {}, `ch ${inst.midiChannel}`)),
    ...(switchFirst ? [switchSections, knobSections] : [knobSections, switchSections]),
    !normal.length && !hidden.length && !fs.length && !banks.length
      && h("div.tp-footnote", {}, q ? "no matches on this pedal" : "no controls"),
    footnote,
  ];
}

function perfPane(ctx, cfg, q) {
  const { store } = ctx;
  const f = store.state.inspForm;
  const { manifest, takeNames } = store.state.link;
  const allTakes = Object.keys(manifest?.performances ?? {}).sort();
  const takes = allTakes.filter((t) => matches(q, t, takeNames?.[t]));
  const actions = PERF_ACTIONS[cfg.kind];
  const action = actions.includes(f.perfAction) ? f.perfAction : actions[0];

  const seg = h("div.segmented.sm",
    actions.map((a) => h("button.seg", {
      class: a === action ? "on" : "",
      onclick: () => a !== action && store.update((s) => { s.inspForm.perfAction = a; }),
    }, a)));

  const bindId = (id) => {
    if (!TAKE_ID_RE.test(id)) {
      store.showToast({ msg: "take id: a-z, 0-9, dashes", undoable: false });
      return;
    }
    cfg.onTarget({ performance: { id, action } });
  };

  const rows = takes.length
    ? takes.map((t) => h("div.tp-row", {},
        h("span.tp-row-id", {}, t),
        h("span.tp-row-sub", {}, takeNames?.[t] ?? "—"),
        h("button.tp-bind", { onclick: () => bindId(t) }, "+ bind")))
    : allTakes.length
    // the manifest has takes but the query filtered them all
    ? h("div.tp-footnote", {}, "no matching takes")
    // nothing on the manifest yet → free-typed id, same validation as before
    : h("div.tp-raw-row", {},
        h("input.label-input.tp-take-input", {
          value: f.perfTake ?? "take", placeholder: "take id",
          dataset: { focusKey: "perf-take-id" },
          oninput: (e) => store.update((s) => { s.inspForm.perfTake = e.target.value; }),
        }),
        h("button.ghost-btn.sm", { onclick: () => bindId((f.perfTake ?? "take").trim()) }, "bind"));

  return [
    h("div.tp-pane-head",
      h("span.tp-head-perf", {}, "PERFORMANCES"),
      h("span.tp-head-sub", {}, "takes · device manifest")),
    actions.length > 1 ? seg : h("div.tp-sec-label", {}, action.toUpperCase()),
    rows,
    h("div.tp-footnote", {}, PERF_ACTION_HINT[action]),
  ];
}

function snapPane(rows, cfg, q) {
  return [
    h("div.tp-pane-head",
      h("span.tp-head-snap", {}, "SNAPSHOTS"),
      h("span.tp-head-sub", {}, "value scenes — new: bindable here")),
    rows.map((r) => h("div.tp-row", {},
      h("span.tp-snap-spine", { style: { background: r.spine } }),
      h("div.tp-row-main",
        h("div.tp-row-id", {}, r.name),
        h("div.tp-row-sub", {}, r.sub)),
      h("button.tp-bind", { onclick: () => cfg.onSnapshot(r.bindings, r.name) }, "+ bind"))),
    !rows.length && h("div.tp-footnote", {},
      q ? "no matching snapshots" : "no snapshots yet — capture one from the DEVICE mirror or a pedal's library page"),
    h("div.tp-footnote", {},
      "binding a snapshot puts the switch in CC-set mode — a press sends every value in the scene"),
  ];
}

// Every bindable snapshot: library-pedal snapshots per rig instance of that
// pedal, then user-captured scenes. Expanded to scene bindings up front so
// counts and the bind action share one shape.
export function snapshotRows(store, rig, pedalsById, q = "") {
  const out = [];
  for (const inst of rig.instances) {
    const pedal = pedalsById[inst.pedalId];
    for (const snap of pedal?.snapshots ?? []) {
      const name = `${inst.instanceId} / ${snap.name}`;
      if (!matches(q, name, snap.name)) continue;
      const bindings = snapshotSceneBindings(pedal, inst, snap);
      if (!bindings.length) continue;
      out.push({ name, spine: pedal.backgroundColor, bindings,
                 sub: `${bindings.length} values · library` });
    }
  }
  for (const snap of store.state.docs.snapshots ?? []) {
    if (!matches(q, snap.name)) continue;
    const bindings = userSceneBindings(snap);
    if (!bindings.length) continue;
    out.push({ name: snap.name, spine: "var(--border-ctl)", bindings,
               sub: `${bindings.length} values · captured scene` });
  }
  return out;
}

function rawPane(ctx, cfg) {
  const { store } = ctx;
  const f = store.state.inspForm;
  return [
    h("div.tp-pane-head",
      h("span.tp-head-raw", {}, "RAW CC"),
      h("span.tp-head-sub", {}, "power corner — anything the library can't name")),
    h("div.tp-raw-row", {},
      "ch ", h("input.num", {
        type: "number", min: 1, max: 16, value: f.rawCh,
        dataset: { focusKey: "raw-ch" },
        oninput: (e) => store.update((s) => { s.inspForm.rawCh = e.target.value; }),
      }),
      "CC ", h("input.num", {
        type: "number", min: 0, max: 127, value: f.rawCC,
        dataset: { focusKey: "raw-cc" },
        oninput: (e) => store.update((s) => { s.inspForm.rawCC = e.target.value; }),
      }),
      h("button.ghost-btn.sm", {
        onclick: () => cfg.onTarget({ raw: { channel: clamp(f.rawCh, 1, 16) || 1,
                                             cc: clamp(f.rawCC, 0, 127) } }),
      }, "bind")),
  ];
}

// ── Rail ────────────────────────────────────────────────────────────────────

function railItem(store, { key, name, spine, count, on, dim = null }) {
  return h("div.tp-rail-item", {
    class: `${on ? "on" : ""}${dim ? " dim" : ""}`,
    title: dim || null,
    onclick: dim ? null : () => store.update((s) => { s.inspForm.pickerRail = key; }),
  },
    h("span.tp-rail-spine", { style: { background: spine } }),
    h("div.tp-rail-main",
      h("div.tp-rail-name", {}, name),
      h("div.tp-rail-count", {}, count)));
}

// Idle counts show the kind's pickable groups; a live query shows matched
// counts instead (spec: "rail counts update to matched counts").
function instanceCount(kind, mine, q) {
  const pick = mine.filter((o) => o.pickable && matches(q, o.label));
  if (q) return `${pick.length} match${pick.length === 1 ? "" : "es"}`;
  const knobs = pick.filter((o) => o.page).length;
  const fs = pick.filter((o) => o.fs).length;
  const dips = pick.filter((o) => o.bank != null).length;
  if (kind === "encoder" || kind === "expression") return `${knobs} knobs`;
  if (kind === "switch") return `${fs} fs · ${dips} dips`;
  return `${knobs + fs + dips} targets`;                       // scene
}

// ── The popover ─────────────────────────────────────────────────────────────

function popover(ctx, cfg) {
  const { store, rig, pedalsById } = ctx;
  const f = store.state.inspForm;
  const q = (f.pickerQuery ?? "").trim().toLowerCase();
  // Replace mode: a binding row was clicked — the next pick swaps that
  // binding's target in place (values/transform kept). The stored subject
  // guards against a selection change while open: another cell's picker
  // ignores a stale index.
  const opts = targetOptions(rig, pedalsById, cfg.kind);

  // Replace mode: locate the binding being changed by TARGET IDENTITY, not
  // a stored index — removing a sibling row while the popover is open would
  // shift an index and silently re-point (or drop) the replace. Targets are
  // unique per cell (the dedupe gate below), so identity is unambiguous.
  // The name comes from the CURRENT occupant, so it tracks across swaps.
  const rep = f.pickerReplace;
  let replacing = null;
  if (cfg.onReplace && rep && rep.subject === cfg.subject) {
    const index = (cfg.cell?.bindings ?? [])
      .findIndex((b) => targetsEqual(b?.target, rep.target));
    if (index >= 0) {
      const t = cfg.cell.bindings[index].target;
      const opt = t.instance
        && opts.find((o) => o.inst.instanceId === t.instance && o.path === t.control);
      replacing = { index, name:
        t.raw ? `raw ch${t.raw.channel} / CC ${t.raw.cc}`
        : t.performance ? `performance / ${t.performance.id}`
        : opt ? `${opt.inst.instanceId} / ${opt.label || "⇵"}` : rep.name };
    }
  }

  // One dedupe gate for every pane: chips render dimmed-✓ and never get here,
  // but raw / performance binds are free-typed and can collide.
  const rawOnTarget = cfg.onTarget;
  const rawOnSnapshot = cfg.onSnapshot;
  cfg = { ...cfg, onTarget: (target) => {
    if (bindingsHaveTarget(cfg.cell?.bindings, target)) {
      store.showToast({ msg: "already bound to this cell", undoable: false });
      return;
    }
    if (replacing) {
      // keep replace mode pointed at this binding across the swap — set the
      // stored identity in the same notify as the mutation (no extra render)
      store.state.inspForm.pickerReplace.target = target;
      cfg.onReplace(replacing.index, target);
    } else rawOnTarget(target);
  },
  onSnapshot: rawOnSnapshot && ((sceneBindings, name) => {
    // scenes go through the same dup gate: values already bound stay put
    const fresh = sceneBindings.filter((sb) =>
      !bindingsHaveTarget(cfg.cell?.bindings, sb.target));
    if (!fresh.length) {
      store.showToast({ msg: "every value in that scene is already bound", undoable: false });
      return;
    }
    rawOnSnapshot(fresh, name);
  }) };

  const instances = rig.instances.filter((i) => pedalsById[i.pedalId]);
  const validRails = [...instances.map((i) => i.instanceId), "perf", "snap", "raw"];
  let rail = validRails.includes(f.pickerRail) ? f.pickerRail : validRails[0];
  if (rail === "snap" && !cfg.onSnapshot) rail = validRails[0];

  const takeCount = Object.keys(store.state.link.manifest?.performances ?? {})
    .filter((t) => matches(q, t, store.state.link.takeNames?.[t])).length;
  const snapRows = snapshotRows(store, rig, pedalsById, q);   // shared: rail count + pane
  const snapCount = snapRows.length;

  const railEl = h("div.tp-rail",
    instances.length > 0 && h("div.tp-rail-label", {}, "YOUR RIG"),
    instances.map((inst) => railItem(store, {
      key: inst.instanceId, name: inst.name ?? inst.instanceId,
      spine: pedalsById[inst.pedalId].backgroundColor,
      count: instanceCount(cfg.kind, opts.filter((o) => o.inst === inst), q),
      on: rail === inst.instanceId,
    })),
    h("div.tp-rail-label", {}, "OTHER SOURCES"),
    railItem(store, { key: "perf", name: "PERFORMANCES", spine: "var(--blue-border)",
      count: takeCount ? `${takeCount} take${takeCount === 1 ? "" : "s"}` : "type an id",
      on: rail === "perf" }),
    railItem(store, { key: "snap", name: "SNAPSHOTS", spine: "var(--amber-border)",
      count: `${snapCount} scene${snapCount === 1 ? "" : "s"}`,
      on: rail === "snap",
      dim: cfg.onSnapshot ? null : "snapshots bind to footswitches & CC-set slots" }),
    railItem(store, { key: "raw", name: "RAW CC", spine: "var(--border-ctl)",
      count: "ch / cc", on: rail === "raw" }));

  const inst = instances.find((i) => i.instanceId === rail);
  const pane = h("div.tp-pane",
    inst ? pedalPane(inst, opts, cfg, q)
      : rail === "perf" ? perfPane(ctx, cfg, q)
      : rail === "snap" ? snapPane(snapRows, cfg, q)
      : rawPane(ctx, cfg));

  return h("div.tp-pop", { class: isPhone() ? "tp-inline" : "tp-float" },
    !isPhone() && h("div.tp-arrow"),
    h("div.tp-head",
      h("input.tp-search", {
        placeholder: "⌕ filter targets…", value: f.pickerQuery ?? "",
        dataset: { focusKey: "tp-search" },
        oninput: (e) => store.update((s) => { s.inspForm.pickerQuery = e.target.value; }),
      }),
      h("span.tp-context", {}, replacing
        ? ["changing ", h("span.tp-subject", {}, replacing.name ?? "target"),
           ` · ${cfg.subject}`]
        : ["adding to ", h("span.tp-subject", {}, cfg.subject),
           cfg.modeTag ? ` · ${cfg.modeTag}` : ""])),
    h("div.tp-body", railEl, pane),
    h("div.tp-foot", {}, replacing
      ? "click a target to swap it in — values and range ride along · esc closes"
      : "click a target to bind — the popover stays open for multi-target scenes · esc closes"));
}

// ── Entry ───────────────────────────────────────────────────────────────────
// One section per inspector call site. cfg:
//   kind       'encoder' | 'switch' | 'scene' | 'expression'
//   subject    "FOOTSWITCH 1" (header context tag)
//   modeTag    "toggle" | "knob" | … (context tag suffix)
//   cell       current cell or null — already-bound chips render dimmed-✓
//   onTarget(target)   target = {instance, control} | {raw} | {performance}
//                      — the call site wraps it in its own one-undo-step edit;
//                      the popover STAYS OPEN (multi-target scenes)
//   onSnapshot(bindings, name) | null — null dims the SNAPSHOTS rail item
//   onReplace(i, target) | undefined — enables click-to-change on binding
//                      rows (openPickerReplace below sets the mode)

// A binding row was clicked: open the popover in replace mode for the
// binding whose `target` this is (identity, not index — sibling removals
// must not re-point the replace). `name` seeds the header context tag.
export function openPickerReplace(store, subject, target, name) {
  store.update((s) => {
    s.inspForm.pickerOpen = true;
    s.inspForm.pickerQuery = "";
    s.inspForm.pickerReplace = { subject, target, name };
  });
}

// True when the popover is currently replacing the binding with this target
// — the inspector highlights that row (.tp-changing anchors the popover).
export function pickerReplacing(store, subject, target) {
  const r = store.state.inspForm.pickerReplace;
  return !!(store.state.inspForm.pickerOpen && r
    && r.subject === subject && targetsEqual(r.target, target));
}

export function addTargetSection(ctx, cfg) {
  const { store } = ctx;
  const open = !!store.state.inspForm.pickerOpen;
  syncGlobalHandlers(store, open);
  if (open && !isPhone()) requestAnimationFrame(positionLive);

  const entry = h("div.add-target-entry", {
    class: open ? "open" : "",
    onclick: () => store.update((s) => {
      // open in replace mode → the entry row switches back to plain adding
      if (s.inspForm.pickerOpen && s.inspForm.pickerReplace) {
        s.inspForm.pickerReplace = null;
        return;
      }
      s.inspForm.pickerOpen = !s.inspForm.pickerOpen;
      s.inspForm.pickerReplace = null;
      if (s.inspForm.pickerOpen) s.inspForm.pickerQuery = "";  // fresh browse each open
    }),
  }, "+ add target — browse all sources…");

  return h("div.insp-section", {},
    h("span.insp-title", {}, "ADD TARGET"),
    entry,
    open && popover(ctx, cfg),
    h("div.insp-hint", {}, "one entry point: rig controls, dips, takes, snapshots, raw CC"));
}
