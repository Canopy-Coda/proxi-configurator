//
// store.mjs — app state: the authored docs (rig / layouts / settings, exactly
// the JSON documents contract v2 stores), UI state, and the undo stack.
// Docs persist to localStorage; the device holds its own copies and the
// manifest diff reconciles the two (link.mjs).
//
import { emptyLayout, pruneHiddenPage } from "./model.mjs";

const LS = {
  rig: "proxi2.rig",
  layouts: "proxi2.layouts",
  settings: "proxi2.settings",
  pedals: "proxi2.pedals",   // user-defined custom pedals only — the library ships with the app
  ui: "proxi2.ui",
  manifest: "proxi2.lastManifest",
  snapshots: "proxi2.snapshots", // user-captured value scenes — app-side only,
                                 //   never synced to the device (apply = CC sends)
};

function loadJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
}

// One-time migration from the PoC's keys (same document shapes).
function migratePoC() {
  if (localStorage.getItem(LS.rig) || !localStorage.getItem("proxi-rig")) return;
  const old = loadJSON("proxi-rig", null);
  const oldLayouts = loadJSON("proxi-layouts", []);
  if (old?.instances?.length) {
    localStorage.setItem(LS.rig, JSON.stringify({
      format: "proxi-rig", formatVersion: 1, id: "rig",
      instances: old.instances,
      omniports: [{ mode: "expression" }, { mode: "unused" }],
    }));
    localStorage.setItem(LS.layouts, JSON.stringify(oldLayouts));
  }
}

