//
// bank-switcher.mjs — the bank (= layout) switching mechanism docked at the
// top of the LAYOUTS plate card and the DEVICE live-mirror card
// (design_handoff_bank_switching, artboard 4a). Two mechanisms behind the
// ⚙ customize A/B flag (store.state.ui.bankSwitcher):
//
//   rail — every bank as a pill in footswitch-walk order; ◂ ▸ circles at the
//          outer edges mimic the physical outermost footswitches; the ✎ edit
//          button opens the layout-list popover (add / delete / reorder).
//   bar  — prev/next footswitch buttons flanking the current bank name; the
//          center label opens the same popover.
//
// Editing banks (✎, delete, add, drag-reorder — in either variant and in
// the popover) is LAYOUTS-only: on DEVICE the switcher only switches, and
// the popover is a plain pick list.
//
// Banking always WRAPS at the ends (deliberately no flag). On LAYOUTS a bank
// press switches the edited layout; on DEVICE it pushes + activates on the
// connected device (the app-side footswitch press). Switching banks resets
// the page to MAIN, matching the hardware.
//
// The hidden-page flip control (ui.hiddenPageView === "flip") rides here
// too: mini page-tabs in the rail's current pill, a two-sheet flip button in
// the bar's center. In "stacked" mode both pages are always visible below,
// so no page control renders at all.
//
// Reordering (both variants, plus the popover list) uses the RIG board's
// insertion-line drag model: a 2px accent line in the gap, drop inserts
// exactly at the line (model.mjs insertionIndex/reorderTarget — same math,
// same tests). Drag state stays out of the store; lines toggle imperatively
// and handlers resolve nodes at event time (the morph trap).
//
import { h } from "./ui.mjs";
import { manifestDiff } from "./link.mjs";
import { bankNeighbors, reorderTarget, hiddenPageUsed } from "./model.mjs";

// Drag state for bank reordering — module-scoped, never in the store (no
// re-renders mid-drag). One drag at a time across rail + popover.
let bankDrag = null; // source index in settings.layoutOrder, or null

const hideLines = (root) => {
  for (const el of root?.querySelectorAll(".bank-ins") ?? []) el.style.display = "none";
};

// A drop zone around one bank entry: two (hidden) insertion lines flanking
// `entry`. `horiz` — rail pills sit in a row, so the lines are vertical and
// "before" means the pointer's LEFT half; popover rows stack, lines are
// horizontal, "before" = top half.
function bankZone(store, i, entry, { horiz = false } = {}) {
  const before = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    return horiz ? e.clientX < r.left + r.width / 2 : e.clientY < r.top + r.height / 2;
  };
  return h(horiz ? "span.bank-zone.h" : "div.bank-zone", {
    ondragover: (e) => {
      if (bankDrag == null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const b = before(e);
      hideLines(e.currentTarget.closest(".bank-rail, .bank-pop"));
      if (reorderTarget(bankDrag, i, b) == null) return; // adjacent = no-op
      const line = e.currentTarget.querySelector(b ? '[data-ln="a"]' : '[data-ln="b"]');
      if (line) line.style.display = "block";
    },
    ondragleave: (e) => {
      if (!e.currentTarget.contains(e.relatedTarget)) hideLines(e.currentTarget);
    },
    ondrop: (e) => {
      e.preventDefault();
      hideLines(e.currentTarget.closest(".bank-rail, .bank-pop"));
      if (bankDrag == null) return;
      const from = bankDrag;
      bankDrag = null;
      const t = reorderTarget(from, i, before(e)); // post-removal splice index
      if (t == null) return;
      store.mutate("reordered banks", (s) => {
        const order = s.docs.settings.layoutOrder;
        const [moved] = order.splice(from, 1);
        order.splice(t, 0, moved);
      });
    },
  },
    h("span.bank-ins", { dataset: { ln: "a" } }),
    entry,
    h("span.bank-ins", { dataset: { ln: "b" } }));
}

