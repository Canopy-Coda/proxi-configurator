//
// views-rig.mjs — the RIG view (design_handoff_rig_restructure, option 3a
// "pedalboard center stage"): three cards on the dark canvas — Library
// (left: compact nav + search; click = full-reference modal, drag = add),
// Pedalboard (center: the chain, the primary focus), Omniports (right: what's
// plugged into the Proxi's two TRS jacks). The read-only pedal reference
// lives in a modal; the custom-pedal editor takes over the whole view.
//
import { h } from "./ui.mjs";
import { uniqueId, controlPositions, layoutBindsInstance, layoutAllBindings,
         insertionIndex, reorderTarget } from "./model.mjs";
import { renderPedalEditor, createCustomPedal } from "./pedal-editor.mjs";
import { applySnapshot } from "./views-device.mjs";

const CATEGORY = { // short descriptors (drag-ghost sub text)
  "cb-billyStringsWombtone": "phaser", "cb-blooper": "looper", "cb-brothersAM": "gain",
  "cb-clean": "preamp", "cb-condorHiFi": "filter/EQ", "cb-darkWorld": "reverb",
  "cb-generationLossMk2": "lo-fi", "cb-gravitas": "tremolo", "cb-habit": "echo",
  "cb-lossy": "lo-fi", "cb-lostAndFound": "delay/verb", "cb-moodMk1": "micro-looper",
  "cb-moodMk2": "micro-looper", "cb-onward": "sustain", "cb-reverseModeC": "reverse delay",
  "cb-thermae": "pitch delay", "cb-warpedVinylHiFi": "vibrato",
};

function nextFreeChannel(rig) {
  const used = new Set(rig.instances.map((i) => i.midiChannel));
  for (let ch = 1; ch <= 16; ch++) if (!used.has(ch)) return ch;
  return 16;
}

// One undo step + toast; `at` inserts at a chain position (drag between rows).
function addToRig(store, pedal, at = null) {
  const rig = store.state.docs.rig;
  const base = pedal.id.replace(/^cb-/, "").toLowerCase();
  const id = uniqueId(base, rig.instances.map((i) => i.instanceId));
  store.mutate(`added ${pedal.name} to the board (ch ${nextFreeChannel(rig)})`, (s) => {
    const inst = { instanceId: id, pedalId: pedal.id, midiChannel: nextFreeChannel(s.docs.rig) };
    at == null ? s.docs.rig.instances.push(inst) : s.docs.rig.instances.splice(at, 0, inst);
  });
}

// How many layouts reference an instance (for the "in N layouts" note) —
// hidden-page and aux-pair bindings count too (model.mjs layoutAllBindings).
function layoutUses(layouts, instanceId) {
  return layouts.filter((l) => layoutBindsInstance(l, instanceId)).length;
}

const usesNote = (uses) => uses
  ? `in ${uses} layout${uses === 1 ? "" : "s"}` : "not placed in any layout yet";

const removeInstance = (store, inst, idx) =>
  store.mutate(`removed ${inst.instanceId} from the board`, (s) => {
    s.docs.rig.instances.splice(idx, 1);
  });

// ── Drag state (outside the store: no re-renders mid-drag, same rule as
//    views-layouts.mjs — HTML5 DnD breaks if the target is replaced) ────────

let dragIdx = null;  // rig-row reorder
let libDrag = null;  // { pedal } — nav item → board drag-to-add
let ghostEl = null;
// The LIVE view root, captured from the drag event — morphChildren keeps the
// mounted nodes and discards each render's fresh tree, so closure-captured
// elements may be detached; e.target/e.currentTarget are always live.
let viewEl = null;

// Compact cursor pill as the drag image (library adds AND row reorders) —
// the browser's default full-row snapshot would blanket the row gaps and
// hide the insertion lines.
function setGhost(e, content, effect = "copy") {
  ghostEl?.remove();
  ghostEl = h("div.drag-ghost", {}, content);
  document.body.append(ghostEl);
  e.dataTransfer.setDragImage(ghostEl, 18, 14);
  e.dataTransfer.setData("text/plain", "proxi");
  e.dataTransfer.effectAllowed = effect;
}

// Hide every insertion line under `root` (a live node from the event).
function hideLines(root) {
  for (const el of root?.querySelectorAll(".ins-line") ?? []) el.style.display = "none";
}

