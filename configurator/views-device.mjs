//
// views-device.mjs — DEVICE view (design_handoff_device_tab_inspector 4a,
// reshaped 2026-08-23 with design_handoff_bank_switching): LEFT card
// "Trigger" — SNAPSHOTS · DIP SWITCHES · PERFORMANCES as collapsible
// Sources-style sections, trigger-only (click fires; nothing drags or
// configures); + snapshot capture sits at the top of SNAPSHOTS. CENTER —
// a headerless card: the bank switcher docked at its top (press = push +
// activate; switch-only here — bank editing is LAYOUTS-only, the old
// BANKS tab is gone) over the live-mirror faceplate mimic resolved
// against live CC state. RIGHT card
// — the MIDI monitor, always in view. Device sync lives in the app-chrome
// device-link pane (renderLinkPane, mounted by app.mjs as a sibling of
// .view — it persists across tabs). BOTTOM drawer — debug console only.
// Disconnected → the connect + backup cards on the same canvas, including
// the Safari/unsupported degradation.
//
import { h, stackDivider } from "./ui.mjs";
import { renderBankSwitcher } from "./bank-switcher.mjs";
import { manifestDiff, pendingCount } from "./link.mjs";
import { resolveCell,
         exportedConfig, parseConfigImport,
         transformValue, ccOwner, snapshotCCs, rigCaptureItems,
         positionIndex, pageView, pageArrays, hiddenPageUsed } from "./model.mjs";
import { snapshotSMF } from "./smf.mjs";
import { renderFaceplate } from "./faceplate.mjs";

// ── Backup / share (export–import the whole authored config) ───────────────
// Lives on the DEVICE tab in every link state — on browsers that can't
// connect at all (Safari), export is how authored work leaves the machine.

function backupCard(ctx) {
  const { store } = ctx;

  const doExport = () => {
    const cfg = exportedConfig(store.state.docs);
    const blob = new Blob([JSON.stringify(cfg, null, 2)], { type: "application/json" });
    const a = h("a", {
      href: URL.createObjectURL(blob),
      download: `proxi-config-${cfg.exportedAt.slice(0, 10)}.json`,
    });
    a.click();
    URL.revokeObjectURL(a.href);
    store.showToast({ msg: `exported ${a.download}`, undoable: false });
  };

  const doImport = async (file) => {
    let next;
    try { next = parseConfigImport(await file.text()); }
    catch (err) {
      store.showToast({ msg: `import failed: ${err.message}`, undoable: false });
      return;
    }
    store.mutate(`imported "${file.name}"`, (s) => {
      s.docs.pedals = next.pedals;
      s.docs.rig = next.rig;
      s.docs.layouts = next.layouts;
      s.docs.settings = next.settings;
      s.docs.snapshots = next.snapshots;
      s.currentLayoutId = next.settings.layoutOrder?.[0] ?? next.layouts[0]?.id ?? null;
      s.selection = null;
    }, { toast: `imported ${file.name}: ${next.rig.instances.length} rig pedal(s) · ${next.layouts.length} layout(s) · ${next.pedals.length} custom pedal(s)` });
  };

  const fileInput = h("input", {
    type: "file", accept: ".json,application/json", style: { display: "none" },
    onchange: (e) => {
      const f = e.target.files[0];
      if (f) doImport(f);
      e.target.value = "";
    },
  });

  // e.currentTarget, not a closured node: morph retains the FIRST render's
  // card and swaps listeners onto it, so a closure over this render's node
  // would paint the drop highlight on a discarded tree.
  const card = h("div.backup-card", {
    ondragover: (e) => { e.preventDefault(); e.currentTarget.classList.add("drop"); },
    ondragleave: (e) => e.currentTarget.classList.remove("drop"),
    ondrop: (e) => {
      e.preventDefault();
      e.currentTarget.classList.remove("drop");
      const f = e.dataTransfer.files?.[0];
      if (f) doImport(f);
    },
  },
    h("span.insp-title", {}, "BACKUP · SHARE"),
    h("div.backup-btns",
      h("button.ghost-btn.sm", { onclick: doExport }, "export config…"),
      h("button.ghost-btn.sm", { onclick: () => fileInput.click() }, "import config…"),
      fileInput),
    h("div.pane-footnote", {},
      "one JSON file: rig, layouts, custom pedals, snapshots, bank order — back it up or hand it to another Proxi owner · import replaces what's here (⌘Z undoes it) · or drop a file on this card · want a .mid? capture a snapshot in the live mirror, then download it from its ⋯ menu"));
  return card;
}

// ── Connect card (5c) ──────────────────────────────────────────────────────