// dragstart wiring shared by pills and popover rows. The dragged element
// dims a tick later so the browser captures the drag image at full opacity.
function bankDragProps(i) {
  return {
    draggable: true,
    ondragstart: (e) => {
      bankDrag = i;
      e.dataTransfer.setData("text/plain", "proxi-bank");
      e.dataTransfer.effectAllowed = "move";
      const el = e.currentTarget;
      setTimeout(() => el.classList.add("dragging"));
    },
    ondragend: (e) => {
      e.currentTarget.classList.remove("dragging");
      bankDrag = null;
      hideLines(document.querySelector(".bank-rail"));
      hideLines(document.querySelector(".bank-pop"));
    },
  };
}

// ── Shared actions ─────────────────────────────────────────────────────────

// Everything both variants need, resolved once per render.
function switcherModel(ctx, view, layout) {
  const { store, linkApi } = ctx;
  const { docs, link } = store.state;
  const order = docs.settings.layoutOrder;
  const nav = bankNeighbors(order, layout.id);
  const nameOf = (id) => docs.layouts.find((l) => l.id === id)?.name ?? id;

  const pick = (id) => {
    if (id === layout.id) return;
    if (view === "device") {
      // the app-side footswitch press: push + activate on the device;
      // page resets to MAIN like the hardware does on a bank walk
      store.update((s) => { s.devicePage = "main"; s.bankPopover = false; });
      linkApi.activate(id, ctx.pedalsById)
        .catch((err) => store.log("Sync", err.message));
    } else {
      store.update((s) => {
        s.currentLayoutId = id;
        s.selection = null;
        s.layoutPage = "main";
        s.bankPopover = false;
      });
    }
    // keep the freshly current pill visible in an overflowing rail
    if (store.state.ui.bankSwitcher !== "bar")
      requestAnimationFrame(() =>
        document.querySelector(".rail-pill.current")
          ?.scrollIntoView({ inline: "nearest", block: "nearest" }));
  };

  // Flip works on the EFFECTIVE page: on DEVICE a held ⇧ (shift-peek) shows
  // HIDDEN while devicePage still says main — the control's label shows the
  // effective page, so its click must land on the opposite of what the user
  // sees, not blindly toggle the stored value (else clicking "HIDDEN ⇄"
  // during a peek pins HIDDEN instead of returning to MAIN).
  const flip = () => store.update((s) => {
    if (view === "device") {
      const cur = s.deviceShiftPeek || s.devicePage === "hidden" ? "hidden" : "main";
      s.devicePage = cur === "hidden" ? "main" : "hidden";
      s.deviceShiftPeek = false; // an explicit flip supersedes the peek
    } else {
      s.layoutPage = s.layoutPage === "hidden" ? "main" : "hidden";
    }
  });

  const flipCtl = store.state.ui.hiddenPageView === "flip";
  // syncTag is LAZY: manifestDiff serializes + hashes every doc, and only
  // surfaces that render a sync tag should pay for it (never per-notify in
  // variants that don't show one).
  const syncTag = () => {
    if (!link.manifest) return "";
    const row = manifestDiff(docs, ctx.pedalsById, link.manifest)
      .find((r) => r.kind === "layout" && r.id === layout.id);
    return row?.status === "in-sync" ? "in sync" : "edited";
  };

  return {
    order, nav, nameOf, pick, flip, syncTag,
    // Bank/layout EDITING (reorder, delete, add, the ✎ popover trigger) is a
    // LAYOUTS-only affordance — on DEVICE the switcher only switches.
    canEdit: view === "layouts",
    active: link.activeLayout === layout.id,
    connected: link.status === "connected",
    showNums: store.state.ui.bankNumbers,
    flipCtl,
    hiddenUsed: flipCtl && hiddenPageUsed(layout), // only the flip controls read it
  };
}

// ── Layout-list popover (both variants share it) ───────────────────────────
// Rows: click switches (on DEVICE: activates), ✕ deletes (hidden when it's
// the only layout — the app always keeps one), drag reorders with insertion
// lines. Last row: + add layout → the generator on LAYOUTS. Close on pick,
// Esc (app.mjs), click-outside (the veil).

