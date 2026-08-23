// lens.mjs — the exploded, rig-aware view of Proxi MIDI (companion-app-plan
// §3b, priority 2). Reads the pedal library + a rig document, then renders
// MIDI — from a .mid file or live Web MIDI input — as per-pedal panels with a
// named lane per control. Channels resolve through the rig (channel →
// instance → pedal), CCs resolve through the pedal definition (CC → control
// label), so the piano-roll's "CC 14 on ch 1" reads as "Lost + Found · TIME".
//
// Chart form (dataviz method): CC data is stepwise change-over-time →
// step-after lines, one series per lane (small multiples — the lane label
// carries identity, no legend). Series color #3987e5 validated against both
// companion surfaces; pedal header bands wear the pedal's own library colors
// (domain data — the same bars the device screens render).

import { parseSMF } from "./smf.mjs";

const LIB_URL = "../pedal-library/pedal-library.json";
const RIG_FIXTURE_URL = "../contract/fixtures/rig.json";
const LIVE_WINDOW_S = 30;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ---------------------------------------------------------------- state
const pedals = new Map(); // pedalId -> pedal definition
let rig = { instances: [] };
let rigSource = "none";
const channels = new Map(); // midiChannel -> {instanceId, pedal, controls: Map(cc -> {label, detail, order})}

let model = { panels: new Map() };
let mode = "idle"; // idle | file | live (wall clock, trailing) | take (host timeline, absolute)
let xDomain = [0, 1];
let fileInfo = "";
let listening = false; // master gate for ALL live intake (Web MIDI, sim, host inject)
let suppressAuto = false; // set by an explicit stop: host events must not re-open the gate
let simTimer = null;
let liveTimer = null;
let liveT0 = 0;
let midiAccess = null;
let takeMaxT = 0; // take mode: rightmost host-timeline second seen
let hostPlaying = false;
let hostT = 0;
let lastFileName = null; // the most-recent .mid, so the File segment can re-show it
let lastFileBytes = null;

// ------------------------------------------------------------- rig setup
function buildChannels() {
  channels.clear();
  rig.instances.forEach((inst, i) => {
    const pedal = pedals.get(inst.pedalId);
    const controls = new Map();
    let order = 0;
    const add = (cc, label, detail) => {
      if (cc > 0 && label && !controls.has(cc)) controls.set(cc, { label, detail, order: order++ });
    };
    if (pedal) {
      for (const e of pedal.encoders?.normal ?? [])
        if (e.type !== "inactive") add(e.cc, e.label || e.position, `CC ${e.cc} · ${e.position}`);
      for (const side of ["left", "right"]) {
        const f = pedal.footswitches?.[side];
        if (f) add(f.cc, f.label || `FS ${side}`, `CC ${f.cc} · footswitch`);
      }
      for (const e of pedal.encoders?.hidden ?? [])
        if (e.type !== "inactive") add(e.cc, e.label, `CC ${e.cc} · hidden ${e.position}`);
      for (const bank of pedal.dipSwitchBanks ?? [])
        for (const sw of bank.switches ?? []) add(sw.cc, sw.label, `CC ${sw.cc} · dip ${bank.label}`);
    }
    channels.set(inst.midiChannel, { instanceId: inst.instanceId, pedal, controls, order: i });
  });
}

// ------------------------------------------------------------ event model
function resetModel() {
  model = { panels: new Map() };
}

function getPanel(ch) {
  const b = channels.get(ch);
  const key = b ? b.instanceId : `ch${ch}`;
  let p = model.panels.get(key);
  if (!p) {
    p = b
      ? { key, bound: true, name: b.pedal?.name ?? b.instanceId, inst: b.instanceId, ch,
          bg: b.pedal?.backgroundColor ?? "#333945", fg: b.pedal?.labelColor ?? "#d8dce4",
          order: b.order, lanes: new Map(), counts: { notes: 0, other: 0 } }
      : { key, bound: false, name: `Channel ${ch}`, inst: null, ch,
          order: 100 + ch, lanes: new Map(), counts: { notes: 0, other: 0 } };
    model.panels.set(key, p);
  }
  return p;
}