function endLibDrag() {
  libDrag = null;
  ghostEl?.remove(); ghostEl = null;
  hideLines(viewEl);
}

// ── Pedalboard (center card) ───────────────────────────────────────────────
// The drag model (handoff turn 2, absorbed by 3a): a 2px accent insertion
// line in the 8px gap between rows — above the hovered row when the pointer
// is in its top half, below otherwise; the drop inserts exactly at the line.
// The dragged row dims; a line never shows adjacent to it (drop = no-op).

function pointerBefore(e) {
  const r = e.currentTarget.getBoundingClientRect();
  return e.clientY < r.top + r.height / 2;
}

// Chase Bliss pedals learn their MIDI channel at power-on: booted with both
// footswitches held, the pedal adopts the channel of the first MIDI message
// it receives. The button sends PC 0 on the row's channel; the firmware
// forwards USB PC out the DIN jack, so it only works over the MIDI transport
// with a real Proxi on the wire.
const PC_HOWTO = "Set the pedal's MIDI channel: hold BOTH footswitches while "
  + "powering the pedal on, then click this button — the pedal adopts the "
  + "channel of the first MIDI message it hears (we send PC 0).";

function pcSendButton(inst, ctx) {
  const { store, linkApi } = ctx;
  const { status, transport } = store.state.link;
  const ready = status === "connected" && transport === "midi";
  return h("button.ghost-btn.sm.pc-set", {
    disabled: !ready,
    title: ready
      ? `${PC_HOWTO} Sends on ch ${inst.midiChannel}.`
      : `${PC_HOWTO} ${status !== "connected"
          ? "Disabled: connect your Proxi (DEVICE tab) first."
          : "Disabled: PC only reaches the pedal over the MIDI transport — reconnect via Web MIDI."}`,
    onclick: () => {
      linkApi.sendPC(inst.midiChannel, 0);
      store.showToast({
        msg: `PC 0 → ch ${inst.midiChannel} sent — ${inst.instanceId} keeps that channel if it was listening`,
        undoable: false,
      });
    },
  }, "SET PEDAL CH");
}

