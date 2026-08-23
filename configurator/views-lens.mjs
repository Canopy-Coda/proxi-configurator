//
// views-lens.mjs — the LENS workspace (design_handoff_performance, turn 4).
// Performance gets its own first-class tab: a collapsible library+meta pane
// (left), the daw-lens' exploded rig-resolved lane timeline brought INLINE
// (center), and an inspector (right) stacking the take's event table over the
// relocated MIDI monitor. Three sources feed the center — FILE (a stored take
// played at its true timeline position), SIM (a scripted stand-in on the rig's
// channels), and LIVE (a 30s trailing window of real incoming MIDI, replayed
// from the store's rolling monitorEvents buffer through the same lane model).
//
// The lane model is lens-model.mjs (the DOM-free port of daw-lens/lens.mjs).
// Converging the daw-lens page onto that shared module is deferred; this tab
// is the configurator-native rebuild the handoff asked for (vanilla h(), no
// framework, UI state in the store — never the DOM — per ui.mjs' contract).
//
// Deferred (documented for a follow-up session):
//   - Lane hover crosshair/tooltip (the inspector table carries exact values).
//   - Take list meta (len · lanes) for unloaded takes — the manifest carries
//     only id+hash, so meta shows once a take is fetched into the cache.
//
import { h } from "./ui.mjs";
import { ccOwner } from "./model.mjs";
import { connectCard } from "./views-device.mjs";
import { parseSMF } from "./smf-read.mjs";   // vendored copy — deploy is /configurator/-only
import { splitPerfData, joinPerfData, rewriteSidecarId, rewriteSidecarName,
         isValidTakeId, describeTake, lensTake, fmtMs } from "./perf.mjs";
import { buildBindings, buildPanels, tableRows, stepAfterPath,
         timeTicks, fmtTick, eventsFromSMF, simEvents, recTakeEvents, valueAt,
         snapshotValuesAt,
         editRowsFromSMF } from "./lens-model.mjs";
import { enterEdit, exitEdit, revertOps, syncEditKey, editedTake, touchedLanes,
         editToolbar, editLaneRow, editValueCell, editsSection, saveEdits,
         wireEditKeys, viewRegion, editWheel, winOf, laneOfSel,
         focusedLeftPane, focusedCenter } from "./views-lens-edit.mjs";

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
// Dev-only SIM preview (retired from the UI per the handoff): `?sim` shows the
// scripted rig sweep when there's no device; window.proxiLens.inject(ch,cc,val)
// feeds fake CC into the live monitor so REC drawing can be exercised bare.
const SIM = typeof location !== "undefined" && /(?:^|[?&])sim(?:=|&|$)/.test(location.search);

// ── FILE take cache ─────────────────────────────────────────────────────────
// Fetching + parsing a take's SMF is async; render() is sync. We cache parsed
// panels per take id (keyed also by the manifest hash so a re-recorded take
// invalidates) and re-render when a load lands. Module-level, not store state:
// it's derived data, excluded from undo/persist.
const takeCache = new Map(); // id → { hash, status:'loading'|'ready'|'error', panels, durationS, sidecar, err }

function ensureFileTake(ctx, id, bindings) {
  const { store, linkApi } = ctx;
  const hash = store.state.link.manifest?.performances?.[id];
  const hit = takeCache.get(id);
  // Same hash: reuse whatever we have — including an error (don't re-fetch a
  // known-bad take every render). Only a hash change (re-recorded) re-loads.
  if (hit && hit.hash === hash) return hit;

  const entry = { hash, status: "loading" };
  takeCache.set(id, entry);
  (async () => {
    try {
      const { sidecar, mid } = splitPerfData(await linkApi.perfFetch(id));
      const parsed = parseSMF(mid);
      entry.panels = buildPanels(eventsFromSMF(parsed), bindings);
      entry.editRows = editRowsFromSMF(parsed);   // lossless rows for the edit/save path
      entry.durationS = Math.max(parsed.durationSeconds, 0.001);
      entry.sidecar = sidecar;
      entry.status = "ready";
    } catch (err) {
      entry.status = "error";
      entry.err = err.message;
      store.log("Lens", `couldn't load take "${id}": ${err.message}`);
    }
    store.update(() => {});
  })();
  return entry;
}

// ── take list order (app-local; the manifest carries no take order) ─────────
function orderedTakeIds(store) {
  const ids = Object.keys(store.state.link.manifest?.performances ?? {});
  const order = store.state.lens.takeOrder.filter((id) => ids.includes(id));
  for (const id of ids.sort()) if (!order.includes(id)) order.push(id);
  return order;
}

const takeName = (store, id) => store.state.link.takeNames?.[id] || id;

// meta line for a take, from cache if we've fetched it ("42.1s · 7 lanes")
function takeMeta(id) {
  const c = takeCache.get(id);
  if (c?.status === "ready") {
    const d = describeTake(c.sidecar);
    return `${fmtMs(c.durationS * 1000)} · ${d.laneCount} lane${d.laneCount === 1 ? "" : "s"}`;
  }
  if (c?.status === "loading") return "loading…";
  return null;
}

// A guard for async action buttons: disable while in flight, log on failure.
const busy = (store) => (fn) => async (e) => {
  const btn = e.target.closest("button");
  if (btn) btn.disabled = true;
  try { await fn(); } catch (err) { store.log("Lens", err.message); }
  if (btn) btn.disabled = false;
};

// ── left pane: library + meta ───────────────────────────────────────────────
let takeDragIdx = null;