export function connectCard(ctx) {
  const { store, linkApi } = ctx;
  const { link } = store.state;

  if (link.status === "unsupported") {
    return h("div.safari-card",
      h("div.safari-head",
        h("span.dot", { style: { background: "#d9a544" } }),
        h("span", {}, "This browser can't talk to the device")),
      h("div.safari-body",
        h("p", {},
          "This browser has neither Web MIDI nor Web Serial. Everything else works — browse the library, build your rig, design layouts. They'll be waiting in this browser's storage. Or connect the demo device — a simulated Proxi that runs right in this tab."),
        h("div.safari-btns",
          h("button.primary-btn", {
            onclick: async () => {
              store.update((s) => { s.link.transport = "demo"; });
              try { await linkApi.connect(ctx.pedalsById); }
              catch { /* logged to the console drawer */ }
            },
          }, "TRY THE DEMO DEVICE"),
          h("button.ghost-btn", {
            onclick: async (e) => {
              await navigator.clipboard?.writeText(location.href);
              e.target.textContent = "copied!";
              setTimeout(() => (e.target.textContent = "Copy link for Chrome / Edge"), 1200);
            },
          }, "Copy link for Chrome / Edge"),
          h("button.link-btn.dim", {
            onclick: () => store.update((s) => { s.view = "layouts"; }),
          }, "Keep designing"))));
  }

  const hasSerial = "serial" in navigator;
  const hasMidi = "requestMIDIAccess" in navigator;
  const transport = link.transport === "serial" && !hasSerial ? "midi" : link.transport;

  return h("div.connect-card",
    h("div.rl-head",
      h("span.dot", { style: { background: link.status === "connecting" ? "#d9a544" : "#4a4d53" } }),
      h("h2.connect-title", {}, "Connect your Proxi"),
      h("span.connect-browser", {}, `${hasSerial && hasMidi ? "Chrome · ok" : hasMidi ? "Web MIDI only" : "Web Serial only"}`)),
    h("div.connect-body",
      h("div.segmented",
        h("button.seg", {
          class: transport === "midi" ? "on" : "", disabled: !hasMidi,
          onclick: () => store.update((s) => { s.link.transport = "midi"; }),
        }, "Web MIDI ", h("span.seg-sub", {}, "recommended")),
        h("button.seg", {
          class: transport === "serial" ? "on" : "", disabled: !hasSerial,
          onclick: () => store.update((s) => { s.link.transport = "serial"; }),
        }, "Web Serial"),
        h("button.seg", {
          class: transport === "demo" ? "on" : "",
          onclick: () => store.update((s) => { s.link.transport = "demo"; }),
        }, "Demo ", h("span.seg-sub", {}, "no hardware"))),
      h("button.primary-btn.big", {
        disabled: link.status === "connecting",
        onclick: async (e) => {
          try { await linkApi.connect(ctx.pedalsById); }
          catch { /* logged to the console drawer */ }
        },
      }, link.status === "connecting" ? "CONNECTING…"
        : transport === "demo" ? "CONNECT DEMO DEVICE" : "CONNECT DEVICE"),
      h("div.connect-hint", {},
        transport === "midi"
          ? "the browser will ask for MIDI + SysEx permission — that's us"
          : transport === "demo"
          ? "a simulated Proxi runs in this tab — push, activate, record, play"
          : "pick the device's usbmodem port in the browser prompt",
        h("br"),
        transport === "demo"
          ? "it starts factory-fresh and forgets everything on disconnect"
          : "nothing listed? check USB, and that the device is powered")));
}

// ── Manifest diff table ────────────────────────────────────────────────────

const KIND_LABEL = { rig: "rig", settings: "settings · bank order" };

function diffTable(ctx) {
  const { store, pedalsById } = ctx;
  const { docs, link } = store.state;
  const rows = manifestDiff(docs, pedalsById, link.manifest);
  const pedalRows = rows.filter((r) => r.kind === "pedal");
  const rest = rows.filter((r) => r.kind !== "pedal");
  const pedalsStale = pedalRows.filter((r) => r.status !== "in-sync").length;

  const layoutName = (id) => docs.layouts.find((l) => l.id === id)?.name ?? id;
  const row = (label, status, note = "") => h("div.diff-row", { class: status },
    h("span.dot", { class: status === "in-sync" ? "green" : "amber" }),
    h("span.diff-name", {}, label),
    note && h("span.diff-note", {}, note),
    h("span.diff-status", { class: status === "in-sync" ? "green" : "amber" },
      status === "in-sync" ? "in sync" : status === "delete" ? "on device only — will remove" : status));

  return h("div.diff-table",
    rest.map((r) => row(
      r.kind === "layout" ? `layout · ${layoutName(r.id)}` : KIND_LABEL[r.kind] ?? r.id,
      r.status)),
    pedalRows.length ? row(`pedal models · ${pedalRows.length}`,
      pedalsStale ? "modified" : "in-sync",
      pedalsStale ? `${pedalsStale} stale` : "") : null);
}

// ── Mirror interaction (backlog #8) ────────────────────────────────────────
// The faceplate is the interact surface: encoder cells AND their physical
// knobs drag like DAW knobs (most people reach for the knob first), toggles
// and footswitches click. Values go out as CC over the MIDI carriage
// (linkApi.sendCC — a no-op wire-wise on Web Serial, but local live state
// still updates so the mirror stays a preview).
//
// One DELEGATED listener set on the faceplate root, never per-cell:
// morphChildren retains mounted nodes and discards each fresh render's tree,
// so only the FIRST render's listeners ever exist on the live DOM. Per-cell
// listeners therefore froze their closured rc.value at the first render
// (drag 32→64, release, drag again → jumped back to 32) and never appeared
// at all on cells bound after the first render (config import, undo). The
// root listener survives the same way — but it resolves the layout, cell,
// value, and target elements fresh at event time, so it can't go stale.

// Send master value v (0..127) through every ok binding's transform.
function sendMaster(ctx, rc, v) {
  for (const b of rc.bindings) {
    if (!b.ok || b.channel == null) continue;   // perf bindings have no MIDI addr
    ctx.linkApi.sendCC(b.channel, b.cc, transformValue(b.transform, v));
  }
}

