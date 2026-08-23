//
// views-layouts.mjs — the home view (design_handoff_layouts_restyle option
// 1a "three surfaces"): Sources shelf · layout · inspector as three cards on
// the #0f1012 canvas, plus the drag model (design_handoff_drop_zones:
// shelf-card handles + legible drop zones) and the empty states (turn 5,
// rendered from views-onboarding.mjs when there's nothing to edit). Push /
// activate live on the DEVICE tab — the old shelf DEVICE strip is gone.
//
// The left pane is the "Sources" shelf (design_handoff_layouts_shelf_
// restructure, option 1b): four independently collapsible sections mirroring
// the add-target picker's rail — PEDALS (the shelf cards, now with a DIP
// SWITCHES group), PERFORMANCES, SNAPSHOTS, RAW CC. The shelf is the drag
// path; the picker stays as the click path. Open/closed state persists in
// store.state.shelfOpen (localStorage UI prefs, never docs).
//
// Drag model (design_handoff_drop_zones, round 3 + 1c):
//   chip   → one cell; occupied cells raise a popover chooser above the
//            glass (⟳ REPLACE default / + MACRO ×N) — no modifier keys
//            (⌥ survives as a power-user default for the macro button)
//   ⋯ / ⋮ / ∷ handles → that row / column / all 9 of the pedal's normal 3×3,
//            anchored top-left on the encoder under the cursor; members past
//            the right edge or below row 3 are clipped (listed in a tray
//            under the plate), never wrapped
//   header → the pedal as a whole; the faceplate paints two half zones
//            (the side-by-side generator's 3×3 placement)
//   fs chips → footswitches only, unchanged; footswitches never join
//            handle or header drags
//   dip chips → footswitches only; a press flips the dip 0⇄127 (toggle)
//   snapshot rows → footswitches only; the drop flips the switch to CC-set
//            mode and merges the scene in (model.mjs sceneDropCell)
//   performance rows → encoders + footswitches; binds {performance:
//            {id, action:"toggle"}} — action editable in the inspector
//   raw CC chip → any encoder cell, footswitch, or configured omniport
//
import { h, stackDivider } from "./ui.mjs";
import { renderFaceplate, nameBars } from "./faceplate.mjs";
import { renderInspector } from "./inspector.mjs";
import { welcomeScreen, generatorScreen } from "./views-onboarding.mjs";
import { renderBankSwitcher } from "./bank-switcher.mjs";
import {
  COLS, controlAt, pagePositions, cellNameShort, resolveCell, bindingsHaveTarget,
  groupMembers, groupTargets, halfTargets, halfFootswitchSlots,
  pageView, ensurePageArrays, layoutBindsInstance,
  hiddenChipPlan, hiddenGroupPlan, applyHiddenPlan,
  pedalShelfCounts, shelfSummary, shelfOpenFor, sceneDropCell,
} from "./model.mjs";
import { snapshotRows } from "./target-picker.mjs";

const HANDLE_GLYPH = { row: "⋯", col: "⋮", grid: "∷", card: "⠿" };

// The current view contexts, one per rendered plate (stacked hidden-page
// mode shows MAIN and HIDDEN glasses at once — design_handoff_bank_switching
// §5), refreshed on every render and keyed by page. The faceplate's
// drag/click listeners are imperative, so morph keeps the FIRST render's
// closures alive on the retained node — they must resolve layout/selection
// state through this map at event time (via the plate's data-page), never
// through a closured ctx (else drops target whichever layout was current
// when the node first rendered — the morph trap).
let viewCtxs = {};
const ctxFor = (fpEl) => viewCtxs[fpEl?.dataset.page ?? "main"] ?? null;

// Drag state lives outside the store: no re-renders mid-drag, so HTML5 DnD
// never has its hover target replaced under the cursor.
// { kind:'chip'|'fschip'|'row'|'col'|'grid'|'card'|'dip'|'snap'|'perf'|'raw',
//   instanceId?, pedal?, control?, label?, idx?, members?,
//   hotColor?,               // hot-ring color for pedal-less drags
//   id?,                     // perf: take id
//   name?, bindings?,        // snap: row name + expanded scene bindings
//   channel?, cc? }          // raw
let drag = null;
let ghostEl = null, ghostSub = null;
let shelfRestore = null; // undoes the imperative lifted/dimmed shelf styling
// A pedal header is both the whole-pedal drag source and the card's collapse
// toggle. Browsers suppress the click after a completed drag, but not after
// every cancelled one — this flag (set on dragstart, cleared a tick after
// dragend) is the belt-and-braces guard the handoff asks for.
let headerDragged = false;

// The native drag image is replaced by a transparent pixel; the ghost pill
// follows the cursor from a document-level dragover so its outcome line can
// update live ("9 knobs · 4 fit here") — a snapshot drag image can't.
const BLANK_IMG = new Image();
BLANK_IMG.src = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
function moveGhost(e) {
  if (!ghostEl || (e.clientX === 0 && e.clientY === 0)) return;
  ghostEl.style.left = `${e.clientX + 14}px`;
  ghostEl.style.top = `${e.clientY + 18}px`;
}

// title: bold subject · sub: mono outcome line (updated live by previewDrop)
// · glyph/bg/ink: pedal-colored pill for handle & header drags.
function setGhost(e, { title, sub = "", glyph = null, bg = null, ink = null }) {
  ghostEl?.remove();
  ghostSub = h("span.ghost-sub", {}, sub);
  ghostEl = h("div.drag-ghost", {
    class: bg ? "pedal" : "",
    style: bg ? { background: bg, color: ink } : {},
  },
    glyph && h("span.ghost-glyph", {}, glyph),
    h("b", {}, title),
    ghostSub);
  document.body.append(ghostEl);
  document.addEventListener("dragover", moveGhost);
  e.dataTransfer.setDragImage(BLANK_IMG, 0, 0);
  e.dataTransfer.setData("text/plain", "proxi");
  e.dataTransfer.effectAllowed = "copy";
}

function endDrag() {
  drag = null;
  setTimeout(() => { headerDragged = false; }, 0); // outlive the same-gesture click

  ghostEl?.remove(); ghostEl = null; ghostSub = null;
  document.removeEventListener("dragover", moveGhost);
  shelfRestore?.(); shelfRestore = null;
  // stacked mode renders two plates — clear both (ctx so cancelled drags
  // restore each plate's name bars)
  for (const fp of liveFaceplates()) {
    clearPreview(fp, ctxFor(fp));
    for (const z of fp.querySelectorAll(".half-zone")) z.remove();
  }
}

// ONE persistent document-level cleanup for cancelled drags (released over
// dead space, Esc). A per-render {once} listener gets consumed by any
// dragend on the page — e.g. a bank-pill drag, which triggers no re-render
// to re-arm it — and the NEXT cancelled shelf drag would then leak its
// ghost and stale drag state. endDrag() is a no-op when nothing is in
// flight, so firing for every drag on the page is safe.
document.addEventListener("dragend", () => endDrag());