function leftPane(ctx, takes, sel) {
  const { store, linkApi } = ctx;
  const { lens } = store.state;
  const set = (patch) => store.update((s) => Object.assign(s.lens, patch));

  // Selecting a take highlights it locally AND — the device being the master —
  // loads it into the recorder so the center + transport follow it. When
  // there's no device, selection is display-only (the frozen file view).
  const pick = (id) => {
    // Dirty guard: pending edits stay persisted (keyed to their take), but
    // make the context switch explicit so it isn't an accident.
    const e = store.state.lens.edit;
    if (e.on && e.ops.length && id !== sel &&
        !confirm(`Switch takes? Your ${e.ops.length} pending edit${e.ops.length === 1 ? "" : "s"} stay saved for this take.`))
      return;
    set({ selectedTakeId: id });
    if (store.state.link.status === "connected" && id !== store.state.link.perf?.loadedId)
      linkApi.perfLoad(id).catch((err) => store.log("Lens", err.message));
  };

  if (lens.leftCollapsed) {
    return h("aside.lens-rail.lens-rail-left",
      h("button.lens-chevron", { title: "expand", onclick: () => set({ leftCollapsed: false }) }, "›"),
      h("span.lens-rail-label", {}, "PERFORMANCES"),
      h("div.lens-rail-dots",
        takes.map((id) => h("span.lens-rail-dot", {
          class: id === sel ? "on" : "",
          title: takeName(store, id),
          style: id === sel ? { background: "var(--accent)" } : null,
          onclick: () => pick(id),
        }))));
  }

  const searchLow = lens.takeSearch.toLowerCase();
  const rows = takes.map((id, i) => {
    const selected = id === sel;
    return h("div.lens-take-row", {
      class: selected ? "on" : "",
      dataset: { key: `take-${id}` },
      draggable: true,
      ondragstart: () => { takeDragIdx = i; },
      ondragover: (e) => { if (takeDragIdx != null) e.preventDefault(); },
      ondrop: (e) => {
        e.preventDefault();
        if (takeDragIdx == null || takeDragIdx === i) return;
        const from = takeDragIdx; takeDragIdx = null;
        store.update((s) => {
          const order = orderedTakeIds(store);
          const [m] = order.splice(from, 1);
          order.splice(i, 0, m);
          s.lens.takeOrder = order;
        });
      },
      onclick: () => pick(id),
    },
      h("span.lens-grip", { title: "drag to reorder" }, "⋮⋮"),
      h("span.lens-dot", { style: { background: selected ? "var(--accent)" : "var(--hint)" } }),
      h("div.lens-take-lines",
        h("span.lens-take-rowname", {}, takeName(store, id)),
        h("span.lens-take-rowmeta", {}, takeMeta(id) ?? id)));
  });

  return h("aside.lens-card.lens-left",
    h("div.lens-pane-head",
      h("span.lens-pane-title", {}, "Performances"),
      h("span.lens-pane-count", {}, String(takes.length)),
      h("button.lens-chevron", { title: "collapse", onclick: () => set({ leftCollapsed: true }) }, "‹")),
    h("div.lens-left-body",
      h("input.lens-search", {
        type: "text", placeholder: "search takes…", value: lens.takeSearch,
        dataset: { focusKey: "lens-left-search" },
        oninput: (e) => set({ takeSearch: e.target.value }),
      }),
      h("span.lens-tiny-label", {}, "TAKES · drag to reorder"),
      takes.length
        ? h("div.lens-take-list", searchLow
            ? rows.filter((_, i) => (takeName(store, takes[i]) + takes[i]).toLowerCase().includes(searchLow))
            : rows)
        : h("span.pane-footnote", {}, "no takes on the SD card yet — record on the device or hit ● REC")),
    metaBlock(ctx, sel));
}

function metaBlock(ctx, sel) {
  const { store, linkApi } = ctx;
  const b = busy(store);
  const connected = store.state.link.status === "connected";
  const meta = sel ? takeMeta(sel) : null;

  const rename = h("div.lens-rename",
    h("input.lens-rename-input", {
      type: "text", value: sel ? takeName(store, sel) : "",
      placeholder: "take name", disabled: !sel || !connected,
      dataset: { focusKey: "lens-rename" },
      onchange: b(async (e) => {
        const name = e.target.value.trim();
        if (!sel || !name || name === store.state.link.takeNames?.[sel]) return;
        const { sidecarBytes, mid } = splitPerfData(await linkApi.perfFetch(sel));
        await linkApi.perfPutData(joinPerfData(rewriteSidecarName(sidecarBytes, name), mid));
        store.log("Lens", `renamed "${sel}" → ${name}`);
      }),
    }),
    h("span.lens-rename-hint", {}, "rename"));

  const actions = h("div.lens-meta-actions",
    h("button.lens-mbtn", {
      disabled: !sel || !connected, title: "copy under a new id (how a take gets a name)",
      onclick: b(async () => {
        const newId = prompt(`duplicate "${sel}" as (a-z, 0-9, dashes):`, `${sel}-2`);
        if (!newId) return;
        if (!isValidTakeId(newId)) throw new Error(`bad take id: ${newId}`);
        const { sidecarBytes, mid } = splitPerfData(await linkApi.perfFetch(sel));
        await linkApi.perfPutData(joinPerfData(rewriteSidecarId(sidecarBytes, newId), mid));
      }),
    }, "dup"),
    h("button.lens-mbtn", {
      disabled: !sel || !connected, title: "download the SMF — drop it on the daw-lens or a DAW",
      onclick: b(async () => downloadMid(ctx, sel)),
    }, "⬇ .mid"),
    h("button.lens-mbtn.danger", {
      disabled: !sel || !connected, title: "delete from the device",
      onclick: b(async () => {
        if (confirm(`Delete take "${sel}" from the device?`)) {
          await linkApi.perfDelete(sel);
          store.update((s) => { if (s.lens.selectedTakeId === sel) s.lens.selectedTakeId = null; });
        }
      }),
    }, "delete"));

  return h("div.lens-meta",
    h("div.lens-meta-head",
      h("span.lens-tiny-label", {}, "TAKE"),
      h("span.lens-meta-sub", {}, sel ? `${takeName(store, sel)}${meta ? ` · ${meta}` : ""}` : "no take selected")),
    rename,
    actions,
    h("span.pane-footnote", {}, "id stays the handle · the name is what shows on the device."));
}

function downloadMid(ctx, id) {
  return ctx.linkApi.perfFetch(id).then((payload) => {
    const { mid } = splitPerfData(payload);
    const a = h("a", { href: URL.createObjectURL(new Blob([mid], { type: "audio/midi" })), download: `${id}.mid` });
    a.click();
    URL.revokeObjectURL(a.href);
    ctx.store.log("Lens", `downloaded ${id}.mid`);
  });
}

// ── center: the one live take (header · lanes · axis · transport dock) ───────
// No source toggle. The take is device-mastered and live by nature: it draws in
// real time while the device records, mirrors the device transport, and freezes
// for inspection when idle. All state (playhead, length, phase) is read from
// `link.perf` — the app's transport buttons only *send* commands.
function centerLiveTake(ctx, view) {
  const header = takeHeader(ctx, view);

  // `empty` replaces the whole center (e.g. the connect card — no device to
  // master a take). `emptyLanes` keeps the dock so REC / Open .mid… stay live.
  if (view.empty) {
    return h("section.lens-card.lens-center", header,
      h("div.lens-center-empty", view.empty));
  }

  const { geo } = view;
  const ticks = timeTicks(geo.x0, geo.x1);

  // 1b: a focused lane replaces the whole center body with the big editor.
  if (view.edit?.focused) {
    return h("section.lens-card.lens-center", header, editToolbar(ctx, view),
      focusedCenter(ctx, view), transportDock(ctx, view));
  }

  const body = view.emptyLanes
    ? h("div.lens-center-body", h("div.lens-center-empty.sm", view.emptyLanes))
    : (() => {
        const ordered = orderPanels(ctx, view.panels);
        const orderedKeys = ordered.map((p) => p.key);
        return h("div.lens-center-body",
          { onwheel: view.edit ? (e) => editWheel(ctx, e, geo) : null },
          ordered.map((p) => pedalPanel(ctx, p, orderedKeys, geo, ticks, view.edit)),
          timeAxis(ticks, geo));
      })();
  return h("section.lens-card.lens-center", header,
    view.edit && editToolbar(ctx, view), body, transportDock(ctx, view));
}

