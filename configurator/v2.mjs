//
// v2.mjs — contract-v2 frame client (docs/contract-v2.md §5).
//
// Transport-agnostic: the caller supplies "send these frame bytes" and feeds
// received wire bytes into a FrameStream. Works over Web Serial (frames raw
// on the stream, interleaved with the firmware's ASCII console lines) and
// Web MIDI (frames inside 7-in-8-packed SysEx DATA chunks, both directions).
// No DOM access — node runs this for tests.
//

export const FRM = {
  HELLO: 0x10, HELLO_REPLY: 0x11, LOG: 0x12, ACK: 0x13, ERR: 0x14,
  MANIFEST_REQ: 0x20, MANIFEST: 0x21, GET_OBJECT: 0x22, OBJECT: 0x23,
  PUT_OBJECT: 0x24, DELETE_OBJECT: 0x25, ACTIVATE_LAYOUT: 0x26,
  STATUS_REQ: 0x27, STATUS: 0x28,
  // F6 performance transfer + transport (payloads: perf.mjs)
  PERF_GET: 0x30, PERF_DATA: 0x31, PERF_PUT: 0x32, PERF_LOAD: 0x34,
  PERF_SAVE: 0x35, PERF_CONTROL: 0x36, PERF_STATUS_REQ: 0x37, PERF_STATUS: 0x38,
  PERF_LIST_REQ: 0x39, PERF_LIST: 0x3a,
};
const FRM_NAME = Object.fromEntries(Object.entries(FRM).map(([k, v]) => [v, k]));
const MAGIC = 0xab;

const enc = new TextEncoder();
const dec = new TextDecoder();

// FNV-1a 32-bit over bytes → 8 lowercase hex chars (contract §2.2; must match
// firmware objstore.cpp and tools/v2-acceptance.py).
export function fnv1a32(bytes) {
  let h = 0x811c9dc5;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function buildFrame(type, payload = new Uint8Array(0)) {
  if (typeof payload === "string" || payload?.constructor === Object) {
    payload = enc.encode(typeof payload === "string" ? payload : JSON.stringify(payload));
  }
  const frame = new Uint8Array(4 + payload.length);
  frame[0] = MAGIC;
  frame[1] = type;
  frame[2] = payload.length & 0xff;
  frame[3] = payload.length >> 8;
  frame.set(payload, 4);
  return frame;
}

// A standalone pedal document (contract §2: library entry + self-describing
// fields) as canonical minified bytes — the exact bytes PUT to the device.
export function standalonePedalDoc(pedal) {
  return enc.encode(JSON.stringify({ format: "proxi-pedal", formatVersion: 1, ...pedal }));
}

export function docBytes(doc) {
  return enc.encode(JSON.stringify(doc));
}

// Extracts 0xAB frames from a byte stream that may interleave plain ASCII
// console text (the serial carriage). Console text never contains 0xAB, so
// magic-scan recovery is exact; the skipped text is surfaced via onText.
export class FrameStream {
  constructor({ onFrame, onText }) {
    this.onFrame = onFrame;
    this.onText = onText ?? (() => {});
    this.buf = new Uint8Array(0);
  }

  push(bytes) {
    const merged = new Uint8Array(this.buf.length + bytes.length);
    merged.set(this.buf);
    merged.set(bytes, this.buf.length);
    this.buf = merged;

    for (;;) {
      const i = this.buf.indexOf(MAGIC);
      if (i < 0) {
        if (this.buf.length) this.#emitText(this.buf);
        this.buf = new Uint8Array(0);
        return;
      }
      if (i > 0) this.#emitText(this.buf.subarray(0, i));
      this.buf = this.buf.subarray(i);
      if (this.buf.length < 4) return;                    // header incomplete
      const type = this.buf[1];
      const length = this.buf[2] | (this.buf[3] << 8);
      if (this.buf.length < 4 + length) return;           // payload incomplete
      this.onFrame(type, this.buf.subarray(4, 4 + length));
      this.buf = this.buf.subarray(4 + length);
    }
  }

  #emitText(bytes) {
    // No trimming: chunks can be arbitrarily small (worst case one byte), so
    // dropping "blank" chunks would eat meaningful spaces out of console text.
    if (bytes.length) this.onText(dec.decode(bytes));
  }
}