function instanceRow(inst, idx, ctx) {
  const { store, pedalsById } = ctx;
  const pedal = pedalsById[inst.pedalId];
  const uses = layoutUses(store.state.docs.layouts, inst.instanceId);
  // Clamp to 1–16, mutate only on a real change (no empty undo steps at the
  // rails), and return the clamped value so callers can normalize the field.
  const setCh = (ch) => {
    const v = Math.max(1, Math.min(16, ch));
    if (v !== inst.midiChannel) store.mutate(`${inst.instanceId} → ch ${v}`, (s) => {
      s.docs.rig.instances[idx].midiChannel = v;
    }, { toast: null });
    return v;
  };

  return h("div.rig-row", {
    draggable: true,
    ondragstart: (e) => {
      dragIdx = idx;
      viewEl = e.target.closest(".rig3");
      setGhost(e, [h("b", {}, inst.instanceId),
        h("span.ghost-sub", {}, ` ch ${inst.midiChannel} · drop on a line`)], "move");
      // dim one tick later so the drag image is captured at full opacity;
      // the node is live (morph never runs mid-drag)
      const el = e.currentTarget;
      setTimeout(() => el.classList.add("dragging"));
    },
    ondragend: (e) => {
      e.currentTarget.classList.remove("dragging");
      dragIdx = null;
      ghostEl?.remove(); ghostEl = null;
      hideLines(viewEl);
      viewEl?.querySelector(".rl-library")?.classList.remove("remove-hot");
    },
  },
    h("span.grip", {}, "⋮⋮"),
    h("div.rig-spine", { style: { background: pedal?.backgroundColor ?? "#33373d" } }),
    h("div.rig-main",
      h("div.rig-names",
        h("input.inst-name", {
          value: inst.instanceId, dataset: { focusKey: `inst-${idx}` }, maxLength: 32,
          // size to content — a fixed width would crowd the stepper
          style: { width: `${Math.min(Math.max(inst.instanceId.length, 4) + 1, 22)}ch` },
          title: "instance name — how layouts refer to this pedal",
          onchange: (e) => {
            const raw = e.target.value;
            store.mutate(`renamed ${inst.instanceId}`, (s) => {
              const others = s.docs.rig.instances.filter((_, i) => i !== idx).map((i) => i.instanceId);
              const newId = uniqueId(raw, others);
              const oldId = s.docs.rig.instances[idx].instanceId;
              s.docs.rig.instances[idx].instanceId = newId;
              // keep every layout's references intact — hidden page and aux
              // sub-cells included (layoutAllBindings walks them all)
              for (const l of s.docs.layouts)
                for (const b of layoutAllBindings(l))
                  if (b.target?.instance === oldId) b.target.instance = newId;
            });
          },
        }),
        h("span.rig-pedal-name", {}, pedal?.name ?? inst.pedalId)),
      h("div.rig-note", { class: uses ? "" : "amber" }, usesNote(uses))),
    // a <label> so clicking "MIDI Channel:" (or the padding) focuses the
    // input; clicks on the nested ▲▼ buttons don't forward (per spec)
    h("label.ch-stepper",
      h("span.ch-label", {}, "MIDI Channel:"),
      h("input.ch-input", {
        value: String(inst.midiChannel), inputMode: "numeric", maxLength: 2,
        dataset: { focusKey: `ch-${idx}` },
        title: "MIDI channel 1–16",
        // digits only while typing; clamp + commit on change (blur/Enter)
        oninput: (e) => { e.target.value = e.target.value.replace(/\D/g, "").slice(0, 2); },
        onchange: (e) => {
          const n = parseInt(e.target.value, 10);
          // normalize even when the store no-ops ("007", "99", garbage)
          e.target.value = String(Number.isNaN(n) ? inst.midiChannel : setCh(n));
        },
        onkeydown: (e) => {
          if (e.key === "ArrowUp") { e.preventDefault(); setCh(inst.midiChannel + 1); }
          else if (e.key === "ArrowDown") { e.preventDefault(); setCh(inst.midiChannel - 1); }
          else if (e.key === "Enter") e.target.blur();
        },
      }),
      h("span.ch-btns",
        h("button.ch-btn", { title: "channel up", onclick: () => setCh(inst.midiChannel + 1) }, "▲"),
        h("button.ch-btn", { title: "channel down", onclick: () => setCh(inst.midiChannel - 1) }, "▼"))),
    pcSendButton(inst, ctx),
    h("button.icon-btn", {
      title: "remove from board",
      onclick: () => removeInstance(store, inst, idx),
    }, "✕"));
}

// A row plus its two (hidden) insertion lines. Line visibility is toggled
// imperatively in the handlers — drag state stays out of the store, and the
// lines self-heal because every handler resolves nodes at event time.
function rowZone(inst, idx, ctx) {
  const { store } = ctx;
  return h("div.row-zone", {
    ondragover: (e) => {
      if (dragIdx == null && !libDrag) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = libDrag ? "copy" : "move";
      const before = pointerBefore(e);
      hideLines(e.currentTarget.closest(".rl-rig-body"));
      // no-op suppression: never a line adjacent to the dragged row itself
      if (dragIdx != null && reorderTarget(dragIdx, idx, before) == null) return;
      const line = e.currentTarget.querySelector(before ? '[data-ln="t"]' : '[data-ln="b"]');
      if (line) line.style.display = "block";
    },
    ondragleave: (e) => {
      if (e.currentTarget.contains(e.relatedTarget)) return;
      hideLines(e.currentTarget);
    },
    ondrop: (e) => {
      e.preventDefault();
      const before = pointerBefore(e);
      hideLines(e.currentTarget.closest(".rl-rig-body"));
      if (libDrag) {
        addToRig(store, libDrag.pedal, insertionIndex(idx, before));
        endLibDrag();
        return;
      }
      if (dragIdx == null) return;
      const target = reorderTarget(dragIdx, idx, before);
      if (target != null) store.mutate("reordered the board (chain order)", (s) => {
        const [moved] = s.docs.rig.instances.splice(dragIdx, 1);
        s.docs.rig.instances.splice(target, 0, moved);
      });
      dragIdx = null;
    },
  },
    h("div.ins-line", { dataset: { ln: "t" } }),
    instanceRow(inst, idx, ctx),
    h("div.ins-line", { dataset: { ln: "b" } }));
}