function ingest(e) {
  if (e.type === "cc" || e.type === "pc") {
    const panel = getPanel(e.ch);
    const b = channels.get(e.ch);
    let laneKey, label, detail, order;
    if (e.type === "pc") {
      laneKey = "pc"; label = "PROGRAM"; detail = "program change"; order = 9000;
    } else {
      const ctrl = b?.controls.get(e.cc);
      laneKey = `cc${e.cc}`;
      label = ctrl?.label ?? `CC ${e.cc}`;
      detail = ctrl?.detail ?? (b ? `CC ${e.cc} · unmapped` : `CC ${e.cc}`);
      order = ctrl?.order ?? 1000 + e.cc;
    }
    let lane = panel.lanes.get(laneKey);
    if (!lane) panel.lanes.set(laneKey, (lane = { key: laneKey, label, detail, order, events: [], last: null }));
    lane.events.push({ t: e.t, v: e.type === "pc" ? e.program : e.value });
    lane.last = lane.events[lane.events.length - 1].v;
  } else if (e.type === "noteOn" || e.type === "noteOff") {
    getPanel(e.ch).counts.notes++;
  } else {
    getPanel(e.ch).counts.other++;
  }
}

// --------------------------------------------------------------- file mode
function loadFile(name, bytes) {
  stopLive();
  let parsed;
  try {
    parsed = parseSMF(bytes);
  } catch (err) {
    $("status").textContent = `can't read ${name}: ${err.message}`;
    return;
  }
  lastFileName = name;
  lastFileBytes = bytes;
  resetModel();
  mode = "file";
  for (const e of parsed.events) ingest({ ...e, t: e.seconds });
  xDomain = [0, Math.max(parsed.durationSeconds, 0.001)];
  const names = parsed.tracks.map((t) => t.name).filter(Boolean).join(", ");
  fileInfo = `${name} — ${parsed.events.length} events · ${fmtSec(parsed.durationSeconds)}s · ` +
    `${parsed.trackCount} track${parsed.trackCount === 1 ? "" : "s"}${names ? ` (${names})` : ""}` +
    (parsed.sysexCount ? ` · ${parsed.sysexCount} sysex skipped` : "");
  render();
}

// --------------------------------------------------------------- live mode
function startLiveClock() {
  if (mode !== "live") { resetModel(); mode = "live"; liveT0 = performance.now(); }
  if (!liveTimer) liveTimer = setInterval(render, 150);
}

// Every live source funnels through here: Web MIDI, the simulator, and the
// plugin shell's inject(). Events carrying a host-timeline `t` (the plugin
// during transport playback) paint into take mode; the rest use the wall
// clock. The `listening` gate covers them all — but a host feed auto-opens
// it once, so the plugin window works with zero clicks until the user says
// stop.
function liveEvent(e) {
  if (!listening) {
    if (suppressAuto) return;
    listening = true;
    updateListenBtn();
  }
  if (typeof e.t === "number") takeEvent(e);
  else {
    startLiveClock();
    ingest({ ...e, t: (performance.now() - liveT0) / 1000 });
  }
}

function takeEvent(e) {
  if (mode !== "take") { resetModel(); mode = "take"; takeMaxT = 0; }
  if (e.t < takeMaxT - 0.05) truncateFrom(e.t); // transport jumped back: this pass repaints from here
  if (e.t > takeMaxT) takeMaxT = e.t;
  ingest(e);
  scheduleRender();
}

function truncateFrom(t) {
  for (const p of model.panels.values())
    for (const lane of p.lanes.values()) {
      lane.events = lane.events.filter((ev) => ev.t < t);
      lane.last = lane.events.length ? lane.events[lane.events.length - 1].v : null;
    }
  takeMaxT = t;
}

function stopLive() {
  if (listening) setListening(false);
  else if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
}

let listenSeq = 0;
async function setListening(on) {
  const seq = ++listenSeq; // a later click wins over a pending permission prompt
  suppressAuto = !on;
  listening = on; // gate opens/closes immediately; Web MIDI binding follows when granted
  if (on && !midiAccess && navigator.requestMIDIAccess) {
    try {
      const access = await navigator.requestMIDIAccess(); // plain MIDI, no sysex needed
      if (seq !== listenSeq) return;
      midiAccess = access;
      midiAccess.onstatechange = bindInputs;
    } catch (err) {
      if (seq !== listenSeq) return;
      statusLine(`Web MIDI unavailable: ${err.message}`);
      // fall through: the gate stays open so a host/inject feed can flow
    }
  }
  if (seq !== listenSeq) return;
  bindInputs();
  updateListenBtn();
  if (!on) { // full stop: silence every live source, freeze the view where it stands
    if (simTimer) { clearInterval(simTimer); simTimer = null; }
    if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
    render();
  }
}

// Keeps the File / Live segmented control in sync with the source. Live is
// "on" whenever we're listening or painting a live/take stream; File is "on"
// when a parsed .mid is showing. The live sub-state (monitor / host take /
// stopped) is carried by the status line, not the toggle.
function updateListenBtn() {
  const liveOn = listening || mode === "live" || mode === "take";
  const segLive = $("seg-live"), segFile = $("seg-file");
  if (segLive) segLive.classList.toggle("on", liveOn), segLive.classList.toggle("live", liveOn);
  if (segFile) segFile.classList.toggle("on", !liveOn && mode === "file");
}

