//
// presets.mjs — one-click layout generators (contract-v2.md §8, vision §1-2).
//
// Pure document generators: firmware knows nothing about presets. The
// side-by-side generator must reproduce companion/contract/fixtures/
// layout-side-by-side.json structurally (test/presets-golden.mjs pins that),
// since fixtures and app share one definition of the canonical layout.
//

const ROWS = ["top", "middle", "bottom"];
const COLS = ["Left", "Center", "Right"];
const pos = (r, c) => `${ROWS[r]}${COLS[c]}`;

function controlAt(pedal, position, page = "normal") {
  return pedal.encoders[page].find((e) => e.position === position);
}

function encoderCell(instanceId, pedal, position, page = "normal") {
  const ctl = controlAt(pedal, position, page);
  if (!ctl || ctl.type === "inactive") return null;
  return {
    interaction: ctl.type, // knob | toggle
    bindings: [{ target: { instance: instanceId, control: `${page}.${position}` } }],
  };
}

function footswitchCell(instanceId, side) {
  return {
    mode: "toggle",
    bindings: [{ target: { instance: instanceId, control: `footswitch.${side}` } }],
  };
}

// The canonical "two v1 Proxis" split: left pedal on columns 0-2, right pedal
// on columns 3-5, each 3×3 half mirroring the pedal's own layout (bottom row
// = its toggles); all four footswitches assigned, expression port sweeping
// both pedals' topCenter controls (second inverted) when it's enabled.
export function sideBySide({ id, name, left, right, pedals, withExpression = true }) {
  const pL = pedals[left.pedalId], pR = pedals[right.pedalId];
  const encoders = [], hiddenEncoders = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 6; c++) {
      const [inst, p, position] = c < 3
        ? [left.instanceId, pL, pos(r, c)]
        : [right.instanceId, pR, pos(r, c - 3)];
      encoders.push(encoderCell(inst, p, position));
      hiddenEncoders.push(encoderCell(inst, p, position, "hidden"));
    }
  }
  const footswitches = [
    footswitchCell(left.instanceId, "left"),
    footswitchCell(left.instanceId, "right"),
    footswitchCell(right.instanceId, "left"),
    footswitchCell(right.instanceId, "right"),
  ];
  // hidden page (contract §9.4): each pedal's hidden controls under the same
  // knobs; the footswitches keep their functions while it is shown. Omitted
  // entirely when neither pedal has hidden controls.
  const hidden = hiddenEncoders.some(Boolean)
    ? {
        encoders: hiddenEncoders,
        footswitches: [
          footswitchCell(left.instanceId, "left"),
          footswitchCell(left.instanceId, "right"),
          footswitchCell(right.instanceId, "left"),
          footswitchCell(right.instanceId, "right"),
        ],
      }
    : undefined;
  return {
    format: "proxi-layout", formatVersion: 1, id, name,
    encoders,
    footswitches,
    ...(hidden ? { hidden } : {}),
    omniports: [
      withExpression
        ? {
            bindings: [
              { target: { instance: left.instanceId, control: "normal.topCenter" } },
              { target: { instance: right.instanceId, control: "normal.topCenter" },
                transform: { invert: true } },
            ],
            label: "MORPH",
          }
        : null,
      null,
    ],
  };
}

// Row-per-pedal: up to 3 instances, one per 6-encoder row — the pedal's six
// knobs in reading order (top row then middle row). Toggles are deliberately
// not exposed (vision §1: bank to a full layout, or the hidden page — which
// this generator now fills with the same six positions' hidden counterparts).
// Footswitch i = pedal i's right footswitch (the bypass on most CB pedals).
export function rowPerPedal({ id, name, instances, pedals }) {
  const KNOB_ORDER = ["topLeft", "topCenter", "topRight",
                      "middleLeft", "middleCenter", "middleRight"];
  const encoders = [], hiddenEncoders = [];
  for (let r = 0; r < 3; r++) {
    const inst = instances[r];
    if (!inst) {
      encoders.push(null, null, null, null, null, null);
      hiddenEncoders.push(null, null, null, null, null, null);
      continue;
    }
    const pedal = pedals[inst.pedalId];
    for (const position of KNOB_ORDER) {
      encoders.push(encoderCell(inst.instanceId, pedal, position));
      hiddenEncoders.push(encoderCell(inst.instanceId, pedal, position, "hidden"));
    }
  }
  const footswitches = [
    instances[0] ? footswitchCell(instances[0].instanceId, "right") : null,
    instances[1] ? footswitchCell(instances[1].instanceId, "right") : null,
    instances[2] ? footswitchCell(instances[2].instanceId, "right") : null,
    null,
  ];
  const hidden = hiddenEncoders.some(Boolean)
    ? { encoders: hiddenEncoders,
        footswitches: footswitches.map((c, i) =>
          c ? footswitchCell(instances[i].instanceId, "right") : null) }
    : undefined;
  return {
    format: "proxi-layout", formatVersion: 1, id, name,
    encoders,
    footswitches,
    ...(hidden ? { hidden } : {}),
    omniports: [null, null],
  };
}