// ── Drop preview (imperative, cleared on drop/leave) ───────────────────────

// `keepPopIndex`: the cell whose popover chooser must survive this pass.
// Removing the element under the cursor mid-drag breaks the browser's
// dragover→drop handshake (the drop never fires), so while the drag stays on
// the same occupied cell its popover is patched, never recreated.
// `ctx` is needed to restore name-bar strips the preview repainted; passing
// null skips that (only safe when no strip was touched).
function clearPreview(root, ctx = null, keepPopIndex = null) {
  root?.classList.remove("drag-live");
  for (const el of root?.querySelectorAll(".drop-hot") ?? []) {
    el.classList.remove("drop-hot");
    el.style.removeProperty("--hot");
    el.removeAttribute("data-incoming");
    el.removeAttribute("data-was");
  }
  const pop = root?.querySelector(".drop-pop");
  if (pop && Number(pop.dataset.index) !== keepPopIndex) {
    root.querySelector(`.scell.pop-open[data-index="${pop.dataset.index}"]`)
      ?.classList.remove("pop-open");
    pop.remove();
  }
  root?.querySelector(".clip-tray")?.remove();
  for (const z of root?.querySelectorAll(".half-zone.hot") ?? []) z.classList.remove("hot");
  if (ctx) restoreNameBars(root, ctx);
}

// ── Name-bar preview ────────────────────────────────────────────────────────
// Strips in document order are [row 0, row 1, row 2, footswitches] regardless
// of the names-inner/outer pref (faceplate.mjs display()). Touched columns
// flip to the incoming pedal's color with "<PEDAL> ?"; the incoming run is
// keyed separately so it never merges with an existing run of the same pedal.

function rowCellsOf(ctx, r) {
  return Array.from({ length: COLS }, (_, c) =>
    resolveCell(ctx.layout.encoders[r * COLS + c], ctx.rig, ctx.pedalsById));
}

function paintNameBars(root, ctx, touched, pedal) {
  const strips = root.querySelectorAll(".namebars");
  for (let r = 0; r < 3; r++) {
    const cols = new Set(touched.filter((i) => Math.floor(i / COLS) === r).map((i) => i % COLS));
    if (!cols.size || !strips[r]) continue;
    const cells = rowCellsOf(ctx, r);
    const runs = [];
    for (let c = 0; c < COLS; c++) {
      const inc = cols.has(c);
      const p = inc ? pedal : cells[c]?.pedal ?? null;
      const key = `${inc ? "»" : ""}${p?.id ?? ""}`;
      const last = runs[runs.length - 1];
      if (last && last.key === key) last.span++;
      else runs.push({ key, pedal: p, inc, span: 1 });
    }
    strips[r].replaceChildren(...runs.map((run) => h("div.namebar", {
      class: run.inc ? "hot" : "",
      style: run.inc
        ? { flex: run.span, background: `color-mix(in srgb, ${pedal.backgroundColor} 60%, #0a0b0c)`, color: "#e8e6e1" }
        : run.pedal
          ? { flex: run.span, background: run.pedal.backgroundColor, color: run.pedal.labelColor }
          : { flex: run.span, background: "#101113" },
    }, run.inc ? `${pedal.name.toUpperCase()} ?` : run.pedal ? run.pedal.name.toUpperCase() : "")));
    strips[r].classList.add("nb-preview");
  }
}

function restoreNameBars(root, ctx) {
  const strips = [...(root?.querySelectorAll(".namebars") ?? [])];
  for (const strip of strips) {
    if (!strip.classList.contains("nb-preview")) continue;
    const r = strips.indexOf(strip);
    strip.replaceChildren(...nameBars(rowCellsOf(ctx, r)).childNodes);
    strip.classList.remove("nb-preview");
  }
}

// ── Popover chooser (1c: chip onto an occupied cell) ───────────────────────

function ensurePopover(root, index, ctx) {
  let pop = root.querySelector(".drop-pop");
  if (pop && Number(pop.dataset.index) === index) return pop;
  pop?.remove(); // a stale pop on another cell was already cleared upstream
  const n = (ctx.layout.encoders[index].bindings?.length ?? 1) + 1;
  pop = h("div.drop-pop", { dataset: { drop: "pop", index } },
    h("div.pop-btn.replace", {
      style: { background: drag.pedal.backgroundColor, color: drag.pedal.labelColor },
    },
      h("span.pop-line1", {}, "⟳ REPLACE"),
      h("span.pop-line2", {}, `${drag.label.toUpperCase()} takes this knob`)),
    h("div.pop-btn.macro", {},
      h("span.pop-line1", {}, `+ MACRO ×${n}`),
      h("span.pop-line2", {}, n === 2 ? "one knob turns both" : `one knob turns all ${n}`)),
    h("div.pop-arrow"));
  const cell = root.querySelector(`.scell[data-drop="enc"][data-index="${index}"]`);
  const rr = root.getBoundingClientRect(), cr = cell.getBoundingClientRect();
  pop.style.left = `${cr.left + cr.width / 2 - rr.left}px`;
  pop.style.top = `${cr.top - rr.top - 10}px`;
  root.append(pop);
  return pop;
}

// Which chooser button a drag event favors: the button under the cursor,
// else ⌥ picks macro, else replace (the default drop).
function popChoice(e) {
  const btn = e.target.closest?.(".pop-btn");
  if (btn) return btn.classList.contains("macro") ? "macro" : "replace";
  return e.altKey ? "macro" : "replace";
}

// ── Clip tray (3c: handle members that don't fit) ──────────────────────────

const COUNT_WORDS = ["", "one", "two"];
function clipReason(anchor, members) {
  const col = anchor % COLS, row = Math.floor(anchor / COLS);
  const overCols = Math.max(0, col + Math.max(...members.map((m) => m.colOff)) - (COLS - 1));
  const overRows = Math.max(0, row + Math.max(...members.map((m) => m.rowOff)) - 2);
  const parts = [];
  if (overCols) parts.push(`${COUNT_WORDS[overCols]} column${overCols > 1 ? "s" : ""} past the right edge`);
  if (overRows) parts.push(`${COUNT_WORDS[overRows]} row${overRows > 1 ? "s" : ""} past the bottom`);
  return parts.join(", ");
}

function paintClipTray(root, pedal, clippedLabels, total, reason) {
  root.querySelector(".clip-tray")?.remove();
  root.append(h("div.clip-tray",
    h("span.clip-label", {}, "OFF THE DEVICE — NOT APPLIED"),
    h("div.clip-chips",
      clippedLabels.map((l) => h("span.clip-chip", {
        style: { borderColor: pedal.backgroundColor },
      }, l.toUpperCase())),
      h("span.clip-note", {}, `${clippedLabels.length} of ${total} — ${reason}`))));
}

// ── Preview ────────────────────────────────────────────────────────────────