function bindInputs() {
  if (!midiAccess) return;
  const names = [];
  for (const input of midiAccess.inputs.values()) {
    input.onmidimessage = listening ? onMidiMessage : null;
    names.push(input.name);
  }
  if (listening) statusLine(names.length ? `hearing: ${names.join(", ")}` : "no MIDI inputs found");
}

function onMidiMessage(msg) {
  const [st, d1, d2] = msg.data;
  if (st >= 0xf0) return; // system messages (clock etc.)
  const kind = st & 0xf0, ch = (st & 0x0f) + 1;
  if (kind === 0xb0) liveEvent({ type: "cc", ch, cc: d1, value: d2 });
  else if (kind === 0xc0) liveEvent({ type: "pc", ch, program: d1 });
  else if (kind === 0x90) liveEvent({ type: d2 ? "noteOn" : "noteOff", ch });
  else if (kind === 0x80) liveEvent({ type: "noteOff", ch });
  else liveEvent({ type: "other", ch });
}

// A scripted stand-in performance (ch 1/2 = the rig, ch 3 = alien traffic) so
// the live path is demoable with no device and drivable from tests.
function toggleSim() {
  if (simTimer) { setListening(false); return; }
  suppressAuto = false;
  if (!listening) { listening = true; updateListenBtn(); }
  let step = 0;
  simTimer = setInterval(() => {
    const t = step * 0.04;
    liveEvent({ type: "cc", ch: 1, cc: 14, value: Math.round(63.5 + 63.5 * Math.sin(t * 1.3)) });
    if (step % 3 === 0) liveEvent({ type: "cc", ch: 2, cc: 16, value: Math.round(63.5 + 63.5 * Math.sin(t * 0.7 + 2)) });
    if (step % 75 === 0) liveEvent({ type: "cc", ch: 1, cc: 21, value: [0, 64, 127][(step / 75) % 3] });
    if (step % 120 === 60) liveEvent({ type: "cc", ch: 1, cc: 102, value: Math.floor(step / 120) % 2 ? 0 : 127 });
    if (step % 200 === 100) liveEvent({ type: "cc", ch: 3, cc: 90, value: step % 128 });
    step++;
  }, 40);
}

// ---------------------------------------------------------------- render
let renderQueued = false;
function scheduleRender() { // rAF-debounced: a burst of injected events renders once
  if (!renderQueued) {
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; render(); });
  }
}

function render() {
  hideHover(); // re-render replaces the crosshair nodes; drop the tooltip with them
  if (mode === "live" && liveTimer) {
    const tNow = (performance.now() - liveT0) / 1000;
    xDomain = [Math.max(0, tNow - LIVE_WINDOW_S), Math.max(tNow, 5)];
  }
  if (mode === "take") xDomain = [0, Math.max(takeMaxT, 5)];
  const [x0, x1] = xDomain;
  const ticks = timeTicks(x0, x1);
  const panelsEl = $("panels");
  $("hint").style.display = model.panels.size ? "none" : "";

  const open = new Set([...panelsEl.querySelectorAll("details[open]")].map((d) => d.dataset.panel));
  const panels = [...model.panels.values()].sort((a, b) => a.order - b.order);
  panelsEl.innerHTML = panels.map((p) => panelHTML(p, x0, x1, ticks)).join("");
  for (const key of open) panelsEl.querySelector(`details[data-panel="${CSS.escape(key)}"]`)?.setAttribute("open", "");
  statusLine();
  updateListenBtn();
}

function panelHTML(p, x0, x1, ticks) {
  const lanes = [...p.lanes.values()].sort((a, b) => a.order - b.order);
  const head = p.bound
    ? `<div class="panel-head" style="background:${esc(p.bg)};color:${esc(p.fg)}">` +
      `${esc(p.name)}<span style="opacity:.8;font-weight:normal">${esc(p.inst)} · ch ${p.ch}</span>` +
      `<span class="meta">${lanes.length} lane${lanes.length === 1 ? "" : "s"}</span></div>`
    : `<div class="panel-head unbound">${esc(p.name)}<span class="meta">not in rig — raw view</span></div>`;
  return `<section class="pedal-panel">${head}` +
    lanes.map((l) => laneHTML(p, l, x0, x1, ticks)).join("") +
    timeAxisHTML(ticks, x0, x1) + eventsTableHTML(p, lanes) + `</section>`;
}

