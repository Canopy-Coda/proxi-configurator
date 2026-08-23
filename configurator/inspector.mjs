//
// inspector.mjs — the right-hand inspector of the Layouts view (design 7a
// for encoder cells, 4a/4b for footswitches, 4c for omniports). Contents
// depend on the current selection; every commit is one undo step.
//
import { h, segmented } from "./ui.mjs";
import {
  resolveCell, resolveBinding, controlAt, cellName, ensurePageArrays,
} from "./model.mjs";
import {
  addTargetSection, openPickerReplace, pickerReplacing, PERF_ACTION_HINT,
} from "./target-picker.mjs";

const MONO_HEAD = "insp-head";

function section(title, ...children) {
  return h("div.insp-section", {}, h("span.insp-title", {}, title), ...children);
}


// The interaction a fresh cell gets for a target: mirror the drop path —
// toggle-type controls land as toggles, everything else (knobs, raw CC,
// performances) as knobs.
function interactionFor(target, rig, pedalsById) {
  if (!target.instance) return "knob";
  const inst = rig.instances.find((i) => i.instanceId === target.instance);
  const ctl = inst && controlAt(pedalsById[inst.pedalId], target.control);
  return ctl?.type === "toggle" ? "toggle" : "knob";
}

function labelColorRow({ rc, inherited, onLabel, onColor, onReset }) {
  const row = h("div.label-row",
    h("input.label-input", {
      value: rc.label, dataset: { focusKey: "insp-label" }, maxLength: 12,
      onchange: (e) => onLabel(e.target.value.trim() || null),
    }),
    (rc.labelOverridden || rc.colorOverridden) && h("span.badge.override", {}, "OVERRIDE"),
    h("input.swatch", {
      type: "color", value: rc.color,
      onchange: (e) => onColor(e.target.value),
    }));
  return section("LABEL & COLOR", row,
    (rc.labelOverridden || rc.colorOverridden) &&
      h("button.link-btn", { onclick: onReset }, `↺ reset to inherited (${inherited ?? "—"})`));
}

function bindingRow(b, i, { detail, onRemove, onTransform, onChange = null, changing = false, extra = null }) {
  const spine = h("div.spine", { style: { background: b.pedal?.backgroundColor ?? "#33373d" } });
  const name = b.raw ? `raw ch${b.channel} / CC ${b.cc}`
    : b.perf ? `performance / ${b.perf.id}`
    : `${b.instance?.instanceId ?? "?"} / ${b.label}`;
  if (b.perf) onTransform = null;    // transforms don't apply to perf actions
  const row = h("div.binding-row", {
    class: `${onChange ? "tp-changeable" : ""}${changing ? " tp-changing" : ""}`,
    title: onChange ? "click to change this target" : null,
    // row click = change this target in the picker; controls inside keep theirs
    onclick: onChange
      ? (e) => { if (!e.target.closest("button, input, label")) onChange(name); }
      : null,
  },
    spine,
    h("div.binding-main",
      h("div.binding-name", {}, name),
      h("div.binding-sub", {}, detail)),
    h("button.icon-btn", { title: "remove target", onclick: onRemove }, "✕"));
  if (!onTransform) return row;
  const t = b.transform ?? {};
  const lo = t.invert ? (t.max ?? 127) : (t.min ?? 0);
  const hi = t.invert ? (t.min ?? 0) : (t.max ?? 127);
  return h("div.binding-block", row,
    h("div.binding-edit",
      h("label", {}, "range",
        h("input.num", { type: "number", min: 0, max: 127, value: t.min ?? 0,
          onchange: (e) => onTransform({ ...t, min: clamp7(e.target.value) }) }),
        "–",
        h("input.num", { type: "number", min: 0, max: 127, value: t.max ?? 127,
          onchange: (e) => onTransform({ ...t, max: clamp7(e.target.value) }) })),
      h("label.inv", {},
        h("input", { type: "checkbox", checked: !!t.invert,
          onchange: (e) => onTransform({ ...t, invert: e.target.checked }) }),
        h("span", { class: t.invert ? "amber" : "" }, "inverted")),
      extra),
    onTransform && t.invert && h("div.binding-note.amber", {}, `sweeps ${lo} → ${hi}`));
}

const clamp7 = (v) => Math.max(0, Math.min(127, Number(v) || 0));

// ── Encoder cell inspector (7a right pane) ─────────────────────────────────