const SLOT_IDLE = "⇢ drag a pedal from the library to add it here";

function dropSlot(ctx) {
  const { store } = ctx;
  return h("div.rig-drop-slot", {
    ondragover: (e) => {
      if (!libDrag) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      e.currentTarget.classList.add("hot");
      e.currentTarget.textContent = `⇣ DROP TO ADD — gets ch ${nextFreeChannel(store.state.docs.rig)}`;
    },
    ondragleave: (e) => {
      e.currentTarget.classList.remove("hot");
      e.currentTarget.textContent = SLOT_IDLE;
    },
    ondrop: (e) => {
      if (!libDrag) return;
      e.preventDefault();
      addToRig(store, libDrag.pedal); // drop at end = append
      endLibDrag();
    },
  }, SLOT_IDLE);
}

function boardCard(ctx) {
  const { store } = ctx;
  const rig = store.state.docs.rig;
  return h("section.rl-card.rl-board",
    h("div.rl-head",
      h("h2.pane-title", {}, "Pedalboard"),
      h("span.pane-sub", {},
        `${rig.instances.length} pedal${rig.instances.length === 1 ? "" : "s"} · order = chain order`),
      h("span.rl-head-hint", {}, "rename an instance and every layout follows")),
    h("div.rl-rig-body",
      rig.instances.length
        ? h("div.rig-rows", rig.instances.map((inst, i) => rowZone(inst, i, ctx)))
        : h("div.firstrun-card",
            h("span.insp-title", {}, "FIRST RUN?"),
            h("span.firstrun-body", {}, "Add pedals from the library at left — each gets a MIDI channel. Then head to ",
              h("b", {}, "LAYOUTS"), " — presets give you a working surface in one click.")),
      dropSlot(ctx),
      h("div.pane-footnote", {},
        "order = chain order · drag rows to reorder · drop a row on the library to remove it")));
}

// ── Library (left card) ────────────────────────────────────────────────────

const NAV_TIP = "click = full reference · drag to place · + adds to the end";