// header: take name + phase badge (READY / PLAYING / ● LIVE) + mono status line,
// with Open .mid… / ⬇ .mid on the right.
function takeHeader(ctx, view) {
  const { store, linkApi } = ctx;
  const { take, name } = view;
  const connected = store.state.link.status === "connected";
  const b = busy(store);

  const editing = !!view.edit;
  const ops = store.state.lens.edit.ops;

  const badge = editing
    ? h("span.lens-badge.blue", {}, h("span.lens-badge-dot"), "EDITING")
    : h("span.lens-badge", { class: take.accent },
        h("span.lens-badge-dot", { class: take.pulse ? "pulse" : "" }), take.badge);
  const dirty = editing && ops.length > 0 &&
    h("span.lens-badge.amber", {}, `${ops.length} edit${ops.length === 1 ? "" : "s"}`);

  // Not editing: Open .mid… / ⬇ .mid (+ ✎ EDIT when a stored take is loaded
  // and the transport is idle). Editing: ✎ DONE / REVERT / SAVE replace them.
  const actions = editing
    ? [h("button.lens-hbtn.blue", { title: "leave edit mode (pending edits are kept)", onclick: () => exitEdit(ctx) }, "✎ DONE"),
       h("button.lens-hbtn", { disabled: !ops.length, title: "discard all pending edits", onclick: () => revertOps(ctx) }, "REVERT"),
       h("button.lens-hbtn.primary", {
         disabled: !ops.length,
         title: "flatten the edits and rewrite the take on the SD card",
         onclick: b(() => saveEdits(ctx, view, view.bindings, { copy: false })),
       }, "SAVE")]
    : [view.canEdit && h("button.lens-hbtn", {
         title: "edit this take's MIDI data",
         onclick: () => enterEdit(ctx, view.downloadId, view.editHash),
       }, "✎ EDIT"),
       h("button.lens-hbtn", {
         disabled: !connected,
         title: connected ? "import a .mid into the device recorder" : "connect a device to import",
         onclick: b(() => openMid(ctx)),
       }, "Open .mid…"),
       h("button.lens-hbtn", {
         disabled: !view.downloadId,
         title: "download the take's .mid",
         onclick: b(() => downloadMid(ctx, view.downloadId)),
       }, "⬇ .mid")];

  return h("div.lens-take-head",
    h("div.lens-take-headmain",
      h("div.lens-take-headtop",
        h("span.lens-take-name", {}, name),
        badge, dirty),
      h("span.lens-take-status", {}, take.status)),
    h("input.lens-file", { type: "file", accept: ".mid,.midi,audio/midi", dataset: { key: "lens-file" } }),
    h("div.lens-head-actions", actions));
}

// The shared time axis (below the lanes). A gutter (label + value cells) lines
// up with each lane's chart, so tick labels sit over the charts.
function timeAxis(ticks, geo) {
  const span = geo.x1 - geo.x0 || 1;
  return h("div.lens-timeaxis",
    h("span.lens-ta-gutter", {}),
    h("div.lens-ta-track",
      ticks.map((t) => h("span.lens-ta-tick",
        { style: { left: `${((t - geo.x0) / span * 100).toFixed(2)}%` } }, fmtTick(t)))));
}

// Default order = the rig/bank order (buildPanels already emits panels in
// rig-instance order, raw channels last). The user's drag order (panelOrder,
// by panel key) overrides it; any panel not in panelOrder — the default, or a
// newly-added pedal — keeps its rig position, after the explicitly-ordered
// ones. Deterministic (no NaN-comparator reliance on rig order).
function orderPanels(ctx, panels) {
  const order = ctx.store.state.lens.panelOrder;
  const rankOf = (key, rigIdx) => {
    const j = order.indexOf(key);
    return j === -1 ? order.length + rigIdx : j;
  };
  return panels
    .map((p, i) => ({ p, rank: rankOf(p.key, i) }))
    .sort((a, b) => a.rank - b.rank)
    .map((x) => x.p);
}

let panelDragKey = null;

function pedalPanel(ctx, p, orderedKeys, geo, ticks, edit = null) {
  const { store } = ctx;
  const collapsed = !!store.state.lens.panelCollapsed[p.key];
  const caret = h("span.lens-pp-caret", {}, collapsed ? "▸" : "▾");
  const meta = geo.phase === "rec" ? "recording…" : geo.phase === "play" ? "playing"
             : `${p.lanes.length} lane${p.lanes.length === 1 ? "" : "s"}`;

  const head = h(p.bound ? "div.lens-pp-head" : "div.lens-pp-head.unbound", {
    style: p.bound ? { background: p.bg, color: p.fg } : null,
    title: "click to fold · drag to reorder",
    draggable: true,
    onclick: () => store.update((s) => {
      s.lens.panelCollapsed = { ...s.lens.panelCollapsed, [p.key]: !s.lens.panelCollapsed[p.key] };
    }),
    ondragstart: (e) => { panelDragKey = p.key; e.dataTransfer.effectAllowed = "move"; },
    ondragover: (e) => {
      if (panelDragKey == null || panelDragKey === p.key) return;
      e.preventDefault();
      e.currentTarget.classList.add("drop-above");   // imperative drag cue (morph-safe)
    },
    ondragleave: (e) => e.currentTarget.classList.remove("drop-above"),
    ondrop: (e) => {
      e.preventDefault();
      e.currentTarget.classList.remove("drop-above");
      const from = panelDragKey; panelDragKey = null;
      if (from == null || from === p.key) return;
      // reorder the currently-shown keys: pull `from` out, drop it before the
      // target, persist the whole list (the new panelOrder)
      const order = orderedKeys.filter((k) => k !== from);
      order.splice(order.indexOf(p.key), 0, from);
      store.update((s) => { s.lens.panelOrder = order; });
    },
  },
    caret,
    h("span.lens-pp-name", {}, p.name),
    h("span.lens-pp-sub", {}, p.bound ? `${p.inst} · ch ${p.ch}` : "not in rig — raw"),
    h("span.lens-pp-meta", {}, meta));

  return h("section.lens-panel", { class: collapsed ? "collapsed" : "", dataset: { key: `pp-${p.key}` } },
    head, !collapsed && p.lanes.map((lane) => edit
      ? editLaneRow(ctx, p, lane, geo, ticks, edit.ghosts.get(`${p.key}|${lane.key}`) ?? null, edit.edited)
      : laneRow(lane, geo, ticks)));
}