// Request/response client. `sendBytes(frameBytes)` puts a frame on the wire;
// call `handleFrame` from the FrameStream. One outstanding request at a time
// (the firmware replies in order; the sync loop is sequential anyway).
export class V2Client {
  constructor(sendBytes, { onLog } = {}) {
    this.sendBytes = sendBytes;
    this.onLog = onLog ?? (() => {});
    this.waiter = null;
  }

  handleFrame(type, payload) {
    if (type === FRM.LOG) {
      this.onLog(dec.decode(payload));
      return;
    }
    if (this.waiter?.types.has(type)) {
      const w = this.waiter;
      this.waiter = null;
      clearTimeout(w.timer);
      w.resolve({ type, payload });
    } else {
      this.onLog(`(unexpected frame ${FRM_NAME[type] ?? type})`);
    }
  }

  request(type, payload, replyTypes, timeoutMs = 8000) {
    if (this.waiter) return Promise.reject(new Error("request already in flight"));
    return new Promise((resolve, reject) => {
      this.waiter = {
        types: new Set(replyTypes),
        resolve,
        timer: setTimeout(() => {
          this.waiter = null;
          reject(new Error(`no reply to ${FRM_NAME[type]} within ${timeoutMs / 1000}s`));
        }, timeoutMs),
      };
      this.sendBytes(buildFrame(type, payload));
    });
  }

  // Reply payloads are JSON except OBJECT (raw document bytes). ERR rejects.
  async #json(type, payload, replyType, timeoutMs) {
    const r = await this.request(type, payload, [replyType, FRM.ERR], timeoutMs);
    const body = JSON.parse(dec.decode(r.payload));
    if (r.type === FRM.ERR) throw new Error(`${body.code}: ${body.msg}`);
    return body;
  }

  hello() { return this.#json(FRM.HELLO, { protocol: 2 }, FRM.HELLO_REPLY, 3000); }
  manifest() { return this.#json(FRM.MANIFEST_REQ, new Uint8Array(0), FRM.MANIFEST); }
  status() { return this.#json(FRM.STATUS_REQ, new Uint8Array(0), FRM.STATUS); }
  put(bytes) { return this.#json(FRM.PUT_OBJECT, bytes, FRM.ACK); }
  del(kind, id) { return this.#json(FRM.DELETE_OBJECT, { kind, id }, FRM.ACK); }
  activate(id) { return this.#json(FRM.ACTIVATE_LAYOUT, { id }, FRM.ACK); }

  async get(kind, id) {
    const r = await this.request(FRM.GET_OBJECT, JSON.stringify({ kind, id }),
                                 [FRM.OBJECT, FRM.ERR]);
    if (r.type === FRM.ERR) {
      const body = JSON.parse(dec.decode(r.payload));
      throw new Error(`${body.code}: ${body.msg}`);
    }
    return r.payload;
  }

  // ── F6 performances ──
  perfStatus() { return this.#json(FRM.PERF_STATUS_REQ, new Uint8Array(0), FRM.PERF_STATUS, 3000); }
  // stored takes with their display names: {takes:[{id, name?}]} (F6 §12)
  perfList() { return this.#json(FRM.PERF_LIST_REQ, new Uint8Array(0), FRM.PERF_LIST, 3000); }
  // extra: {pos} for scrub, {id} for trigger/toggle/scrubto (§4.3 verbs)
  perfControl(action, extra = null) {
    return this.#json(FRM.PERF_CONTROL, { action, ...(extra ?? {}) }, FRM.ACK);
  }
  perfLoad(id) { return this.#json(FRM.PERF_LOAD, { id }, FRM.ACK); }
  perfSave(id = "take") { return this.#json(FRM.PERF_SAVE, { id }, FRM.ACK, 15000); }
  perfPut(payload) { return this.#json(FRM.PERF_PUT, payload, FRM.ACK, 15000); }

  async perfGet(id) {           // raw sidecar+'\n'+SMF payload (perf.mjs splits)
    const r = await this.request(FRM.PERF_GET, JSON.stringify({ id }),
                                 [FRM.PERF_DATA, FRM.ERR], 15000);
    if (r.type === FRM.ERR) {
      const body = JSON.parse(dec.decode(r.payload));
      throw new Error(`${body.code}: ${body.msg}`);
    }
    return r.payload;
  }
}