// A group member resolved against the drag pedal on the dragged page
// (normal for header drags): null when that shelf slot is inactive (an
// inactive member still stamps its cell empty on drop).
const memberControl = (m) => {
  const ctl = controlAt(drag.pedal, `${drag.page ?? "normal"}.${m.position}`);
  return ctl && ctl.type !== "inactive" ? ctl : null;
};

// Drop-target identity: faceplate cells carry data-drop/data-index; omniport
// chips carry data-omni only (the DEVICE mirror's delegated handlers key on
// data-drop, so omni chips must not grow one — see views-device.mjs).
function dropKindIndex(targetEl) {
  if (targetEl.dataset.drop != null)
    return { kind: targetEl.dataset.drop, index: Number(targetEl.dataset.index) };
  return { kind: "omni", index: Number(targetEl.dataset.omni) };
}

function previewDrop(root, targetEl, e, ctx) {
  const { kind, index } = dropKindIndex(targetEl);
  const keepPop = (drag.kind === "chip" && kind === "enc" && ctx.layout.encoders[index])
    || kind === "pop" ? index : null;
  clearPreview(root, ctx, keepPop);
  root.classList.add("drag-live");

  const hot = drag.hotColor ?? drag.pedal?.backgroundColor ?? "var(--accent)";
  const markHot = (i, attrs = null) => {
    for (const el of root.querySelectorAll(`[data-drop="enc"][data-index="${i}"]`)) {
      el.classList.add("drop-hot");
      el.style.setProperty("--hot", hot);
      if (el.classList.contains("scell") && attrs) {
        if (attrs.incoming) el.setAttribute("data-incoming", attrs.incoming);
        if (attrs.was) el.setAttribute("data-was", attrs.was);
      }
    }
  };
  const markFsHot = (i, incoming) => {
    for (const el of root.querySelectorAll(`[data-drop="fs"][data-index="${i}"]`)) {
      el.classList.add("drop-hot");
      el.style.setProperty("--hot", hot);
      if (el.classList.contains("scell")) el.setAttribute("data-incoming", incoming);
    }
  };
  const wasLabel = (i) => {
    const was = resolveCell(ctx.layout.encoders[i], ctx.rig, ctx.pedalsById);
    return was ? `was ${was.label}` : null;
  };

  if (drag.kind === "fschip" || drag.kind === "dip") {
    if (kind !== "fs") return false;
    markFsHot(index, `${drag.label}?`);
    return true;
  }

  if (drag.kind === "snap") {
    if (kind !== "fs") return false;
    markFsHot(index, `CC set · ${drag.bindings.length}?`);
    return true;
  }

  if (drag.kind === "perf") {
    if (kind === "enc") {
      markHot(index, { incoming: `${drag.id}? · toggle`, was: wasLabel(index) });
      return true;
    }
    if (kind === "fs") { markFsHot(index, `${drag.id}?`); return true; }
    return false;
  }

  if (drag.kind === "raw") {
    const label = `CC ${drag.cc}?`;
    if (kind === "enc") {
      markHot(index, { incoming: label, was: wasLabel(index) });
      return true;
    }
    if (kind === "fs") { markFsHot(index, label); return true; }
    if (kind === "omni") {
      // only a configured port takes targets (mode is rig-level)
      if ((ctx.rig.omniports?.[index]?.mode ?? "unused") === "unused") return false;
      const chip = root.querySelector(`.omni-chip[data-omni="${index}"]`);
      chip?.classList.add("drop-hot");
      chip?.style.setProperty("--hot", hot);
      return true;
    }
    return false;
  }

  if (drag.kind === "chip") {
    if (kind !== "enc" && kind !== "pop") return false;
    const occupied = !!ctx.layout.encoders[index];
    if (!occupied) {
      markHot(index, { incoming: `${drag.label}? · release to bind` });
      return true;
    }
    // occupied → popover chooser above the glass (1c); the cell keeps its
    // content readable under a hot ring
    markHot(index);
    root.querySelector(`.scell[data-drop="enc"][data-index="${index}"]`)
      ?.classList.add("pop-open");
    const pop = ensurePopover(root, index, ctx);
    const choice = popChoice(e);
    pop.children[0].classList.toggle("hot", choice === "replace");
    pop.children[1].classList.toggle("hot", choice === "macro");
    return true;
  }

  if (drag.kind === "card") {
    // a mid-drag re-render (e.g. toast expiry) morphs the zones away —
    // recreate them so the next dragover lands on a zone again
    addHalfZones(root, drag.pedal, drag.knobCount, drag.fsCount);
    if (kind !== "half") return false;
    targetEl.classList.add("hot");
    if (ghostSub) ghostSub.textContent = `→ ${index ? "right" : "left"} half`;
    return true;
  }

  // row / col / grid handle → anchored group with clipping
  if (kind !== "enc") return false;
  const targets = groupTargets(index, drag.members);
  const touched = [];
  const clipped = [];
  let fit = 0, total = 0;
  for (const t of targets) {
    const ctl = memberControl(t);
    if (ctl) total++;
    if (t.index == null) { if (ctl) clipped.push(ctl.label); continue; }
    markHot(t.index, {
      incoming: ctl ? `${ctl.label.toUpperCase()}?` : "—",
      was: wasLabel(t.index),
    });
    touched.push(t.index);
    if (ctl) fit++;
  }
  paintNameBars(root, ctx, touched, drag.pedal);
  if (clipped.length)
    paintClipTray(root, drag.pedal, clipped, total, clipReason(index, drag.members));
  if (ghostSub) {
    ghostSub.textContent = clipped.length
      ? `${total} knobs · ${fit} fit here`
      : drag.kind === "row"
        ? `${total} knobs · lands on ${touched.map((i) => i % COLS + 1).join("·")}`
        : drag.kind === "col"
          ? `${total} knobs · one per row`
          : `${total} knobs · all fit`;
    if (ctx.page !== "hidden" && drag.page !== "hidden"
        && hiddenGroupPlan(drag.pedal, drag.instanceId, targets))
      ghostSub.textContent += " · ⇧ hidden too";
  }
  return true;
}

// ── Drop mutations ─────────────────────────────────────────────────────────

// ── "Also update hidden?" (contract §9.4 hidden page) ──────────────────────
// A drop of NORMAL-page pedal content onto the MAIN page can mirror itself
// onto the hidden page (the pedal's hidden controls at the same positions —
// plan built by model.mjs). shift-drop applies both silently; otherwise the
// store.hiddenDrop pref decides: both | main | ask (a prompt toast whose
// ALWAYS / NEVER buttons remember the answer — change it later in the
// header's ⚙ customize modal). Drops onto the hidden page, and drags that carry
// hidden-page controls, never prompt (plan builders return null).