// knob drag: vertical. The dragged cell paints imperatively for zero-lag
// feedback, and moves also trigger throttled (~30fps) re-renders so every
// other cell bound to the same CCs (a macro's other targets on their own
// encoders) follows in real time, matching the glass. Time-based, not rAF —
// rAF starves on occluded pages. Mid-drag re-renders are safe: morph
// retains the captured node and imperative listeners. rc is resolved at
// pointerdown, so startV is the CURRENT value, never a render-time
// snapshot.
function startEncoderDrag(e, fp, cell, index, rc, ctx) {
  e.preventDefault();
  // capture keeps the drag alive outside the cell; a failed capture must not
  // kill the drag (the buttons check in move() is the backstop)
  try { cell.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
  const startY = e.clientY, startV = rc.value;
  // paint targets resolved from the live tree NOW — both the screen cell's
  // bar/number and the physical knob's pointer follow the drag
  const scell = fp.querySelector(`.scell[data-drop="enc"][data-index="${index}"]`);
  const vfill = scell?.querySelector(".vfill");
  const vnum = scell?.querySelector(".vnum");
  const pointer = fp.querySelector(`.knob[data-drop="enc"][data-index="${index}"] .pointer`);
  const paint = (v) => {
    if (vfill) vfill.style.width = `${Math.round((v / 127) * 100)}%`;
    if (vnum) vnum.textContent = String(v);
    if (pointer) pointer.style.transform = `rotate(${-135 + (v / 127) * 270}deg)`;
  };
  let lastRender = 0;
  const move = (ev) => {
    // drag ended without us hearing about it (missed pointerup) — bail
    // rather than track a button-less cursor
    if (!(ev.buttons & 1)) return end();
    const v = Math.max(0, Math.min(127, Math.round(startV + (startY - ev.clientY) * 0.7)));
    paint(v);
    sendMaster(ctx, rc, v);
    const now = performance.now();
    if (now - lastRender > 33) {
      lastRender = now;
      ctx.store.update(() => {});
    }
  };
  // The drag can end three ways: pointerup, pointercancel (browser takes
  // the gesture — e.g. dragging past the window edge), or losing the
  // capture. Clean up on ALL of them, or the move listener stays behind and
  // the value tracks the bare cursor on the next hover.
  const end = () => {
    cell.removeEventListener("pointermove", move);
    cell.removeEventListener("pointerup", end);
    cell.removeEventListener("pointercancel", end);
    cell.removeEventListener("lostpointercapture", end);
    try { cell.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    ctx.store.update(() => {}); // one re-render to settle state
  };
  cell.addEventListener("pointermove", move);
  cell.addEventListener("pointerup", end);
  cell.addEventListener("pointercancel", end);
  cell.addEventListener("lostpointercapture", end);
}

function encoderToggleClick(rc, ctx) {
  const vals = rc.positions?.map((p) => p.value) ?? [0, 127];
  const next = vals[(positionIndex(rc.positions, rc.value) + 1) % vals.length]
    ?? (rc.value >= 64 ? 0 : 127);
  sendMaster(ctx, rc, next);
  ctx.store.update(() => {});
}

function momentaryPress(e, cell, rc, ctx, send) {
  try { cell.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
  send("on");
  // release on cancel/lost-capture too — a momentary must never latch on
  const off = () => {
    cell.removeEventListener("pointerup", off);
    cell.removeEventListener("pointercancel", off);
    cell.removeEventListener("lostpointercapture", off);
    send("off");
  };
  cell.addEventListener("pointerup", off);
  cell.addEventListener("pointercancel", off);
  cell.addEventListener("lostpointercapture", off);
}

// click actions for the non-momentary footswitch modes (rc is event-fresh)
function footswitchClick(rc, ctx, send) {
  if (rc.mode === "send") {
    send("on"); // a scene is one-shot
  } else if (rc.mode === "cycle") {
    // arcade-button semantics: advance to the next discrete position, wrapping
    const vals = rc.positions?.map((p) => p.value);
    if (!vals?.length) return;
    const next = vals[(positionIndex(rc.positions, rc.value) + 1) % vals.length];
    for (const b of rc.bindings) {
      if (!b.ok || b.channel == null) continue;
      ctx.linkApi.sendCC(b.channel, b.cc, next);
    }
    ctx.store.update(() => {});
  } else { // toggle
    const b0 = rc.bindings[0];
    const cur = b0?.ok ? ctx.store.state.live[`${b0.channel}:${b0.cc}`] ?? 0 : 0;
    send(cur === (b0?.on ?? 127) ? "off" : "on");
  }
}

function fsSend(rc, ctx) {
  return (which) => {
    for (const b of rc.bindings) {
      if (!b.ok || b.channel == null) continue;
      ctx.linkApi.sendCC(b.channel, b.cc, which === "on" ? b.on ?? 127 : b.off ?? 0);
    }
    ctx.store.update(() => {});
  };
}

// The live faceplate: the LAYOUTS renderer, resolved against live CC state,
// wired as the interact surface (screen cells AND the physical knobs /
// footswitches). Device-originated CC re-renders the whole faceplate
// (coalesced in link.mjs), so knob angles and LEDs follow live too.
// The page the DEVICE mirror shows: the switcher's pick, overridden while
// shift is held (the app-side SW2+SW3 — release returns to MAIN).
export const devicePageOf = (s) =>
  s.deviceShiftPeek || s.devicePage === "hidden" ? "hidden" : "main";

// The layout the mirror reflects: what's live on the device, else the
// current selection, else the first authored layout.
export const mirrorLayoutOf = (s) =>
  s.docs.layouts.find((l) => l.id === s.link.activeLayout)
  ?? s.docs.layouts.find((l) => l.id === s.currentLayoutId)
  ?? s.docs.layouts[0];

// Resolve one mirror cell entirely from CURRENT state. The delegated
// listeners below live on a morph-retained node, so EVERYTHING they need —
// including which layout is active — must resolve at event time. A closured
// layout id here survived bank switches and kept footswitch clicks sending
// the previous bank's channels (2026-07-17).
// `page` — which glass the event landed on: in stacked hidden-page view both
// plates are live at once, so the caller passes the plate's own page; the
// default keeps the flip-mode behavior (the switcher's page, shift-peek
// included).
export function mirrorCellAt(s, pedalsById, kind, index, page = devicePageOf(s)) {
  // A tap-triggered reserved gesture (STATUS.gestures, contract §9.3)
  // claims its switches whole — the firmware never fires cells there, so
  // neither does the mirror. (Current firmware only reserves chords —
  // hidden, bank-dn/up — which leave every switch bindable.)
  if (kind === "fs" && Object.values(s.link.gestures ?? {}).some(
        (g) => g?.trigger === "tap" && (g?.switches ?? []).includes(index)))
    return null;
  const lay = mirrorLayoutOf(s);
  const a = lay && pageArrays(lay, page);
  const cell = !a ? null
    : kind === "fs" ? a.footswitches[index] : a.encoders[index];
  const rc = cell ? resolveCell(cell, s.docs.rig, pedalsById, s.live) : null;
  return rc && !rc.broken ? rc : null;
}

function liveFaceplate(ctx, realLayout, page) {
  const { store, pedalsById } = ctx;
  const { docs, link, live } = store.state;
  const layout = pageView(realLayout, page);
  const fp = renderFaceplate({ ...ctx, layout, page, rig: docs.rig, live,
                               gestures: link.gestures, store });
  // Keyed so morph only ever pairs this node with the matching live mirror —
  // without a key the LAYOUTS plates (same tag, own keys) could inherit this
  // node and its live listeners. Stacked mode keys per page (two plates live
  // at once, pages never change); flip mode keeps ONE stable key, because a
  // page-dependent key would make a mid-gesture shift-peek REPLACE the node
  // an in-flight encoder drag holds its pointer listeners on. Handlers read
  // dataset.page (re-synced by morph every render) at event time instead.
  fp.dataset.key = ctx.store.state.ui.hiddenPageView === "stacked"
    ? `live-mirror-${page}` : "live-mirror";
  fp.dataset.page = page;

  // Resolve a cell fresh from CURRENT state (event time, not render time) —
  // including the CURRENT page for this plate: in flip mode a shift release
  // between render and click must not drive the hidden cell (dataset.page is
  // re-synced by morph every render), and in stacked mode each plate keeps
  // addressing its own glass.
  const rcAt = (kind, index, fpEl) =>
    mirrorCellAt(ctx.store.state, ctx.pedalsById, kind, index, fpEl.dataset.page);

  // Affordance classes on the fresh tree — morphNode syncs attributes onto
  // retained nodes, so cursors stay correct even though listeners don't ride
  // along (that's what the delegation below is for).
  layout.encoders.forEach((cell, i) => {
    const rc = cell && resolveCell(cell, docs.rig, pedalsById, live);
    if (!rc || rc.broken) return;
    for (const el of fp.querySelectorAll(`[data-drop="enc"][data-index="${i}"]`)) {
      el.classList.add("hot");
      if (rc.interaction !== "toggle") el.classList.add("draggable");
    }
  });
  layout.footswitches.forEach((cell, i) => {
    const rc = cell && resolveCell(cell, docs.rig, pedalsById, live);
    if (!rc || rc.broken) return;
    for (const el of fp.querySelectorAll(`[data-drop="fs"][data-index="${i}"]`))
      el.classList.add("hot");
  });

  // Delegated interaction (see the section comment above): pointerdown owns
  // the drag-like gestures (knob drag, momentary press), click owns the rest.
  fp.addEventListener("pointerdown", (e) => {
    const t = e.target.closest("[data-drop]");
    if (!t) return;
    const index = Number(t.dataset.index);
    const rc = rcAt(t.dataset.drop, index, e.currentTarget);
    if (!rc) return;
    if (t.dataset.drop === "enc" && rc.interaction !== "toggle")
      startEncoderDrag(e, e.currentTarget, t, index, rc, ctx);
    else if (t.dataset.drop === "fs" && rc.mode === "momentary")
      momentaryPress(e, t, rc, ctx, fsSend(rc, ctx));
  });
  fp.addEventListener("click", (e) => {
    const t = e.target.closest("[data-drop]");
    if (!t) return;
    const rc = rcAt(t.dataset.drop, Number(t.dataset.index), e.currentTarget);
    if (!rc) return;
    if (t.dataset.drop === "enc") {
      if (rc.interaction === "toggle") encoderToggleClick(rc, ctx);
    } else if (rc.mode !== "momentary") {
      footswitchClick(rc, ctx, fsSend(rc, ctx));
    }
  });
  return fp;
}

// The right card's body: the faceplate mimic + interaction footnote. In
// stacked hidden-page view both live glasses render at once with the violet
// divider between them (design_handoff_bank_switching §5); in flip mode a
// single plate follows the flip control / shift-peek.
function mirrorBody(ctx, layout, page) {
  if (!layout) return h("div.dev-mirror-body",
    h("div.insp-hint", {}, "no layouts yet — build one in LAYOUTS, then it mirrors here"));

  if (ctx.store.state.ui.hiddenPageView === "stacked") {
    // Only mirror a hidden glass that HAS content — unlike the LAYOUTS
    // plate (an authoring surface, where the empty glass is the drop
    // target), an empty hidden mirror is a full faceplate rebuilt every
    // live-CC notify for zero pixels of information.
    const hid = hiddenPageUsed(layout);
    return h("div.dev-mirror-body",
      liveFaceplate(ctx, layout, "main"),
      hid && stackDivider(),
      hid && liveFaceplate(ctx, layout, "hidden"),
      h("div.pane-footnote", {},
        "interactive: drag a value like a DAW knob, click toggles & footswitches — sends real CC over Web MIDI (local preview on other connections)",
        !hid && " · this layout's hidden page is empty — author it in LAYOUTS and it mirrors here"));
  }

  return h("div.dev-mirror-body", { class: page === "hidden" ? "page-hidden" : "" },
    liveFaceplate(ctx, layout, page),
    h("div.pane-footnote", {}, page === "hidden"
      ? "the HIDDEN page — on the device: hold SW2+SW3 (release returns) · here: hold ⇧ or the flip control"
      : "interactive: drag a value like a DAW knob, click toggles & footswitches — sends real CC over Web MIDI (local preview on other connections)"));
}

// ── Snapshots ───────────────────────────────────────────────────────────────
// Two kinds. Pedal "START HERE" presets ride the pedal doc (read-only,
// backlog #12). USER snapshots are scenes captured from the live mirror —
// stored app-side in docs.snapshots (undoable, exported with the config,
// NEVER synced to the device: applying one is just CC sends).

export function applySnapshot(ctx, inst, pedal, snap) {
  const sends = snapshotCCs(pedal, inst, snap);
  for (const s of sends) ctx.linkApi.sendCC(s.channel, s.cc, s.value);
  ctx.store.showToast({
    msg: `${snap.name} → ${inst.instanceId}: ${sends.length} value${sends.length === 1 ? "" : "s"} sent`,
    undoable: false,
  });
  ctx.store.update(() => {});
}

function downloadSnapshotMid(store, name, values) {
  const a = h("a", {
    href: URL.createObjectURL(new Blob(
      [snapshotSMF(values.map(({ channel, cc, value }) => ({ channel, cc, value })))],
      { type: "audio/midi" })),
    download: `${name.trim().replace(/[^\w-]+/g, "-").toLowerCase() || "snapshot"}.mid`,
  });
  a.click();
  URL.revokeObjectURL(a.href);
  store.showToast({ msg: `${values.length} CC values → ${a.download}`, undoable: false });
}

function openSnapshotEditor(ctx, layout) {
  const { docs, live } = ctx.store.state;
  ctx.store.update((s) => {
    s.deviceShelf.snaps = true;    // the editor renders in the SNAPSHOTS section
    s.snapEdit = {
      name: `${layout.name} · ${new Date().toISOString().slice(0, 10)}`,
      items: rigCaptureItems(docs.rig, ctx.pedalsById, live),
    };
  });
}

// Rectangle (rubber-band) selection: press and sweep a box across the list;
// on release every chip the box touches is set the same way — deselected if
// the sweep started on a selected chip, selected otherwise. A no-move click
// is a zero-size box, i.e. it toggles the one chip under the pointer. The
// box overlay and the chip preview outline are imperative (no store churn
// mid-drag); selection commits once, on pointerup.
let snapRect = null;

const rectFrom = (a, b) => ({
  left: Math.min(a.x, b.x), top: Math.min(a.y, b.y),
  right: Math.max(a.x, b.x), bottom: Math.max(a.y, b.y),
});

function chipsInRect(container, r) {
  return [...container.querySelectorAll(".snap-item")].filter((el) => {
    const c = el.getBoundingClientRect();
    return c.right >= r.left && c.left <= r.right && c.bottom >= r.top && c.top <= r.bottom;
  });
}

function clearSnapRect(container) {
  snapRect?.box.remove();
  snapRect = null;
  container?.querySelectorAll(".snap-item.rect-in")
    .forEach((el) => el.classList.remove("rect-in"));
}

// Create flow: the whole rig is offered, grouped per instance, everything
// selected — deselect what the scene shouldn't touch. Click a chip, sweep a
// box across many, or click a group head for the whole pedal; name it,
// create. Values are frozen at open time (what you see is what you
// capture).
function snapshotEditor(ctx) {
  const { store } = ctx;
  const edit = store.state.snapEdit;
  const selected = edit.items.filter((i) => i.selected);

  const groups = [];
  for (const it of edit.items) {
    let g = groups[groups.length - 1];
    if (!g || g.name !== it.group) groups.push(g = { name: it.group, color: it.color, items: [] });
    g.items.push(it);
  }

  return h("div.snap-editor",
    h("div.snap-editor-head",
      h("input.snap-name-input", {
        value: edit.name,
        dataset: { focusKey: "snap-name" },
        oninput: (e) => { store.state.snapEdit.name = e.target.value; },
      }),
      h("span.custom-note", {}, `${selected.length}/${edit.items.length} values selected · click or sweep a box across items · click a pedal name for all of it`)),
    h("div.snap-groups", {
      onpointerdown: (e) => {
        if (e.target.closest(".snap-group-head")) return; // heads keep their click
        const startChip = e.target.closest(".snap-item");
        const startItem = store.state.snapEdit.items
          .find((x) => x.key === startChip?.dataset.key);
        const box = h("div.snap-rect");
        document.body.append(box);
        snapRect = { to: startItem ? !startItem.selected : true, start: { x: e.clientX, y: e.clientY }, box };
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
        e.preventDefault();
      },
      onpointermove: (e) => {
        if (!snapRect) return;
        if (e.pointerType === "mouse" && !(e.buttons & 1)) return clearSnapRect(e.currentTarget);
        const r = rectFrom(snapRect.start, { x: e.clientX, y: e.clientY });
        Object.assign(snapRect.box.style, {
          left: `${r.left}px`, top: `${r.top}px`,
          width: `${r.right - r.left}px`, height: `${r.bottom - r.top}px`,
        });
        const inRect = new Set(chipsInRect(e.currentTarget, r));
        for (const el of e.currentTarget.querySelectorAll(".snap-item"))
          el.classList.toggle("rect-in", inRect.has(el));
      },
      onpointerup: (e) => {
        if (!snapRect) return;
        const r = rectFrom(snapRect.start, { x: e.clientX, y: e.clientY });
        const keys = new Set(chipsInRect(e.currentTarget, r).map((el) => el.dataset.key));
        const to = snapRect.to;
        clearSnapRect(e.currentTarget);
        if (keys.size) store.update((s) => {
          for (const it of s.snapEdit.items) if (keys.has(it.key)) it.selected = to;
        });
      },
      onpointercancel: (e) => clearSnapRect(e.currentTarget),
      onlostpointercapture: (e) => clearSnapRect(e.currentTarget),
    },
      groups.map((g) => h("div.snap-group",
        h("button.snap-group-head", {
          title: `${g.items.filter((i) => i.selected).length}/${g.items.length} selected — click to toggle the whole pedal`,
          onclick: () => {
            const to = !g.items.every((i) => i.selected);
            store.update((s) => {
              for (const it of s.snapEdit.items) if (it.group === g.name) it.selected = to;
            });
          },
        },
          h("span.snap-item-dot", { style: { background: g.color } }),
          h("span", {}, g.name),
          h("span.snap-group-count", {}, `${g.items.filter((i) => i.selected).length}/${g.items.length}`)),
        h("div.snap-items",
          g.items.map((it) => h("button.snap-item", {
            class: it.selected ? "on" : "",
            title: `ch ${it.channel} · CC ${it.cc}`,
            dataset: { key: it.key },
          },
            h("span.snap-item-dot", { style: { background: it.color } }),
            h("span.snap-item-label", {}, it.label),
            h("span.snap-item-val", {}, String(it.value)))))))),
    h("div.snap-editor-actions",
      h("button.gen-btn", {
        disabled: !selected.length,
        onclick: () => {
          const name = store.state.snapEdit.name.trim() || "snapshot";
          const snap = {
            id: `snap-${Date.now().toString(36)}`,
            name,
            createdAt: new Date().toISOString(),
            values: selected.map(({ channel, cc, value }) => ({ channel, cc, value })),
          };
          store.mutate(`snapshot "${name}" · ${snap.values.length} value${snap.values.length === 1 ? "" : "s"}`, (s) => {
            s.docs.snapshots.push(snap);
            s.snapEdit = null;
          });
        },
      }, "CREATE SNAPSHOT"),
      h("button.link-btn.dim", {
        onclick: () => store.update((s) => { s.snapEdit = null; }),
      }, "cancel")));
}

function userSnapshotRow(ctx, snap) {
  const { store, linkApi } = ctx;
  const menuOpen = store.state.snapMenu === snap.id;
  const renaming = store.state.snapRename === snap.id;

  const apply = () => {
    for (const v of snap.values) linkApi.sendCC(v.channel, v.cc, v.value);
    store.showToast({ msg: `${snap.name}: ${snap.values.length} value${snap.values.length === 1 ? "" : "s"} sent`, undoable: false });
    store.update(() => {});
  };

  const nameEl = renaming
    ? h("input.snap-name-input", {
        value: snap.name,
        dataset: { focusKey: `snap-rename-${snap.id}` },
        onclick: (e) => e.stopPropagation(),
        onchange: (e) => {
          const name = e.target.value.trim();
          if (name && name !== snap.name) {
            store.mutate(`renamed snapshot → "${name}"`, (s) => {
              s.docs.snapshots.find((x) => x.id === snap.id).name = name;
              s.snapRename = null;
            });
          } else store.update((s) => { s.snapRename = null; });
        },
      })
    : h("span.snap-name", {}, snap.name);

  return h("div.usnap",
    h("div.usnap-row",
      h("button.snap-btn", {
        title: `sends ${snap.values.length} CC value${snap.values.length === 1 ? "" : "s"}`,
        onclick: apply,
      },
        h("span.snap-spine.user"),
        nameEl,
        h("span.snap-count", {}, String(snap.values.length))),
      h("button.snap-menu-btn", {
        class: menuOpen ? "on" : "",
        title: "rename · replace · download · delete",
        onclick: () => store.update((s) => { s.snapMenu = menuOpen ? null : snap.id; s.snapRename = null; }),
      }, "⋯")),
    menuOpen && h("div.snap-actions",
      h("button.ghost-btn.sm", {
        onclick: () => store.update((s) => { s.snapRename = snap.id; }),
      }, "rename"),
      h("button.ghost-btn.sm", {
        title: "re-capture these same controls' current values (delete + create in one)",
        onclick: () => store.mutate(`"${snap.name}" ← current values`, (s) => {
          const sn = s.docs.snapshots.find((x) => x.id === snap.id);
          sn.values = sn.values.map((v) => ({ ...v, value: s.live[`${v.channel}:${v.cc}`] ?? v.value }));
        }),
      }, "replace with current"),
      h("button.ghost-btn.sm", {
        title: "SMF type-0: this snapshot's values as CC events at t=0 — for a DAW or the daw-lens",
        onclick: () => downloadSnapshotMid(store, snap.name, snap.values),
      }, "download .mid"),
      h("button.ghost-btn.sm.danger", {
        onclick: () => store.mutate(`deleted snapshot "${snap.name}"`, (s) => {
          s.docs.snapshots = s.docs.snapshots.filter((x) => x.id !== snap.id);
          s.snapMenu = null;
        }),
      }, "delete")));
}

// SNAPS section: user scenes as full-width rows (click = send every value;
// the ⋯ menu keeps rename/replace/download/delete — this is where snapshots
// are managed), then the pedal "START HERE" presets. The create-editor
// (opened from the + snapshot button at the top of the section) renders
// here too.
function snapsBody(ctx) {
  const { store, pedalsById } = ctx;
  const userSnaps = store.state.docs.snapshots;
  const edit = store.state.snapEdit;
  const layout = mirrorLayoutOf(store.state);
  const presetRows = store.state.docs.rig.instances
    .map((inst) => ({ inst, pedal: pedalsById[inst.pedalId] }))
    .filter((r) => r.pedal?.snapshots?.length);

  return [
    // capture lives at the top of the list (the mirror card has no header)
    layout && !edit && h("button.ghost-btn.sm.snap-capture", {
      title: "capture current values — anything in your rig, this layout's controls pre-selected",
      onclick: () => openSnapshotEditor(ctx, layout),
    }, "+ snapshot"),
    edit && snapshotEditor(ctx),
    !userSnaps.length && !presetRows.length && !edit
      && h("div.insp-hint", {}, "no snapshots yet — + snapshot captures current values"),
    userSnaps.length > 0 && h("div.snap-rows",
      userSnaps.map((snap) => userSnapshotRow(ctx, snap))),
    presetRows.length > 0 && h("div.snap-rows",
      presetRows.flatMap(({ inst, pedal }) =>
        pedal.snapshots.map((snap) => h("button.snap-btn", {
          title: `${snap.source ?? ""} · sends ${Object.keys(snap.values).length} CC values on ch ${inst.midiChannel}`,
          onclick: () => applySnapshot(ctx, inst, pedal, snap),
        },
          h("span.snap-spine", { style: { background: pedal.backgroundColor } }),
          h("span.snap-inst", {}, inst.instanceId),
          h("span.snap-name", {}, snap.name))))),
    (userSnaps.length > 0 || presetRows.length > 0)
      && h("span.pane-footnote", {}, "+ snapshot captures current values"),
  ];
}

// ── DIPS section (backlog #9): view + click-to-flip per rig instance ───────

function dipsBody(ctx) {
  const { store, pedalsById, linkApi } = ctx;
  const { docs, live } = store.state;

  const insts = docs.rig.instances.filter((i) => pedalsById[i.pedalId]?.dipSwitchBanks?.length);
  if (!insts.length)
    return [h("div.insp-hint", {}, "no rig pedals with dip switches")];

  return [
    insts.map((inst) => {
      const pedal = pedalsById[inst.pedalId];
      return h("div.dip-inst",
        h("div.dip-inst-head",
          h("div.rig-spine", { style: { background: pedal.backgroundColor } }),
          h("span.dip-inst-name", {}, inst.instanceId),
          h("span.dip-inst-ch", {}, `ch ${inst.midiChannel}`)),
        pedal.dipSwitchBanks.map((bank) => h("div.dip-bank-row",
          h("span.dip-bank-label", {}, bank.label),
          h("div.dip-chips",
            bank.switches.map((sw) => {
              const key = `${inst.midiChannel}:${sw.cc}`;
              // CB dip semantics (verified vs v1 firmware dipToggleSelected):
              // 0 = off, any non-zero = on; we send 127/0 like v1 did
              const on = (live[key] ?? sw.defaultValue ?? 0) > 0;
              return h("button.dip-chip", {
                class: on ? "on" : "",
                title: `CC ${sw.cc} · ${on ? "on (non-zero)" : "off (0)"}`,
                onclick: () => {
                  linkApi.sendCC(inst.midiChannel, sw.cc, on ? 0 : 127);
                  store.update(() => {});
                },
              }, sw.label);
            })))));
    }),
    h("div.pane-footnote", {},
      "dips can also live on the surface — bind one to a footswitch or scene in the layout inspector"),
  ];
}

// ── MIDI monitor (right pane card): resolved live CC state ─────────────────

function monitorBody(ctx) {
  const { store, pedalsById } = ctx;
  const { docs, live } = store.state;
  const entries = Object.entries(live)
    .map(([key, value]) => {
      const [channel, cc] = key.split(":").map(Number);
      return { channel, cc, value, owner: ccOwner(docs.rig, pedalsById, channel, cc) };
    })
    .sort((a, b) => a.channel - b.channel || a.cc - b.cc);

  return [
    entries.length
      ? h("div.insp-monitor",
          entries.map((e) => h("div.dmon-row",
            h("span.monitor-src", {},
              e.owner
                ? [h("span.monitor-dot", { style: { background: e.owner.pedal.backgroundColor } }),
                   `${e.owner.instance.instanceId} · ${e.owner.label}`]
                : h("span.dim", {}, "unmapped")),
            h("span.monitor-addr", {}, `ch ${e.channel} · CC ${e.cc}`),
            h("span.monitor-val", {}, String(e.value)))))
      : h("div.insp-hint", {}, "nothing yet — twist something (device or mirror) and it shows up here"),
    h("span.pane-footnote", {},
      "resolved to instance / control names · ",
      h("button.link-btn.dim", {
        onclick: () => store.update((s) => { s.live = {}; }),
      }, "clear")),
  ];
}

// ── Bottom drawer: debug console only (the monitor lives in the inspector) ─

function bottomDrawer(ctx) {
  const { store } = ctx;
  const open = store.state.consoleOpen;
  const fmt = (d) => d.toTimeString().slice(0, 8);

  let body = null;
  if (open) {
    body = h("div.console-lines",
      store.state.console.map((e) => h("div.console-line",
        h("span.console-t", {}, fmt(e.t)), `  ${e.line}`)));
    queueMicrotask(() => { body.scrollTop = body.scrollHeight; });
  }

  return h("div.console-drawer", { class: open ? "open" : "" },
    h("div.console-head.clickable", {
      onclick: () => store.update((s) => { s.consoleOpen = !s.consoleOpen; }),
    },
      h("span.console-caret", {}, open ? "▾" : "▸"),
      h("span.console-title", {}, "DEBUG CONSOLE"),
      h("span.console-sub", {}, "raw device traffic · the MIDI monitor is the right pane"),
      h("span.console-actions",
        h("button.link-btn.dim", {
          onclick: (e) => {
            e.stopPropagation();
            navigator.clipboard?.writeText(
              store.state.console.map((l) => `${fmt(l.t)} ${l.line}`).join("\n"));
          },
        }, "copy"), " · ",
        h("button.link-btn.dim", {
          onclick: (e) => {
            e.stopPropagation();
            store.update((s) => { s.console = []; });
          },
        }, "clear"))),
    body);
}

// ── Device-link system pane (app chrome, mounted by app.mjs) ───────────────
// Full height on the right edge, fused to the header's green segment: sync
// status, transport, the whole manifest diff, PUSH, disconnect, backup.
// It sits OUTSIDE the tab views, so it persists across RIG/LAYOUTS/DEVICE/
// LENS. Only rendered while connected.

export function renderLinkPane(ctx) {
  const { store, linkApi, pedalsById } = ctx;
  const { docs, link } = store.state;
  if (link.status !== "connected" || !store.state.linkPaneOpen) return null;

  const n = pendingCount(manifestDiff(docs, pedalsById, link.manifest));

  return h("aside.link-pane",
    h("div.link-pane-body",
      h("span.pane-footnote", {},
        "fused to the green segment above — one object · stays put across tabs"),
      h("span.link-pane-fw", {},
        `fw ${link.fw ?? "?"} · ${Object.keys(link.manifest?.pedals ?? {}).length} models on SD`),
      h("div.segmented",
        h("button.seg", { class: link.transport === "midi" ? "on" : "", disabled: true }, "Web MIDI"),
        h("button.seg", { class: link.transport === "serial" ? "on" : "", disabled: true }, "Web Serial"),
        h("button.seg", { class: link.transport === "demo" ? "on" : "", disabled: true }, "Demo")),
      h("div.diff-head",
        h("span.insp-title", {}, "APP ⇄ DEVICE · MANIFEST DIFF"),
        h("span.changes", { class: n ? "amber" : "" }, n ? `${n} to push` : "all in sync")),
      diffTable(ctx),
      h("button.primary-btn", {
        disabled: !n,
        onclick: async (e) => {
          const btn = e.target.closest("button");
          btn.disabled = true;
          try { await linkApi.push(pedalsById); }
          catch (err) { store.log("Sync", err.message); }
          btn.disabled = false;
        },
      }, n ? `PUSH ${n} CHANGE${n === 1 ? "" : "S"}` : "PUSH"),
      h("button.ghost-btn", { onclick: () => linkApi.disconnect() }, "disconnect"),
      backupCard(ctx)));
}

// ── Left card: trigger sources (SNAPS · DIPS · PERFORMANCES) ───────────────
// The LAYOUTS Sources shelf's section language, but TRIGGER-ONLY (Steve
// 2026-08-23): nothing here drags or configures — clicking a row fires it.
// Bank management moved wholesale to the bank switcher above the mirror
// (the old BANKS tab + PUSH+ACTIVATE detail are gone: a switcher press IS
// push+activate, ✕/reorder live in its popover).

// PERFORMANCES: takes from the device manifest; a click is the app-side
// footswitch perf-toggle — load the take (if it isn't the loaded one) and
// play; click again while it runs to stop.
function perfBody(ctx) {
  const { store, linkApi } = ctx;
  const { manifest, takeNames, perf } = store.state.link;
  const takes = Object.keys(manifest?.performances ?? {}).sort();
  if (!takes.length)
    return [h("div.insp-hint", {}, "no takes yet — record one on the LENS tab")];

  const running = perf?.state === "play" || perf?.state === "rec" || perf?.state === "overdub";
  const trigger = async (id) => {
    try {
      if (running && perf?.loadedId === id) { await linkApi.perfControl("stop"); return; }
      if (perf?.loadedId !== id) await linkApi.perfLoad(id);
      await linkApi.perfControl("play");
    } catch (err) { store.log("Perf", err.message); }
  };

  return [
    takes.map((t) => {
      const live = running && perf?.loadedId === t;
      return h("button.perf-trig", {
        class: live ? "on" : "",
        title: live ? "playing — click to stop"
          : "click to load + play this take on the device",
        onclick: () => trigger(t),
      },
        h("span.tp-snap-spine", { style: { background: "var(--blue-border)" } }),
        h("span.perf-trig-id", {}, t),
        h("span.perf-trig-sub", {}, takeNames?.[t] ?? "—"),
        h("span.perf-trig-state", {}, live ? "▶ playing" : "▶"));
    }),
    h("span.pane-footnote", {}, "click = load + play on the device · click again to stop · takes live on the LENS tab"),
  ];
}

function sourcesCard(ctx) {
  const { store } = ctx;
  const open = store.state.deviceShelf;
  const toggle = (key) => store.update((s) => { s.deviceShelf[key] = !s.deviceShelf[key]; });
  const secHead = (key, title, spine, count) =>
    h("div.src-head", { onclick: () => toggle(key) },
      h("span.src-caret", {}, open[key] ? "▾" : "▸"),
      h("span.src-spine", { style: { background: spine } }),
      h("span.src-title", {}, title),
      h("span.src-count", {}, count));

  const { docs, link } = store.state;
  const nDips = docs.rig.instances
    .filter((i) => ctx.pedalsById[i.pedalId]?.dipSwitchBanks?.length).length;
  const nTakes = Object.keys(link.manifest?.performances ?? {}).length;

  return h("section.rl-card.dev-insp",
    h("div.rl-head",
      h("h2.pane-title", {}, "Trigger"),
      h("span.pane-sub", {}, "click to fire — nothing here edits")),
    h("div.dev-insp-body",
      secHead("snaps", "SNAPSHOTS", "var(--amber-border)", "one click sends every value"),
      open.snaps && snapsBody(ctx),
      secHead("dips", "DIP SWITCHES", "var(--border-ctl)", nDips ? "click to flip" : "—"),
      open.dips && dipsBody(ctx),
      secHead("perf", "PERFORMANCES", "var(--blue-border)", `${nTakes} take${nTakes === 1 ? "" : "s"}`),
      open.perf && perfBody(ctx)));
}

// Right card: the MIDI monitor, always in view next to the live mirror.
function monitorCard(ctx) {
  return h("section.rl-card.dev-mon",
    h("div.rl-head",
      h("h2.pane-title", {}, "Monitor"),
      h("span.pane-sub", {}, "live channel:cc → value")),
    h("div.dev-insp-body", monitorBody(ctx)));
}

// ── View entry ─────────────────────────────────────────────────────────────
// (The F6 performance recorder card is gone — the LENS tab owns takes and
// transport now; it duplicated that surface.)

export function renderDeviceView(ctx) {
  const { store } = ctx;
  const { docs, link } = store.state;

  if (link.status !== "connected") {
    return h("div.device-grid.disconnected",
      h("div.device-disc",
        connectCard(ctx),
        backupCard(ctx)),
      bottomDrawer(ctx));
  }

  // The layout the mirror reflects (same rule the event-time resolver uses).
  const layout = mirrorLayoutOf(store.state);

  // Right column — the bank switcher (a press here = the app-side footswitch
  // press: push + activate) above the live mirror card (full faceplate
  // mimic). Page: the flip control or a held shift (the app-side SW2+SW3
  // peek); in stacked mode both pages render and this only feeds the
  // (unrendered) flip state.
  const page = devicePageOf(store.state);
  // No card header — the bank-dock switcher IS the top of the card
  // (+ snapshot moved to the Trigger pane's SNAPSHOTS section).
  const rightCard = h("section.rl-card.dev-mirror",
    layout && h("div.bank-dock",
      renderBankSwitcher(ctx, { view: "device", layout, page })),
    mirrorBody(ctx, layout, page));
  const rightCol = h("div.dev-center", rightCard);

  return h("div.device-grid",
    h("div.device-canvas", sourcesCard(ctx), rightCol, monitorCard(ctx)),
    bottomDrawer(ctx));
}