function libraryCard(ctx, rigCounts) {
  const { store, library } = ctx;
  const customs = store.state.docs.pedals;
  const q = store.state.search.toLowerCase();
  const match = (p) => !q || p.name.toLowerCase().includes(q);

  // A wrapper div (not a button — the + would nest interactive-in-interactive)
  // holding the main click/drag surface and the append button.
  const navItem = (p, isCustomPedal = false) => {
    const count = rigCounts[p.id] ?? 0;
    return h("div.lib-nav-item", {
      draggable: true,
      ondragstart: (e) => {
        libDrag = { pedal: p };
        setGhost(e, [h("b", {}, p.name), h("span.ghost-sub", {},
          ` ${isCustomPedal ? "custom" : CATEGORY[p.id] ?? "pedal"} · drop to add (ch ${nextFreeChannel(store.state.docs.rig)})`)]);
        viewEl = e.target.closest(".rig3");
        document.addEventListener("dragend", endLibDrag, { once: true });
      },
    },
      h("button.lib-nav-main", {
        title: NAV_TIP,
        // selection is momentary — clicking opens the reference modal
        onclick: () => store.update((s) => { s.modalPedalId = p.id; }),
      },
        h("span.lib-nav-name", {}, p.name),
        count > 0 && h("span.lib-nav-mark", {}, count > 1 ? `✓×${count}` : "✓")),
      h("button.lib-nav-add", {
        title: `add ${p.name} to the end of the board (ch ${nextFreeChannel(store.state.docs.rig)})`,
        onclick: () => addToRig(store, p),
      }, "+"));
  };

  // While a ROW drag is in flight the whole card is a remove zone (drop =
  // take the instance off the board). Class + veil are toggled imperatively,
  // like the insertion lines — drag state never touches the store.
  return h("section.rl-card.rl-library", {
    ondragover: (e) => {
      if (dragIdx == null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      e.currentTarget.classList.add("remove-hot");
    },
    ondragleave: (e) => {
      if (e.currentTarget.contains(e.relatedTarget)) return;
      e.currentTarget.classList.remove("remove-hot");
    },
    ondrop: (e) => {
      if (dragIdx == null) return;
      e.preventDefault();
      e.currentTarget.classList.remove("remove-hot");
      const inst = store.state.docs.rig.instances[dragIdx];
      if (inst) removeInstance(store, inst, dragIdx);
      dragIdx = null;
    },
  },
    h("div.remove-veil", {}, "⇣ DROP TO REMOVE FROM THE BOARD"),
    h("div.rl-head",
      h("h2.pane-title", {}, "Library"),
      h("span.pane-sub", {},
        `${library.pedals.length} models${customs.length ? ` + ${customs.length} yours` : ""}`)),
    h("div.lib-search-row",
      h("input.search", {
        placeholder: "⌕ search pedals…", value: store.state.search,
        dataset: { focusKey: "search" },
        oninput: (e) => store.update((s) => { s.search = e.target.value; }),
      })),
    h("nav.lib-nav",
      h("div.lib-nav-sep", {}, "YOUR PEDALS"),
      customs.filter(match).map((p) => navItem(p, true)),
      h("button.lib-nav-item.lib-nav-new", {
        onclick: () => createCustomPedal(ctx),
      }, "+ new pedal"),
      h("div.lib-nav-sep", {}, "CHASE BLISS"),
      library.pedals.filter(match).map((p) => navItem(p))),
    h("div.card-footnote", {}, NAV_TIP));
}

// ── Omniports (right card) ─────────────────────────────────────────────────
// Configures what's plugged into each TRS jack; where the ports are BOUND
// stays in LAYOUTS. Data model unchanged: rig.omniports[i].mode.

const OMNI_MODES = [
  ["expression", "Expression pedal", "heel→toe CC sweeps"],
  ["aux", "Aux switches", "a pair — one TRS jack carries two"],
  ["unused", "Nothing plugged in", "port is ignored"],
];

function omniGroup(i, ctx) {
  const { store } = ctx;
  const mode = store.state.docs.rig.omniports?.[i]?.mode ?? "unused";
  return h("div.omni-group",
    h("div.omni-group-head",
      h("span.omni-port-id", {}, `PORT ${i + 1}`),
      h("span.omni-port-sub", {}, "what's plugged in")),
    OMNI_MODES.map(([v, label, desc]) => h("button.omni-opt", {
      class: v === mode ? "on" : "",
      onclick: () => v !== mode && store.mutate(`omniport ${i + 1} → ${v}`, (s) => {
        s.docs.rig.omniports[i] = { mode: v };
      }),
    },
      h("span.omni-opt-dot"),
      h("span.omni-opt-text",
        h("span.omni-opt-label", {}, label),
        h("span.omni-opt-desc", {}, desc)))));
}

function omniportsCard(ctx) {
  return h("section.rl-card.rl-omni",
    h("div.rl-head",
      h("h2.pane-title", {}, "Omniports"),
      h("span.pane-sub", {}, "TRS jacks on your Proxi")),
    h("div.omni-body",
      omniGroup(0, ctx), omniGroup(1, ctx),
      h("div.pane-footnote.omni-footnote", {},
        "what each port controls is bound per layout — head to LAYOUTS to map expression sweeps and aux switches")));
}

// ── Pedal-reference modal ──────────────────────────────────────────────────
// The full read-only reference (the old detail pane's content), opened by
// clicking a library nav item. Escape / backdrop / ✕ close it.

// Delete a custom pedal (modal head, next to "edit" — the one delete path;
// the editor keeps only "duplicate"). Blocked while the board uses it —
// deleting under a rig instance would break every layout binding through
// it. Confirmed, then one undoable step; the modal closes with its pedal.
function deleteCustomButton(ctx, pedal) {
  const { store } = ctx;
  const usedBy = store.state.docs.rig.instances.filter((i) => i.pedalId === pedal.id);
  return h("button.ghost-btn.sm.danger", {
    disabled: usedBy.length > 0,
    title: usedBy.length
      ? `on your pedalboard as ${usedBy.map((i) => i.instanceId).join(", ")} — remove it there first`
      : "delete this pedal from YOUR PEDALS (undoable — ⌘Z)",
    onclick: () => {
      if (!confirm(`Delete "${pedal.name}"?\n\nUndoable here (⌘Z). Library pedals aren't affected — this only removes your custom pedal.`))
        return;
      store.mutate(`deleted pedal "${pedal.name}"`, (s) => {
        s.docs.pedals = s.docs.pedals.filter((p) => p.id !== pedal.id);
        if (s.modalPedalId === pedal.id) s.modalPedalId = null;
        if (s.pedalEditorId === pedal.id) s.pedalEditorId = null;
      });
    },
  }, "delete");
}

// IN YOUR PEDALBOARD — this pedal's instances + add/remove.
function inBoardCard(ctx, pedal) {
  const { store } = ctx;
  const rig = store.state.docs.rig;
  const insts = rig.instances
    .map((inst, idx) => ({ inst, idx }))
    .filter(({ inst }) => inst.pedalId === pedal.id);
  return h("div.inrig-card",
    h("div.inrig-head",
      h("span.insp-title", {}, "IN YOUR PEDALBOARD"),
      h("span.inrig-hint", {}, "this pedal's instances — the full board lives behind this modal")),
    insts.map(({ inst, idx }) => {
      const uses = layoutUses(store.state.docs.layouts, inst.instanceId);
      return h("div.inrig-row",
        h("div.rig-spine", { style: { background: pedal.backgroundColor } }),
        h("span.inrig-name", {}, inst.instanceId),
        h("span.rig-note", { class: uses ? "" : "amber" }, usesNote(uses)),
        h("div.inrig-ch",
          h("span.ch-label", {}, "ch"),
          h("span.ch-num", {}, String(inst.midiChannel))),
        h("button.remove-btn", {
          onclick: () => removeInstance(store, inst, idx),
        }, "− remove"));
    }),
    h("div.inrig-add-row",
      h("button.inrig-add", { onclick: () => addToRig(store, pedal) },
        insts.length ? "+ ADD ANOTHER" : "+ ADD TO PEDALBOARD"),
      h("span.inrig-hint", {}, `gets the next free channel (ch ${nextFreeChannel(rig)})`)));
}

// Snapshot rows — apply buttons appear per board instance (a snapshot needs
// a channel); otherwise a hint.
function snapshotSection(ctx, pedal) {
  if (!pedal.snapshots?.length) return null;
  const insts = ctx.store.state.docs.rig.instances.filter((i) => i.pedalId === pedal.id);
  return h("div.lib-page",
    h("span.insp-title", {}, "SNAPSHOTS"),
    pedal.snapshots.map((snap) => h("div.lib-snap",
      h("div.lib-snap-main",
        h("span.lib-snap-name", {}, snap.name),
        snap.source && h("span.lib-snap-src", {}, snap.source),
        h("span.libenc-cc", {}, `${Object.keys(snap.values).length} values`)),
      insts.length
        ? h("span.lib-snap-btns", insts.map((inst) => h("button.ghost-btn.sm", {
            onclick: () => applySnapshot(ctx, inst, pedal, snap),
          }, `apply → ${inst.instanceId}`)))
        : h("span.libenc-cc", {}, "add to your pedalboard to apply"))));
}

function encoderCard(e, pedal) {
  if (e.type === "inactive") return h("div.libenc.inactive", {}, "—");
  const card = h("div.libenc",
    h("div.libenc-head",
      h("span.libenc-shape", { class: e.type }, e.type === "toggle" ? "⇵" : ""),
      h("span.libenc-label", { style: { color: e.labelColor ?? pedal.labelColor } }, e.label)),
    h("div.libenc-cc", {}, `CC ${e.cc} · default ${e.defaultValue}`));
  const extras = [];
  const pos = controlPositions(e);
  if (pos) extras.push(`${pos.length}-position ${e.style === "arcade" ? "arcade button" : "toggle"}`);
  if (e.detents?.length) extras.push(`${e.detents.length} detents`);
  if (e.ranges?.length) extras.push(`${e.ranges.length} ranges`);
  if (extras.length) card.append(h("div.libenc-extra", {}, extras.join(" · ")));
  return card;
}

function pedalModal(ctx, pedal, isCustom) {
  const { store } = ctx;
  const close = () => store.update((s) => { s.modalPedalId = null; });

  const page = (name) => h("div.lib-page",
    h("span.insp-title", {}, name.toUpperCase() + " PAGE"),
    h("div.lib-page-grid", { style: { background: pedal.backgroundColor } },
      pedal.encoders[name].map((e) => encoderCard(e, pedal))));

  return h("div.modal-overlay", {
    onclick: (e) => { if (e.target === e.currentTarget) close(); },
  },
    h("div.pedal-modal",
      h("div.lib-head", { style: { background: pedal.backgroundColor, color: pedal.labelColor } },
        h("h2.lib-title", {}, pedal.name),
        h("code.lib-id", {}, pedal.id),
        !isCustom && h("a.ghost-btn.sm.manual-link", {
          style: { marginLeft: "auto" },
          href: "https://www.chasebliss.com/manuals",
          target: "_blank", rel: "noopener",
          title: `Chase Bliss manuals page — find ${pedal.name} there (their PDF URLs move, so we link the hub)`,
        }, "manual ↗"),
        isCustom
          ? h("span.pedit-head-actions", {},
              h("button.ghost-btn.sm", {
                title: "open this pedal in the editor — every control is editable",
                onclick: () => store.update((s) => { s.modalPedalId = null; s.pedalEditorId = pedal.id; }),
              }, "edit"),
              deleteCustomButton(ctx, pedal))
          : h("button.ghost-btn.sm", {
              title: "copy this pedal into YOUR PEDALS, where every control is editable",
              onclick: () => { close(); createCustomPedal(ctx, pedal); },
            }, "edit a copy"),
        h("button.modal-close", { title: "close (esc)", onclick: close }, "✕")),
      inBoardCard(ctx, pedal),
      page("normal"),
      page("hidden"),
      h("div.lib-page",
        h("span.insp-title", {}, "FOOTSWITCHES"),
        h("div.lib-fs-row",
          ["left", "right"].map((side) => h("div.lib-fs",
            h("span.lib-fs-pos", {}, side.toUpperCase()),
            h("span.lib-fs-label", {}, pedal.footswitches[side].label),
            h("span.libenc-cc", {}, `CC ${pedal.footswitches[side].cc}`))))),
      pedal.dipSwitchBanks?.length ? h("div.lib-page",
        h("span.insp-title", {}, "DIP SWITCH BANKS"),
        h("div.lib-dips",
          pedal.dipSwitchBanks.map((bank) => h("div.lib-dip-bank",
            h("span.lib-dip-title", {}, bank.label),
            bank.switches.map((sw) => h("div.lib-dip",
              h("span", {}, sw.label),
              h("span.libenc-cc", {}, `CC ${sw.cc}`))))))) : null,
      snapshotSection(ctx, pedal),
      h("div.pane-footnote", {},
        "read-only reference — colors and labels come from pedal-library.json and flow through every layout")));
}

// ── Custom-pedal editor takeover ───────────────────────────────────────────
// The modal is read-only reference only; editing takes over the whole view
// (the editor component itself is unchanged — pedal-editor.mjs).

function editorTakeover(ctx, pedal) {
  const { store } = ctx;
  return h("div.pedit-takeover",
    h("section.rl-card.pedit-card",
      h("div.rl-head",
        h("button.ghost-btn.sm", {
          onclick: () => store.update((s) => { s.pedalEditorId = null; }),
        }, "← back to the board"),
        h("h2.pane-title", {}, "Custom pedal"),
        h("span.pane-sub", {}, "editable copy — behaves exactly like a library pedal")),
      renderPedalEditor(ctx, pedal)));
}

// ── View entry ─────────────────────────────────────────────────────────────

export function renderRigView(ctx) {
  const { store, library } = ctx;
  const rig = store.state.docs.rig;
  const customs = store.state.docs.pedals;

  const editing = customs.find((p) => p.id === store.state.pedalEditorId);
  if (editing) return editorTakeover(ctx, editing);

  const rigCounts = {};
  for (const i of rig.instances) rigCounts[i.pedalId] = (rigCounts[i.pedalId] ?? 0) + 1;

  const modalPedal = [...customs, ...library.pedals]
    .find((p) => p.id === store.state.modalPedalId);

  return h("div.rig3",
    libraryCard(ctx, rigCounts),
    boardCard(ctx),
    omniportsCard(ctx),
    modalPedal && pedalModal(ctx, modalPedal, customs.includes(modalPedal)));
}