function offerHiddenPlan(store, layoutId, plan, dropLabel) {
  const applyPlan = (label) => store.mutate(label, (s) => {
    const l = s.docs.layouts.find((x) => x.id === layoutId);
    if (l) applyHiddenPlan(l, plan);
  });
  const n = `${plan.count} hidden control${plan.count === 1 ? "" : "s"}`;
  store.showToast({
    msg: `${dropLabel} — also update the HIDDEN page? (${n})`,
    undoable: true,
    ttl: 9000,
    actions: [
      { label: "ALSO HIDDEN", run: () => applyPlan(`hidden page updated (${n})`) },
      { label: "ALWAYS", run: () => {
        applyPlan(`hidden page updated (${n}) · always from now on`);
        store.update((s) => { s.hiddenDrop = "both"; });
      } },
      { label: "NEVER", run: () => {
        store.update((s) => { s.hiddenDrop = "main"; });
        store.showToast({ msg: "won't ask again — change it in ⚙ customize (top right)", undoable: false });
      } },
    ],
  });
}

function performDrop(root, targetEl, e, ctx) {
  const { store } = ctx;
  const { kind, index } = dropKindIndex(targetEl);
  const layoutId = ctx.layout.id;
  const inLayout = (s) => s.docs.layouts.find((l) => l.id === layoutId);
  const inPage = (s) => ensurePageArrays(inLayout(s), ctx.page);
  const d = drag;

  // Hidden-mirror plan for this drop (null = never offer): only MAIN-page
  // drops of normal-page pedal content qualify, and only for drag kinds that
  // stamp cells (chips binding/replacing, handles, header halves).
  const planFor = () => {
    if (ctx.page === "hidden" || d.page === "hidden") return null;
    if (d.kind === "chip")
      return hiddenChipPlan(d.pedal, d.instanceId, d.control, index);
    if (d.kind === "row" || d.kind === "col" || d.kind === "grid")
      return hiddenGroupPlan(d.pedal, d.instanceId, groupTargets(index, d.members));
    if (d.kind === "card" && kind === "half")
      return hiddenGroupPlan(d.pedal, d.instanceId, halfTargets(index), halfFootswitchSlots(index));
    return null;
  };
  // shift-drop = both pages in ONE mutation (one undo step); pref both = same
  const plan = planFor();
  const hiddenMode = !plan ? null : e.shiftKey ? "both" : store.state.hiddenDrop;
  // inside-the-mutation mirror for the silent modes
  const alsoHidden = (s) => {
    if (plan && hiddenMode === "both") applyHiddenPlan(inLayout(s), plan);
  };
  const hiddenTag = plan && hiddenMode === "both" ? " · hidden too" : "";
  // post-mutation prompt for ask mode
  const afterDrop = (label) => {
    if (plan && hiddenMode === "ask") offerHiddenPlan(store, layoutId, plan, label);
  };

  // Stamp a group of anchored members into the layout: active controls bind,
  // inactive members clear their cell (the side-by-side generator's rule);
  // clipped members simply don't apply. Selection lands on the first
  // (top-left-most) cell that received a control. `also` runs inside the
  // same mutation (one undo step) for extras like a header drop's fs slots.
  const applyGroup = (label, targets, also = null) => {
    const landing = targets.filter((t) => t.index != null);
    if (!landing.length) return;
    const page = d.page ?? "normal";
    store.mutate(label + hiddenTag, (s) => {
      const a = inPage(s);
      for (const t of landing) {
        const ctl = memberControl(t);
        a.encoders[t.index] = ctl ? {
          interaction: ctl.type === "toggle" ? "toggle" : "knob",
          bindings: [{ target: { instance: d.instanceId, control: `${page}.${t.position}` } }],
        } : null;
      }
      also?.(a);
      alsoHidden(s);
      const first = landing.filter((t) => memberControl(t))
        .reduce((a, t) => (a == null || t.index < a ? t.index : a), null);
      s.selection = { type: "encoder", index: first ?? landing[0].index };
    });
    afterDrop(label);
  };

  if (d.kind === "fschip" && kind === "fs") {
    store.mutate(`FS${index + 1} → ${d.instanceId} / ${d.label}`, (s) => {
      inPage(s).footswitches[index] = {
        mode: "toggle",
        bindings: [{ target: { instance: d.instanceId, control: d.control }, on: 127, off: 0 }],
      };
      s.selection = { type: "footswitch", index };
    });
    return;
  }

  // dip chip → footswitch: a press flips the dip 0⇄127 (plain toggle — the
  // firmware already resolves dip.<bank>.<switch> paths)
  if (d.kind === "dip") {
    if (kind !== "fs") return;
    store.mutate(`FS${index + 1} → ${d.instanceId} / ${d.label} (dip)`, (s) => {
      inPage(s).footswitches[index] = {
        mode: "toggle",
        bindings: [{ target: { instance: d.instanceId, control: d.control }, on: 127, off: 0 }],
      };
      s.selection = { type: "footswitch", index };
    });
    return;
  }

  // snapshot row → footswitch: CC-set mode, scene merged in (dedupe keeps
  // already-bound values put — same gate as the picker's onSnapshot)
  if (d.kind === "snap") {
    if (kind !== "fs") return;
    const cell = sceneDropCell(ctx.layout.footswitches[index], d.bindings);
    if (!cell) {
      store.showToast({ msg: "every value in that scene is already bound", undoable: false });
      return;
    }
    store.mutate(`bound "${d.name}" · FS${index + 1} → CC set`, (s) => {
      inPage(s).footswitches[index] = cell;
      s.selection = { type: "footswitch", index };
    });
    return;
  }

  // performance row → encoder or footswitch: default action is toggle
  // (change it in the inspector). Occupied cells are replaced — the drop
  // default everywhere; the picker is the additive path.
  if (d.kind === "perf") {
    const target = { performance: { id: d.id, action: "toggle" } };
    if (kind === "enc") {
      if (bindingsHaveTarget(ctx.layout.encoders[index]?.bindings, target)) {
        store.showToast({ msg: `${d.id} is already on ${cellNameShort(index)}`, undoable: false });
        return;
      }
      store.mutate(`${cellNameShort(index)} → performance / ${d.id}`, (s) => {
        inPage(s).encoders[index] = { interaction: "knob", bindings: [{ target }] };
        s.selection = { type: "encoder", index };
      });
    } else if (kind === "fs") {
      if (bindingsHaveTarget(ctx.layout.footswitches[index]?.bindings, target)) {
        store.showToast({ msg: `${d.id} is already on FS${index + 1}`, undoable: false });
        return;
      }
      store.mutate(`FS${index + 1} → performance / ${d.id}`, (s) => {
        // performance bindings carry no CC values — a press just fires them
        inPage(s).footswitches[index] = { mode: "toggle", bindings: [{ target }] };
        s.selection = { type: "footswitch", index };
      });
    }
    return;
  }

  // raw CC chip → anywhere: encoder cell, footswitch, or configured omniport
  if (d.kind === "raw") {
    const target = { raw: { channel: d.channel, cc: d.cc } };
    const name = `raw ch${d.channel} / CC ${d.cc}`;
    if (kind === "enc") {
      if (bindingsHaveTarget(ctx.layout.encoders[index]?.bindings, target)) {
        store.showToast({ msg: `${name} is already on ${cellNameShort(index)}`, undoable: false });
        return;
      }
      store.mutate(`${cellNameShort(index)} → ${name}`, (s) => {
        inPage(s).encoders[index] = { interaction: "knob", bindings: [{ target }] };
        s.selection = { type: "encoder", index };
      });
    } else if (kind === "fs") {
      if (bindingsHaveTarget(ctx.layout.footswitches[index]?.bindings, target)) {
        store.showToast({ msg: `${name} is already on FS${index + 1}`, undoable: false });
        return;
      }
      store.mutate(`FS${index + 1} → ${name}`, (s) => {
        inPage(s).footswitches[index] = {
          mode: "toggle", bindings: [{ target, on: 127, off: 0 }],
        };
        s.selection = { type: "footswitch", index };
      });
    } else if (kind === "omni") {
      // omniports are page-free (top-level) and additive like the inspector:
      // an expression pedal usually sweeps several targets at once
      const mode = ctx.rig.omniports?.[index]?.mode ?? "unused";
      if (mode === "unused") return;
      if (bindingsHaveTarget(ctx.layout.omniports[index]?.bindings, target)) {
        store.showToast({ msg: `${name} is already on omni ${index + 1}`, undoable: false });
        return;
      }
      store.mutate(`omni ${index + 1} → ${name}`, (s) => {
        const l = inLayout(s);
        const binding = mode === "aux" ? { target, on: 127, off: 0 } : { target };
        if (!l.omniports[index])
          l.omniports[index] = mode === "aux"
            ? { mode: "toggle", bindings: [binding] } : { bindings: [binding] };
        else l.omniports[index].bindings.push(binding);
        s.selection = { type: "omniport", index };
      });
    }
    return;
  }

  if (d.kind === "card") {
    if (kind !== "half") return;
    // the pedal as a whole = its 3×3 plus its footswitches on that half's
    // two fs slots (the side-by-side generator's placement)
    const sides = halfFootswitchSlots(index).filter((s) => d.pedal.footswitches?.[s.side]);
    applyGroup(
      `${index ? "right" : "left"} half → ${d.instanceId} (3×3${sides.length ? ` + ${sides.length} fs` : ""})`,
      halfTargets(index),
      (a) => {
        for (const s of sides) {
          a.footswitches[s.index] = {
            mode: "toggle",
            bindings: [{ target: { instance: d.instanceId, control: `footswitch.${s.side}` }, on: 127, off: 0 }],
          };
        }
      });
    return;
  }

  if (d.kind === "row" || d.kind === "col" || d.kind === "grid") {
    if (kind !== "enc") return;
    const targets = groupTargets(index, d.members);
    const active = targets.filter((t) => memberControl(t));
    const fit = active.filter((t) => t.index != null).length;
    const page = d.page === "hidden" ? "hidden " : "";
    const subject = page + (d.kind === "grid" ? "3×3"
      : d.kind === "row" ? `row ${d.idx + 1}` : `col ${d.idx + 1}`);
    const count = fit === active.length
      ? `${active.length} knob${active.length === 1 ? "" : "s"}`
      : `${fit} of ${active.length} fit`;
    applyGroup(`${cellNameShort(index)} → ${d.instanceId} (${subject} · ${count})`, targets);
    return;
  }

  if (d.kind !== "chip" || (kind !== "enc" && kind !== "pop")) return;

  const target = { instance: d.instanceId, control: d.control };
  const ctl = controlAt(d.pedal, d.control);
  const interaction = ctl?.type === "toggle" ? "toggle" : "knob";
  const occupied = !!ctx.layout.encoders[index];
  if (!occupied) {
    const label = `${cellNameShort(index)} → ${d.instanceId} / ${d.label}`;
    store.mutate(label + hiddenTag, (s) => {
      inPage(s).encoders[index] = { interaction, bindings: [{ target }] };
      alsoHidden(s);
      s.selection = { type: "encoder", index }; // inspector shows what you just dropped
    });
    afterDrop(label);
    return;
  }
  const existing = resolveCell(ctx.layout.encoders[index], ctx.rig, ctx.pedalsById);
  if (popChoice(e) === "macro") {
    // macro-add is additive fine-tuning on ONE cell — never mirrored to the
    // hidden page (a hidden counterpart wouldn't be a macro)
    if (bindingsHaveTarget(ctx.layout.encoders[index].bindings, target)) {
      store.showToast({ msg: `${d.instanceId} / ${d.label} is already on ${cellNameShort(index)}`, undoable: false });
      return;
    }
    store.mutate(`macro · ${existing.bindings.length + 1} targets`, (s) => {
      inPage(s).encoders[index].bindings.push({ target });
      s.selection = { type: "encoder", index };
    }, { edit: { type: "encoder", index } });
  } else {
    const label = `replaced ${existing?.bindings[0]?.instance?.instanceId ?? ""} / ${existing?.label ?? ""}`;
    store.mutate(label + hiddenTag, (s) => {
      inPage(s).encoders[index] = { interaction, bindings: [{ target }] };
      alsoHidden(s);
      s.selection = { type: "encoder", index };
    });
    afterDrop(label);
  }
}