function encoderInspector(ctx) {
  const { store, layout, rig, pedalsById, index } = ctx;
  // ctx.layout is the current PAGE's view (model.mjs pageView) — reads come
  // from it; writes resolve the stored doc and address the same page.
  const cell = layout.encoders[index];
  const rc = resolveCell(cell, rig, pedalsById, ctx.live);
  const edit = (label, fn, opts) => store.mutate(label, (s) => {
    const l = s.docs.layouts.find((x) => x.id === layout.id);
    const a = ensurePageArrays(l, ctx.page);
    fn(a, a.encoders[index], (c) => (a.encoders[index] = c));
  }, opts);

  const head = h("div." + MONO_HEAD,
    h("span.insp-id", {}, `CELL ${cellName(index)}`),
    ctx.page === "hidden" && h("span.insp-tag.hidden-tag", {}, "HIDDEN PAGE"),
    h("span.insp-tag", {}, !rc ? "empty" : rc.macro ? "macro encoder" : rc.interaction));

  const subject = `CELL ${cellName(index)}`;
  const pickerCfg = () => ({
    kind: "encoder",
    subject,
    modeTag: rc ? (rc.macro ? "macro" : rc.interaction) : "empty",
    cell,
    onSnapshot: null,          // snapshots bind to footswitches & CC-set slots
    onReplace: (i, target) => edit(`changed target on ${cellName(index)}`, (_, c) => {
      c.bindings[i].target = target;
    }),
    onTarget: (target) => {
      const what = target.performance ? "performance" : target.raw ? "raw CC" : "target";
      if (!layout.encoders[index]) {
        const label = what === "target" ? `bound ${cellName(index)}` : `bound ${what} to ${cellName(index)}`;
        edit(label, (l) => {
          l.encoders[index] = { interaction: interactionFor(target, rig, pedalsById), bindings: [{ target }] };
        });
      } else {
        edit(`added ${what} to ${cellName(index)}`, (_, c) => c.bindings.push({ target }));
      }
    },
  });

  if (!rc) {
    return [head, h("div.insp-hint", {},
      "empty cell — drag a control here from the rig shelf, or browse every source below"),
      addTargetSection(ctx, pickerCfg())];
  }

  const inheritedLabel = rc.bindings[0]?.ok && !rc.bindings[0].raw ? rc.bindings[0].label : null;

  const nodes = [head];

  nodes.push(labelColorRow({
    rc, inherited: inheritedLabel,
    onLabel: (v) => edit(`renamed ${cellName(index)}`, (_, c) => {
      if (v) c.label = v; else delete c.label;
    }),
    onColor: (v) => edit(`recolored ${cellName(index)}`, (_, c) => { c.color = v; }),
    onReset: () => edit(`reset ${cellName(index)} to inherited`, (_, c) => {
      delete c.label; delete c.color;
    }),
  }));

  nodes.push(section("INTERACTION",
    segmented([{ label: "Knob", value: "knob" }, { label: "Toggle", value: "toggle" }],
      rc.interaction,
      (v) => edit(`${cellName(index)} → ${v}`, (_, c) => { c.interaction = v; }))));

  const bindings = h("div.bindings",
    rc.bindings.map((b, i) => bindingRow(b, i, {
      onChange: (name) => openPickerReplace(store, subject, cell.bindings[i]?.target, name),
      changing: pickerReplacing(store, subject, cell.bindings[i]?.target),
      detail: b.perf ? `${b.perf.action} · ${PERF_ACTION_HINT[b.perf.action]}`
        : b.raw ? `channel ${b.channel}` :
        `CC ${b.cc ?? "?"} · range ${fmtRange(b.transform)}${b.transform?.invert ? " · " : ""}` ,
      onRemove: () => edit(
        rc.bindings.length > 1 ? `removed target from ${cellName(index)}` : `cleared ${cellName(index)}`,
        (l, c) => {
          c.bindings.splice(i, 1);
          if (!c.bindings.length) l.encoders[index] = null;
        }),
      onTransform: (t) => edit(`edited target range`, (_, c) => {
        c.bindings[i].transform = t;
      }, { toast: null }),
    })));

  nodes.push(section(`BINDINGS · ${rc.bindings.length}`,
    bindings,
    rc.macro && h("div.insp-hint", {}, "one turn moves every target — a macro encoder")));

  nodes.push(addTargetSection(ctx, pickerCfg()));

  nodes.push(h("div.insp-footer",
    h("button.ghost-btn", { onclick: () => edit(`cleared ${cellName(index)}`, (l) => {
      l.encoders[index] = null;
    }, { edit: null }) }, "Clear cell"),
    h("button.ghost-btn", {
      disabled: !(rc.labelOverridden || rc.colorOverridden || rc.macro),
      title: "drop overrides and extra targets — back to the plain inherited binding",
      onclick: () => edit(`reset ${cellName(index)}`, (_, c) => {
        delete c.label; delete c.color;
        c.bindings = c.bindings.slice(0, 1);
      }),
    }, "Reset cell")));

  return nodes;
}

