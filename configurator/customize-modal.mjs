//
// customize-modal.mjs — the global ⚙ customize modal
// (design_handoff_bank_switching §2): per-user A/B flags for the beta, plus
// the device prefs that used to live under DEVICE ▸ BANKS ▸ CUSTOMIZATION
// (absorbed here wholesale). Opened by the header's ⚙ customize button on
// every tab; flags apply instantly (store update → morph re-render).
//
// All rows are app-local UI prefs (store.state.ui / hiddenDrop, localStorage)
// EXCEPT pedal labels, which is the device's settings.prefs.nameBars — a doc
// change (one undo step) pushed live to the glass when connected.
//
import { h, segmented } from "./ui.mjs";
import { nameBarsPref } from "./faceplate.mjs";

export function renderCustomizeModal(ctx) {
  const { store, linkApi } = ctx;
  if (!store.state.customizeOpen) return null;
  const close = () => store.update((s) => { s.customizeOpen = false; });
  const connected = store.state.link.status === "connected";

  // One modal row: label + note on the left, the app's segmented control on
  // the right. `value`/`set` close over the current render — morph swaps
  // listeners every render, so they never go stale.
  const row = (label, note, value, options, set) =>
    h("div.cust-row",
      h("div.cust-row-label",
        h("span.cust-label", {}, label),
        h("span.cust-note", {}, note)),
      segmented(options.map(([v, text]) => ({ value: v, label: text })),
        value, set, "cust-seg"));

  const setUI = (key) => (v) => store.update((s) => { s.ui[key] = v; });

  const nameBars = nameBarsPref(store.state.docs.settings);
  const setNameBars = async (v) => {
    store.mutate(`pedal labels → ${v === "inner" ? "between the cells" : "outer screen edges"}`, (s) => {
      (s.docs.settings.prefs ??= {}).nameBars = v;
    });
    // connected → apply to the glass right away, not on the next push
    if (linkApi.connected) {
      try { await linkApi.pushSettings(); }
      catch (err) { store.log("Sync", err.message); }
    }
  };

  return h("div.cust-veil", { onclick: close },
    h("div.cust-panel", { onclick: (e) => e.stopPropagation() },
      h("div.cust-head",
        h("span.cust-title", {}, "CUSTOMIZATION"),
        h("span.cust-sub", {}, "per user · the A/B flags for the beta"),
        h("button.cust-x", { onclick: close }, "✕")),
      row("BANK SWITCHER", "how the walk shows at the top of the plate",
        store.state.ui.bankSwitcher,
        [["rail", "walk rail"], ["bar", "footswitch bar"]],
        setUI("bankSwitcher")),
      row("HIDDEN PAGE", "stacked shows both pages at once",
        store.state.ui.hiddenPageView,
        [["stacked", "stacked below"], ["flip", "flip control"]],
        setUI("hiddenPageView")),
      row("BANK NUMBERS", "on the ◂ ▸ buttons and the bank pills",
        store.state.ui.bankNumbers,
        [[true, "show"], [false, "hide"]],
        setUI("bankNumbers")),
      row("PEDAL LABELS",
        connected
          ? "name bars on the glass — applies to the device immediately"
          : "name bars on the glass — applies to the device on the next push",
        nameBars,
        [["outer", "outer screen edges"], ["inner", "between the cells"]],
        setNameBars),
      row("DROP → HIDDEN PAGE",
        "what a MAIN-page drop does about the hidden page · ⇧-drop always updates both",
        store.state.hiddenDrop,
        [["ask", "ask each time"], ["both", "update both"], ["main", "main only"]],
        (v) => store.update((s) => { s.hiddenDrop = v; })),
      h("button.cust-done", { onclick: close }, "done")));
}
