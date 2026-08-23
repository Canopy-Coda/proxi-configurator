//
// faceplate.mjs — the hardware-true device mimic (design 7a; geometry per
// firmware/proxi2/ui.cpp): three rows of six identical knobs, display 1
// between rows 1–2 (bands: row1 | name bars | row2), display 2 between row 3
// and the footswitches (bands: row3 | name bars | 4 footswitch cells), then
// the unlabeled physical footswitch row and the omniport chips.
//
// Band↔row orientation is unverified until physical mounting (F3) — the
// BAND_* constants below are the single flip point.
//
import { h } from "./ui.mjs";
import {
  COLS, resolveCell, positionIndex, columnPedals, nameBarRuns,
} from "./model.mjs";

// Display 1 carries encoder rows [0, 1]; display 2 carries row 2 on its top
// band. Flip an array to flip a display's band order at the F3 gate.
const BAND_ROWS_D1 = [0, 1];
const BAND_ROWS_D2 = [2];

const mut = (ink) => `color-mix(in srgb, ${ink} 55%, #6f7278)`;
const tint = (bg) => `color-mix(in srgb, ${bg} 24%, #0a0b0c)`;

// ── Screen cells ───────────────────────────────────────────────────────────

function valueBar(rc) {
  if (rc.macro) {
    const stops = rc.bindings.map((b, i, a) => {
      const c = b.pedal?.backgroundColor ?? "#33373d";
      return `${c} ${(i / a.length) * 100}% ${((i + 1) / a.length) * 100}%`;
    });
    return h("div.vbar", { style: { background: `linear-gradient(90deg,${stops.join(",")})` } });
  }
  const pct = Math.round((rc.value / 127) * 100);
  return h("div.vbar", { style: { background: tint(rc.color) } },
    h("div.vfill", { style: { width: `${pct}%`, background: rc.color } }));
}

function toggleDots(rc) {
  const positions = rc.positions ?? [{ value: 0 }, { value: 64 }, { value: 127 }];
  const idx = positionIndex(positions, rc.value);
  return h("div.tdots",
    positions.map((p, i) => h("span.tdot", {
      style: { background: i === idx ? (p.color ?? rc.color) : tint(rc.color) },
    })),
    h("span.tcount", { style: { color: mut(rc.ink) } }, `${idx + 1}/${positions.length}`));
}

// Macro binding chips, capped so a many-target macro can't flood the cell.
const MACRO_CHIP_CAP = 4;
export function macroChips(bindings) {
  const chips = bindings.slice(0, MACRO_CHIP_CAP).map((b) =>
    h("span.chip", { style: { background: b.pedal?.backgroundColor ?? "#33373d" } }));
  if (bindings.length > MACRO_CHIP_CAP)
    chips.push(h("span.chip-more", {}, `+${bindings.length - MACRO_CHIP_CAP}`));
  return chips;
}

// One encoder screen cell (or an empty/broken one).
export function screenCell(rc, { selected = false, index, kind = "enc" } = {}) {
  const cell = h("div.scell", {
    class: (selected ? "selected " : "") + (rc ? "" : "empty"),
    dataset: { drop: kind, index },
  });
  if (!rc) { cell.append(h("div.scell-empty", {}, "·")); return cell; }
  if (rc.broken) {
    cell.append(h("div.scell-label", { style: { color: "#d95f5f" } }, "⚠ unresolved"),
                h("div.scell-sub", {}, "check rig"));
    return cell;
  }
  const head = h("div.scell-head");
  if (rc.macro) head.append(...macroChips(rc.bindings));
  head.append(h("span.scell-label", { style: { color: rc.ink } }, rc.label.toUpperCase()));
  cell.append(head);

  if (rc.interaction === "toggle" && !rc.macro) {
    cell.append(toggleDots(rc));
  } else {
    cell.append(h("div.scell-val",
      valueBar(rc),
      h("span.vnum", { style: { color: mut(rc.ink) } }, String(rc.value))));
  }
  return cell;
}

