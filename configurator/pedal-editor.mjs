//
// pedal-editor.mjs — the custom-pedal editor ("YOUR PEDALS"). Rendered as a
// full-view takeover on the RIG tab (views-rig.mjs editorTakeover, keyed by
// store.state.pedalEditorId).
// Custom pedals are authored docs (store.docs.pedals) with the exact
// pedal-library entry shape (contract pedal.schema.json), so they flow
// through resolution, layouts, and device push identically to library
// pedals. Every edit is one undo step; field edits skip the toast.
//
import { h } from "./ui.mjs";
import { uniqueId, newCustomPedal, controlPositions } from "./model.mjs";

const clamp7 = (v) => Math.max(0, Math.min(127, Number(v) || 0));
const upHex = (v) => v.toUpperCase();

// Shared with views: create a custom pedal (optionally cloning an existing
// one) and jump to its editor.
export function createCustomPedal(ctx, source = null) {
  const { store, library } = ctx;
  const taken = [...library.pedals, ...store.state.docs.pedals].map((p) => p.id);
  const id = uniqueId(source ? `${source.id.replace(/^cb-/, "")}-custom` : "my-pedal", taken);
  const pedal = source
    ? { ...structuredClone(source), id, name: `${source.name} copy`.slice(0, 32) }
    : newCustomPedal({ id, name: "My Pedal" });
  delete pedal.format; delete pedal.formatVersion; // in case a standalone doc ever lands here
  store.mutate(source ? `copied ${source.name} to your pedals` : "created a custom pedal", (s) => {
    s.docs.pedals.push(pedal);
    s.view = "rig";
    s.pedalEditorId = id;   // editing takes over the RIG view
  });
}

// One encoder cell editor (both pages share it).
function encEditor(page, i, pedal, edit) {
  const e = pedal.encoders[page][i];
  const key = `pedit-${page}-${i}`;
  const active = e.type !== "inactive";

  const setType = (type) => {
    if (type === e.type) return;
    edit(`encoder ${page}.${e.position} → ${type}`, (p) => {
      const enc = p.encoders[page][i];
      enc.type = type;
      if (type === "inactive") {
        Object.assign(enc, { label: "", cc: 0, defaultValue: 0,
          labelColor: "#000000", color: "#000000", highlightColor: "#000000" });
        delete enc.positions;
        delete enc.toggle;
      } else {
        // activate with the pedal's colors (white knob body, library-style)
        Object.assign(enc, { labelColor: p.labelColor, color: "#FFFFFF", highlightColor: p.labelColor });
        if (!enc.label) enc.label = e.position.replace(/([A-Z])/g, " $1").toUpperCase().trim();
        if (type === "toggle" && !enc.positions)
          enc.positions = [{ value: 0 }, { value: 64 }, { value: 127 }];
        if (type === "knob") { delete enc.positions; delete enc.toggle; }
      }
    });
  };

  const num = (label, value, onset, focusSuffix) => h("label.pedit-num",
    h("span", {}, label),
    h("input.num", {
      type: "number", min: 0, max: 127, value,
      dataset: { focusKey: `${key}-${focusSuffix}` },
      onchange: (ev) => onset(clamp7(ev.target.value)),
    }));

  return h("div.pedit-enc", { class: active ? "" : "off" },
    h("div.pedit-enc-head",
      h("span.pedit-pos", {}, e.position),
      h("div.segmented.sm",
        [["knob", "knob"], ["toggle", "toggle"], ["–", "inactive"]].map(([label, t]) =>
          h("button.seg", { class: e.type === t ? "on" : "", onclick: () => setType(t) }, label)))),
    active && h("div.pedit-enc-body",
      h("input.inst-name.pedit-label", {
        value: e.label, maxLength: 15, placeholder: "label",
        dataset: { focusKey: `${key}-label` },
        onchange: (ev) => edit(`relabeled ${page}.${e.position}`, (p) => {
          p.encoders[page][i].label = ev.target.value.slice(0, 15);
        }),
      }),
      h("div.pedit-nums",
        num("cc", e.cc, (v) => edit(`cc for ${page}.${e.position}`, (p) => {
          p.encoders[page][i].cc = v;
        }), "cc"),
        num("default", e.defaultValue, (v) => edit(`default for ${page}.${e.position}`, (p) => {
          p.encoders[page][i].defaultValue = v;
        }), "def")),
      e.type === "toggle" && h("div.pedit-nums",
        (controlPositions(e) ?? [{ value: 0 }, { value: 64 }, { value: 127 }]).map((p0, pi) =>
          num(p0.label || `pos ${pi + 1}`, p0.value, (v) => edit(`position ${pi + 1} value`, (p) => {
            const enc = p.encoders[page][i];
            // normalize legacy toggle docs to positions on first edit
            const pos = enc.positions ??= (controlPositions(enc) ?? [{ value: 0 }, { value: 64 }, { value: 127 }])
              .map((x) => ({ ...x }));
            delete enc.toggle;
            pos[pi] = { ...pos[pi], value: v };
          }), `tg-${pi}`)))));
}

