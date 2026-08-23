//
// perf.mjs — performance (take) wire helpers, F6.
//
// PERF_DATA / PERF_PUT payloads are `sidecar JSON + '\n' + raw SMF bytes`.
// The sidecar MUST be single-line JSON — the firmware splits at the FIRST
// 0x0A, and the SMF half is binary that may legitimately contain 0x0A.
// Pure bytes, no DOM — node runs this for tests.
//

const enc = new TextEncoder();
const dec = new TextDecoder();

// PERF_DATA payload → { sidecar (object), sidecarBytes, mid (Uint8Array) }.
export function splitPerfData(payload) {
  const nl = payload.indexOf(0x0a);
  if (nl < 0) throw new Error("perf payload has no sidecar/SMF separator");
  const sidecarBytes = payload.subarray(0, nl);
  const mid = payload.subarray(nl + 1);
  const sidecar = JSON.parse(dec.decode(sidecarBytes));
  if (sidecar.format !== "proxi-performance") {
    throw new Error(`not a performance sidecar: ${sidecar.format}`);
  }
  return { sidecar, sidecarBytes, mid };
}

// sidecar (object or bytes) + SMF bytes → one PERF_PUT payload.
export function joinPerfData(sidecar, mid) {
  const sideBytes = sidecar instanceof Uint8Array ? sidecar
    : enc.encode(JSON.stringify(sidecar));
  if (sideBytes.includes(0x0a)) {
    throw new Error("sidecar must be single-line JSON (firmware splits at the first newline)");
  }
  if (mid.length < 14 || dec.decode(mid.subarray(0, 4)) !== "MThd") {
    throw new Error("SMF bytes must start with MThd");
  }
  const out = new Uint8Array(sideBytes.length + 1 + mid.length);
  out.set(sideBytes);
  out[sideBytes.length] = 0x0a;
  out.set(mid, sideBytes.length + 1);
  return out;
}

// Duplicate-take helper: same sidecar under a new id (canonical minified
// bytes; the device stores byte-faithfully, so the new object's hash is
// deterministic for sync).
export function rewriteSidecarId(sidecarBytes, newId) {
  if (!isValidTakeId(newId)) throw new Error(`bad take id: ${newId}`);
  const sidecar = JSON.parse(dec.decode(sidecarBytes));
  sidecar.id = newId;
  return enc.encode(JSON.stringify(sidecar));
}

// Rename in place: rewrite the sidecar's display `name` under the SAME id
// (the id stays the handle). JSON.stringify escapes any newline in the name,
// so the single-line invariant holds. The on-device rename path (0x39 take
// list) keeps the .mid hash stable; a re-PUT from the app rewrites the whole
// take object, so its hash moves — acceptable (the name persists), and a
// name-only frame could optimize it later.
export function rewriteSidecarName(sidecarBytes, name) {
  const sidecar = JSON.parse(dec.decode(sidecarBytes));
  sidecar.name = String(name).slice(0, 32);
  const out = enc.encode(JSON.stringify(sidecar));
  if (out.includes(0x0a)) throw new Error("renamed sidecar must stay single-line");
  return out;
}

// Contract §2.1 id rules (mirrors firmware objValidId).
export function isValidTakeId(id) {
  return typeof id === "string" && /^[a-zA-Z0-9-]{1,32}$/.test(id);
}

export function fmtMs(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

// Recorder status → the panel's transport labels. The click labels mirror
// the device's enc3/enc4 strip (perfStripContent in ui.cpp) so the app and
// the glass always name the same action the same way.
export function transportLabels(perf) {
  const st = perf.state;
  const running = st === "play" || st === "overdub" || st === "rec";
  return {
    running,
    rec: st === "idle" ? "● REC" : st === "rec" ? "CLOSE LOOP"
       : st === "overdub" ? "DUB OFF" : "● DUB",
    play: running ? "■ STOP" : "▶ PLAY",
    playAction: running ? "stop" : "play",
    status: st === "idle" ? "empty"
      : st === "rec" ? `● REC ${fmtMs(perf.pos)}`
      : `${st === "play" ? "▶" : st === "overdub" ? "●" : "‖"} ${st.toUpperCase()} `
        + `${fmtMs(perf.pos)} / ${fmtMs(perf.len)}`,
  };
}

// LENS "one live take" presentation, derived purely from the device's reported
// transport state (the device is the master — the app mirrors it). Returns the
// header badge, an accent key (green live / amber playback / idle), and the mono
// status line. state: idle | rec | play | overdub | stopped. `name` is the shown
// take's display name, used in the idle status line.
export function lensTake(perf, name = "take") {
  const st = perf?.state ?? "idle";
  const posS = (perf?.pos ?? 0) / 1000;
  const lenS = (perf?.len ?? 0) / 1000;
  if (st === "rec" || st === "overdub")
    return { phase: "rec", accent: "green", badge: "LIVE", pulse: true, running: true,
             status: `recording from device · ${posS.toFixed(1)}s captured` };
  if (st === "play")
    return { phase: "play", accent: "amber", badge: "PLAYING", pulse: true, running: true,
             status: `mirroring device playback · ${posS.toFixed(1)}s / ${lenS.toFixed(1)}s` };
  const has = (perf?.lanes ?? 0) > 0;
  return { phase: "ready", accent: "idle", badge: "READY", pulse: false, running: false,
           status: has
             ? `${name} · ${perf.events} event${perf.events === 1 ? "" : "s"} · ${lenS.toFixed(1)}s · device ${st}`
             : "no take loaded — hit ● REC to capture one, or Open .mid…" };
}

// Sidecar → display summary for the takes list.
export function describeTake(sidecar) {
  const lanes = sidecar.lanes ?? [];
  return {
    id: sidecar.id,
    name: sidecar.name ?? "",       // display-only (F6 §12); id stays the handle
    lenMs: sidecar.len ?? 0,
    lenLabel: fmtMs(sidecar.len ?? 0),
    laneCount: lanes.length,
    labels: lanes.map((l) => l.label || `CC ${l.cc}`),
  };
}