// ── Half zones (3d: header drag paints the faceplate halves) ───────────────
// Created imperatively at dragstart (no re-render mid-drag) covering the
// content area — knob rows through display 2, footswitch band included
// visually but never a target — and removed by endDrag.

function addHalfZones(root, pedal, knobCount, fsCount = 0) {
  if (!root || root.querySelector(".half-zone")) return;
  const firstRow = root.querySelector(".enc-row");
  const displays = root.querySelectorAll(".display");
  const last = displays[displays.length - 1];
  if (!firstRow || !last) return;
  const rr = root.getBoundingClientRect();
  const top = firstRow.getBoundingClientRect().top - rr.top;
  const bottom = last.getBoundingClientRect().bottom - rr.top;
  for (const side of [0, 1]) {
    root.append(h("div.half-zone", {
      dataset: { drop: "half", index: side },
      style: {
        top: `${top}px`, height: `${bottom - top}px`,
        [side ? "right" : "left"]: "20px",
        width: "calc(50% - 24px)",
        "--hot": pedal.backgroundColor, "--hot-ink": pedal.labelColor,
      },
    }, h("span.half-pill", {},
      `${side ? "◨ RIGHT" : "◧ LEFT"} HALF · ${pedal.name.toLowerCase()} 3×3`,
      h("span.half-count", {},
        ` · ${knobCount} KNOBS${fsCount ? ` + ${fsCount} FS` : ""}`))));
  }
}

// ── Rig shelf ──────────────────────────────────────────────────────────────

const handleDots = (n) => Array.from({ length: n }, () => h("span.hdot"));

// The mounted layouts-tab faceplates (one, or two in stacked hidden-page
// mode), resolved fresh at event time (never closured: morph swaps
// h()-listeners to the latest render, whose fresh faceplate node was
// discarded in favor of the retained one).
const liveFaceplates = () => [...document.querySelectorAll(".lo-plate .faceplate")];