function footswitchEditor(side, pedal, edit) {
  const fs = pedal.footswitches[side];
  const key = `pedit-fs-${side}`;
  return h("div.lib-fs",
    h("span.lib-fs-pos", {}, side.toUpperCase()),
    h("input.inst-name.pedit-label", {
      value: fs.label, maxLength: 15,
      dataset: { focusKey: `${key}-label` },
      onchange: (ev) => edit(`footswitch ${side} label`, (p) => {
        p.footswitches[side].label = ev.target.value.slice(0, 15);
      }),
    }),
    h("label.pedit-num", h("span", {}, "cc"),
      h("input.num", {
        type: "number", min: 0, max: 127, value: fs.cc,
        dataset: { focusKey: `${key}-cc` },
        onchange: (ev) => edit(`footswitch ${side} cc`, (p) => {
          p.footswitches[side].cc = clamp7(ev.target.value);
        }),
      })));
}

export function renderPedalEditor(ctx, pedal) {
  const { store } = ctx;
  const idx = store.state.docs.pedals.findIndex((p) => p.id === pedal.id);
  const edit = (label, fn) => store.mutate(label, (s) => fn(s.docs.pedals[idx]), { toast: null });

  const colorInput = (label, prop) => h("label.pedit-color",
    h("span", {}, label),
    h("input", {
      type: "color", value: pedal[prop],
      onchange: (ev) => edit(`pedal ${label} color`, (p) => {
        p[prop] = upHex(ev.target.value);
        // custom pedals keep uniform colors: active encoders follow the pedal
        for (const page of ["normal", "hidden"])
          for (const e of p.encoders[page])
            if (e.type !== "inactive") {
              e.labelColor = p.labelColor;
              e.highlightColor = p.labelColor;
            }
      }),
    }));

  const page = (name) => h("div.lib-page",
    h("span.insp-title", {}, name.toUpperCase() + " PAGE"),
    h("div.lib-page-grid.pedit-grid", { style: { background: pedal.backgroundColor } },
      pedal.encoders[name].map((_, i) => encEditor(name, i, pedal, edit))));

  return h("section.lib-detail",
    h("div.lib-head", { style: { background: pedal.backgroundColor, color: pedal.labelColor } },
      h("input.inst-name.pedit-name", {
        value: pedal.name, maxLength: 32, style: { color: pedal.labelColor },
        dataset: { focusKey: "pedit-name" },
        onchange: (ev) => edit(`renamed pedal`, (p) => { p.name = ev.target.value.slice(0, 32) || p.name; }),
      }),
      h("code.lib-id", {}, pedal.id),
      h("span.pedit-badge", {}, "CUSTOM"),
      // deleting lives in the pedal's reference modal (confirmed there) —
      // the editor only duplicates
      h("span.pedit-head-actions",
        h("button.ghost-btn.sm", { onclick: () => createCustomPedal(ctx, pedal) }, "duplicate"))),
    h("div.pedit-colors",
      colorInput("background", "backgroundColor"),
      colorInput("label", "labelColor")),
    pedal.snapshots?.length ? h("div.lib-page",
      h("span.insp-title", {}, "SNAPSHOTS"),
      pedal.snapshots.map((snap, si) => h("div.lib-snap",
        h("div.lib-snap-main",
          h("span.lib-snap-name", {}, snap.name),
          h("span.libenc-cc", {}, `${Object.keys(snap.values).length} values`)),
        h("button.icon-btn", {
          title: "delete this snapshot",
          onclick: () => edit(`deleted snapshot "${snap.name}"`, (p) => {
            p.snapshots.splice(si, 1);
            if (!p.snapshots.length) delete p.snapshots;
          }),
        }, "✕"))),
      h("div.insp-hint", {},
        "snapshots ride the pedal doc — apply them from the pedal's reference modal or the DEVICE tab")) : null,
    page("normal"),
    page("hidden"),
    h("div.lib-page",
      h("span.insp-title", {}, "FOOTSWITCHES"),
      h("div.lib-fs-row",
        footswitchEditor("left", pedal, edit),
        footswitchEditor("right", pedal, edit))),
    h("div.pane-footnote", {},
      "custom pedals behave exactly like library ones — add to your pedalboard, place in layouts, push to the device · dip-switch banks aren't editable yet"));
}