function layoutPopover(ctx, layout, m) {
  const { store } = ctx;
  const close = () => store.update((s) => { s.bankPopover = false; });

  const rows = m.order.map((id, i) => bankZone(store, i, h("div.pop-row", {
    class: id === layout.id ? "cur" : "",
    title: m.canEdit
      ? "click to switch to this bank · drag to reorder the walk"
      : "click to switch to this bank",
    ...(m.canEdit ? bankDragProps(i) : {}),
    // picking the current row is a no-op switch — still close, per design
    onclick: () => (id === layout.id ? close() : m.pick(id)),
  },
    h("span.pop-n", {}, String(i + 1)),
    h("span.pop-name", {}, m.nameOf(id)),
    id === layout.id && h("span.pop-cur", {}, "CURRENT"),
    m.canEdit && m.order.length > 1 && h("button.pop-x", {
      title: "delete layout — everywhere (⌘Z undoes it)",
      onclick: (e) => {
        e.stopPropagation();
        // the ✕ sits millimetres from the switch-to-bank row — confirm
        // before destroying a whole authored layout (Steve 2026-08-23)
        if (confirm(`Delete layout "${m.nameOf(id)}"?\n\nUndoable here (⌘Z). If it lives on the device, the next push removes it there too.`))
          store.deleteLayout(id);
      },
    }, "✕"))));

  return [
    h("div.pop-veil", { onclick: close }),
    h("div.bank-pop",
      rows,
      m.canEdit && h("button.pop-add", {
        onclick: () => store.update((s) => {
          s.bankPopover = false;
          s.creatingLayout = true;
          s.view = "layouts";
        }),
      }, "+ add layout")),
  ];
}

const popAnchor = (ctx, layout, m, trigger) =>
  h("span.bank-pop-anchor",
    trigger,
    ctx.store.state.bankPopover && layoutPopover(ctx, layout, m));

// ── Page controls (flip mode only) ─────────────────────────────────────────

// Rail current pill: two stacked mini-tabs — front = current page, back
// peeking bottom-right. Click flips. On the device: hold SW2+SW3. The back
// tab carries the violet content dot when the layout has hidden content
// (matching flipButton and the retired pageSwitcher).
function pageTabs(page, m) {
  const hidden = page === "hidden";
  return h("button.page-tabs", {
    class: hidden ? "hid" : "",
    title: "the layout's two pages — click to flip · on the device: hold SW2+SW3",
    onclick: (e) => { e.stopPropagation(); m.flip(); },
  },
    h("span.pt-back", {}, hidden ? "MAIN" : "HIDDEN",
      !hidden && m.hiddenUsed && h("span.page-dot", {
        title: "this layout has hidden-page content",
      })),
    h("span.pt-front", {}, hidden ? "HIDDEN" : "MAIN"));
}

// Bar center: a flip button with a two-sheet glyph (front solid, back
// dashed) + the violet content dot when the layout has hidden content.
function flipButton(page, m) {
  const hidden = page === "hidden";
  return h("button.flip-btn", {
    class: hidden ? "hid" : "",
    title: "flip to the other page — on the device: hold SW2+SW3",
    onclick: m.flip,
  },
    h("span.flip-glyph", h("span.fg-back"), h("span.fg-front")),
    h("span.flip-label", {}, `${hidden ? "HIDDEN" : "MAIN"} ⇄`),
    m.hiddenUsed && h("span.page-dot", {
      title: "this layout has hidden-page content",
    }));
}

// ── Walk rail ──────────────────────────────────────────────────────────────

