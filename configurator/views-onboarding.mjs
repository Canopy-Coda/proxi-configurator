//
// views-onboarding.mjs — the empty states (design turn 5): 5a fresh app,
// 5b rig-but-no-layouts (preset generators with previews drawn from the
// rig's own pedal colors). The connect card (5c) lives in views-device.mjs.
//
import { h } from "./ui.mjs";
import { sideBySide, rowPerPedal } from "./presets.mjs";
import { emptyLayout, uniqueId } from "./model.mjs";

// Stylized device glyph: two knob rows around colored name-bar strips.
function deviceGlyph(colors) {
  const strip = (cs) => h("div.glyph-strip", {
    style: { background: cs.length
      ? `linear-gradient(90deg,${cs.map((c, i) => `${c} ${(i / cs.length) * 100}% ${((i + 1) / cs.length) * 100}%`).join(",")})`
      : "#26282c" },
  });
  const knobRow = () => h("div.glyph-knobs",
    Array.from({ length: 6 }, () => h("div.glyph-knob")));
  return h("div.device-glyph",
    knobRow(), strip(colors.slice(0, 4)), knobRow(), strip(colors.slice(4, 8).length ? colors.slice(4, 8) : colors.slice(0, 3)), knobRow());
}

export function welcomeScreen(ctx) {
  const { store, library } = ctx;
  const colors = library.pedals.slice(0, 8).map((p) => p.backgroundColor);
  const step = (n, title, body, extra) => h("div.step-card",
    h("span.step-n", {}, `STEP ${n}`),
    h("span.step-title", {}, title),
    h("span.step-body", {}, body),
    extra);
  return h("div.onboard",
    deviceGlyph(["#6C876D", "#C6BE9A", "#A8C8D6", "#DBB149", "#DA877B", "#906C88", "#212338"]),
    h("h1.onboard-h1", {}, "18 knobs, all of them yours."),
    h("p.onboard-sub", {},
      "Tell Proxi which Chase Bliss pedals you own, lay them across the surface, and every knob gets a label, a color, and a job."),
    h("div.step-row",
      step(1, "Build your rig",
        `Pick from ${library.pedals.length} pedals. Each gets a MIDI channel — we suggest the next free one.`,
        h("div.step-swatches",
          colors.slice(0, 3).map((c) => h("div.step-swatch", { style: { background: c } })),
          h("div.step-swatch.dashed"))),
      step(2, "Make a layout",
        "One-click presets give you a working surface. Then drag, swap, and macro to taste.",
        h("div.step-strip", { style: { background: "linear-gradient(90deg,#6C876D 0 50%,#C6BE9A 50% 100%)" } })),
      step(3, "Connect & push",
        "Plug in over USB, push, and watch the surface reconfigure live.",
        h("div.step-live",
          h("span.led", { style: { background: "#5fbf8f" } }),
          h("span.step-live-note", {}, "works without the device until then")))),
    h("div.onboard-cta",
      h("button.primary-btn.big", {
        onclick: () => store.update((s) => { s.view = "rig"; }),
      }, "BUILD YOUR RIG"),
      h("button.link-btn.dim", {
        onclick: () => store.update((s) => { s.view = "rig"; }),
      }, "or browse the library first")));
}

// ── 5b: preset generators ──────────────────────────────────────────────────

function makeSideBySide(store, pedalsById, chosenIds) {
  const byId = Object.fromEntries(store.state.docs.rig.instances.map((i) => [i.instanceId, i]));
  const [left, right] = chosenIds.map((id) => byId[id]);
  const name = `${pedalsById[left.pedalId].name} / ${pedalsById[right.pedalId].name}`.slice(0, 32);
  const taken = store.state.docs.layouts.map((l) => l.id);
  store.addLayout(sideBySide({
    id: uniqueId(`sbs-${left.instanceId}-${right.instanceId}`, taken),
    name, left, right, pedals: pedalsById,
  }));
}

function makeRowPerPedal(store, pedalsById, chosenIds) {
  const byId = Object.fromEntries(store.state.docs.rig.instances.map((i) => [i.instanceId, i]));
  const instances = chosenIds.map((id) => byId[id]).slice(0, 3);
  while (instances.length < 3) instances.push(null);
  const name = instances.filter(Boolean)
    .map((i) => pedalsById[i.pedalId].name.split(" ")[0]).join(" + ").slice(0, 32);
  const taken = store.state.docs.layouts.map((l) => l.id);
  store.addLayout(rowPerPedal({
    id: uniqueId(`rows-${instances.filter(Boolean).map((i) => i.instanceId).join("-")}`, taken),
    name, instances, pedals: pedalsById,
  }));
}

function makeBlank(store) {
  const taken = store.state.docs.layouts.map((l) => l.id);
  const n = store.state.docs.layouts.length + 1;
  store.addLayout(emptyLayout(uniqueId(`blank-${n}`, taken), `Layout ${n}`));
}