function shelfCard(inst, ctx) {
  const { store, pedalsById, layout } = ctx;
  const pedal = pedalsById[inst.pedalId];
  if (!pedal) return h("div.shelf-card.missing", {}, `${inst.pedalId} — not in library`);
  const used = layout && layoutBindsInstance(layout, inst.instanceId);
  const counts = pedalShelfCounts(pedal);

  // Collapse state (persisted UI prefs; defaults from model.mjs)
  const open = shelfOpenFor(store.state.shelfOpen, inst.instanceId);
  const setOpen = (key, v) => store.update((s) => {
    (s.shelfOpen.pedals[inst.instanceId] ??= {})[key] = v;
  });
  const subHead = (label, count, key, cls = "") =>
    h(`div.shelf-sub-head${cls}`, { onclick: () => setOpen(key, !open[key]) },
      h("span.src-caret", {}, open[key] ? "▾" : "▸"),
      h("span.shelf-sub-label", {}, label),
      h("span.shelf-sub-count", {}, `· ${count}`));

  const chip = (path) => {
    const ctl = controlAt(pedal, path);
    if (!ctl || ctl.type === "inactive") return h("div.ctl-chip.inactive", {}, "—");
    return h("div.ctl-chip", {
      draggable: true,
      title: `${ctl.label} · CC ${ctl.cc} — drag onto a cell; an occupied cell offers replace / macro`,
      ondragstart: (e) => {
        drag = { kind: "chip", instanceId: inst.instanceId, pedal, control: path, label: ctl.label };
        setGhost(e, { title: ctl.label, sub: ` ${inst.instanceId} · CC ${ctl.cc}` });
        e.stopPropagation();
      },
    }, ctl.label);
  };

  // The normal 3×3 grows drag handles: ∷ corner (all 9), ⋮ per column,
  // ⋯ per row. Mid-drag styling is imperative (no re-render mid-drag);
  // shelfRestore rewinds it on dragend. TRAP: elements must be resolved from
  // e.currentTarget at drag time, never closured — morphChildren keeps the
  // OLD DOM nodes and discards freshly rendered trees.
  const liftChips = (handleEl, kind, idx) => {
    const chips = [...handleEl.closest(".chip-grid").querySelectorAll(".ctl-chip")];
    const idxs = kind === "grid" ? chips.map((_, i) => i)
      : kind === "row" ? [0, 1, 2].map((c) => idx * 3 + c)
        : [0, 1, 2].map((r) => r * 3 + idx);
    for (const i of idxs) {
      chips[i]?.classList.add("lifted");
      chips[i]?.style.setProperty("--hot", pedal.backgroundColor);
    }
    return () => {
      for (const i of idxs) {
        chips[i]?.classList.remove("lifted");
        chips[i]?.style.removeProperty("--hot");
      }
    };
  };

  const handle = (page, cls, kind, idx, title, subject) =>
    h(`div.grab-handle.${cls}`, {
      draggable: true, title,
      ondragstart: (e) => {
        drag = { kind, idx, page, instanceId: inst.instanceId, pedal, members: groupMembers(kind, idx) };
        const n = drag.members.filter(memberControl).length;
        setGhost(e, {
          title: subject, sub: `${n} knob${n === 1 ? "" : "s"}`,
          glyph: HANDLE_GLYPH[kind],
          bg: pedal.backgroundColor, ink: pedal.labelColor,
        });
        e.stopPropagation();
        const el = e.currentTarget;
        el.classList.add("active");
        el.style.setProperty("--hot", pedal.backgroundColor);
        const unlift = liftChips(el, kind, idx);
        shelfRestore = () => {
          el.classList.remove("active");
          el.style.removeProperty("--hot");
          unlift();
        };
      },
    }, handleDots(kind === "grid" ? 9 : 3));

  const name = inst.name ?? inst.instanceId;
  const header = h("div.shelf-head", {
    draggable: true,
    style: { background: pedal.backgroundColor, color: pedal.labelColor },
    title: "drag the pedal onto a device half — its 3×3 and footswitches take that half · click to collapse",
    // the whole header is the collapse toggle; a drag that started here
    // suppresses the click (headerDragged, cleared a tick after dragend)
    onclick: () => { if (!headerDragged) setOpen("card", !open.card); },
    ondragstart: (e) => {
      headerDragged = true;
      const fsCount = fsSides.length;
      drag = { kind: "card", instanceId: inst.instanceId, pedal, knobCount: counts.knobs, fsCount };
      setGhost(e, {
        title: name, sub: "→ drop on a half", glyph: HANDLE_GLYPH.card,
        bg: pedal.backgroundColor, ink: pedal.labelColor,
      });
      for (const fp of liveFaceplates()) addHalfZones(fp, pedal, counts.knobs, fsCount);
      // "the pedal is in your hand now": the whole card dims and dashes.
      // Resolve live nodes from the event (morph trap — see liftChips).
      const head = e.currentTarget;
      const liveCard = head.closest(".shelf-card");
      const prev = { bg: head.style.background, color: head.style.color };
      head.style.background = `color-mix(in srgb, ${pedal.backgroundColor} 30%, #1d1f23)`;
      head.style.color = "#c9cbcf";
      liveCard.classList.add("dragging-card");
      shelfRestore = () => {
        head.style.background = prev.bg;
        head.style.color = prev.color;
        liveCard.classList.remove("dragging-card");
      };
    },
  },
    h("span.head-grip", {}, "⠿"),
    h("span.shelf-name", {}, name),
    h("span.shelf-ch", {}, `ch ${inst.midiChannel}`),
    h("span.shelf-caret", {}, open.card ? "▾" : "▸"));

  const positions = pagePositions();
  const handledGrid = (page) => {
    const tag = page === "hidden" ? "hidden " : "";
    return h("div.chip-grid.handled",
      handle(page, "corner", "grid", 0, `drag all 9 ${tag}knobs onto any encoder`, `${name} · ${tag}3×3`),
      [0, 1, 2].map((c) => handle(page, "colh", "col", c,
        `drag this ${tag}column of 3 onto any encoder`, `${name} · ${tag}column ${c + 1}`)),
      [0, 1, 2].map((r) => [
        handle(page, "rowh", "row", r, `drag this ${tag}row of 3 onto any encoder`, `${name} · ${tag}row ${r + 1}`),
        positions.slice(r * 3, r * 3 + 3).map((pos) => chip(`${page}.${pos}`)),
      ]));
  };

  // Collapsed: header + a one-line summary (also clickable to expand).
  // fsSides must exist first — the header's dragstart closure reads it.
  const fsSides = ["left", "right"].filter((side) => pedal.footswitches?.[side]);
  if (!open.card) {
    return h("div.shelf-card", { class: used ? "" : "unused" },
      header,
      h("div.shelf-summary", { onclick: () => setOpen("card", true) },
        shelfSummary(counts)));
  }

  const fsChips = h("div.fs-chip-row",
    fsSides.map((side) => h("div.ctl-chip", {
      draggable: true,
      title: `drag onto a footswitch`,
      ondragstart: (e) => {
        drag = { kind: "fschip", instanceId: inst.instanceId, pedal,
                 control: `footswitch.${side}`, label: pedal.footswitches[side].label };
        setGhost(e, { title: pedal.footswitches[side].label, sub: ` ${inst.instanceId} fs` });
        e.stopPropagation();
      },
    }, pedal.footswitches[side].label)));

  // DIP SWITCHES: per bank, a wrap-row of draggable chips — footswitch-only
  // drops that flip the dip 0⇄127
  const dipBanks = (pedal.dipSwitchBanks ?? []).map((bank, bi) => [
    h("div.dip-bank-label", {}, bank.label),
    h("div.dip-chip-row",
      bank.switches.map((sw, si) => h("div.ctl-chip.dip", {
        draggable: true,
        title: `drag onto a footswitch — flips 0⇄127 on CC ${sw.cc}`,
        ondragstart: (e) => {
          drag = { kind: "dip", instanceId: inst.instanceId, pedal,
                   control: `dip.${bi}.${si}`, label: sw.label };
          setGhost(e, { title: sw.label, sub: ` ${inst.instanceId} dip · → fs` });
          e.stopPropagation();
        },
      }, sw.label))),
  ]);

  // Unused instances keep their full chip grid — a single control should be
  // draggable onto a cell without placing the whole pedal first. The dashed
  // border + note stay as the "not in this layout" cue. Only sections the
  // pedal actually has render (counts from pedalShelfCounts).
  const card = h("div.shelf-card", { class: used ? "" : "unused" },
    header,
    handledGrid("normal"),
    counts.hidden > 0 && subHead("HIDDEN", counts.hidden, "hidden", ".violet"),
    counts.hidden > 0 && open.hidden && handledGrid("hidden"),
    fsSides.length > 0 && subHead("FOOTSWITCHES", counts.fs, "fs"),
    fsSides.length > 0 && open.fs && fsChips,
    counts.dips > 0 && subHead("DIP SWITCHES", counts.dips, "dips"),
    counts.dips > 0 && open.dips && dipBanks,
    counts.dips > 0 && open.dips && h("div.shelf-teach", {},
      "dips drop on footswitches — knobs and encoder cells dim during the drag"),
    !used && layout && h("div.shelf-note", {}, "not in this layout"));
  return card;
}