const fmtRange = (t) => `${t?.min ?? 0}–${t?.max ?? 127}`;

// ── Footswitch inspector (4a / 4b) ─────────────────────────────────────────

function footswitchInspector(ctx) {
  const { store, layout, rig, pedalsById, index, gestures, live } = ctx;
  const cell = layout.footswitches[index];
  const rc = resolveCell(cell, rig, pedalsById, live);
  const edit = (label, fn, opts) => store.mutate(label, (s) => {
    const l = s.docs.layouts.find((x) => x.id === layout.id);
    const a = ensurePageArrays(l, ctx.page);
    fn(a, a.footswitches[index]);
  }, opts);

  const head = h("div." + MONO_HEAD,
    h("span.insp-id", {}, `FOOTSWITCH ${index + 1}`),
    ctx.page === "hidden" && h("span.insp-tag.hidden-tag", {}, "HIDDEN PAGE"),
    h("span.insp-tag", {}, rc ? (rc.mode === "send" ? "CC set" : "LED: pedal color") : "empty"));

  // Binding a snapshot puts the switch in CC-set mode and expands the scene
  // into ordinary {target, on} rows (handoff decision: expand at bind time —
  // editable afterwards like any scene, no live reference to the snapshot).
  const onSnapshot = (sceneBindings, name) => {
    const label = `bound "${name}" · FS${index + 1} → CC set`;
    edit(label, (l, c) => {
      if (!c) l.footswitches[index] = { mode: "send", bindings: sceneBindings };
      else { c.mode = "send"; c.bindings.push(...sceneBindings); }
    });
  };

  const subject = `FOOTSWITCH ${index + 1}`;
  const pickerCfg = () => ({
    kind: rc?.mode === "send" ? "scene" : "switch",
    subject,
    modeTag: rc ? (rc.mode === "send" ? "CC set" : rc.mode) : "empty",
    cell,
    onSnapshot,
    onReplace: (i, target) => edit(`changed FS${index + 1} target`, (_, c) => {
      c.bindings[i].target = target;
    }),
    onTarget: (target) => {
      if (!layout.footswitches[index]) {
        edit(target.performance ? `bound FS${index + 1} to a performance` : `bound FS${index + 1}`, (l) => {
          l.footswitches[index] = { mode: "toggle",
            bindings: [target.performance ? { target } : { target, on: 127, off: 0 }] };
        });
      } else if (rc?.mode === "send") {
        edit(`added scene target`, (_, c) => c.bindings.push({ target, on: 64 }));
      } else if (!cell.bindings?.length) {
        edit(`bound FS${index + 1}`, (_, c) =>
          c.bindings.push(target.performance ? { target } : { target, on: 127, off: 0 }));
      } else {
        edit(target.performance ? `added performance to FS${index + 1}` : `added target to FS${index + 1}`,
          (_, c) => c.bindings.push(target.performance ? { target } : { target, on: 127, off: 0 }));
      }
    },
  });

  if (!rc) {
    return [head, h("div.insp-hint", {},
      "empty — drag a footswitch chip here from a rig card (fs ×2), or browse every source below"),
      addTargetSection(ctx, pickerCfg())];
  }

  const nodes = [head];

  nodes.push(labelColorRow({
    rc, inherited: rc.bindings[0]?.ok && !rc.bindings[0].raw ? rc.bindings[0].label : null,
    onLabel: (v) => edit(`renamed FS${index + 1}`, (_, c) => {
      if (v) c.label = v; else delete c.label;
    }),
    onColor: (v) => edit(`recolored FS${index + 1}`, (_, c) => { c.color = v; }),
    onReset: () => edit(`reset FS${index + 1} label`, (_, c) => {
      delete c.label; delete c.color;
    }),
  }));

  nodes.push(section("MODE",
    segmented([
      { label: "Toggle", value: "toggle" },
      { label: "Momentary", value: "momentary" },
      { label: "CC set", value: "send" },
      { label: "Cycle", value: "cycle" },
    ], rc.mode, (v) => edit(`FS${index + 1} → ${v}`, (_, c) => { c.mode = v; }))));

  if (rc.mode === "cycle") {
    nodes.push(section("BINDING",
      h("div.bindings", rc.bindings.map((b, i) => bindingRow(b, i, {
        detail: b.raw ? `channel ${b.channel}` : `${b.raw ? "" : cellPath(b)} · CC ${b.cc ?? "?"}`,
        onRemove: () => edit(`cleared FS${index + 1}`, (l) => { l.footswitches[index] = null; }),
      }))),
      h("div.insp-hint", {}, rc.positions?.length
        ? `each press advances: ${rc.positions.map((p, i) => p.label || `pos ${i + 1}`).join(" → ")} → …`
        : "cycle needs a control with discrete positions (a toggle or arcade button)")));
  } else if (rc.mode === "send") {
    nodes.push(section(`ON PRESS · SEND · ${rc.bindings.length}`,
      h("div.bindings", rc.bindings.map((b, i) => {
        const name = b.raw ? `raw ch${b.channel} / CC ${b.cc}`
          : b.perf ? `performance / ${b.perf.id}`
          : `${b.instance?.instanceId} / ${b.label}`;
        return h("div.binding-row", {
          class: `tp-changeable${pickerReplacing(store, subject, cell.bindings[i]?.target) ? " tp-changing" : ""}`,
          title: "click to change this target",
          onclick: (e) => {
            if (!e.target.closest("button, input, label"))
              openPickerReplace(store, subject, cell.bindings[i]?.target, name);
          },
        },
          h("div.spine", { style: { background: b.pedal?.backgroundColor ?? "#33373d" } }),
          h("div.binding-main",
            h("div.binding-name", {}, name),
            h("div.binding-sub", {}, b.perf
              ? `${b.perf.action} · rides along — not a CC value`
              : `CC ${b.cc ?? "?"}`)),
          // performance actions have no scene value — a press just fires them
          !b.perf && h("span.send-val", {}, "→ ",
            h("input.num", { type: "number", min: 0, max: 127, value: b.on ?? 127,
              onchange: (e) => edit("edited scene value", (_, c) => {
                c.bindings[i].on = clamp7(e.target.value);
              }, { toast: null }) })),
          h("button.icon-btn", { onclick: () => edit("removed scene target", (l, c) => {
            c.bindings.splice(i, 1);
            if (!c.bindings.length) l.footswitches[index] = null;
          }) }, "✕"));
      })),
      h("button.link-btn", {
        title: "set every target's value from the current live state",
        onclick: () => edit("captured current values", (_, c) => {
          for (const b of c.bindings) {
            const r = resolveBinding(b, rig, pedalsById);
            if (r.ok && !r.perf) b.on = live[`${r.channel}:${r.cc}`] ?? r.control?.defaultValue ?? b.on ?? 0;
          }
        }),
      }, "capture now"),
      h("div.insp-hint", {}, "values are absolute — a scene sets controls, it doesn't toggle them")));
  } else {
    nodes.push(section("BINDING",
      h("div.bindings", rc.bindings.map((b, i) => bindingRow(b, i, {
        onChange: (name) => openPickerReplace(store, subject, cell.bindings[i]?.target, name),
        changing: pickerReplacing(store, subject, cell.bindings[i]?.target),
        detail: b.raw ? `channel ${b.channel}` : `${b.raw ? "" : cellPath(b)} · CC ${b.cc ?? "?"}`,
        onRemove: () => edit(
          rc.bindings.length > 1 ? `removed target from FS${index + 1}` : `cleared FS${index + 1}`,
          (l, c) => {
            c.bindings.splice(i, 1);
            if (!c.bindings.length) l.footswitches[index] = null;
          }),
      })))));

    // The unified picker allows several targets on one toggle/momentary
    // switch, so on/off writes go to EVERY non-performance binding (they all
    // flip together); the display reads the first. Performance bindings
    // carry no CC values — a switch holding only those hides the section.
    const isPerf = (b) => !!b?.target?.performance;
    const b0 = cell.bindings.find((b) => !isPerf(b)) ?? null;
    const setAll = (key) => (e) => edit(`edited ${key} value`, (_, c) => {
      for (const b of c.bindings) if (!isPerf(b)) b[key] = clamp7(e.target.value);
    }, { toast: null });
    if (b0) nodes.push(section(rc.mode === "toggle" ? "TOGGLE VALUES" : "PRESS / RELEASE VALUES",
      h("div.onoff-row",
        h("label.onoff", {}, rc.mode === "toggle" ? "on" : "press",
          h("input.num", { type: "number", min: 0, max: 127, value: b0.on ?? 127,
            onchange: setAll("on") })),
        h("label.onoff", {}, rc.mode === "toggle" ? "off" : "release",
          h("input.num", { type: "number", min: 0, max: 127, value: b0.off ?? 0,
            onchange: setAll("off") }))),
      cell.bindings.filter((b) => !isPerf(b)).length > 1
        && h("div.insp-hint", {}, "applies to every target on this switch")));
  }

  // Cycle mode drives ONE control's positions — adding more targets makes no
  // sense there, so cycle only gets the picker while it has no binding yet.
  if (rc.mode !== "cycle" || !rc.bindings.length)
    nodes.push(addTargetSection(ctx, pickerCfg()));

  // Reserved combos are firmware-advertised (STATUS.gestures) — never local.
  const reserved = Object.entries(gestures ?? {})
    .filter(([, g]) => (g?.switches ?? g?.fs ?? []).includes?.(index));
  nodes.push(section("LONG PRESS",
    reserved.length
      ? h("div.reserved-block", {},
          `unavailable in combo — reserved by firmware (${reserved.map(([n]) => n).join(", ")})`)
      : h("div.insp-hint", {},
          store.state.link.status === "connected"
            ? "no firmware-reserved combos on this switch"
            : "reserved combos are advertised by the device on connect")));

  return nodes;
}

