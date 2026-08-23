//
// app.mjs — Proxi web configurator (contract v2). Root render: header with
// the four view tabs (LAYOUTS is home; RIG absorbed the old LIBRARY tab),
// the ⚙ customize button (global A/B-flag modal —
// design_handoff_bank_switching), the connection pill (carries the
// pending-push count and toggles the device-link pane —
// design_handoff_device_tab_inspector), toasts, ⌘Z undo.
//
// Vanilla ES modules, no build step, no dependencies — the same constraints
// as the PoC this replaces (see README).
//
import { h, morphChildren, captureFocus, restoreFocus } from "./ui.mjs";
import { createStore } from "./store.mjs";
import { createLink, manifestDiff, pendingCount } from "./link.mjs";
import { renderLayoutsView } from "./views-layouts.mjs";
import { renderRigView } from "./views-rig.mjs";
import { renderDeviceView, renderLinkPane } from "./views-device.mjs";
import { renderLensView } from "./views-lens.mjs";
import { lensEditUndo } from "./views-lens-edit.mjs";
import { renderCustomizeModal } from "./customize-modal.mjs";

const library = await fetch("../pedal-library/pedal-library.json").then((r) => {
  if (!r.ok) throw new Error(`pedal-library.json: HTTP ${r.status}`);
  return r.json();
});
const libraryById = Object.fromEntries(library.pedals.map((p) => [p.id, p]));

const store = createStore();
const linkApi = createLink(store);
// ctx.pedalsById = library + the user's custom pedals; rebuilt every render
// (custom pedals are authored docs and change under ⌘Z like everything else).
const ctx = { store, linkApi, library, pedalsById: libraryById };
const refreshPedalsById = () => {
  ctx.pedalsById = {
    ...libraryById,
    ...Object.fromEntries(store.state.docs.pedals.map((p) => [p.id, p])),
  };
};

const VIEWS = {
  rig: renderRigView,
  layouts: renderLayoutsView,
  device: renderDeviceView,
  lens: renderLensView,
};

// ── Header ─────────────────────────────────────────────────────────────────

function header() {
  const { state } = store;
  const pending = pendingCount(manifestDiff(state.docs, ctx.pedalsById, state.link.manifest));
  const connected = state.link.status === "connected";

  // The pending count lives in the pill now (device_tab_inspector handoff);
  // the old DEVICE tab badge is gone.
  const tab = (id, label) => h("button.tab", {
    class: state.view === id ? "on" : "",
    // a bank popover left open must not reappear on the next tab's switcher
    onclick: () => store.update((s) => { s.view = id; s.bankPopover = false; }),
  }, label);

  // When connected, the pill mirrors the device transport (● REC green pulse /
  // ▶ PLAY amber / connected) so the live take's master reads at a glance.
  const perfState = state.link.perf?.state;
  const connectedPill = perfState === "rec" || perfState === "overdub"
    ? { dot: "#8fd4af", cls: "green", text: "Proxi · ● REC" }
    : perfState === "play"
    ? { dot: "#d9a544", cls: "amber", text: "Proxi · ▶ PLAY" }
    : { dot: "#5fbf8f", cls: "green", text: `${
        state.link.transport === "midi" ? "Web MIDI"
        : state.link.transport === "demo" ? "Demo device" : "Web Serial"} · connected` };
  const pillStates = {
    connected: connectedPill,
    connecting: { dot: "#d9a544", cls: "amber", text: "connecting…" },
    disconnected: { dot: "#4a4d53", cls: "", text: "no device — that's fine for now" },
    unsupported: { dot: "#d9a544", cls: "amber", text: "this browser can't connect" },
  };
  const p = pillStates[state.link.status];
  const countSeg = connected && pending > 0
    && h("span.pill-count", {}, `${pending} to push`);
  const togglePane = () => store.update((s) => { s.linkPaneOpen = !s.linkPaneOpen; });

  // Connected: the pill toggles the device-link pane. Open, it swells into a
  // fused header segment — exactly the pane's width, no seam (the pane's
  // header). Not connected: it stays a shortcut to the DEVICE tab (where the
  // connect card lives).
  const pill = connected && state.linkPaneOpen
    ? h("button.link-seg", {
        title: "click to close — collapses back into the pill",
        onclick: togglePane,
      },
        h("span.dot", { style: { background: p.dot } }),
        h("span.link-seg-text", {}, p.text),
        countSeg,
        h("span.link-seg-caret", {}, "▴"))
    : h("button.conn-pill", {
        class: p.cls,
        title: connected ? "device link — click for sync + backup"
          : "device link — click for the DEVICE tab",
        onclick: connected ? togglePane
          : () => store.update((s) => { s.view = "device"; }),
      },
        h("span.dot", { style: { background: p.dot } }),
        p.text,
        countSeg,
        connected && h("span.pill-caret", {}, "▾"));

  // ⚙ customize — right-aligned, immediately left of the connection pill;
  // opens the global customization modal (design_handoff_bank_switching §1)
  const customize = h("button.customize-btn", {
    title: "per-user customization — bank switcher, hidden page, labels",
    onclick: () => store.update((s) => { s.customizeOpen = true; }),
  }, "⚙ customize");

  return h("header.topbar",
    h("div.wordmark", h("span.wm-proxi", {}, "PROXI"), h("span.wm-sub", {}, "CONFIGURATOR")),
    h("nav.tabs", tab("rig", "RIG"), tab("layouts", "LAYOUTS"), tab("device", "DEVICE"), tab("lens", "LENS")),
    customize,
    pill);
}

