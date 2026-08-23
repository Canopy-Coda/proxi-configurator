//
// mock-device.mjs — a simulated Proxi: the FIRMWARE side of contract v2,
// in-memory, DOM-free. The link's "demo" transport wires one of these where
// the Web MIDI / Web Serial carriage would sit, so the whole app — DEVICE
// tab, manifest diff, push/activate, live mirror, LENS recorder — runs with
// no hardware. Node runs it too (test/mock-device.mjs drives it with the
// real V2Client), so it doubles as the protocol test double.
//
// Fidelity rules: reply payload shapes mirror firmware framelink.cpp /
// perf.cpp byte-for-byte in structure (same keys, same ack fields), hashes
// are the same fnv1a32 the device computes, and PERF_DATA payloads are real
// `sidecar + '\n' + SMF` bytes (perf.mjs / smf-read.mjs parse them
// unchanged). What it does NOT simulate: SD latency, frame loss, watchdog.
//
// Nothing persists — every connect is a factory-fresh device (plus the
// optional seeded demo take), which keeps the push/activate demo honest.
//

import { FRM, buildFrame, fnv1a32, FrameStream } from "./v2.mjs";
import { splitPerfData, joinPerfData } from "./perf.mjs";
import { parseSMF } from "./smf-read.mjs";
import { eventsFromSMF, simEvents } from "./lens-model.mjs";
import { writeTakeSMF } from "./smf.mjs";

const enc = new TextEncoder();
const dec = new TextDecoder();

const FW = "demo-sim";
const FORMAT_KIND = {
  "proxi-pedal": "pedal", "proxi-layout": "layout",
  "proxi-rig": "rig", "proxi-settings": "settings",
};
const VALID_ID = /^[a-zA-Z0-9-]{1,32}$/;

export class MockProxi {
  // onSend(bytes): frame bytes device→host (feed the link's FrameStream).
  // onCC(ch, cc, value): plain CC device→host (playback drives the mirror).
  // now(): ms clock, injectable for tests.
  constructor({ onSend, onCC = () => {}, now = () => Date.now() } = {}) {
    this.onSend = onSend;
    this.onCC = onCC;
    this.now = now;

    this.objects = new Map();      // "kind/id" -> Uint8Array (stored bytes)
    this.activeLayout = null;

    // laneMeta: "ch:cc" -> {label, color, instanceId, controlId} — cosmetic
    // names for lanes recorded live (seedFromRig fills it).
    this.laneMeta = new Map();

    // Recorder (F6). pos/len in ms; lanes: "ch:cc" -> {channel, cc, v0,
    // label, color, instanceId, controlId, events: [{t(ms), value}]}.
    this.st = "idle";              // idle | rec | play | overdub | stopped
    this.anchor = 0;               // clock base while running: pos = now - anchor
    this.posMs = 0;
    this.lenMs = 0;
    this.w0 = 0;
    this.w1 = 0;
    this.loopOn = true;
    this.dirty = false;
    this.lanes = new Map();
    this.loadedId = "take";
    this.loadedName = "";
    this.backup = null;            // set-aside take (clear → restore)
    this.lastEmit = 0;             // playback CC emission watermark (ms)

    this.stream = new FrameStream({
      onFrame: (type, payload) => this.#handle(type, payload),
      onText: () => {},
    });
  }

  // ── wire ──────────────────────────────────────────────────────────────────
  receive(bytes) { this.stream.push(bytes); }