const cellPath = (b) => b.instance ? `footswitch` : "";

// ── Omniport inspector (4c) ────────────────────────────────────────────────

function omniportInspector(ctx) {
  const { store, layout, rig, pedalsById, index, live, link } = ctx;
  const mode = rig.omniports?.[index]?.mode ?? "unused";
  const cell = layout.omniports[index];
  const rc = resolveCell(cell, rig, pedalsById, live);
  const editLayout = (label, fn, opts) => store.mutate(label, (s) => {
    const l = s.docs.layouts.find((x) => x.id === layout.id);
    fn(l, l.omniports[index]);
  }, opts);

  const nodes = [h("div." + MONO_HEAD,
    h("span.insp-id", {}, `OMNIPORT ${index + 1}`),
    h("span.insp-tag", {}, "rig-level · all layouts"))];

  // Mode is RIG-level (physical setup), targets are per-layout.
  nodes.push(segmented([
    { label: "Expression", value: "expression" },
    { label: "Aux switches", value: "aux" },
    { label: "Unused", value: "unused" },
  ], mode, (v) => store.mutate(`omniport ${index + 1} → ${v}`, (s) => {
    s.docs.rig.omniports[index] = { mode: v };
  })));

  if (mode === "unused") {
    nodes.push(h("div.insp-hint", {}, "set a mode to give this port targets (mode is part of the rig — it describes what's plugged in)"));
    return nodes;
  }

  // Expression kind = encoder chip rules + scrub-only performances (heel→toe
  // IS the sweep); aux switches behave like footswitches minus CC-set.
  const subject = `OMNIPORT ${index + 1}`;
  const pickerCfg = () => ({
    kind: mode === "aux" ? "switch" : "expression",
    subject,
    modeTag: mode,
    cell,
    onSnapshot: null,          // omniports have no CC-set mode
    onReplace: (i, target) => editLayout(`changed omni ${index + 1} target`, (_, c) => {
      c.bindings[i].target = target;
    }),
    onTarget: (target) => {
      if (!layout.omniports[index]) {
        editLayout(target.performance
          ? `bound omni ${index + 1} to a performance` : `added omni ${index + 1} target`, (l) => {
          l.omniports[index] = mode === "aux"
            ? { mode: "toggle", bindings: [target.performance ? { target } : { target, on: 127, off: 0 }] }
            : { bindings: [{ target }] };
        });
      } else {
        editLayout(target.performance
          ? `added performance to omni ${index + 1}` : `added omni ${index + 1} target`,
          (_, c) => c.bindings.push(
            mode === "aux" && !target.performance ? { target, on: 127, off: 0 } : { target }));
      }
    },
  });

  if (!rc) {
    nodes.push(h("div.insp-hint", {}, "no targets in this layout yet"),
      addTargetSection(ctx, pickerCfg()));
    return nodes;
  }

  nodes.push(h("div.label-row",
    h("input.label-input", {
      value: rc.label, dataset: { focusKey: "omni-label" }, maxLength: 12,
      onchange: (e) => editLayout(`renamed omni ${index + 1}`, (_, c) => {
        const v = e.target.value.trim();
        if (v) c.label = v; else delete c.label;
      }),
    }),
    rc.labelOverridden && h("span.badge.override", {}, "LABEL")));

  nodes.push(section(`TARGETS · ${rc.bindings.length}`,
    h("div.bindings", rc.bindings.map((b, i) => bindingRow(b, i, {
      onChange: (name) => openPickerReplace(store, subject, cell.bindings[i]?.target, name),
      changing: pickerReplacing(store, subject, cell.bindings[i]?.target),
      detail: `CC ${b.cc ?? "?"} · range ${fmtRange(b.transform)}`,
      onRemove: () => editLayout(`removed omni target`, (l, c) => {
        c.bindings.splice(i, 1);
        if (!c.bindings.length) l.omniports[index] = null;
      }),
      onTransform: (t) => editLayout("edited omni range", (_, c) => {
        c.bindings[i].transform = t;
      }, { toast: null }),
    })))));

  nodes.push(addTargetSection(ctx, pickerCfg()));

  if (mode === "expression") nodes.push(heelToePreview(rc, ctx));
  nodes.push(h("div.insp-hint", {}, "omniport mode is rig-level; the target list is per-layout"));
  return nodes;
}

