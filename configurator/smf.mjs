//
// smf.mjs — minimal Standard MIDI File writers. Two entry points:
//   snapshotSMF(events)      — the DEVICE tab's snapshot export: one type-0
//                              track, every event at t=0 (v1 MIDIExporter).
//   writeTakeSMF(rows, lenS) — LENS take editing: a full timed event list →
//                              SMF-0 in the firmware's take format
//                              (division 500 + tempo 500000 µs/qn → 1 tick
//                              = 1 ms, matching perfstore.cpp SMF_DIVISION).
// Pure bytes, no DOM — node runs this for tests.
//

const PPQ = 480;

function chunk(tag, bytes) {
  const out = new Uint8Array(8 + bytes.length);
  out.set([...tag].map((c) => c.charCodeAt(0)));
  new DataView(out.buffer).setUint32(4, bytes.length);
  out.set(bytes, 8);
  return out;
}

// events: [{ channel (1-16), cc (0-127), value (0-127) }] — all at delta 0.
export function snapshotSMF(events, { bpm = 120 } = {}) {
  const track = [];
  const usPerBeat = Math.round(60_000_000 / bpm);
  track.push(0x00, 0xff, 0x51, 0x03,
    (usPerBeat >> 16) & 0xff, (usPerBeat >> 8) & 0xff, usPerBeat & 0xff);
  for (const e of events)
    track.push(0x00, 0xb0 | ((e.channel - 1) & 0x0f), e.cc & 0x7f, e.value & 0x7f);
  track.push(0x00, 0xff, 0x2f, 0x00); // end of track

  const header = new Uint8Array(6);
  const hv = new DataView(header.buffer);
  hv.setUint16(0, 0); // format 0
  hv.setUint16(2, 1); // one track
  hv.setUint16(4, PPQ);

  const mthd = chunk("MThd", header);
  const mtrk = chunk("MTrk", new Uint8Array(track));
  const out = new Uint8Array(mthd.length + mtrk.length);
  out.set(mthd);
  out.set(mtrk, mthd.length);
  return out;
}

// ── full-take writer (LENS editing save path) ───────────────────────────────
// rows: the normalized rows the LENS edit model carries — {t (seconds), ch
// (1-based), type, …} in smf-read.mjs' event vocabulary: cc {cc, value},
// pc {program}, noteOn/noteOff {note, velocity}, pitchBend {value −8192..8191},
// other {status, d1, d2?}. Must be time-sorted ascending. `lenS` pins the
// End-of-Track marker (the take's length can exceed its last event).
// Format: SMF-0, division 500, one Set Tempo 500000 at t=0 → 1 tick = 1 ms,
// byte-compatible with the firmware recorder's own take files.
const TAKE_DIVISION = 500;

function vlq(out, v) {
  if (v < 0) v = 0;
  const b = [v & 0x7f];
  while ((v >>= 7)) b.unshift((v & 0x7f) | 0x80);
  out.push(...b);
}

export function writeTakeSMF(rows, lenS) {
  const track = [];
  track.push(0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20); // tempo 500000 µs/qn

  let lastTick = 0;
  const emit = (t, ...bytes) => {
    const tick = Math.max(Math.round(t * 1000), lastTick); // monotonic, 1 tick = 1 ms
    vlq(track, tick - lastTick);
    lastTick = tick;
    track.push(...bytes);
  };

  for (const e of rows) {
    const ch = ((e.ch ?? 1) - 1) & 0x0f;
    switch (e.type) {
      case "cc": emit(e.t, 0xb0 | ch, e.cc & 0x7f, e.value & 0x7f); break;
      case "pc": emit(e.t, 0xc0 | ch, e.program & 0x7f); break;
      case "noteOn": emit(e.t, 0x90 | ch, e.note & 0x7f, e.velocity & 0x7f); break;
      case "noteOff": emit(e.t, 0x80 | ch, e.note & 0x7f, e.velocity & 0x7f); break;
      case "pitchBend": {
        const v = (e.value ?? 0) + 8192;
        emit(e.t, 0xe0 | ch, v & 0x7f, (v >> 7) & 0x7f);
        break;
      }
      case "other": {
        const bytes = [e.status, e.d1 & 0x7f];
        if (e.d2 != null) bytes.push(e.d2 & 0x7f);
        emit(e.t, ...bytes);
        break;
      }
      // "note" (the lossy count-only row) and unknown types are skipped —
      // the save path must feed smf-read vocabulary rows, never lens-model's
      // collapsed note rows.
    }
  }

  // EOT at the take length (≥ the last event)
  const endTick = Math.max(Math.round((lenS ?? 0) * 1000), lastTick);
  vlq(track, endTick - lastTick);
  track.push(0xff, 0x2f, 0x00);

  const header = new Uint8Array(6);
  const hv = new DataView(header.buffer);
  hv.setUint16(0, 0);
  hv.setUint16(2, 1);
  hv.setUint16(4, TAKE_DIVISION);

  const mthd = chunk("MThd", header);
  const mtrk = chunk("MTrk", new Uint8Array(track));
  const out = new Uint8Array(mthd.length + mtrk.length);
  out.set(mthd);
  out.set(mtrk, mthd.length);
  return out;
}