// ── Sources pane (design_handoff_layouts_shelf_restructure, 1b) ────────────
// Four independently collapsible sections mirroring the add-target picker's
// rail. All rows/chips are drag sources; counts follow live data.

function sourcesPane(ctx) {
  const { store, rig, pedalsById } = ctx;
  const secs = store.state.shelfOpen.sections;
  const toggleSec = (key) => store.update((s) => {
    s.shelfOpen.sections[key] = !s.shelfOpen.sections[key];
  });
  const secHead = (key, title, spine, count) =>
    h("div.src-head", { onclick: () => toggleSec(key) },
      h("span.src-caret", {}, secs[key] ? "▾" : "▸"),
      h("span.src-spine", { style: { background: spine } }),
      h("span.src-title", {}, title),
      h("span.src-count", {}, count));
  const note = (...text) => h("div.tp-footnote.src-note", {}, ...text);

  const { manifest, takeNames } = store.state.link;
  const takes = Object.keys(manifest?.performances ?? {}).sort();
  const snaps = snapshotRows(store, rig, pedalsById);
  const n = rig.instances.length;
  const plural = (c, w) => `${c} ${w}${c === 1 ? "" : "s"}`;

  // PERFORMANCES — takes from the device manifest, draggable to enc + fs
  const perfRows = takes.map((t) => h("div.tp-row.src-row", {
    draggable: true,
    title: "drag onto an encoder or footswitch — binds the take (toggle)",
    ondragstart: (e) => {
      drag = { kind: "perf", id: t, hotColor: "var(--blue)" };
      setGhost(e, { title: t, sub: " toggle · → enc · fs" });
    },
  },
    h("span.tp-snap-spine", { style: { background: "var(--blue-border)", height: "16px" } }),
    h("span.tp-row-id", {}, t),
    h("span.tp-row-sub", {}, takeNames?.[t] ?? "—"),
    h("span.src-row-tag", {}, "→ enc · fs")));

  // SNAPSHOTS — library snapshots per rig instance + user-captured scenes
  const snapRows = snaps.map((r) => h("div.tp-row.src-row", {
    draggable: true,
    title: "drag onto a footswitch — CC set: a press sends every value in the scene",
    ondragstart: (e) => {
      drag = { kind: "snap", name: r.name, bindings: r.bindings, hotColor: r.spine };
      setGhost(e, { title: r.name, sub: ` ${r.bindings.length} values · → fs` });
    },
  },
    h("span.tp-snap-spine", { style: { background: r.spine } }),
    h("div.tp-row-main",
      h("div.tp-row-id", {}, r.name),
      h("div.tp-row-sub", {}, r.sub)),
    h("span.src-row-tag", {}, "→ fs")));

  // RAW CC — ch/cc inputs + one draggable chip that re-labels live
  const f = store.state.inspForm;
  const rawCh = Math.max(1, Math.min(16, Number(f.rawCh) || 1));
  const rawCC = Math.max(0, Math.min(127, Number(f.rawCC) || 0));
  const numIn = (key, min, max) => h("input.num", {
    type: "number", min, max, value: f[key],
    dataset: { focusKey: `shelf-raw-${key}` },
    oninput: (e) => store.update((s) => { s.inspForm[key] = e.target.value; }),
  });
  const rawBody = [
    h("div.tp-raw-row.src-raw", {},
      "ch ", numIn("rawCh", 1, 16),
      "CC ", numIn("rawCC", 0, 127),
      h("div.raw-chip", {
        draggable: true,
        title: "drag anywhere — an encoder cell, footswitch, or omniport",
        ondragstart: (e) => {
          drag = { kind: "raw", channel: rawCh, cc: rawCC, hotColor: "var(--accent)" };
          setGhost(e, { title: `CH ${rawCh} · CC ${rawCC}`, sub: " → anywhere" });
        },
      }, `⠿ CH ${rawCh} · CC ${rawCC}`)),
    note("power corner — anything the library can't name; drag the chip anywhere"),
  ];

  return h("section.rl-card.lo-shelf",
    h("div.rl-head",
      h("h2.pane-title", {}, "Sources"),
      h("span.pane-sub", {},
        `${plural(n, "pedal")} · ${plural(takes.length, "take")} · ${plural(snaps.length, "scene")}`),
      h("button.link-btn", {
        style: { marginLeft: "auto" },
        onclick: () => store.update((s) => { s.view = "rig"; }),
      }, "+ pedal")),
    h("div.lo-shelf-body",
      secHead("pedals", "PEDALS", "var(--border-ctl)", String(n)),
      secs.pedals && rig.instances.map((inst) => shelfCard(inst, ctx)),
      secHead("perf", "PERFORMANCES", "var(--blue-border)", plural(takes.length, "take")),
      secs.perf && (takes.length
        ? [perfRows, note("takes from the device manifest · drop picks the default action (toggle) — change it in the inspector")]
        : note("no takes yet — record one on the LENS tab, or connect a device")),
      secHead("snap", "SNAPSHOTS", "var(--amber-border)", plural(snaps.length, "scene")),
      secs.snap && (snaps.length
        ? [snapRows, note("drops on a footswitch only — puts it in CC-set mode; a press sends every value in the scene")]
        : note("no snapshots yet — capture one from the DEVICE mirror or a pedal's library page")),
      secHead("raw", "RAW CC", "var(--border-ctl)", "ch / cc"),
      secs.raw && rawBody,
      h("div.shelf-hint", {}, "drag a control — or a ⋯ ⋮ ∷ handle — onto a cell →")));
}