// Heel→toe preview scrubber: computed values update live, and go to the
// device over MIDI when connected. Position lives in inspForm and the whole
// section renders from it — imperative readout/target updates would land on
// morph-discarded nodes (same failure as the old bind sections).
const scrubValue = (b, pos) => {
  const t = b.transform ?? {};
  const lo = t.min ?? 0, hi = t.max ?? 127;
  return Math.round(t.invert ? hi - (hi - lo) * pos : lo + (hi - lo) * pos);
};

function heelToePreview(rc, ctx) {
  const { store } = ctx;
  const pct = Math.max(0, Math.min(100, Number(store.state.inspForm.scrubPos) || 0));
  const targets = h("div.preview-targets", {},
    rc.bindings.filter((b) => b.ok).map((b) => {
      const t = b.transform ?? {};
      const lo = t.min ?? 0, hi = t.max ?? 127;
      return h("div.preview-target",
        h("div.pt-head", { style: { color: b.pedal?.backgroundColor ?? "#e8e6e1" } },
          `${b.label} · ${b.instance?.instanceId ?? "raw"}`),
        h("div.pt-val", {}, String(scrubValue(b, pct / 100))),
        h("div.pt-range", { class: t.invert ? "amber" : "" },
          t.invert ? `range ${hi} → ${lo} · inverted` : `range ${lo} → ${hi}`));
    }));
  const slider = h("input.scrubber", {
    type: "range", min: 0, max: 100, value: pct,
    oninput: (e) => {
      const pos = Number(e.target.value) / 100;
      for (const b of rc.bindings) {
        if (!b.ok) continue;
        ctx.linkApi?.sendCC(b.channel, b.cc, scrubValue(b, pos));
      }
      store.update((s) => { s.inspForm.scrubPos = e.target.value; });
    },
  });
  return section("HEEL→TOE PREVIEW",
    h("div.scrub-row", h("span.scrub-end", {}, "HEEL"),
      h("span.pos-readout", {}, `position ${pct}%`), h("span.scrub-end", {}, "TOE")),
    slider, targets,
    h("div.insp-hint", {}, ctx.link.status === "connected"
      ? "targets update live on the device too"
      : "drag to preview — connects go live on the device"));
}

// ── Entry ──────────────────────────────────────────────────────────────────

export function renderInspector(ctx) {
  const { selection } = ctx;
  const pane = h("aside.inspector");
  if (!selection) {
    // no mono INSPECTOR head — the card header above already carries the title
    pane.append(
      h("div.insp-hint", {},
        "click a cell, footswitch, or omniport on the faceplate to edit it — or drag controls in from the rig shelf"));
    return pane;
  }
  const parts = selection.type === "encoder" ? encoderInspector({ ...ctx, index: selection.index })
    : selection.type === "footswitch" ? footswitchInspector({ ...ctx, index: selection.index })
    : omniportInspector({ ...ctx, index: selection.index });
  // phone bottom-sheet dismissal — hidden on desktop (no deselect affordance there
  // beyond picking elsewhere, which touch users don't discover)
  pane.append(h("button.insp-close", {
    onclick: () => ctx.store.update((s) => { s.selection = null; }),
  }, "done"));
  pane.append(...parts);
  return pane;
}