function toast() {
  const t = store.state.toast;
  if (!t) return null;
  return h("div.toast",
    h("span.toast-msg", {}, t.msg),
    // multi-action prompt toasts (e.g. "also update the HIDDEN page?"):
    // each action runs its own store call (a mutate = its own undo step)
    t.actions?.map((a) => h("button.toast-btn", {
      onclick: () => { store.update((s) => { s.toast = null; }); a.run(); },
    }, a.label)),
    t.action && h("button.toast-btn", {
      onclick: () => store.update((s) => { t.action.apply(s); s.toast = null; }),
    }, t.action.label),
    t.edit && h("button.toast-btn", {
      onclick: () => store.update((s) => { s.selection = t.edit; s.toast = null; s.view = "layouts"; }),
    }, "edit"),
    t.undoable && h("button.toast-btn", {
      onclick: () => { store.undo(); },
    }, "undo"));
}

// ── Render loop ────────────────────────────────────────────────────────────

const root = document.getElementById("app");

function render() {
  refreshPedalsById();
  const focus = captureFocus();
  // Morph instead of replaceChildren: unchanged nodes keep their identity, so
  // a render never resets the cursor/hover/scroll under the pointer. The
  // data-key on .view forces a wholesale swap (fresh scroll) on tab switch.
  morphChildren(root, [
    header(),
    // The device-link pane is app chrome: a sibling of .view inside the body
    // row, so it survives tab switches (only .view carries the swap key).
    h("div.app-body",
      h("div.view", { class: `view-${store.state.view}`, dataset: { key: store.state.view } },
        VIEWS[store.state.view](ctx)),
      renderLinkPane(ctx)),
    renderCustomizeModal(ctx),
    toast(),
  ].filter(Boolean));
  restoreFocus(focus);
}

store.subscribe(render);
render();

// ⌘Z / Ctrl+Z — every doc mutation is exactly one undo step. While the LENS
// take editor is active its op stack takes the shortcut instead (ops aren't
// docs; each completed gesture is one in-edit step).
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "z") {
    const el = document.activeElement;
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA") && el.type !== "range") return;
    e.preventDefault();
    if (store.state.view === "lens" && lensEditUndo(store)) return;
    store.undo();
  }
});

// Escape closes overlays outermost-first: the ⚙ customize modal, the
// bank-switcher popover, the RIG pedal-reference modal, then the
// custom-pedal editor takeover (edits are committed live, so closing loses
// nothing).
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (store.state.customizeOpen) { store.update((s) => { s.customizeOpen = false; }); return; }
  if (store.state.bankPopover) { store.update((s) => { s.bankPopover = false; }); return; }
  if (store.state.modalPedalId) { store.update((s) => { s.modalPedalId = null; }); return; }
  if (!store.state.pedalEditorId || store.state.view !== "rig") return;
  const el = document.activeElement;
  // Escape inside a field means "leave the field", not "leave the editor"
  if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) { el.blur(); return; }
  store.update((s) => { s.pedalEditorId = null; });
});

// Held shift on the DEVICE tab peeks the hidden page (the app-side SW2+SW3
// hold); release — or losing the window — returns to MAIN. Ignored while
// typing (shift is how capitals happen), and inert in stacked hidden-page
// view (both pages are already visible — don't re-render per keystroke).
document.addEventListener("keydown", (e) => {
  if (e.key !== "Shift" || store.state.view !== "device" || store.state.deviceShiftPeek) return;
  if (store.state.ui.hiddenPageView === "stacked") return;
  const el = document.activeElement;
  if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
  store.update((s) => { s.deviceShiftPeek = true; });
});
document.addEventListener("keyup", (e) => {
  if (e.key === "Shift" && store.state.deviceShiftPeek)
    store.update((s) => { s.deviceShiftPeek = false; });
});
window.addEventListener("blur", () => {
  if (store.state.deviceShiftPeek) store.update((s) => { s.deviceShiftPeek = false; });
});

// Serial unplug → clean disconnect.
if ("serial" in navigator) {
  navigator.serial.addEventListener("disconnect", () => {
    if (store.state.link.status === "connected" && store.state.link.transport === "serial")
      linkApi.disconnect();
  });
}

store.log("Config", `pedal library loaded: ${library.pedals.length} pedals (format v${library.formatVersion})`);

// Dev handle for console poking / UI tests. Not an API.
window.__proxi = { store, link: linkApi, library };
