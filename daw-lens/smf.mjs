// smf.mjs — minimal Standard MIDI File (SMF) reader for the DAW lens.
//
// Scope: format 0/1, metrical time division only (SMPTE rejected — Logic/Live
// export metrical by default). Emits one merged, tick-sorted event stream with
// wall-clock seconds derived from the tempo map. Channels are 1-based to match
// the rig documents (`midiChannel: 1`), NOT the 0-based wire nibble.
//
// Runs in node (tests) and the browser (lens page) — no dependencies.

export function parseSMF(bytes) {
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  const r = reader(bytes);

  if (r.ascii(4) !== "MThd") throw new Error("not a MIDI file (missing MThd)");
  const headerLen = r.u32();
  const format = r.u16();
  const trackCount = r.u16();
  const division = r.u16();
  r.skip(headerLen - 6); // spec allows a longer header; ignore the extra
  if (division & 0x8000) throw new Error("SMPTE time division not supported");
  if (format > 1) throw new Error(`SMF format ${format} not supported (0/1 only)`);

  const tracks = [];
  const events = []; // merged; {tick, type, ...} — seconds added after tempo map
  const tempoChanges = []; // {tick, usPerQuarter}
  let sysexCount = 0;
  let maxTick = 0;

  for (let t = 0; r.remaining() >= 8; t++) {
    const id = r.ascii(4);
    const len = r.u32();
    const end = r.pos() + len;
    if (id !== "MTrk") { r.seek(end); continue; } // alien chunk: spec says skip

    let tick = 0;
    let runningStatus = 0;
    let name = "";
    let eventCount = 0;

    while (r.pos() < end) {
      tick += r.vlq();
      let b = r.u8();

      if (b === 0xff) { // meta event (cancels running status)
        runningStatus = 0;
        const metaType = r.u8();
        const metaLen = r.vlq();
        const dataStart = r.pos();
        if (metaType === 0x51 && metaLen === 3) {
          tempoChanges.push({ tick, usPerQuarter: (r.u8() << 16) | (r.u8() << 8) | r.u8() });
        } else if (metaType === 0x03 && !name) {
          name = r.text(metaLen);
        } else if (metaType === 0x2f) {
          r.seek(dataStart + metaLen);
          break; // end of track
        }
        r.seek(dataStart + metaLen);
        continue;
      }

      if (b === 0xf0 || b === 0xf7) { // sysex (cancels running status)
        runningStatus = 0;
        sysexCount++;
        r.skip(r.vlq());
        continue;
      }

      let status, d1;
      if (b & 0x80) {
        status = runningStatus = b;
        d1 = r.u8();
      } else {
        if (!runningStatus) throw new Error(`data byte 0x${b.toString(16)} with no running status @${r.pos() - 1}`);
        status = runningStatus;
        d1 = b;
      }

      const kind = status & 0xf0;
      const ch = (status & 0x0f) + 1; // 1-based, rig-document convention
      let ev;
      switch (kind) {
        case 0xb0: ev = { type: "cc", ch, cc: d1, value: r.u8() }; break;
        case 0xc0: ev = { type: "pc", ch, program: d1 }; break;
        case 0x90: {
          const vel = r.u8();
          ev = vel === 0 ? { type: "noteOff", ch, note: d1, velocity: 0 }
                         : { type: "noteOn", ch, note: d1, velocity: vel };
          break;
        }
        case 0x80: ev = { type: "noteOff", ch, note: d1, velocity: r.u8() }; break;
        case 0xe0: ev = { type: "pitchBend", ch, value: ((r.u8() << 7) | d1) - 8192 }; break;
        case 0xd0: ev = { type: "other", ch, status, d1 }; break;                 // channel pressure
        case 0xa0: ev = { type: "other", ch, status, d1, d2: r.u8() }; break;     // poly pressure
        default: throw new Error(`unexpected status byte 0x${status.toString(16)} @${r.pos()}`);
      }
      ev.tick = tick;
      ev.track = t;
      ev.seq = events.length; // merge-stable tiebreak
      events.push(ev);
      eventCount++;
    }
    if (tick > maxTick) maxTick = tick;
    tracks.push({ name, eventCount });
    r.seek(end);
  }

  events.sort((a, b) => a.tick - b.tick || a.seq - b.seq);
  events.forEach((e) => delete e.seq);

  const tempoMap = buildTempoMap(tempoChanges, division);
  for (const e of events) e.seconds = tempoMap.secondsAt(e.tick);

  return {
    format,
    division,
    trackCount,
    tracks,
    events,
    sysexCount,
    tempoMap: tempoMap.segments,
    durationSeconds: tempoMap.secondsAt(maxTick),
  };
}

// Tempo map: piecewise-linear tick→seconds. Default 120 BPM before any Set Tempo.
function buildTempoMap(changes, division) {
  changes.sort((a, b) => a.tick - b.tick);
  const segments = []; // {tick, seconds, usPerQuarter}
  let usPerQuarter = 500000;
  let lastTick = 0;
  let lastSeconds = 0;
  if (!changes.length || changes[0].tick > 0) segments.push({ tick: 0, seconds: 0, usPerQuarter });
  for (const c of changes) {
    lastSeconds += ((c.tick - lastTick) * usPerQuarter) / division / 1e6;
    lastTick = c.tick;
    usPerQuarter = c.usPerQuarter;
    const prev = segments[segments.length - 1];
    if (prev && prev.tick === c.tick) { prev.usPerQuarter = usPerQuarter; prev.seconds = lastSeconds; }
    else segments.push({ tick: c.tick, seconds: lastSeconds, usPerQuarter });
  }
  return {
    segments,
    secondsAt(tick) {
      let seg = segments[0];
      for (const s of segments) { if (s.tick <= tick) seg = s; else break; }
      return seg.seconds + ((tick - seg.tick) * seg.usPerQuarter) / division / 1e6;
    },
  };
}

function reader(bytes) {
  let p = 0;
  const need = (n) => { if (p + n > bytes.length) throw new Error(`truncated file @${p}+${n}`); };
  return {
    pos: () => p,
    seek: (to) => { p = to; },
    skip: (n) => { need(n); p += n; },
    remaining: () => bytes.length - p,
    u8: () => { need(1); return bytes[p++]; },
    u16: () => { need(2); return (bytes[p++] << 8) | bytes[p++]; },
    u32: () => { need(4); return ((bytes[p++] << 24) | (bytes[p++] << 16) | (bytes[p++] << 8) | bytes[p++]) >>> 0; },
    ascii(n) { need(n); let s = ""; while (n--) s += String.fromCharCode(bytes[p++]); return s; },
    text(n) { need(n); const s = new TextDecoder().decode(bytes.subarray(p, p + n)); p += n; return s; },
    vlq() {
      let v = 0;
      for (let i = 0; i < 4; i++) {
        const b = this.u8();
        v = (v << 7) | (b & 0x7f);
        if (!(b & 0x80)) return v;
      }
      throw new Error(`variable-length quantity too long @${p}`);
    },
  };
}