export function generatorScreen(ctx, { cancellable = false } = {}) {
  const { store, pedalsById } = ctx;
  const rig = store.state.docs.rig;
  const insts = rig.instances;
  const color = (i) => pedalsById[insts[i]?.pedalId]?.backgroundColor ?? null;

  const sbsPreview = h("div.gen-preview",
    Array.from({ length: 3 }, (_, r) => h("div.gen-row",
      h("div.gen-bar", { style: { background: color(0) ?? "#26282c", opacity: r === 2 ? .65 : 1 } }),
      h("div.gen-bar", { style: { background: color(1) ?? "#26282c", opacity: r === 2 ? .65 : 1 } }))));
  const rppPreview = h("div.gen-preview",
    Array.from({ length: 3 }, (_, r) => h("div.gen-row",
      h("div.gen-bar", { style: color(r)
        ? { background: color(r) } : { border: "1px dashed #33373d" } }))));
  const blankPreview = h("div.gen-preview",
    Array.from({ length: 3 }, () => h("div.gen-row", h("div.gen-bar.dashed"))));

  // Preset pedal picker (2026-07-11): Generate never auto-picks pedals — it
  // flips the card into a pick-from-your-rig step. Click order = placement
  // order (left half first / row 1 first). Transient UI state, not persisted.
  const pick = store.state.genPick; // { preset: 'sbs'|'rpp', chosen: [instanceId] }
  const picker = (preset, { min, max, hint }, create) => {
    const chosen = pick?.chosen ?? [];
    const chip = (inst) => {
      const at = chosen.indexOf(inst.instanceId);
      const pedal = pedalsById[inst.pedalId];
      return h("button.gen-pick-chip", {
        class: at >= 0 ? "on" : "",
        style: at >= 0 && pedal ? { background: pedal.backgroundColor, color: pedal.labelColor, borderColor: "transparent" } : {},
        onclick: () => store.update((s) => {
          const c = s.genPick.chosen;
          at >= 0 ? c.splice(at, 1) : c.length < max && c.push(inst.instanceId);
        }),
      }, at >= 0 && max > 1 ? `${at + 1} · ${inst.name ?? inst.instanceId}` : (inst.name ?? inst.instanceId));
    };
    return h("div.gen-pick",
      h("span.gen-pick-hint", {}, hint),
      h("div.gen-pick-chips", insts.map(chip)),
      h("div.gen-pick-actions",
        h("button.gen-btn", {
          disabled: chosen.length < min,
          onclick: () => { const ids = [...chosen]; store.update((s) => { s.genPick = null; }); create(ids); },
        }, chosen.length < min ? `pick ${min - chosen.length} more` : "CREATE"),
        h("button.link-btn.dim", {
          onclick: () => store.update((s) => { s.genPick = null; }),
        }, "back")));
  };

  const card = (title, preview, body, btnText, onGenerate, { dashed = false, disabled = false, pickUI = null } = {}) =>
    h("div.gen-card", { class: dashed ? "dashed" : "" },
      h("span.gen-title", {}, title),
      preview,
      pickUI || [
        h("span.gen-body", {}, body),
        h("button.gen-btn", { class: dashed ? "ghost-btn" : "", disabled, onclick: onGenerate }, btnText),
      ]);

  return h("div.onboard",
    h("h1.onboard-h2", {}, insts.length
      ? "Your rig is ready. Give it a surface."
      : "A layout maps your rig onto the 18 encoders."),
    h("p.onboard-sub", {},
      `A layout maps your ${insts.length} pedal${insts.length === 1 ? "" : "s"} onto the 18 encoders. Start from a preset — everything stays editable.`),
    h("div.gen-row-cards",
      card("Side-by-side", sbsPreview,
        "Two pedals, each gets a 3×3 half — you pick which two.",
        "Generate", () => store.update((s) => { s.genPick = { preset: "sbs", chosen: [] }; }),
        { disabled: insts.length < 2,
          pickUI: pick?.preset === "sbs" && picker("sbs",
            { min: 2, max: 2, hint: "pick 2 — first pick takes the LEFT half" },
            (ids) => makeSideBySide(store, pedalsById, ids)) }),
      card("Row per pedal", rppPreview,
        "Each pedal takes a full row of 6 — you pick which, top row first.",
        "Generate", () => store.update((s) => { s.genPick = { preset: "rpp", chosen: [] }; }),
        { disabled: insts.length < 1,
          pickUI: pick?.preset === "rpp" && picker("rpp",
            { min: 1, max: 3, hint: "pick up to 3 — in row order, top to bottom" },
            (ids) => makeRowPerPedal(store, pedalsById, ids)) }),
      card("Blank", blankPreview,
        "18 empty cells. Drag every binding yourself. For people who alphabetize their patch cables.",
        "Start empty", () => makeBlank(store), { dashed: true })),
    h("p.gen-footnote", {}, "presets are starting points, not templates — every cell stays editable afterward"),
    cancellable && h("button.link-btn.dim", {
      onclick: () => store.update((s) => { s.creatingLayout = false; }),
    }, "cancel"));
}