// Footswitch screen cell (display 2's bottom band — labels live on glass).
export function fsScreenCell(rc, { selected = false, index, reserved = null } = {}) {
  const cell = h("div.scell.fs", {
    class: (selected ? "selected " : "") + (rc ? "" : "empty"),
    dataset: { drop: "fs", index },
  });
  if (!rc) { cell.append(h("div.scell-empty", {}, "·")); return cell; }
  const on = rc.mode === "send" ? false : rc.value >= 64;
  cell.append(h("div.scell-head",
    h("span.scell-label", { style: { color: rc.labelOverridden ? "#e8e6e1" : rc.ink } },
      rc.label.toUpperCase())));
  const status = h("div.fs-status");
  if (rc.mode === "send") {
    const pedals = [...new Map(rc.bindings.filter((b) => b.pedal)
      .map((b) => [b.pedal.id, b.pedal])).values()];
    status.append(...pedals.map((p) =>
      h("span.led.sm", { style: { background: p.backgroundColor } })));
    status.append(h("span.fs-mode", {}, `CC set · ${rc.bindings.length}`));
  } else {
    status.append(
      h("span.led", { style: on
        ? { background: "#5fbf8f", boxShadow: "0 0 6px #5fbf8f" }
        : { background: tint(rc.color) } }),
      h("span.fs-mode", {},
        `${on ? "on" : "off"} · ${rc.mode}`,
        reserved ? h("span.reserved-tag", {}, ` · ${reserved}`) : null));
  }
  cell.append(status);
  return cell;
}

// ── Name bars ──────────────────────────────────────────────────────────────

// One strip per band, like the glass: each band owns a name strip on its
// inner or outer edge (settings.prefs.nameBars, mirroring the firmware's
// names-inner / names-outer layouts). `cells` is that band's resolved row.
// Exported so the drag preview (views-layouts.mjs) can restore a strip it
// repainted imperatively mid-drag.
export function nameBars(cells, cols = COLS) {
  const runs = nameBarRuns(columnPedals([cells], cols));
  return h("div.namebars",
    runs.map((r) => h("div.namebar", {
      style: r.pedal
        ? { flex: r.span, background: r.pedal.backgroundColor, color: r.pedal.labelColor }
        : { flex: r.span, background: "#101113" },
    }, r.pedal ? r.pedal.name.toUpperCase() : "")));
}

// Stack a display's bands and their name strips per the pref.
// bands: [{ cells: [...], cols, band }] top-to-bottom.
export function nameBarsPref(settings) {
  return settings?.prefs?.nameBars === "inner" ? "inner" : "outer"; // default: outer
}
function display(pref, top, bottom) {
  const parts = pref === "outer"
    ? [top.strip, top.band, bottom.band, bottom.strip]
    : [top.band, top.strip, bottom.strip, bottom.band];
  return h("div.display", parts);
}

// ── Knobs & footswitches ───────────────────────────────────────────────────

function knob(rc, { selected = false, index } = {}) {
  const angle = rc && rc.interaction !== "toggle"
    ? -135 + (rc.value / 127) * 270
    : rc
      ? -135 + positionIndex(rc.positions, rc.value)
          * (270 / Math.max(1, (rc.positions?.length ?? 3) - 1))
      : 0;
  const k = h("div.knob", {
    class: selected ? "selected" : "",
    dataset: { drop: "enc", index },
  }, h("div.pointer", { style: { transform: `rotate(${angle}deg)` } }));
  if (rc?.macro) k.append(h("span.macro-badge", {}, `×${rc.bindings.length}`));
  return h("div.knob-slot", {}, k);
}

function footswitch(rc, { selected = false, index } = {}) {
  const inner = [];
  if (rc?.mode === "send") {
    const pedals = [...new Map(rc.bindings.filter((b) => b.pedal)
      .map((b) => [b.pedal.id, b.pedal])).values()].slice(0, 3);
    inner.push(h("div.led-row", pedals.map((p) =>
      h("span.led.sm", { style: { background: p.backgroundColor } }))));
  } else if (rc) {
    const on = rc.value >= 64;
    inner.push(h("span.led", { style: on
      ? { background: rc.color, boxShadow: `0 0 6px ${rc.color}` }
      : { background: "#33373d" } }));
  } else {
    inner.push(h("span.led", { style: { background: "#26282c" } }));
  }
  return h("div.fs-slot", {},
    h("div.fswitch", { class: selected ? "selected" : "", dataset: { drop: "fs", index } },
      inner));
}