export function createStore() {
  migratePoC();

  const docs = {
    rig: loadJSON(LS.rig, {
      format: "proxi-rig", formatVersion: 1, id: "rig",
      instances: [],
      omniports: [{ mode: "expression" }, { mode: "unused" }],
    }),
    layouts: loadJSON(LS.layouts, []),
    settings: loadJSON(LS.settings, {
      format: "proxi-settings", formatVersion: 1, id: "settings", layoutOrder: [],
    }),
    pedals: loadJSON(LS.pedals, []),
    // [{ id, name, createdAt, values: [{channel, cc, value}] }] — undoable via
    // mutate like every doc, but excluded from device sync (link.mjs localDocs).
    snapshots: loadJSON(LS.snapshots, []),
  };
  // settings.layoutOrder tracks the layouts that actually exist
  reconcileBankOrder(docs);

  const ui = loadJSON(LS.ui, {});
  const state = {
    docs,
    // rig | layouts | device — "library" merged into "rig" (2026-07-11), old
    // persisted values route there
    view: ui.view === "library" ? "rig" : ui.view ?? "layouts",
    currentLayoutId: ui.currentLayoutId ?? docs.settings.layoutOrder[0] ?? null,
    selection: null,                      // {type:'encoder'|'footswitch'|'omniport', index}
    // Inspector bind-form state. Lives here (not in the DOM) because every
    // store notify re-morphs the inspector — DOM-held open/typed state gets
    // wiped by the perf poll / live CC stream (the 2026-07-13 "can't bind a
    // performance" bug). Transient: not persisted.
    // pickerOpen/Rail/Query drive the unified add-target popover
    // (target-picker.mjs); perf/raw fields feed its panes. pickerReplace
    // ({subject, index, name} | null): a binding row was clicked — the next
    // pick REPLACES that binding's target instead of appending.
    inspForm: { perfAction: null, perfTake: null,
                rawCh: 1, rawCC: 0, scrubPos: 0,
                pickerOpen: false, pickerRail: null, pickerQuery: "",
                pickerReplace: null },
    creatingLayout: false,                // 5b generator screen shown from LAYOUTS
    // Layout pages (contract §9.4): which page each center pane shows.
    // Transient by design — every load starts on MAIN, like the hardware.
    layoutPage: "main",                   // LAYOUTS tab: main | hidden
    devicePage: "main",                   // DEVICE tab mirror: main | hidden
    deviceShiftPeek: false,               // held-shift peek on the DEVICE tab
                                          //   (mirrors holding SW2+SW3)
    // After dropping normal-page pedal content on the MAIN page: also mirror
    // it onto the hidden page? ask (prompt toast) | both | main. Persisted.
    hiddenDrop: ui.hiddenDrop ?? "ask",
    // The ⚙ customize modal's A/B flags (design_handoff_bank_switching).
    // Per-user UI prefs — persisted to localStorage, never part of the synced
    // docs (nameBars is the exception: it stays in settings.prefs).
    ui: {
      bankSwitcher: ui.bankSwitcher ?? "rail",       // rail | bar
      hiddenPageView: ui.hiddenPageView ?? "stacked", // stacked | flip
      bankNumbers: ui.bankNumbers ?? true,            // numbers on the switcher
    },
    customizeOpen: false,                 // the ⚙ customize modal (transient)
    bankPopover: false,                   // bank-switcher layout-list popover (transient)
    // LAYOUTS Sources shelf open/closed state (design_handoff_layouts_shelf_
    // restructure). Persisted UI prefs — never part of the synced docs.
    // sections: the four top-level disclosures; pedals: per-instance
    // { card, hidden, fs, dips } overrides (defaults in model.mjs
    // shelfOpenFor: card/hidden/fs open, dips closed).
    shelfOpen: {
      sections: { pedals: true, perf: true, snap: false, raw: false,
                  ...ui.shelfOpen?.sections },
      pedals: ui.shelfOpen?.pedals ?? {},
    },
    // RIG view (design_handoff_rig_restructure). Both transient — never
    // persisted, never part of docs/undo.
    modalPedalId: null,                   // pedal-reference modal, or null
    pedalEditorId: null,                  // custom-pedal editor takeover, or null
    // Device-link system pane (design_handoff_device_tab_inspector): app
    // chrome on the right edge, toggled by the header pill, persists across
    // tab switches. Only rendered while connected; the flag survives a
    // disconnect so the pane comes back on reconnect.
    linkPaneOpen: ui.linkPaneOpen ?? false,
    // DEVICE tab left "Trigger" card (2026-08-23): per-section disclosure
    // state, persisted. Trigger-only — rows fire, never drag/configure.
    deviceShelf: { snaps: true, dips: true, perf: true, ...ui.deviceShelf },
    // LENS tab UI (design_handoff_performance turn 4). All UI state lives here,
    // never in the DOM (the perf poll / live CC stream re-morphs every render).
    // Persisted subset: source / view / collapses / selectedTakeId.
    lens: {
      selectedTakeId: ui.lens?.selectedTakeId ?? null,
      view: ui.lens?.view ?? "lanes",         // lanes | table
      leftCollapsed: ui.lens?.leftCollapsed ?? false,
      rightCollapsed: ui.lens?.rightCollapsed ?? false,
      thisTakeOpen: true,                      // inspector section collapses
      monitorOpen: false,                      // MIDI monitor: collapsed at the bottom by default
      takeSearch: "",                          // left-pane take search
      takeOrder: ui.lens?.takeOrder ?? [],     // app-local list order (drag grip)
      panelOrder: ui.lens?.panelOrder ?? [],   // center pedal-panel order (drag header)
      panelCollapsed: ui.lens?.panelCollapsed ?? {}, // key → true when a panel is folded
      // Non-destructive trim / loop region (seconds) — it never rewrites the
      // take's events. `loop` mirrors the LOADED TAKE's own loop mode when a
      // device is connected (link.mjs syncs it from PERF_STATUS; it persists
      // in the take's sidecar); offline it's app-local UI intent. trimA/B:
      // null bounds → the full take.
      loop: ui.lens?.loop ?? false,
      trimA: ui.lens?.trimA ?? null,
      trimB: ui.lens?.trimB ?? null,
      // Transient pointer-drag flag (scrub | trimA | trimB), never persisted.
      drag: null,
      // Take editing (design_handoff_lens_midi_editing). Transient here — the
      // op stack itself persists to localStorage keyed `takeId#hash` (see
      // views-lens-edit.mjs) so unsaved work survives reload; everything else
      // resets on entry. The ops are NOT part of docs, so they get their own
      // in-edit undo stack (opsUndo) instead of riding store.undo().
      edit: {
        on: false,
        key: null,           // `takeId#hash` of the take being edited
        focusedLane: null,   // {ch, cc} → the 1b focused lane editor
        win: null,           // {t0, t1} zoom window (seconds); null = fit
        sel: null,           // {ch, cc, t0?, t1?, ids: []} — lane / range selection
        ops: [],             // ordered op stack (lens-model.mjs applyOps)
        opsUndo: [],         // snapshots of `ops` for in-edit ⌘Z
        rev: 0,              // bumped on every ops change (memo key)
        preview: null,       // in-flight gesture op (not yet on the stack)
        previewRev: 0,
      },
    },
    // Rolling buffer of live CC traffic for the LENS MIDI monitor, newest
    // first, capped. Fed by link.trackCC; distinct from `live` (current values
    // keyed by channel:cc) — the monitor wants a time-ordered log.
    monitorEvents: [],
    search: "",
    toast: null,                          // {msg, undoable, edit?:selection}
    undoStack: [],                        // [{label, docs-snapshot}]
    // device link (owned by link.mjs, mirrored here for rendering)
    link: {
      status: "serial" in navigator || "requestMIDIAccess" in navigator
        ? "disconnected" : "unsupported",
      transport: ui.transport ?? "midi",  // midi | serial | demo (simulated Proxi)
      name: null, fw: null,
      activeLayout: null, bankIndex: 0, gestures: {},
      perf: null,                           // recorder status (F6), polled
      manifest: loadJSON(LS.manifest, null), // last-seen device manifest
    },
    console: [],                          // [{t, line}]
    consoleOpen: false,
    live: {},                             // "channel:cc" -> value
  };

  const listeners = new Set();
  const notify = () => listeners.forEach((fn) => fn(state));

  function persistDocs() {
    localStorage.setItem(LS.rig, JSON.stringify(state.docs.rig));
    localStorage.setItem(LS.layouts, JSON.stringify(state.docs.layouts));
    localStorage.setItem(LS.settings, JSON.stringify(state.docs.settings));
    localStorage.setItem(LS.pedals, JSON.stringify(state.docs.pedals));
    localStorage.setItem(LS.snapshots, JSON.stringify(state.docs.snapshots));
  }
  function persistUI() {
    localStorage.setItem(LS.ui, JSON.stringify({
      view: state.view, currentLayoutId: state.currentLayoutId,
      transport: state.link.transport, hiddenDrop: state.hiddenDrop,
      bankSwitcher: state.ui.bankSwitcher,
      hiddenPageView: state.ui.hiddenPageView,
      bankNumbers: state.ui.bankNumbers,
      shelfOpen: state.shelfOpen,
      linkPaneOpen: state.linkPaneOpen, deviceShelf: state.deviceShelf,
      lens: {
        selectedTakeId: state.lens.selectedTakeId,
        view: state.lens.view, leftCollapsed: state.lens.leftCollapsed,
        rightCollapsed: state.lens.rightCollapsed, takeOrder: state.lens.takeOrder,
        panelOrder: state.lens.panelOrder, panelCollapsed: state.lens.panelCollapsed,
        loop: state.lens.loop, trimA: state.lens.trimA, trimB: state.lens.trimB,
      },
    }));
  }

  let toastTimer = null;

  return {
    state,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    // UI-only change (no undo, no doc persistence).
    update(fn) { fn(state); persistUI(); notify(); },

    // Doc mutation = exactly one undo step + optional toast.
    mutate(label, fn, { toast = label, undoable = true, edit = null, action = null } = {}) {
      if (undoable) {
        state.undoStack.push({ label, snapshot: structuredClone(state.docs) });
        if (state.undoStack.length > 100) state.undoStack.shift();
      }
      fn(state);
      reconcileBankOrder(state.docs);
      // an all-null hidden page reads as no hidden page — keep docs (and
      // their content hashes) clean of empty scaffolding
      for (const l of state.docs.layouts) pruneHiddenPage(l);
      persistDocs();
      if (toast) this.showToast({ msg: toast, undoable, edit, action });
      notify();
    },

    undo() {
      const step = state.undoStack.pop();
      if (!step) return;
      state.docs = step.snapshot;
      reconcileBankOrder(state.docs);
      persistDocs();
      this.showToast({ msg: `undid: ${step.label}`, undoable: false });
      notify();
    },

    showToast(toast) {
      state.toast = toast;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { state.toast = null; notify(); }, toast.ttl ?? 5000);
      notify();
    },

    log(tag, line) {
      state.console.push({ t: new Date(), line: `[${tag}] ${line}` });
      if (state.console.length > 500) state.console.shift();
      notify();
    },

    saveManifest(man) {
      state.link.manifest = man;
      localStorage.setItem(LS.manifest, JSON.stringify(man));
      notify();
    },

    currentLayout() {
      return state.docs.layouts.find((l) => l.id === state.currentLayoutId) ?? null;
    },

    addLayout(doc) {
      this.mutate(`created layout "${doc.name}"`, (s) => {
        s.docs.layouts.push(doc);
        s.currentLayoutId = doc.id;
        s.creatingLayout = false;
        s.view = "layouts";
      });
    },

    // Local delete only — if the layout is on the device, the DEVICE tab's
    // manifest diff flags it "on device only" and the next push removes it.
    deleteLayout(id) {
      const doc = state.docs.layouts.find((l) => l.id === id);
      if (!doc) return;
      this.mutate(`deleted layout "${doc.name}"`, (s) => {
        const at = s.docs.settings.layoutOrder.indexOf(id);
        s.docs.layouts = s.docs.layouts.filter((l) => l.id !== id);
        if (s.currentLayoutId === id) {
          const order = s.docs.settings.layoutOrder.filter((x) => x !== id);
          s.currentLayoutId = order[Math.min(at, order.length - 1)] ?? null;
        }
        s.selection = null;
      });
    },
  };
}

function reconcileBankOrder(docs) {
  const ids = docs.layouts.map((l) => l.id);
  const order = docs.settings.layoutOrder.filter((id) => ids.includes(id));
  for (const id of ids) if (!order.includes(id)) order.push(id);
  docs.settings.layoutOrder = order;
}

export { emptyLayout };