  #send(type, body) {
    const payload = typeof body === "string" ? enc.encode(body)
      : body instanceof Uint8Array ? body : enc.encode(JSON.stringify(body));
    this.onSend(buildFrame(type, payload));
  }
  #ack(ref, obj) { this.#send(FRM.ACK, { ref, ...obj }); }
  #err(ref, code, msg) { this.#send(FRM.ERR, { ref, code, msg }); }
  #log(line) { this.#send(FRM.LOG, `[Demo] ${line}`); }

  // ── seeding ───────────────────────────────────────────────────────────────
  // Build lane metadata + a pre-recorded demo take from the app's rig, using
  // the LENS SIM generator (deterministic, no RNG). The device's config store
  // stays EMPTY — the first connect shows the real push/activate flow — but
  // LENS has a take to browse immediately, and live-recorded lanes get real
  // labels/colors instead of "CC n".
  seedFromRig(bindings) {
    if (!bindings?.size) return;
    for (const [ch, b] of bindings) {
      for (const [cc, ctl] of b.controls) {
        this.laneMeta.set(`${ch}:${cc}`, {
          label: ctl.label, color: b.bg,
          instanceId: b.instanceId, controlId: ctl.label,
        });
      }
    }
    const { events, durationS } = simEvents(bindings, { durS: 24, hz: 8 });
    const rows = events.filter((e) => e.type === "cc");
    const lanes = [];
    const seen = new Set();
    for (const e of rows) {
      const key = `${e.ch}:${e.cc}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const meta = this.laneMeta.get(key) ?? {};
      lanes.push({
        channel: e.ch, cc: e.cc, v0: e.value,
        label: meta.label ?? `CC ${e.cc}`, color: meta.color ?? "#333945",
        instanceId: meta.instanceId ?? "", controlId: meta.controlId ?? "",
        events: rows.filter((r) => r.ch === e.ch && r.cc === e.cc).length,
      });
    }
    const lenMs = Math.round(durationS * 1000);
    const sidecar = {
      format: "proxi-performance", formatVersion: 1, id: "demo-take",
      name: "Demo Take", len: lenMs, w0: 0, w1: lenMs, loop: true, lanes,
    };
    const payload = joinPerfData(sidecar, writeTakeSMF(rows, durationS));
    this.objects.set("performance/demo-take", payload);
    this.#loadTake("demo-take");
  }

  // ── protocol handlers ─────────────────────────────────────────────────────
  #handle(type, payload) {
    const json = () => { try { return JSON.parse(dec.decode(payload)); } catch { return null; } };
    switch (type) {
      case FRM.HELLO:
        this.#send(FRM.HELLO_REPLY, {
          protocol: 2, contract: 2, fw: FW, hw: "proxi2", maxFrame: 65535,
          accepts: { pedal: [1], layout: [1], rig: [1], settings: [1], performance: [1] },
        });
        return;

      case FRM.MANIFEST_REQ: {
        const man = { pedals: {}, layouts: {}, rig: null, settings: null, performances: {} };
        for (const [key, bytes] of this.objects) {
          const [kind, id] = [key.slice(0, key.indexOf("/")), key.slice(key.indexOf("/") + 1)];
          const hash = fnv1a32(bytes);
          if (kind === "rig") man.rig = hash;
          else if (kind === "settings") man.settings = hash;
          else man[`${kind}s`][id] = hash;
        }
        this.#send(FRM.MANIFEST, man);
        return;
      }

      case FRM.GET_OBJECT: {
        const req = json();
        const bytes = req && this.objects.get(`${req.kind}/${req.id}`);
        if (!bytes) return this.#err(FRM.GET_OBJECT, "unknown-id", req?.id ?? "?");
        this.#send(FRM.OBJECT, bytes);
        return;
      }

      case FRM.PUT_OBJECT: {
        let doc;
        try { doc = JSON.parse(dec.decode(payload)); }
        catch { return this.#err(FRM.PUT_OBJECT, "bad-json", "put rejected"); }
        const kind = FORMAT_KIND[doc?.format];
        const id = doc?.id;
        if (!kind || doc.formatVersion !== 1 || typeof id !== "string")
          return this.#err(FRM.PUT_OBJECT, "schema", "put rejected");
        if (!VALID_ID.test(id)) return this.#err(FRM.PUT_OBJECT, "bad-id", "put rejected");
        if ((kind === "rig" && id !== "rig") || (kind === "settings" && id !== "settings"))
          return this.#err(FRM.PUT_OBJECT, "schema", "put rejected");
        const bytes = new Uint8Array(payload);      // copy: stream buffer is reused
        this.objects.set(`${kind}/${id}`, bytes);
        this.#ack(FRM.PUT_OBJECT, { kind, id, hash: fnv1a32(bytes) });
        return;
      }

      case FRM.DELETE_OBJECT: {
        const req = json();
        if (!req?.kind || !req?.id) return this.#err(FRM.DELETE_OBJECT, "schema", "want kind,id");
        if (!this.objects.delete(`${req.kind}/${req.id}`))
          return this.#err(FRM.DELETE_OBJECT, "unknown-id", req.id);
        if (req.kind === "layout" && this.activeLayout === req.id) this.activeLayout = null;
        this.#ack(FRM.DELETE_OBJECT, { kind: req.kind, id: req.id });
        return;
      }

      case FRM.ACTIVATE_LAYOUT: {
        const req = json();
        if (!req?.id || !this.objects.has(`layout/${req.id}`))
          return this.#err(FRM.ACTIVATE_LAYOUT, "unknown-id", req?.id ?? "?");
        this.activeLayout = req.id;
        this.#log(`activated layout "${req.id}" on the glass`);
        this.#ack(FRM.ACTIVATE_LAYOUT, { id: req.id, errors: 0 });
        return;
      }

      case FRM.STATUS_REQ: {
        const order = this.#bankOrder();
        // gestures mirror the real firmware's STATUS — all chords, switches
        // stay bindable: SW2+SW3 = hidden page, SW1+SW2/SW3+SW4 = bank walk
        const gestures = { hidden: { switches: [1, 2] },
                           "bank-dn": { switches: [0, 1] },
                           "bank-up": { switches: [2, 3] } };
        this.#send(FRM.STATUS, this.activeLayout
          ? { activeLayout: this.activeLayout, bankIndex: order.indexOf(this.activeLayout),
              bankCount: order.length, errors: 0, fw: FW, gestures }
          : { activeLayout: null, bankIndex: -1, bankCount: order.length, fw: FW, gestures });
        return;
      }

      // ── F6 recorder ──
      case FRM.PERF_STATUS_REQ:
        this.#sync();
        this.#send(FRM.PERF_STATUS, this.#perfStatus());
        return;

      case FRM.PERF_LIST_REQ: {
        const takes = [];
        for (const [key, bytes] of this.objects) {
          if (!key.startsWith("performance/")) continue;
          let name = "";
          try { name = splitPerfData(bytes).sidecar.name ?? ""; } catch { /* raw */ }
          takes.push({ id: key.slice("performance/".length), name });
        }
        this.#send(FRM.PERF_LIST, { takes });
        return;
      }

      case FRM.PERF_GET: {
        const req = json();
        let bytes = req && this.objects.get(`performance/${req.id}`);
        if (!bytes && req?.id === this.loadedId && this.lanes.size)
          bytes = this.#serializeTake(this.loadedId);   // live, unsaved recorder
        if (!bytes) return this.#err(FRM.PERF_GET, "unknown-id", req?.id ?? "?");
        this.#send(FRM.PERF_DATA, bytes);
        return;
      }

      case FRM.PERF_PUT: {
        let sidecar;
        try { sidecar = splitPerfData(payload).sidecar; }
        catch (e) { return this.#err(FRM.PERF_PUT, "schema", e.message); }
        if (!VALID_ID.test(sidecar.id ?? "")) return this.#err(FRM.PERF_PUT, "bad-id", "put rejected");
        const bytes = new Uint8Array(payload);
        this.objects.set(`performance/${sidecar.id}`, bytes);
        this.#ack(FRM.PERF_PUT, { kind: "performance", id: sidecar.id, hash: fnv1a32(bytes) });
        return;
      }

      case FRM.PERF_SAVE: {
        const req = json();
        const id = req?.id || "take";
        if (!VALID_ID.test(id)) return this.#err(FRM.PERF_SAVE, "bad-id", id);
        this.#sync();
        const bytes = this.#serializeTake(id);
        this.objects.set(`performance/${id}`, bytes);
        this.loadedId = id;
        this.dirty = false;
        this.#ack(FRM.PERF_SAVE, { id, hash: fnv1a32(bytes) });
        return;
      }

      case FRM.PERF_LOAD: {
        const req = json();
        if (!req?.id || !this.objects.has(`performance/${req.id}`))
          return this.#err(FRM.PERF_LOAD, "unknown-id", req?.id ?? "?");
        this.#loadTake(req.id);
        this.#ack(FRM.PERF_LOAD, { id: req.id });
        return;
      }

      case FRM.PERF_CONTROL: {
        const req = json();
        if (!req?.action) return this.#err(FRM.PERF_CONTROL, "schema", 'want {"action"}');
        this.#sync();
        if (!this.#control(req))
          return this.#err(FRM.PERF_CONTROL, "invalid-action", req.action);
        this.#ack(FRM.PERF_CONTROL, { perf: this.#perfStatus() });
        return;
      }

      default:
        this.#err(type, "unknown-frame", `0x${type.toString(16)}`);
    }
  }

  #bankOrder() {
    const settings = this.objects.get("settings/settings");
    if (settings) {
      try {
        const order = JSON.parse(dec.decode(settings)).bankOrder;
        if (Array.isArray(order) && order.length) return order;
      } catch { /* fall through */ }
    }
    return [...this.objects.keys()]
      .filter((k) => k.startsWith("layout/")).map((k) => k.slice("layout/".length));
  }

  // ── recorder core ─────────────────────────────────────────────────────────
  #running() { return this.st === "rec" || this.st === "play" || this.st === "overdub"; }

  // Lazily bring posMs up to the clock. Playback CC emission + window
  // wrap/stop happen here, so status polls and ticks share one path.
  #sync() {
    if (!this.#running()) return;
    const t = this.now();
    if (this.st === "rec") {
      this.posMs = this.lenMs = Math.max(0, t - this.anchor);
      return;
    }
    let pos = t - this.anchor;
    for (;;) {
      const end = Math.min(pos, this.w1);
      this.#emitRange(this.lastEmit, end);
      this.lastEmit = end;
      if (pos < this.w1) break;
      if (this.loopOn) {                     // wrap to the window start
        pos -= (this.w1 - this.w0) || 1;
        this.anchor += (this.w1 - this.w0) || 1;
        this.lastEmit = this.w0;
      } else {                               // one-shot: stop at the window end
        this.st = "stopped";
        this.posMs = this.w1;
        return;
      }
    }
    this.posMs = Math.max(this.w0, pos);
  }

  #emitRange(a, b) {
    if (b <= a) return;
    for (const lane of this.lanes.values()) {
      for (const e of lane.events) {
        if (e.t > a && e.t <= b) this.onCC(lane.channel, lane.cc, e.value);
      }
    }
  }

  // Advance playback + emit CC. The link calls this on an interval; tests
  // call it after moving the fake clock.
  tick() { this.#sync(); }

  // App-side CC (mirror knob drags) — records while the recorder is open.
  feedCC(channel, cc, value) {
    this.#sync();
    if (this.st !== "rec" && this.st !== "overdub") return;
    const key = `${channel}:${cc}`;
    let lane = this.lanes.get(key);
    if (!lane) {
      const meta = this.laneMeta.get(key) ?? {};
      lane = {
        channel, cc, v0: value,
        label: meta.label ?? `CC ${cc}`, color: meta.color ?? "#333945",
        instanceId: meta.instanceId ?? "", controlId: meta.controlId ?? "",
        events: [],
      };
      this.lanes.set(key, lane);
    }
    lane.events.push({ t: this.posMs, value });
    lane.events.sort((x, y) => x.t - y.t);
    this.dirty = true;
  }

  #setState(st) {
    this.#sync();
    const t = this.now();
    if (st === "rec") { this.anchor = t; this.posMs = this.lenMs = 0; }
    else if (st === "play" || st === "overdub") this.anchor = t - this.posMs;
    this.lastEmit = this.posMs;
    this.st = st;
  }

  #closeLoop() {
    this.lenMs = Math.max(this.posMs, 1);
    this.w0 = 0;
    this.w1 = this.lenMs;
    this.posMs = 0;
    this.#setState("play");
  }

  #control(req) {
    const a = req.action;
    if (a === "record") {
      if (this.st === "idle") { this.lanes.clear(); this.#setState("rec"); return true; }
      if (this.st === "rec") { this.#closeLoop(); return true; }
      if (this.st === "play" || this.st === "stopped") { this.#setState("overdub"); this.dirty = true; return true; }
      if (this.st === "overdub") { this.#setState("play"); return true; }
    }
    if (a === "play") {
      if (this.st === "idle") return false;
      if (this.st === "rec") { this.#closeLoop(); return true; }
      if (this.st === "stopped" || this.st === "overdub") { this.#setState("play"); return true; }
      return true;
    }
    if (a === "stop") {
      if (this.st === "idle") return false;
      if (this.st === "rec") this.#closeLoop();
      if (this.st === "play" || this.st === "overdub") this.#setState("stopped");
      return true;
    }
    if (a === "scrub") {
      if (req.pos == null || req.pos < 0) return false;
      this.posMs = Math.min(Math.max(req.pos, 0), this.lenMs);
      this.anchor = this.now() - this.posMs;
      this.lastEmit = this.posMs;
      return true;
    }
    if (a === "scrubto") {
      this.posMs = Math.round(((req.frac ?? 0) / 1000) * this.lenMs);
      this.anchor = this.now() - this.posMs;
      this.lastEmit = this.posMs;
      return true;
    }
    if (a === "window") {
      const w0 = req.w0 ?? -1, w1 = req.w1 ?? -1;
      if (w0 < 0 || w1 <= w0) return false;
      this.w0 = Math.min(w0, this.lenMs);
      this.w1 = Math.min(w1, this.lenMs);
      return true;
    }
    if (a === "loop") { this.loopOn = !!req.loop; return true; }
    if (a === "clear") {
      if (this.lanes.size) this.backup = this.#serializeTake(this.loadedId);
      this.st = "idle";
      this.lanes.clear();
      this.posMs = this.lenMs = this.w0 = this.w1 = 0;
      this.dirty = false;
      return true;
    }
    if (a === "restore") {
      if (!this.backup) return false;
      const bytes = this.backup;
      this.backup = null;
      this.objects.set(`performance/${this.loadedId}`, bytes);
      this.#loadTake(this.loadedId);
      return true;
    }
    if (a === "trigger" || a === "toggle") {
      const id = req.id || this.loadedId;
      if (id !== this.loadedId) {
        if (!this.objects.has(`performance/${id}`)) return false;
        this.#loadTake(id);
      }
      if (a === "toggle" && this.#running()) { this.#setState("stopped"); return true; }
      this.posMs = this.w0;
      this.loopOn = a === "toggle";
      this.#setState("play");
      return true;
    }
    return false;
  }

  #perfStatus() {
    let events = 0;
    for (const l of this.lanes.values()) events += l.events.length;
    return {
      state: this.st, pos: Math.round(this.posMs), len: Math.round(this.lenMs),
      w0: Math.round(this.w0), w1: Math.round(this.w1),
      lanes: this.lanes.size, events, dirty: this.dirty, uiActive: false,
      loadedId: this.loadedId, loadedName: this.loadedName,
      oneShot: !this.loopOn, loop: this.loopOn, canRestore: !!this.backup,
    };
  }

  // recorder state → `sidecar + '\n' + SMF` (the firmware perfstore format)
  #serializeTake(id) {
    const rows = [];
    for (const l of this.lanes.values())
      for (const e of l.events)
        rows.push({ t: e.t / 1000, ch: l.channel, type: "cc", cc: l.cc, value: e.value });
    rows.sort((x, y) => x.t - y.t);
    const sidecar = {
      format: "proxi-performance", formatVersion: 1, id,
      ...(this.loadedName && id === this.loadedId ? { name: this.loadedName } : {}),
      len: Math.round(this.lenMs), w0: Math.round(this.w0), w1: Math.round(this.w1),
      loop: this.loopOn,
      lanes: [...this.lanes.values()].map((l) => ({
        channel: l.channel, cc: l.cc, v0: l.v0, label: l.label, color: l.color,
        instanceId: l.instanceId, controlId: l.controlId, events: l.events.length,
      })),
    };
    return joinPerfData(sidecar, writeTakeSMF(rows, this.lenMs / 1000));
  }

  #loadTake(id) {
    const bytes = this.objects.get(`performance/${id}`);
    if (!bytes) return;
    const { sidecar, mid } = splitPerfData(bytes);
    this.lanes.clear();
    const metaByKey = new Map(
      (sidecar.lanes ?? []).map((l) => [`${l.channel}:${l.cc}`, l]));
    for (const e of eventsFromSMF(parseSMF(mid))) {
      if (e.type !== "cc") continue;
      const key = `${e.ch}:${e.cc}`;
      let lane = this.lanes.get(key);
      if (!lane) {
        const m = metaByKey.get(key) ?? this.laneMeta.get(key) ?? {};
        lane = {
          channel: e.ch, cc: e.cc, v0: m.v0 ?? e.value,
          label: m.label ?? `CC ${e.cc}`, color: m.color ?? "#333945",
          instanceId: m.instanceId ?? "", controlId: m.controlId ?? "",
          events: [],
        };
        this.lanes.set(key, lane);
      }
      lane.events.push({ t: Math.round(e.t * 1000), value: e.value });
    }
    this.lenMs = sidecar.len ?? 0;
    this.w0 = sidecar.w0 ?? 0;
    this.w1 = sidecar.w1 ?? this.lenMs;
    if (!this.w1) this.w1 = this.lenMs;
    this.loopOn = sidecar.loop ?? true;
    this.loadedId = id;
    this.loadedName = sidecar.name ?? "";
    this.posMs = this.w0;
    this.dirty = false;
    this.st = this.lanes.size ? "stopped" : "idle";
  }
}