function laneRow(lane, geo, ticks) {
  const W = 1000, H = 44;
  const span = geo.x1 - geo.x0 || 1;
  const pctOf = (t) => (((t - geo.x0) / span) * 100).toFixed(2);
  const grid = ticks.map((t) => {
    const x = (((t - geo.x0) / span) * W).toFixed(1);
    return `<line x1="${x}" y1="0" x2="${x}" y2="${H}" class="lens-grid" vector-effect="non-scaling-stroke"/>`;
  }).join("");
  const mid = `<line x1="0" y1="${(H - 4 - (64 / 127) * (H - 8)).toFixed(1)}" x2="${W}" ` +
    `y2="${(H - 4 - (64 / 127) * (H - 8)).toFixed(1)}" class="lens-mid" stroke-dasharray="2 5" vector-effect="non-scaling-stroke"/>`;
  // draw on the axis scale [x0, x1], holding only out to the playhead (drawTo)
  const d = stepAfterPath(lane.events, geo.x0, geo.x1, W, H, 4, geo.drawTo);
  const svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${grid}${mid}` +
    (d ? `<path d="${d}" class="lens-series" vector-effect="non-scaling-stroke"/>` : "") + `</svg>`;

  const val = valueAt(lane.events, geo.valueT);

  return h("div.lens-lane",
    h("div.lens-lane-label",
      h("span.lens-lane-name", {}, lane.label),
      h("span.lens-lane-cc", {}, lane.detail)),
    h("div.lens-lane-val", { style: { color: geo.headShown ? geo.headColor : "var(--text-2)" } },
      val == null ? "" : String(val)),
    h("div.lens-lane-chart",
      geo.showTrim && h("div.lens-lane-trim", {
        style: { left: `${pctOf(geo.trimA)}%`, width: `${(pctOf(geo.trimB) - pctOf(geo.trimA)).toFixed(2)}%` },
      }),
      h("div.lens-lane-svg", { innerHTML: svg }),
      geo.headShown && h("div.lens-lane-head", {
        style: { left: `${pctOf(geo.playheadS)}%`, background: geo.headColor },
      })));
}

// ── right pane: inspector (THIS TAKE table + MIDI monitor) ──────────────────
function rightPane(ctx, view) {
  const { store } = ctx;
  const { lens } = store.state;
  const set = (patch) => store.update((s) => Object.assign(s.lens, patch));

  if (lens.rightCollapsed) {
    return h("aside.lens-rail.lens-rail-right",
      h("button.lens-chevron", { title: "expand", onclick: () => set({ rightCollapsed: false }) }, "‹"),
      h("span.lens-rail-label", {}, "INSPECTOR"));
  }

  return h("aside.lens-card.lens-right",
    h("div.lens-pane-head",
      h("span.lens-pane-title", {}, "Inspector"),
      h("button.lens-chevron", { title: "collapse", onclick: () => set({ rightCollapsed: true }) }, "›")),
    view.edit && editsSection(ctx, view, view.bindings),
    thisTakeSection(ctx, view),
    monitorSection(ctx));
}

const TT_CAP = 400; // cap rendered event rows (a dense sim take is thousands)

function thisTakeSection(ctx, view) {
  const { store } = ctx;
  const open = store.state.lens.thisTakeOpen;
  const edit = view.edit;
  // 1b: the focused editor filters the table to the focused lane
  const focused = edit?.focused;
  const allRows = view.panels ? tableRows(view.panels) : [];
  const rows = focused
    ? allRows.filter((r) => r.ch === focused.ch && r.cc === focused.cc)
    : allRows;
  const sel = edit && store.state.lens.edit.sel;
  const inSel = (r) => sel && sel.t0 != null && r.ch === sel.ch && r.cc === sel.cc &&
    r.t >= sel.t0 - 1e-9 && r.t <= sel.t1 + 1e-9;

  const head = h("div.lens-sec-head", {
    onclick: () => store.update((s) => { s.lens.thisTakeOpen = !s.lens.thisTakeOpen; }),
  },
    h("span.lens-sec-caret", {}, open ? "▾" : "▸"),
    h("span.lens-sec-title", {}, focused ? "THIS LANE" : "THIS TAKE"),
    focused && h("span.lens-lanepill", {}, `${edit.focusedLabel ?? `CC ${focused.cc}`} only`),
    h("span.lens-sec-count", {},
      `${rows.length} event${rows.length === 1 ? "" : "s"}${edit ? " · click a value to edit" : ""}`));

  const body = open ? h("div.lens-tt-body",
    rows.length
      ? [rows.slice(0, TT_CAP).map((r) => h("div.lens-tt-row", {
          class: inSel(r) ? "on" : "",
          dataset: edit && r.id != null ? { key: `tt-${r.id}` } : null,
        },
          h("span.lens-tt-time", {}, fmtMs(r.t * 1000)),
          h("span.lens-tt-ctrl",
            h("span.lens-sq", { style: { background: r.bg ?? "var(--hint)" } }),
            r.label),
          h("div.lens-tt-val",
            h("div.lens-tt-track", h("div.lens-tt-fill", { style: { width: `${(r.v / 127 * 100).toFixed(1)}%` } })),
            edit && r.id != null ? editValueCell(ctx, r) : h("span.lens-tt-num", {}, String(r.v))))),
         rows.length > TT_CAP && h("div.lens-tt-more", {}, `… ${rows.length - TT_CAP} more`)]
      : h("span.pane-footnote", {}, view.empty ? "—" : "no recorded events")) : null;

  return h("div.lens-sec.lens-sec-take", head, body);
}

function monitorSection(ctx) {
  const { store, pedalsById } = ctx;
  const open = store.state.lens.monitorOpen;
  const evs = store.state.monitorEvents;
  const rig = store.state.docs.rig;

  const head = h("div.lens-sec-head", {
    onclick: () => store.update((s) => { s.lens.monitorOpen = !s.lens.monitorOpen; }),
  },
    h("span.lens-sec-caret", {}, open ? "▾" : "▸"),
    h("span.lens-sec-title", {}, "MIDI MONITOR"),
    h("span.lens-live", h("span.lens-live-dot"), "live"));

  const body = open ? h("div.lens-mon-body",
    evs.length
      ? evs.slice(0, 60).map((e, i) => {
          const owner = ccOwner(rig, pedalsById, e.channel, e.cc);
          return h("div.lens-mon-row", { dataset: { key: `mon-${i}` } },
            h("span.lens-mon-src",
              owner
                ? [h("span.lens-sq", { style: { background: owner.pedal.backgroundColor } }),
                   `${owner.pedal.name} · ${owner.label}`]
                : h("span.dim", {}, `ch ${e.channel} — unmapped`)),
            h("span.lens-mon-cc", {}, `CC ${e.cc}`),
            h("span.lens-mon-val", {}, String(e.value)));
        })
      : h("span.pane-footnote", {}, "nothing yet — twist something on the device")) : null;

  return h("div.lens-sec.lens-sec-mon", head, body);
}

// ── transport dock (bottom) ─────────────────────────────────────────────────
// Buttons in the label gutter, a scrub bar aligned to the lane charts, a loop
// toggle, the clock, and the device-mirror label. The device is the master:
// every button *sends* a command (linkApi.perfControl), and every visual reads
// back from `link.perf`.
function transportDock(ctx, view) {
  const { store, linkApi } = ctx;
  const { geo, take } = view;
  const perf = store.state.link.perf;
  const connected = store.state.link.status === "connected" && !!perf;
  const running = take.running;
  const hasTake = (perf?.lanes ?? 0) > 0 || geo.lengthS > 0.02;
  // While edits are pending the lanes show the EDITED take but the device can
  // only play the ORIGINAL — playing would look broken, so PLAY is disabled
  // until SAVE flattens (Steve's call, 2026-07-14).
  const editDirty = !!view.edit && store.state.lens.edit.ops.length > 0;
  const b = busy(store);

  // Per-state buttons: running → ■ STOP only; else ● REC + ▶ PLAY.
  const buttons = running
    ? [h("button.lens-tp.stop", {
        disabled: !connected, title: "stop the device",
        onclick: b(() => linkApi.perfControl("stop")),
      }, "■ STOP")]
    : [h("button.lens-tp.rec", {
        disabled: !connected,
        title: connected ? "record on the device" : "connect a device to record",
        onclick: b(() => linkApi.perfControl("record")),
      }, "● REC"),
      h("button.lens-tp.play", {
        disabled: !connected || !hasTake || editDirty,
        title: editDirty ? "the device has the original — SAVE your edits to audition them"
                         : "play the take on the device",
        onclick: b(() => playCmd(ctx, geo)),
      }, "▶ PLAY")];

  // Loop is a property of the TAKE (stored in its sidecar on the device), so
  // this button mirrors whichever take is loaded — link.mjs syncs lens.loop
  // from every fresh PERF_STATUS. Clicking flips optimistically and tells the
  // device; the ACK echoes the take's new mode back.
  const loopOn = store.state.lens.loop;
  const loopBtn = h("button.lens-tp.loop", {
    class: loopOn ? "on" : "",
    title: loopOn ? "this take loops at the trim end (click to stop there instead)"
                  : "this take stops at the trim end (click to loop instead)",
    onclick: () => {
      store.update((s) => { s.lens.loop = !s.lens.loop; });
      if (connected) linkApi.perfControl("loop", { loop: store.state.lens.loop ? 1 : 0 }).catch(() => {});
    },
  }, "⟲ LOOP");

  // ✦ SNAP: freeze every lane's value under the playhead into a user snapshot
  // (the DEVICE tab's SNAPS scenes). Pure app-side read of the lanes — works
  // without a device. Uses geo.valueT so it captures exactly the values the
  // lane gutter cells are showing.
  const snappable = (view.panels ?? []).some((p) => p.lanes.some((l) => l.cc != null));
  const snapBtn = h("button.lens-tp.snap", {
    disabled: !snappable,
    title: snappable
      ? "capture every lane's value at the playhead as a snapshot (DEVICE › SNAPS)"
      : "load or record a take first — snapshots capture lane values at the playhead",
    onclick: () => snapshotAtPlayhead(ctx, view),
  }, "✦ SNAP");

  const span = geo.lengthS || 1;
  const pctOf = (t) => ((t / span) * 100).toFixed(2);
  const scrubbable = connected && hasTake;
  const scrub = h("div.lens-scrub", {
    class: scrubbable ? "" : "disabled",
    dataset: { scrubtrack: "1" },
    onpointerdown: scrubbable ? (e) => startScrub(ctx, e, geo.lengthS) : null,
  },
    geo.showTrim && h("div.lens-scrub-region", {
      style: { left: `${pctOf(geo.trimA)}%`, width: `${(pctOf(geo.trimB) - pctOf(geo.trimA)).toFixed(2)}%` } }),
    geo.showTrim && h("div.lens-scrub-handle", {
      title: "trim start", style: { left: `${pctOf(geo.trimA)}%` },
      onpointerdown: (e) => startTrim(ctx, e, "a", geo.lengthS) }, h("span.lens-scrub-grip")),
    geo.showTrim && h("div.lens-scrub-handle", {
      title: "trim end", style: { left: `${pctOf(geo.trimB)}%` },
      onpointerdown: (e) => startTrim(ctx, e, "b", geo.lengthS) }, h("span.lens-scrub-grip")),
    geo.headShown && h("div.lens-scrub-head", { style: { left: `${pctOf(geo.playheadS)}%`, background: geo.headColor } }),
    geo.headShown && h("div.lens-scrub-knob", { style: { left: `${pctOf(geo.playheadS)}%`, background: geo.headColor } }),
    view.edit && viewRegion(ctx, geo));

  // The clock reflects the trimmed segment (the play window), not the whole
  // performance: elapsed within [A,B] / segment duration. Recording shows the
  // captured length instead.
  const segLen = Math.max(geo.trimB - geo.trimA, 0);
  const segPos = clamp(geo.playheadS, geo.trimA, geo.trimB) - geo.trimA;
  const clock = geo.phase === "rec"
    ? `● ${geo.playheadS.toFixed(1)}s`
    : `${segPos.toFixed(1)}s / ${segLen.toFixed(1)}s`;
  const mirror = deviceMirror(store);

  return h("div.lens-dock", { class: geo.phase === "rec" ? "rec" : geo.phase === "play" ? "play" : "" },
    h("div.lens-dock-row",
      h("div.lens-dock-gutter", buttons),
      scrub),
    h("div.lens-dock-row",
      h("div.lens-dock-gutter", loopBtn, snapBtn),
      h("div.lens-dock-meta",
        h("span.lens-clock", {}, clock),
        h("span.lens-mirror", { class: mirror.accent }, h("span.lens-mirror-dot"), mirror.text))));
}

// ✦ SNAP → a user snapshot in docs.snapshots, named after the take + time.
// One value per ch:cc lane — the value the lane holds at geo.valueT (idle at
// the start = end-of-take, matching the gutter). Undoable; the toast points
// at where it landed.
function snapshotAtPlayhead(ctx, view) {
  const { store } = ctx;
  const t = view.geo.valueT;
  const values = snapshotValuesAt(view.panels, t);
  if (!values.length) return;
  const name = `${view.name} @ ${(+t.toFixed(1))}s`;
  const snap = { id: `snap-${Date.now().toString(36)}`, name,
    createdAt: new Date().toISOString(), values };
  store.mutate(`snapshot "${name}" · ${values.length} value${values.length === 1 ? "" : "s"}`,
    (s) => { s.docs.snapshots.push(snap); },
    { action: { label: "view in SNAPS",
        apply: (s) => { s.view = "device"; s.deviceShelf.snaps = true; } } });
}

// The device-mirror line (bottom-right of the dock, and the model for the
// topbar pill): derived from the reported link + transport state.
function deviceMirror(store) {
  const link = store.state.link;
  if (link.status !== "connected") return { accent: "off", text: "no device" };
  const st = link.perf?.state;
  if (st === "rec" || st === "overdub") return { accent: "green", text: "Proxi · ● REC" };
  if (st === "play") return { accent: "amber", text: "Proxi · ▶ PLAY" };
  return { accent: "idle", text: "Proxi · connected" };
}

// PLAY: the trim segment is the play window. Seek to the segment start if the
// head is outside it, then play. The device owns the wrap/stop at the window
// end — the loaded take's own loop mode (its sidecar) decides which.
async function playCmd(ctx, geo) {
  const { linkApi, store } = ctx;
  const perf = store.state.link.perf;
  const aMs = Math.round(geo.trimA * 1000), bMs = Math.round(geo.trimB * 1000);
  const posMs = perf?.pos ?? 0;
  if (posMs < aMs || posMs >= bMs - 20) await linkApi.perfControl("scrub", { pos: aMs });
  await linkApi.perfControl("play");
}

// ── pointer scrub / trim ────────────────────────────────────────────────────
// Scrub: drag anywhere on the track → set the playhead by fraction, and command
// the device to seek there (throttled while dragging, final seek on release).
// The playhead + value cells follow lens.drag.posMs live during the drag.
function startScrub(ctx, e, lengthS) {
  e.preventDefault();
  const { store, linkApi } = ctx;
  const rect = e.currentTarget.getBoundingClientRect();
  const posMsAt = (ev) => Math.round(clamp((ev.clientX - rect.left) / rect.width, 0, 1) * lengthS * 1000);
  let lastSent = 0;
  const move = (ev) => {
    const posMs = posMsAt(ev);
    store.update((s) => { s.lens.drag = { kind: "scrub", posMs }; });
    const now = performance.now();
    if (store.state.link.status === "connected" && now - lastSent > 70) {
      lastSent = now; linkApi.perfControl("scrub", { pos: posMs }).catch(() => {});
    }
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    const drag = store.state.lens.drag;
    store.update((s) => { s.lens.drag = null; });
    if (drag && store.state.link.status === "connected")
      linkApi.perfControl("scrub", { pos: drag.posMs }).catch((err) => store.log("Lens", err.message));
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  move(e);
}

// Trim: drag a bracket handle → move the loop window [A, B] (seconds), clamped
// to [0, length] and kept ≥ 0.3s apart. When connected the device's window
// (w0/w1) is the master, so the drag commands it (perfControl("window")) —
// throttled while dragging, final on release — and the glass mirrors it; the
// optimistic drag value is shown until the device echoes back. Offline it just
// writes the app-local lens.trimA/trimB.
function startTrim(ctx, e, which, lengthS) {
  e.preventDefault(); e.stopPropagation();
  const { store, linkApi } = ctx;
  const track = e.currentTarget.closest("[data-scrubtrack]");
  if (!track) return;
  const rect = track.getBoundingClientRect();
  const connected = store.state.link.status === "connected";
  const perf = store.state.link.perf;
  // The edge we're NOT dragging stays pinned at its current value.
  const start = connected && perf
    ? { a: (perf.w0 ?? 0) / 1000, b: (perf.w1 ?? lengthS * 1000) / 1000 }
    : { a: store.state.lens.trimA ?? 0, b: store.state.lens.trimB ?? lengthS };
  const sendWindow = (a, b) =>
    linkApi.perfControl("window", { w0: Math.round(a * 1000), w1: Math.round(b * 1000) });
  let lastSent = 0;
  const move = (ev) => {
    const t = clamp((ev.clientX - rect.left) / rect.width, 0, 1) * lengthS;
    let a = start.a, b = start.b;
    if (which === "a") a = clamp(t, 0, start.b - 0.3);
    else b = clamp(t, start.a + 0.3, lengthS);
    store.update((s) => { s.lens.drag = { kind: `trim${which}`, trimA: a, trimB: b }; });
    if (connected) {
      const now = performance.now();
      if (now - lastSent > 70) { lastSent = now; sendWindow(a, b).catch(() => {}); }
    }
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    const drag = store.state.lens.drag;
    store.update((s) => {
      s.lens.drag = null;
      if (!connected && drag) { s.lens.trimA = drag.trimA; s.lens.trimB = drag.trimB; }
    });
    if (connected && drag) sendWindow(drag.trimA, drag.trimB).catch((err) => store.log("Lens", err.message));
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

// ── Open .mid… → import a local file into the device recorder ────────────────
// Parse the .mid, resolve its CC into rig lanes, synthesize a take sidecar, push
// it under a fresh id, and load it (so it becomes the mastered take). Device
// acceptance of externally-authored SMF is HARDWARE-UNVERIFIED — flagged in the
// log; the round-tripped payload shape is covered by node tests.
function openMid(ctx) {
  return new Promise((resolve) => {
    const input = document.querySelector("input.lens-file");
    if (!input) return resolve();
    input.value = "";
    input.onchange = async () => {
      const f = input.files && input.files[0];
      if (f) { try { await importMid(ctx, f); } catch (err) { ctx.store.log("Lens", `import failed: ${err.message}`); } }
      resolve();
    };
    input.click();
  });
}

async function importMid(ctx, file) {
  const { store, linkApi, pedalsById } = ctx;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const parsed = parseSMF(bytes);
  const bindings = buildBindings(store.state.docs.rig, pedalsById);
  const panels = buildPanels(eventsFromSMF(parsed), bindings);
  const lenMs = Math.max(Math.round(parsed.durationSeconds * 1000), 1);

  const lanes = [];
  for (const p of panels) for (const l of p.lanes) {
    if (l.cc == null) continue;             // notes/PC don't ride a CC lane sidecar
    lanes.push({ channel: p.ch, cc: l.cc, v0: l.events[0]?.v ?? 0, label: l.label,
      color: p.bg || "#FFFFFF", instanceId: p.inst || "", controlId: "", events: l.events.length });
  }

  const base = (file.name.replace(/\.[^.]+$/, "").toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "")) || "import";
  const existing = store.state.link.manifest?.performances || {};
  let id = base, n = 2;
  while (existing[id]) id = `${base}-${n++}`;

  const sidecar = { format: "proxi-performance", formatVersion: 1, id,
    name: file.name.replace(/\.[^.]+$/, ""), len: lenMs, w0: 0, w1: lenMs, lanes };
  await linkApi.perfPutData(joinPerfData(sidecar, bytes));
  await linkApi.perfLoad(id);
  store.update((s) => { s.lens.selectedTakeId = id; });
  store.log("Lens", `imported ${file.name} → "${id}" (device SMF acceptance unverified on hardware)`);
}

// ── device-mastered playhead interpolation ──────────────────────────────────
// The recorder status polls only every ~5s, so between polls we advance a local
// clock from the last reported pos while running — the device stays the source
// of truth (each poll re-syncs), the playhead just stops stuttering.
let posClock = null;
function displayPosMs(perf) {
  if (!perf) return 0;
  const running = perf.state === "rec" || perf.state === "play" || perf.state === "overdub";
  const sig = `${perf.state}:${perf.pos}:${perf.len}`;
  if (!posClock || posClock.sig !== sig) posClock = { sig, at: performance.now(), pos: perf.pos };
  return running ? perf.pos + (performance.now() - posClock.at) : perf.pos;
}

// First-pass recording timeline scale: a fixed 10s window that grows in ×1.5
// steps, so the lanes draw and update in place instead of continuously
// rescaling. The playhead travels all the way to the right edge before the
// scale steps (grows once pos reaches the full scale). Reset to 0 between takes
// (recResetScale) so each new recording starts at 10s.
const REC_INITIAL_MS = 10000;
let recScaleMs = 0;
function recAxisMs(posMs) {
  if (recScaleMs === 0) recScaleMs = REC_INITIAL_MS;
  while (posMs >= recScaleMs) recScaleMs += Math.floor(recScaleMs / 2);
  return recScaleMs;
}
const recResetScale = () => { recScaleMs = 0; };

// The full first-pass recording, accumulated from live CC into an UNCAPPED
// buffer. The store's monitorEvents is capped at 200, so rebuilding a take from
// it only yields the recent tail (the line appears to start from the right).
// Instead, anchor a buffer at rec-start (wall-clock of take t=0) and append
// every new CC at its true take-time, so the series fills left→right. Kept after
// the pass ends so the frozen unsaved take still shows in full.
let recBuf = [], recAnchorWall = 0, recLastSeen = 0, recWasRec = false;
function recAccumulate(monitorEvents, nowMs, posMs) {
  if (!recWasRec) {                        // entering a fresh record pass
    recBuf = [];
    recAnchorWall = nowMs - posMs;         // wall-clock of take t=0
    recLastSeen = recAnchorWall;           // ignore CC from before REC
    recWasRec = true;
  }
  for (let i = monitorEvents.length - 1; i >= 0; i--) {   // oldest-first
    const e = monitorEvents[i];
    if (e.t <= recLastSeen) continue;
    recBuf.push({ t: Math.max(0, (e.t - recAnchorWall) / 1000), ch: e.channel, type: "cc", cc: e.cc, value: e.value });
  }
  if (monitorEvents.length) recLastSeen = Math.max(recLastSeen, monitorEvents[0].t);
  return recBuf;
}
const recEndPass = () => { recWasRec = false; };   // stop accumulating; keep recBuf

// SIM is deterministic but a full sweep is thousands of events; memoize by the
// rig signature so a live-CC re-render doesn't rebuild it. (Dev ?sim only.)
let simMemo = { sig: null, view: null };
function simView(rig, bindings) {
  const sig = JSON.stringify(rig.instances.map((i) => [i.instanceId, i.pedalId, i.midiChannel]));
  if (simMemo.sig !== sig) {
    const { events, durationS } = simEvents(bindings);
    simMemo = { sig, view: { durationS, panels: buildPanels(events, bindings) } };
  }
  return simMemo.view;
}

// ── the one live take: device state → the view center + inspector share ──────
function buildLiveTake(ctx, sel, bindings) {
  const { store } = ctx;
  const link = store.state.link;
  const perf = link.perf;
  const lens = store.state.lens;
  const connected = link.status === "connected" && !!perf;
  // Each recording pass restarts the stepped scale at 10s and stops the live
  // accumulator (the buffer is kept so a just-stopped unsaved take still shows).
  if (!(connected && perf.state === "rec")) { recResetScale(); recEndPass(); }

  const nameFor = connected ? (perf.loadedName || perf.loadedId)
    : (sel ? takeName(store, sel) : "No take");
  const take = lensTake(connected ? perf : null, nameFor);

  // Assemble the geometry (playhead, trim, draw window) shared by lanes + dock.
  const mkGeo = ({ lengthS, playMs, phase, recDraw }) => {
    const dragScrub = lens.drag?.kind === "scrub";
    let playheadS = Math.max(0, (dragScrub ? lens.drag.posMs : playMs) / 1000);
    const running = phase === "rec" || phase === "play";
    // The trim segment is the play window and is ALWAYS present (default = the
    // whole take). LOOP does not gate it — LOOP only decides what happens at the
    // segment end (stop vs. jump to the start). Shown whenever there's a take to
    // play and we're not mid-record.
    // Source of truth: the device's loop window w0/w1 when connected (so a trim
    // set on the glass shows here); the app-local lens.trimA/B when offline; the
    // live drag value mid-gesture (optimistic, before the device echoes back).
    const dragTrim = lens.drag && (lens.drag.kind === "trima" || lens.drag.kind === "trimb") ? lens.drag : null;
    const rawA = dragTrim ? dragTrim.trimA : connected ? (perf.w0 ?? 0) / 1000 : lens.trimA ?? 0;
    const rawB = dragTrim ? dragTrim.trimB : connected ? (perf.w1 ?? lengthS * 1000) / 1000 : lens.trimB ?? lengthS;
    const trimA = clamp(rawA, 0, lengthS);
    const trimB = clamp(rawB, trimA + 0.05, lengthS || trimA + 0.05);
    const showTrim = phase !== "rec" && lengthS > 0.02;
    // During playback the head can't run past the segment end (it stops or loops
    // there); recording ignores the segment.
    if (running && !dragScrub)
      playheadS = Math.min(playheadS, phase === "play" ? trimB : lengthS);
    const idleAtStart = !running && !dragScrub && playheadS < 0.02;
    const headColor = phase === "rec" ? "var(--green-text)" : phase === "play" ? "var(--amber)" : "var(--faint)";
    return {
      x0: 0,
      x1: Math.max(lengthS, 0.001),        // stable axis (rec passes a stepped scale)
      drawTo: recDraw ? Math.max(playheadS, 0.001) : Math.max(lengthS, 0.001),
      playheadS, valueT: idleAtStart ? lengthS : playheadS,
      headShown: running || dragScrub || playheadS > 0.02,
      headColor, phase, loop: lens.loop, trimA, trimB, showTrim, lengthS,
    };
  };

  // No device → nothing to master. Dev ?sim shows the scripted sweep; otherwise
  // the connect card (matches the DEVICE tab).
  if (!connected) {
    if (SIM && bindings.size) {
      const sv = simView(store.state.docs.rig, bindings);
      return { name: "Simulation (?sim)", take, panels: sv.panels, downloadId: null,
               geo: mkGeo({ lengthS: sv.durationS, playMs: 0, phase: "ready", recDraw: false }) };
    }
    return { name: nameFor, take, empty: connectCard(ctx) };
  }

  const posMs = displayPosMs(perf);

  // First-pass recording → draw the accumulated take in place on the stepped
  // axis. New lanes/pedals appear as their CC arrives; existing lanes extend
  // inline from the left toward the playhead. The axis does not scroll.
  if (perf.state === "rec") {
    const panels = buildPanels(recAccumulate(store.state.monitorEvents, Date.now(), posMs), bindings);
    return { name: nameFor, take, downloadId: null, panels,
             geo: mkGeo({ lengthS: recAxisMs(posMs) / 1000, playMs: posMs, phase: "rec", recDraw: true }) };
  }
  // Overdub → the take length is known; paint the live monitor over it.
  if (perf.state === "overdub") {
    const events = recTakeEvents(store.state.monitorEvents, Date.now(), posMs);
    return { name: nameFor, take, downloadId: null, panels: buildPanels(events, bindings),
             geo: mkGeo({ lengthS: Math.max(perf.len || posMs, 1) / 1000, playMs: posMs, phase: "rec", recDraw: true }) };
  }

  const phase = perf.state === "play" ? "play" : "ready";

  // Empty recorder → keep the dock (so REC / Open .mid… work), no lanes.
  if (perf.lanes === 0) {
    return { name: nameFor, take, panels: [], downloadId: null,
             emptyLanes: "no take yet — hit ● REC and twist knobs, or Open .mid…",
             geo: mkGeo({ lengthS: 0, playMs: 0, phase, recDraw: false }) };
  }

  // A stored take is on SD → fetch its SMF for full fidelity.
  if (link.manifest?.performances?.[perf.loadedId]) {
    const t = ensureFileTake(ctx, perf.loadedId, bindings);
    const lenS = (perf.len || 0) / 1000;
    if (t.status === "loading")
      return { name: nameFor, take, panels: [], downloadId: null, emptyLanes: "loading take…",
               geo: mkGeo({ lengthS: lenS, playMs: posMs, phase, recDraw: false }) };
    if (t.status === "error")
      return { name: nameFor, take, panels: [], downloadId: null, emptyLanes: `couldn't load: ${t.err}`,
               geo: mkGeo({ lengthS: lenS, playMs: posMs, phase, recDraw: false }) };

    // Edit mode (design_handoff_lens_midi_editing): the lanes render the op
    // stack applied over the parsed take, on the zoom window. Only a stored,
    // idle take is editable; if the device starts running, the edit chrome
    // yields for that render (state is kept — it resumes when idle).
    const canEdit = phase === "ready";
    if (lens.edit.on && canEdit) {
      syncEditKey(store, perf.loadedId, t.hash);   // direct-mutate, render-safe
      const edited = editedTake(store, t);
      const activeOps = lens.edit.preview ? [...lens.edit.ops, lens.edit.preview] : lens.edit.ops;
      const touched = touchedLanes(activeOps);
      const panels = buildPanels(edited.rows, bindings);
      const geo = mkGeo({ lengthS: edited.lenS, playMs: posMs, phase, recDraw: false });
      const w = winOf(store, edited.lenS);
      geo.x0 = w.t0; geo.x1 = w.t1; geo.drawTo = w.t1;
      // an active TRIM shifts the edited timeline off the device's — the
      // playhead would lie, so hide it until the trim is saved or bypassed
      if (touched.take) geo.headShown = false;
      // ghost series: the ORIGINAL lane events under touched lanes (the diff)
      const ghosts = new Map();
      for (const p of t.panels) for (const l of p.lanes)
        if (touched.lanes.has(`${p.ch}:${l.cc}`)) ghosts.set(`${p.key}|${l.key}`, l.events);
      const selRef = laneOfSel(panels, lens.edit.sel);
      const focused = lens.edit.focusedLane;
      const focusedRef = focused && laneOfSel(panels, focused);
      take.status = lens.edit.ops.length
        ? `editing in place · ⌘Z undoes each edit · SAVE to audition — the device still has the original`
        : `editing in place · drag points · drag empty lane space to select a range · double-click to insert`;
      return { name: nameFor, take, panels, downloadId: perf.loadedId, editHash: t.hash,
               geo, edit: { entry: t, edited, touched, ghosts,
                            selLabel: selRef?.lane.label, selColor: selRef?.panel.bg,
                            focused, focusedRef,
                            focusedLabel: focusedRef?.lane.label } };
    }

    return { name: nameFor, take, panels: t.panels, downloadId: perf.loadedId,
             canEdit, editHash: t.hash,
             geo: mkGeo({ lengthS: Math.max(lenS, t.durationS || 0), playMs: posMs, phase, recDraw: false }) };
  }

  // Unsaved recorder take (not on SD): show the full buffer we accumulated
  // while recording it; fall back to the capped monitor tail if we have none.
  const events = recBuf.length ? recBuf : recTakeEvents(store.state.monitorEvents, Date.now(), perf.len || 0);
  return { name: nameFor, take, downloadId: null, panels: buildPanels(events, bindings),
           geo: mkGeo({ lengthS: (perf.len || 0) / 1000, playMs: posMs, phase, recDraw: false }) };
}

