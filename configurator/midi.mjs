//
// midi.mjs — Web MIDI (SysEx) transport for the config link.
//
// Spike counterpart of firmware/proxi2/sysex.cpp — see
// docs/sysex-transport-spike.md for the envelope, packing, and chunking.
// The framed 0xAB bytes come from the same codec.mjs as the serial path;
// this module only changes the carriage.
//

export const SX = {
  MFR: 0x7d, // educational/non-commercial manufacturer id
  TAG0: 0x50, // 'P'
  TAG1: 0x58, // 'X'
  HELLO: 0x01,
  HELLO_REPLY: 0x02,
  DATA: 0x03,
  LOG: 0x04,
};

// Max decoded bytes per DATA chunk: 217 → 248 packed + 6 envelope = 254,
// under the Teensy core's 290-byte complete-SysEx-message buffer.
export const CHUNK_DECODED = 217;

// 7-in-8 packing: each group of ≤7 bytes → [MSB byte, 7×(byte & 0x7F)],
// MSB-byte bit k (LSB-first) = byte k's high bit. Mirrors sysex.cpp.
export function pack7(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length; i += 7) {
    const group = bytes.subarray(i, Math.min(i + 7, bytes.length));
    let msb = 0;
    for (let k = 0; k < group.length; k++) if (group[k] & 0x80) msb |= 1 << k;
    out.push(msb);
    for (let k = 0; k < group.length; k++) out.push(group[k] & 0x7f);
  }
  return out;
}

// Inverse of pack7 — device→host DATA chunks carry contract-v2 frames
// (framelink.cpp sendMidiData packs symmetrically).
export function unpack7(packed) {
  const out = [];
  for (let i = 0; i < packed.length; ) {
    const msb = packed[i++];
    for (let k = 0; k < 7 && i < packed.length; k++, i++)
      out.push(packed[i] | ((msb >> k) & 1 ? 0x80 : 0));
  }
  return new Uint8Array(out);
}

const ascii = (bytes) => String.fromCharCode(...bytes);

// Raw 2-byte Program Change — shared by the wire sender and the node test.
export const pcBytes = (channel, program) =>
  [0xc0 | ((channel - 1) & 0x0f), program & 0x7f];

// Opens the Web MIDI transport: requests sysex access, picks the device pair
// (first port matching /teensy|proxi/i, else the first port), and wires
// device→host messages to `onLine(text)` (v1 LOG / HELLO_REPLY) and
// `onData(bytes)` (decoded contract-v2 DATA payloads — feed a FrameStream).
// `onCC(channel1based, cc, value)` receives plain CC from the device (live
// state for the mirror). Returns { name, sendFrame, hello, sendCC, close }.
export async function openMidi(log, onLine, onData = null, onCC = null) {
  if (!("requestMIDIAccess" in navigator)) {
    throw new Error("this browser has no Web MIDI API (use Chrome/Edge/Firefox)");
  }
  const access = await navigator.requestMIDIAccess({ sysex: true });
  const outs = [...access.outputs.values()];
  const ins = [...access.inputs.values()];
  if (!outs.length || !ins.length) throw new Error("no MIDI ports found");

  const prefer = (ports) =>
    ports.find((p) => /teensy|proxi/i.test(p.name)) ?? ports[0];
  const output = prefer(outs);
  const input = prefer(ins);
  if (outs.length > 1 || ins.length > 1) {
    log(`MIDI ports available: out [${outs.map((p) => p.name).join(", ")}], in [${ins.map((p) => p.name).join(", ")}]`);
  }

  input.onmidimessage = (e) => {
    const d = e.data;
    if ((d[0] & 0xf0) === 0xb0 && d.length >= 3) {
      onCC?.((d[0] & 0x0f) + 1, d[1], d[2]);
      return;
    }
    if (d.length < 6 || d[0] !== 0xf0 || d[1] !== SX.MFR || d[2] !== SX.TAG0 || d[3] !== SX.TAG1) return;
    const body = d.subarray(5, d.length - 1); // strip envelope + trailing F7
    switch (d[4]) {
      case SX.LOG:
        onLine(ascii(body));
        break;
      case SX.HELLO_REPLY:
        onLine(`HELLO_REPLY  protocol=${body[0]}  contract=${body[1]}  ident="${ascii(body.subarray(2))}"`);
        break;
      case SX.DATA: // contract-v2 frames, device→host
        onData?.(unpack7(body));
        break;
      default:
        onLine(`unknown SysEx cmd 0x${d[4].toString(16)}`);
    }
  };

  return {
    name: `${output.name} / ${input.name}`,

    // Tunnel one framed 0xAB message as chunked, packed DATA SysEx messages.
    sendFrame(frame) {
      for (let off = 0; off < frame.length; off += CHUNK_DECODED) {
        const chunk = frame.subarray(off, Math.min(off + CHUNK_DECODED, frame.length));
        output.send([0xf0, SX.MFR, SX.TAG0, SX.TAG1, SX.DATA, ...pack7(chunk), 0xf7]);
      }
      return Math.ceil(frame.length / CHUNK_DECODED);
    },

    hello() {
      output.send([0xf0, SX.MFR, SX.TAG0, SX.TAG1, SX.HELLO, 0xf7]);
    },

    // Plain CC — drives the device's MIDI-in path (state + live display).
    sendCC(channel, cc, value) {
      output.send([0xb0 | ((channel - 1) & 0x0f), cc & 0x7f, value & 0x7f]);
    },

    // Program Change — the firmware forwards USB PC to the DIN out
    // (midi.cpp onThruProgramChange), so this reaches the pedal chain.
    sendPC(channel, program) {
      output.send(pcBytes(channel, program));
    },

    close() {
      input.onmidimessage = null;
      output.close?.();
      input.close?.();
    },
  };
}