// ── The full faceplate ─────────────────────────────────────────────────────
// ctx: { layout, rig, pedalsById, live, selection, gestures }
export function renderFaceplate(ctx) {
  const { layout, rig, pedalsById, live, selection } = ctx;
  const rc = (i) => resolveCell(layout.encoders[i], rig, pedalsById, live);
  const rcFS = (i) => resolveCell(layout.footswitches[i], rig, pedalsById, live);
  const sel = (type, i) => selection?.type === type && selection.index === i;

  const encRow = (r) => h("div.enc-row",
    Array.from({ length: COLS }, (_, c) => {
      const i = r * COLS + c;
      return knob(rc(i), { selected: sel("encoder", i), index: i });
    }));

  const cellBand = (r) => h("div.band",
    Array.from({ length: COLS }, (_, c) => {
      const i = r * COLS + c;
      return screenCell(rc(i), { selected: sel("encoder", i), index: i });
    }));

  const rowCells = (r) => Array.from({ length: COLS }, (_, c) => rc(r * COLS + c));

  // Reserved-combo tags come from STATUS.gestures (never hardcoded). The
  // shape is firmware-defined; render any gesture naming a footswitch index.
  const reservedFor = (i) => {
    for (const [name, g] of Object.entries(ctx.gestures ?? {})) {
      const switches = g?.switches ?? g?.fs ?? [];
      if (Array.isArray(switches) && switches.includes(i))
        return `${g?.trigger ?? "hold"}⇢${name}`;   // e.g. hold⇢hidden, tap⇢bank
    }
    return null;
  };

  const fsBand = h("div.band.fsband",
    Array.from({ length: 4 }, (_, i) =>
      fsScreenCell(rcFS(i), { selected: sel("footswitch", i), index: i, reserved: reservedFor(i) })));

  const fsRow = h("div.fs-row",
    Array.from({ length: 4 }, (_, i) =>
      footswitch(rcFS(i), { selected: sel("footswitch", i), index: i })));

  const omni = h("div.omni-row",
    layout.omniports.map((cell, i) => {
      const mode = rig.omniports?.[i]?.mode ?? "unused";
      const rcO = resolveCell(cell, rig, pedalsById, live);
      const used = mode !== "unused" && rcO;
      return h("div.omni-chip", {
        class: (used ? "" : "unused ") + (sel("omniport", i) ? "selected" : ""),
        dataset: { omni: i },
      },
        h("span.omni-id", {}, `OMNI ${i + 1}`),
        used
          ? [h("span.omni-label", {}, rcO.label),
             h("span.omni-info", {},
               `${mode === "expression" ? "expr" : "aux"} · ${rcO.bindings.length} target${rcO.bindings.length === 1 ? "" : "s"}`)]
          : h("span.omni-unused", {}, mode === "unused" ? "unused" : `${mode} · no targets`));
    }));

  const pref = nameBarsPref(ctx.store?.state.docs.settings);
  const fsCells = Array.from({ length: 4 }, (_, i) => rcFS(i));

  // Hidden page (ctx.page): a class the CSS tints + badges — the cell
  // arrays already came in swapped via pageView (model.mjs).
  return h("div.faceplate", { class: ctx.page === "hidden" ? "hidden-page" : "" },
    encRow(0),
    display(pref,
      { band: cellBand(BAND_ROWS_D1[0]), strip: nameBars(rowCells(BAND_ROWS_D1[0])) },
      { band: cellBand(BAND_ROWS_D1[1]), strip: nameBars(rowCells(BAND_ROWS_D1[1])) }),
    encRow(1),
    encRow(2),
    display(pref,
      { band: cellBand(BAND_ROWS_D2[0]), strip: nameBars(rowCells(BAND_ROWS_D2[0])) },
      { band: fsBand, strip: nameBars(fsCells, 4) }),
    fsRow,
    omni);
}