// While the device runs (and LENS is showing) keep an ~80ms repaint going so the
// interpolated playhead is smooth. The device owns the wrap/stop at the window
// end (the loaded take's loop mode, set via the "loop" action), so the app no
// longer drives the transport here — it just repaints. Self-clears when LENS is
// hidden or the device stops.
let perfTimer = null;
function syncPerfTicker(ctx) {
  const { store } = ctx;
  const isRunning = (s) => {
    const p = s.link.perf;
    return s.view === "lens" && s.link.status === "connected" && p &&
      (p.state === "rec" || p.state === "play" || p.state === "overdub");
  };
  if (isRunning(store.state) && !perfTimer) {
    perfTimer = setInterval(() => {
      if (!isRunning(store.state)) { clearInterval(perfTimer); perfTimer = null; return; }
      store.update(() => {});
    }, 80);
  } else if (!isRunning(store.state) && perfTimer) {
    clearInterval(perfTimer); perfTimer = null;
  }
}

// Dev hook: window.proxiLens.inject(ch, cc, val) feeds the live monitor so REC
// drawing can be exercised without hardware. Wired once.
let devWired = false;
function wireDevHooks(ctx) {
  if (devWired) return;
  devWired = true;
  window.proxiLens = window.proxiLens || {};
  window.proxiLens.inject = (channel, cc, value) => {
    const mon = ctx.store.state.monitorEvents;
    mon.unshift({ t: Date.now(), channel, cc, value });
    if (mon.length > 200) mon.length = 200;
    ctx.store.update(() => {});
  };
}

// ── entry ───────────────────────────────────────────────────────────────────
export function renderLensView(ctx) {
  const { store, pedalsById } = ctx;
  wireDevHooks(ctx);
  wireEditKeys(ctx);
  syncPerfTicker(ctx);
  const takes = orderedTakeIds(store);
  const sel = store.state.lens.selectedTakeId && takes.includes(store.state.lens.selectedTakeId)
    ? store.state.lens.selectedTakeId
    : takes[0] ?? null;
  const bindings = buildBindings(store.state.docs.rig, pedalsById);
  const view = buildLiveTake(ctx, sel, bindings);
  view.bindings = bindings;

  return h("div.lens",
    h("div.lens-body",
      // 1b: while a lane is focused, the left pane becomes the lane list
      view.edit?.focused
        ? focusedLeftPane(ctx, view, takes, sel)
        : leftPane(ctx, takes, sel),
      centerLiveTake(ctx, view),
      rightPane(ctx, view)));
}