function laneHTML(p, lane, x0, x1, ticks) {
  return `<div class="lane"><div class="lane-gutter">` +
    `<div class="lane-label">${esc(lane.label)}</div><div class="lane-detail">${esc(lane.detail)}</div></div>` +
    `<div class="lane-value">${lane.last ?? ""}</div>` +
    `<div class="lane-chart" data-panel="${esc(p.key)}" data-lane="${esc(lane.key)}">${laneSVG(lane, x0, x1, ticks)}` +
    `<div class="crosshair"></div><div class="crosshair-dot"></div></div></div>`;
}

function laneSVG(lane, x0, x1, ticks) {
  const W = 1000, H = 44, P = 4;
  const X = (t) => (((t - x0) / (x1 - x0)) * W).toFixed(1);
  const Y = (v) => (H - P - (v / 127) * (H - 2 * P)).toFixed(1);
  const nss = 'vector-effect="non-scaling-stroke"';
  let g = ticks.map((t) => `<line class="grid-line" x1="${X(t)}" y1="0" x2="${X(t)}" y2="${H}" ${nss}/>`).join("");
  g += `<line class="mid-line" x1="0" y1="${Y(64)}" x2="${W}" y2="${Y(64)}" ${nss}/>`;
  let d = "", pen = null;
  for (const e of lane.events) {
    if (e.t <= x0) { pen = e.v; continue; }
    if (e.t > x1) break;
    d += d === ""
      ? (pen === null ? `M${X(e.t)} ${Y(e.v)}` : `M0 ${Y(pen)} H${X(e.t)} V${Y(e.v)}`)
      : ` H${X(e.t)} V${Y(e.v)}`;
    pen = e.v;
  }
  if (pen !== null) d = (d === "" ? `M0 ${Y(pen)}` : d) + ` H${W}`;
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${g}` +
    (d ? `<path class="series-line" d="${d}" ${nss}/>` : "") + `</svg>`;
}

function timeAxisHTML(ticks, x0, x1) {
  const span = ticks
    .map((t) => `<span style="left:${(((t - x0) / (x1 - x0)) * 100).toFixed(2)}%">${fmtTick(t)}</span>`)
    .join("");
  return `<div class="time-axis">${span}</div>`;
}

function eventsTableHTML(p, lanes) {
  const rows = [];
  for (const lane of lanes) for (const e of lane.events) rows.push({ t: e.t, label: lane.label, v: e.v });
  rows.sort((a, b) => a.t - b.t);
  const CAP = 400;
  const extra =
    (p.counts.notes ? ` · ${p.counts.notes} note event${p.counts.notes === 1 ? "" : "s"} (not lanes)` : "") +
    (p.counts.other ? ` · ${p.counts.other} other (not lanes)` : "");
  return `<details class="events" data-panel="${esc(p.key)}"><summary>${rows.length} events${extra} — table view</summary>` +
    `<table><tr><th>t (s)</th><th>control</th><th>value</th></tr>` +
    rows.slice(0, CAP).map((r) => `<tr><td>${r.t.toFixed(3)}</td><td>${esc(r.label)}</td><td>${r.v}</td></tr>`).join("") +
    (rows.length > CAP ? `<tr><td colspan="3">… ${rows.length - CAP} more</td></tr>` : "") +
    `</table></details>`;
}

// ----------------------------------------------------------- axis helpers
function timeTicks(x0, x1) {
  const span = x1 - x0;
  const step = [0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300].find((s) => span / s <= 8) ?? 600;
  const ticks = [];
  for (let t = Math.ceil(x0 / step) * step; t <= x1 + 1e-9; t += step) ticks.push(+t.toFixed(4));
  return ticks;
}
const fmtSec = (s) => (s >= 10 ? s.toFixed(1) : s.toFixed(2));
const fmtTick = (t) => (t >= 60 ? `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, "0")}` : `${+t.toFixed(2)}s`);

// ------------------------------------------------------ crosshair/tooltip
let hoverCell = null;
function hideHover() {
  $("tooltip").style.display = "none";
  if (hoverCell) {
    hoverCell.querySelector(".crosshair").style.display = "none";
    hoverCell.querySelector(".crosshair-dot").style.display = "none";
    hoverCell = null;
  }
}

$("panels").addEventListener("pointermove", (ev) => {
  const cell = ev.target.closest(".lane-chart");
  if (!cell) return hideHover();
  const panel = model.panels.get(cell.dataset.panel);
  const lane = panel?.lanes.get(cell.dataset.lane);
  if (!lane || !lane.events.length) return hideHover();
  if (hoverCell && hoverCell !== cell) hideHover();
  hoverCell = cell;

  const rect = cell.getBoundingClientRect();
  const [x0, x1] = xDomain;
  const t = x0 + ((ev.clientX - rect.left) / rect.width) * (x1 - x0);
  let e = lane.events[0];
  for (const c of lane.events) if (Math.abs(c.t - t) < Math.abs(e.t - t)) e = c;

  const ex = ((e.t - x0) / (x1 - x0)) * rect.width;
  const ey = 4 + (1 - e.v / 127) * (rect.height - 8);
  const line = cell.querySelector(".crosshair");
  const dot = cell.querySelector(".crosshair-dot");
  line.style.display = "block";
  line.style.left = `${ex.toFixed(1)}px`;
  dot.style.display = "block";
  dot.style.left = `${ex.toFixed(1)}px`;
  dot.style.top = `${ey.toFixed(1)}px`;

  const tip = $("tooltip");
  tip.innerHTML = `${esc(lane.label)} <span class="t">t=${e.t.toFixed(2)}s</span> <span class="v">${e.v}</span>`;
  tip.style.display = "block";
  const tx = Math.min(ev.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
  tip.style.left = `${tx}px`;
  tip.style.top = `${ev.clientY - 32}px`;
});
$("panels").addEventListener("pointerleave", hideHover);

// ------------------------------------------------------------------ status
function statusLine(extra) {
  const bits = [`${pedals.size} pedals`, `rig: ${rigSource} (${rig.instances.map((i) => i.instanceId).join(", ") || "empty"})`];
  if (mode === "file") bits.push(fileInfo);
  if (mode === "live") bits.push(liveTimer ? "live" : "live (stopped)");
  if (mode === "take") bits.push(`host take · ${fmtSec(takeMaxT)}s` + (hostPlaying ? ` · playing @ ${fmtSec(hostT)}s` : " · transport stopped"));
  if (extra) bits.push(extra);
  $("status").textContent = bits.join(" · ");
}

// -------------------------------------------------------------------- init
async function init() {
  try {
    const lib = await (await fetch(LIB_URL)).json();
    for (const p of lib.pedals) pedals.set(p.id, p);
  } catch (err) {
    $("status").textContent = `pedal library failed to load: ${err.message}`;
    return;
  }
  let stored = null;
  try { stored = JSON.parse(localStorage.getItem("proxi-rig") ?? "null"); } catch { /* fresh profile */ }
  if (stored?.instances?.length) {
    rig = stored;
    rigSource = "configurator (localStorage)";
  } else {
    try {
      rig = await (await fetch(RIG_FIXTURE_URL)).json();
      rigSource = "contract fixture";
    } catch {
      rigSource = "none — all channels raw";
    }
  }
  buildChannels();
  statusLine();

  $("open-btn").addEventListener("click", () => $("file-input").click());
  $("file-input").addEventListener("change", async (ev) => {
    const f = ev.target.files[0];
    if (f) loadFile(f.name, new Uint8Array(await f.arrayBuffer()));
  });
  $("demo-btn").addEventListener("click", loadDemo);
  // Live segment = the master listen gate (click again to stop → freeze).
  $("seg-live").addEventListener("click", () => setListening(!listening));
  // File segment = re-show the loaded .mid; if none yet, open the picker.
  $("seg-file").addEventListener("click", () => {
    if (lastFileBytes) loadFile(lastFileName, lastFileBytes);
    else $("file-input").click();
  });
  updateListenBtn();
  window.addEventListener("dragover", (ev) => ev.preventDefault());
  window.addEventListener("drop", async (ev) => {
    ev.preventDefault();
    const f = ev.dataTransfer?.files?.[0];
    if (f) loadFile(f.name, new Uint8Array(await f.arrayBuffer()));
  });
  if (new URLSearchParams(location.search).has("sim")) toggleSim();
}

async function loadDemo() {
  const bytes = new Uint8Array(await (await fetch("test/fixtures/take.mid")).arrayBuffer());
  loadFile("take.mid (demo)", bytes);
}

// Hook for the plugin shell and for tests (see README). inject() with a
// numeric `t` = host-timeline seconds paints take mode; without it, live
// mode on the wall clock. hostTransport() is the plugin's ~30 Hz transport
// ping — display only, no data mutation.
window.proxiLens = {
  inject: liveEvent,
  hostTransport({ playing, t }) {
    const changed = playing !== hostPlaying;
    hostPlaying = playing;
    hostT = t;
    if (mode === "take") { statusLine(); if (changed && !playing) scheduleRender(); }
  },
  loadDemo,
  panels: () => [...model.panels.values()],
  mode: () => mode,
};

init();