// ── View entry ─────────────────────────────────────────────────────────────
// The old card-header picker row is gone (design_handoff_bank_switching §4):
// the bank switcher docked at the top of the card owns switching, add,
// delete, and reorder (editing is exclusive to this tab). The hidden page renders
// stacked below the main plate or behind a flip control (ui.hiddenPageView).

export function renderLayoutsView(ctx) {
  const { store } = ctx;
  const { docs } = store.state;

  if (!docs.rig.instances.length) return welcomeScreen(ctx);
  if (!docs.layouts.length || store.state.creatingLayout)
    return generatorScreen(ctx, { cancellable: docs.layouts.length > 0 });

  const layout = store.currentLayout() ?? docs.layouts[0];
  if (layout.id !== store.state.currentLayoutId) store.state.currentLayoutId = layout.id;
  const stacked = store.state.ui.hiddenPageView === "stacked";
  // The page the inspector (and in flip mode, the single plate) addresses.
  // In stacked mode both glasses are visible and clicking/dropping on one
  // retargets this to that plate's page.
  const inspPage = store.state.layoutPage === "hidden" ? "hidden" : "main";

  // The per-page view contexts, built up front so EVERY consumer this render
  // (plates, shelf, inspector) shares one ctx shape — a hand-built partial
  // ctx for the shelf silently diverges the moment a shelf feature reads
  // ctx.live or ctx.link.
  viewCtxs = {}; // event handlers resolve state through this, never a closure
  for (const page of stacked ? ["main", "hidden"] : [inspPage]) {
    viewCtxs[page] = { ...ctx, layout: pageView(layout, page), page,
                       rig: docs.rig, live: store.state.live,
                       // only the plate the inspector addresses paints the
                       // selection — the same index exists on both glasses
                       selection: inspPage === page ? store.state.selection : null,
                       gestures: store.state.link.gestures,
                       link: store.state.link };
  }

  // Build one wired plate for `page`. Everything inside (previews, drops,
  // the click-to-select) reads/writes THIS page's cells; omniports stay
  // page-free. The listeners attach to this render's node, but morph retains
  // the FIRST rendered node (and its listeners) — so every handler resolves
  // the live node and current state at event time (ctxFor / currentTarget).
  const wirePlate = (page) => {
    const fp = renderFaceplate(viewCtxs[page]);
    fp.dataset.page = page;
    fp.dataset.key = `plate-${page}`; // never morph-pair MAIN with HIDDEN

    // click-to-select (design: click cell → inspector focuses it); on the
    // stacked hidden glass this also points the inspector at that page
    fp.addEventListener("click", (e) => {
      const pg = e.currentTarget.dataset.page;
      const omni = e.target.closest("[data-omni]");
      if (omni) {
        store.update((s) => {
          s.layoutPage = pg;
          s.selection = { type: "omniport", index: Number(omni.dataset.omni) };
        });
        return;
      }
      const t = e.target.closest("[data-drop]");
      if (!t) return;
      store.update((s) => {
        s.layoutPage = pg;
        s.selection = { type: t.dataset.drop === "fs" ? "footswitch" : "encoder",
                        index: Number(t.dataset.index) };
      });
    });

    // drag wiring (see module header) — omni chips carry data-omni only, so
    // the target lookup spans both (dropKindIndex resolves which)
    fp.addEventListener("dragover", (e) => {
      if (!drag) return;
      const t = e.target.closest("[data-drop], [data-omni]");
      if (!t) return;
      if (previewDrop(e.currentTarget, t, e, ctxFor(e.currentTarget))) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }
    });
    fp.addEventListener("dragleave", (e) => {
      if (!e.currentTarget.contains(e.relatedTarget))
        clearPreview(e.currentTarget, ctxFor(e.currentTarget));
    });
    fp.addEventListener("drop", (e) => {
      const t = e.target.closest("[data-drop], [data-omni]");
      if (drag && t) {
        e.preventDefault();
        const pg = e.currentTarget.dataset.page;
        // the drop selects the landed cell — point the inspector at the
        // glass it landed on FIRST, through the store (matters in stacked
        // mode; a raw state write would leave a rejected drop's page flip
        // invisible until some unrelated render). Mid-drop re-renders are
        // safe: morph retains the plate and its imperative listeners.
        if (store.state.layoutPage !== pg)
          store.update((s) => { s.layoutPage = pg; });
        performDrop(e.currentTarget, t, e, ctxFor(e.currentTarget));
      }
      endDrag();
    });
    return fp;
  };

  const shelf = sourcesPane(viewCtxs[inspPage]);

  const body = stacked
    ? h("div.lo-plate-body",
        wirePlate("main"),
        stackDivider(),
        wirePlate("hidden"),
        h("div.canvas-hint", {},
          "click a cell on either glass to edit it · drops on the hidden glass never prompt · every change is one undo step (⌘Z)"))
    : h("div.lo-plate-body",
        wirePlate(inspPage),
        h("div.canvas-hint", {}, inspPage === "hidden"
          ? "the HIDDEN page — shown on the device while SW2+SW3 are held · drops here never prompt"
          : "click a cell to edit · drag from the shelf to re-map · every change is one undo step (⌘Z)"));

  // The bank switcher docks INSIDE the plate card (its own top strip),
  // not floating above it — the card is the whole center pane.
  const plate = h("section.rl-card.lo-plate",
    h("div.bank-dock",
      renderBankSwitcher(ctx, { view: "layouts", layout, page: inspPage })),
    body);

  const insp = h("section.rl-card.lo-insp",
    h("div.rl-head",
      h("h2.pane-title", {}, "Inspector"),
      h("span.pane-sub", {}, inspPage === "hidden" ? "edits the selected cell · hidden page" : "edits the selected cell")),
    renderInspector({ ...viewCtxs[inspPage], selection: store.state.selection }));

  const center = h("div.lo-center", plate);

  return h("div.layouts-grid", { class: store.state.selection ? "has-selection" : "" },
    shelf, center, insp);
}