function walkRail(ctx, view, layout, page, m) {
  const railBtn = (dir) => {
    const id = dir === "prev" ? m.nav.prevId : m.nav.nextId;
    const solo = id === layout.id;
    return h("button.rail-btn", {
      disabled: solo,
      title: dir === "prev"
        ? "bank left — on the hardware: the leftmost footswitch"
        : "bank right — on the hardware: the rightmost footswitch",
      onclick: () => m.pick(id),
    }, dir === "prev" ? "◂" : "▸");
  };

  // The removed card header carried the sync tag and ACTIVE marker — the
  // current pill keeps them (a small mono status after the name) so the
  // default variant never hides "does the device match what I'm editing".
  const status = () => {
    const tag = m.syncTag();
    const activeTag = m.active ? (view === "device" ? "ACTIVE" : "ACTIVE ON DEVICE") : "";
    if (!tag && !activeTag) return null;
    return h("span.rp-status", {},
      tag,
      activeTag && h("span.sub-active", {}, `${tag ? " · " : ""}${activeTag}`));
  };

  const pills = m.order.map((id, i) => {
    if (id === layout.id) {
      return bankZone(ctx.store, i, h("span.rail-pill.current", {
        title: m.canEdit ? "the current bank · drag to reorder the walk" : "the current bank",
        ...(m.canEdit ? bankDragProps(i) : {}),
      },
        m.showNums && h("span.rp-n", {}, String(i + 1)),
        h("span.rp-name", {}, m.nameOf(id)),
        status(),
        m.flipCtl && pageTabs(page, m)), { horiz: true });
    }
    return bankZone(ctx.store, i, h("button.rail-pill", {
      title: m.canEdit ? "jump to this bank · drag to reorder the walk" : "jump to this bank",
      ...(m.canEdit ? bankDragProps(i) : {}),
      onclick: () => m.pick(id),
    },
      m.showNums && h("span.rp-n", {}, `${i + 1} · `),
      m.nameOf(id)), { horiz: true });
  });

  return h("div.bank-rail",
    railBtn("prev"),
    // ✎ sits between the pills and ▸ — this mirror-width spacer keeps the
    // centered pill row on the card's true centerline
    m.canEdit && h("span.rail-balance"),
    h("div.rail-pills", h("div.rail-pills-inner", pills)),
    m.canEdit && popAnchor(ctx, layout, m, h("button.rail-edit", {
      class: ctx.store.state.bankPopover ? "on" : "",
      title: "edit banks — add · delete · reorder",
      onclick: () => ctx.store.update((s) => { s.bankPopover = !s.bankPopover; }),
    }, "✎")),
    railBtn("next"));
}

// ── Footswitch bar ─────────────────────────────────────────────────────────

function footswitchBar(ctx, view, layout, page, m) {
  const { store } = ctx;
  const stepBtn = (dir) => {
    const [id, num] = dir === "prev"
      ? [m.nav.prevId, m.nav.prevN] : [m.nav.nextId, m.nav.nextN];
    const solo = id === layout.id;
    const glyph = h("span.bar-fs", {}, dir === "prev" ? "◂" : "▸");
    const label = h("span.bar-step-label",
      m.showNums && h("span.bar-eyebrow", {}, `BANK ${num}`),
      h("span.bar-step-name", {}, m.nameOf(id)));
    return h("button.bar-step", {
      class: dir,
      disabled: solo,
      title: dir === "prev"
        ? "bank left — on the hardware: the leftmost footswitch"
        : "bank right — on the hardware: the rightmost footswitch",
      onclick: () => m.pick(id),
    }, dir === "prev" ? [glyph, label] : [label, glyph]);
  };

  const tag = m.syncTag();
  const sub = h("span.bar-sub", {},
    `bank ${m.nav.n} of ${m.nav.count}${tag ? ` · ${tag}` : ""}`,
    view === "device" && m.active && h("span.sub-active", {}, " · ACTIVE ON DEVICE"),
    view === "layouts" && m.active && h("span.sub-active", {}, " · ACTIVE"));

  const center = popAnchor(ctx, layout, m, h("button.bar-cur", {
    title: "click for the layout list",
    onclick: () => store.update((s) => { s.bankPopover = !s.bankPopover; }),
  },
    h("span.bar-cur-row",
      h("span.bar-cur-name", {}, layout.name),
      h("span.bar-caret", {}, "▾")),
    sub));

  return h("div.bank-bar",
    stepBtn("prev"),
    h("div.bar-center", center, m.flipCtl && flipButton(page, m)),
    stepBtn("next"));
}

// ── Entry ──────────────────────────────────────────────────────────────────
// view: "layouts" | "device" — which surface the switcher drives.
// page: the page the single plate currently shows (flip mode); ignored in
// stacked mode (no page control renders).
export function renderBankSwitcher(ctx, { view, layout, page }) {
  const m = switcherModel(ctx, view, layout);
  if (!m.nav) return null;
  return ctx.store.state.ui.bankSwitcher === "bar"
    ? footswitchBar(ctx, view, layout, page, m)
    : walkRail(ctx, view, layout, page, m);
}
