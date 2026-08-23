//
// link.mjs — the device link: Web MIDI (SysEx) / Web Serial carriages, the
// contract-v2 client, differential sync, and the manifest diff the UI shows.
// v2-only: the v1 0xAB message types and blind full-library sync are gone
// (contract-v2.md §10 — this app IS the "web parity" that retires them).
//
import { openMidi } from "./midi.mjs";
import { FrameStream, V2Client, fnv1a32, standalonePedalDoc, docBytes } from "./v2.mjs";
import { MockProxi } from "./mock-device.mjs";
import { buildBindings } from "./lens-model.mjs";

// ── Local document set (what SHOULD be on the device) ──────────────────────
// Only pedals referenced by the rig are pushed; layouts and rig/settings go
// verbatim (they're already the wire format).
export function localDocs(docs, pedalsById) {
  const out = [];
  for (const pedalId of new Set(docs.rig.instances.map((i) => i.pedalId))) {
    const p = pedalsById[pedalId];
    if (p) out.push({ kind: "pedal", id: pedalId, bytes: standalonePedalDoc(p) });
  }
  if (docs.rig.instances.length)
    out.push({ kind: "rig", id: "rig", bytes: docBytes(docs.rig) });
  for (const l of docs.layouts) out.push({ kind: "layout", id: l.id, bytes: docBytes(l) });
  if (docs.layouts.length)
    out.push({ kind: "settings", id: "settings", bytes: docBytes(docs.settings) });
  return out;
}

// Diff local docs against a device manifest (or null = never seen a device):
// [{kind, id, name, status: 'modified'|'new'|'in-sync'|'delete'}]. `delete`
// rows are device layouts absent locally (authoring is app-side truth).
export function manifestDiff(docs, pedalsById, manifest) {
  const remoteHash = (kind, id) => !manifest ? undefined
    : kind === "rig" ? manifest.rig
    : kind === "settings" ? manifest.settings
    : manifest[`${kind}s`]?.[id];
  const rows = localDocs(docs, pedalsById).map((d) => {
    const remote = remoteHash(d.kind, d.id);
    return {
      kind: d.kind, id: d.id, bytes: d.bytes,
      status: remote === fnv1a32(d.bytes) ? "in-sync" : remote ? "modified" : "new",
    };
  });
  if (manifest?.layouts) {
    for (const id of Object.keys(manifest.layouts))
      if (!docs.layouts.some((l) => l.id === id))
        rows.push({ kind: "layout", id, status: "delete" });
  }
  return rows;
}

export const pendingCount = (diffRows) =>
  diffRows.filter((r) => r.status !== "in-sync").length;

// ── The link ───────────────────────────────────────────────────────────────
// One instance for the app's lifetime. Calls back into the store via the
// hooks given to the constructor.
export function createLink(store) {
  let serialPort = null, serialWriter = null, readAbort = null;
  let midi = null;
  let mock = null, mockTick = null;
  let client = null;
  let perfPoll = null;

  const log = (tag, line) => store.log(tag, line);

  const frameStream = new FrameStream({
    onFrame: (type, payload) => client?.handleFrame(type, payload),
    onText: (text) => {                      // serial console lines (firmware LOGs)
      for (const line of text.split("\n")) if (line.trim()) log("Device", line.trim());
    },
  });

  const sendBytes = (bytes) => {
    if (mock) mock.receive(bytes);
    else if (midi) midi.sendFrame(bytes);
    else serialWriter?.write(bytes);
  };

  // Device CC can arrive as a dense stream (knob sweeps); write live state
  // immediately but coalesce the re-render to one per animation frame.
  let liveNotifyQueued = false;
  function trackCC(channel, cc, value) {
    store.state.live[`${channel}:${cc}`] = value;
    // Rolling log for the LENS MIDI monitor (newest first, capped). `live`
    // above keeps only the current value per channel:cc; the monitor wants a
    // time-ordered trail.
    const mon = store.state.monitorEvents;
    mon.unshift({ t: Date.now(), channel, cc, value });
    if (mon.length > 200) mon.length = 200;
    if (liveNotifyQueued) return;
    liveNotifyQueued = true;
    requestAnimationFrame(() => {
      liveNotifyQueued = false;
      store.update(() => {});
    });
  }

  async function openSerial() {
    serialPort = await navigator.serial.requestPort();
    await serialPort.open({ baudRate: 9600 });
    serialWriter = serialPort.writable.getWriter();
    readAbort = new AbortController();
    (async () => {
      try {
        while (serialPort?.readable) {
          const reader = serialPort.readable.getReader();
          try {
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              frameStream.push(value);
            }
          } finally { reader.releaseLock(); }
        }
      } catch (err) {
        if (!readAbort.signal.aborted) log("Serial", `read error: ${err.message}`);
      }
    })();
    const info = serialPort.getInfo();
    return `usb ${info.usbVendorId?.toString(16) ?? "?"}:${info.usbProductId?.toString(16) ?? "?"}`;
  }

  async function openMidiTransport() {
    midi = await openMidi(
      (line) => log("MIDI", line),
      (line) => log("Device", line),
      (bytes) => frameStream.push(bytes),
      trackCC); // plain CC from the device drives the live mirror
    return midi.name;
  }

  // Demo transport: a simulated Proxi (mock-device.mjs) sits where the wire
  // would be. Its config store starts EMPTY — the demo IS the push/activate
  // flow — but it's seeded with a rig-derived take so LENS has content, and
  // its playback CC drives the live mirror like a real device's would.
  // Nothing survives a disconnect.
  function openDemoTransport(pedalsById) {
    mock = new MockProxi({
      onSend: (bytes) => frameStream.push(bytes),
      onCC: trackCC,
    });
    const rig = store.state.docs.rig;
    if (pedalsById && rig?.instances?.length)
      mock.seedFromRig(buildBindings(rig, pedalsById));
    mockTick = setInterval(() => mock?.tick(), 100);   // playback CC pump
    return "simulated Proxi (demo)";
  }

  // Sync operations are strictly serialized: push and activate from any
  // button share one gate, so a retry click can never race the in-flight
  // request ("request already in flight" pile-ups). On a reply timeout,
  // probe the link with a HELLO so the console says whether the device is
  // still alive (frame lost in transit → retry) or wedged (power-cycle).
  let syncBusy = false;
  async function serialized(name, fn) {
    if (syncBusy) throw new Error(`${name} skipped — a sync operation is already running`);
    syncBusy = true;
    try {
      return await fn();
    } catch (err) {
      if (/no reply to/.test(err.message) && client) {
        try {
          await client.hello();
          log("Sync", `${err.message} — but the device answers HELLO, so the link is alive; the frame was lost in transit. Try again.`);
        } catch {
          log("Sync", `${err.message} — and the device no longer answers HELLO. Power-cycle the Proxi, then reconnect.`);
        }
      }
      throw err;
    } finally {
      syncBusy = false;
    }
  }

  const link = {
    get connected() { return store.state.link.status === "connected"; },
    client: () => client,

    // pedalsById is optional — only the demo transport uses it (rig-derived
    // take seeding); hardware transports ignore it.
    async connect(pedalsById = null) {
      const { transport } = store.state.link;
      store.update((s) => { s.link.status = "connecting"; });
      try {
        const name = transport === "serial" ? await openSerial()
          : transport === "demo" ? openDemoTransport(pedalsById)
          : await openMidiTransport();
        log(transport === "serial" ? "Serial" : transport === "demo" ? "Demo" : "MIDI",
            `port open: ${name}`);
        client = new V2Client(sendBytes, { onLog: (line) => log("Device", line) });
        const hello = await client.hello();
        log("Sync", `HELLO → v${hello.contract} · fw ${hello.fw}`);
        store.update((s) => {
          s.link.status = "connected";
          s.link.name = name;
          s.link.fw = hello.fw;
        });
        await this.refreshManifest();
        await this.refreshStatus();
        await this.refreshPerf().catch(() => {});   // pre-F6 firmware: fine
        // Recorder + device status poll — keeps the transport/playhead live
        // AND follows device-side bank walks (activeLayout/gestures ride
        // STATUS, which nothing else re-asks after connect). Gated to a
        // visible tab (a background tab polling SysEx correlates with two
        // 2026-07-12 device wedges — root cause under investigation) and
        // paced at 5 s. Sequential: the client allows ONE in-flight request,
        // so parallel calls would reject each other. A poll that collides
        // with an in-flight request just skips a beat.
        perfPoll = setInterval(() => {
          if (document.visibilityState !== "visible") return;
          this.refreshPerf().then(() => this.refreshStatus()).catch(() => {});
        }, 5000);
      } catch (err) {
        log("Sync", `connect failed: ${err.message}`);
        await this.disconnect(true);
        throw err;
      }
    },

    async disconnect(silent = false) {
      try {
        if (midi) midi.close();
        readAbort?.abort();
        serialWriter?.releaseLock();
        await serialPort?.close();
      } catch { /* tearing down anyway */ }
      clearInterval(perfPoll);
      perfPoll = null;
      clearInterval(mockTick);
      mockTick = null; mock = null;
      midi = null; serialPort = null; serialWriter = null; client = null;
      store.update((s) => {
        s.link.status = "disconnected";
        s.link.name = null; s.link.fw = null; s.link.activeLayout = null;
        s.link.perf = null;
      });
      if (!silent) log("Sync", "disconnected");
    },

    async refreshManifest() {
      if (!client) return;
      const man = await client.manifest();
      store.saveManifest(man);
      // Take display names ride their own frame (F6 §12 — the manifest stays
      // ids+hashes, and renames don't move the .mid hash). Older firmware
      // without 0x39 just leaves the map empty.
      try {
        const list = await client.perfList();
        store.update((s) => {
          s.link.takeNames = Object.fromEntries(
            (list.takes ?? []).map((t) => [t.id, t.name ?? ""]));
        });
      } catch { /* pre-name firmware */ }
    },

    async refreshStatus() {
      if (!client) return;
      const st = await client.status();
      store.update((s) => {
        s.link.activeLayout = st.activeLayout ?? null;
        s.link.bankIndex = st.bankIndex ?? 0;
        s.link.gestures = st.gestures ?? {};
      });
    },

    // ── F6 recorder (device performance takes) ──
    // Every fresh status also mirrors the loaded take's loop mode into
    // lens.loop — loop is a property of the take (it rides the sidecar), so
    // the ⟲ LOOP button follows whichever take is loaded. Older firmware
    // without the field leaves the app-local value alone.
    async refreshPerf() {
      if (!client) return;
      const perf = await client.perfStatus();
      store.update((s) => {
        s.link.perf = perf;
        if (typeof perf?.loop === "boolean") s.lens.loop = perf.loop;
      });
    },

    // Remote transport; the ACK carries fresh recorder status.
    // extra: {id} for trigger/toggle (fire a specific take), {pos}/{frac}
    // for scrub verbs.
    async perfControl(action, extra = null) {
      if (!client) throw new Error("not connected");
      const ack = await client.perfControl(action, extra);
      store.update((s) => {
        s.link.perf = ack.perf ?? s.link.perf;
        if (typeof ack.perf?.loop === "boolean") s.lens.loop = ack.perf.loop;
      });
      if (action === "clear" || action === "restore") {
        await this.refreshManifest();   // stored take set aside / brought back
      }
      return ack;
    },

    async perfSave(id = "take") {
      if (!client) throw new Error("not connected");
      const ack = await client.perfSave(id);
      log("Perf", `saved "${id}" · ${ack.hash}`);
      await this.refreshManifest();
      await this.refreshPerf();
      return ack;
    },

    async perfLoad(id) {
      if (!client) throw new Error("not connected");
      await client.perfLoad(id);
      log("Perf", `loaded "${id}" into the recorder`);
      await this.refreshPerf();
    },

    perfFetch(id) {                     // raw PERF_DATA payload (perf.mjs splits)
      if (!client) throw new Error("not connected");
      return client.perfGet(id);
    },

    async perfPutData(payload) {
      if (!client) throw new Error("not connected");
      const ack = await client.perfPut(payload);
      log("Perf", `stored "${ack.id}" · ${ack.hash}`);
      await this.refreshManifest();
      return ack;
    },

    async perfDelete(id) {
      if (!client) throw new Error("not connected");
      await client.del("performance", id);
      log("Perf", `deleted take "${id}"`);
      await this.refreshManifest();
    },

    // Differential push (contract §5.2): PUT stale docs, DELETE device-only
    // layouts, verify stored hashes, refresh the manifest.
    push(pedalsById) {
      return serialized("push", () => this.pushNow(pedalsById));
    },

    async pushNow(pedalsById) {
      if (!client) throw new Error("not connected");
      const { docs } = store.state;
      const rows = manifestDiff(docs, pedalsById, store.state.link.manifest);
      let pushed = 0;
      for (const r of rows) {
        if (r.status === "in-sync") continue;
        if (r.status === "delete") {
          await client.del("layout", r.id);
          log("Sync", `DELETE layout ${r.id} ✓`);
        } else {
          const localHash = fnv1a32(r.bytes);
          const ack = await client.put(r.bytes);
          if (ack.hash !== localHash)
            throw new Error(`hash mismatch on ${r.kind} ${r.id}: sent ${localHash}, stored ${ack.hash}`);
          log("Sync", `PUT ${r.kind}:${r.id} · ${r.bytes.length} B ✓ ${ack.hash}`);
        }
        pushed++;
      }
      log("Sync", pushed ? `push complete: ${pushed} doc(s)` : "nothing to push — all in sync");
      await this.refreshManifest();
      await this.refreshStatus();
      return pushed;
    },

    // Push just the settings doc — appearance prefs apply to the glass
    // immediately instead of waiting for the next full push.
    pushSettings() {
      return serialized("push settings", async () => {
        if (!client) throw new Error("not connected");
        const bytes = docBytes(store.state.docs.settings);
        const ack = await client.put(bytes);
        log("Sync", `PUT settings · ${bytes.length} B ✓ ${ack.hash}`);
        await this.refreshManifest();
      });
    },

    // Push-then-activate (the demo's money shot).
    activate(layoutId, pedalsById) {
      return serialized("activate", async () => {
        if (!client) throw new Error("not connected");
        await this.pushNow(pedalsById);
        const ack = await client.activate(layoutId);
        log("Config", `activate layout=${layoutId} ${ack.errors ? `· ${ack.errors} error cell(s)` : "✓"}`);
        await this.refreshStatus();
        return ack;
      });
    },

    // Live preview CC (omniport heel→toe scrubber, when connected over MIDI).
    // Updates live state WITHOUT notifying: a re-render here would replace
    // the scrubber under the pointer mid-drag. The mirror catches up on the
    // next render.
    sendCC(channel, cc, value) {
      midi?.sendCC(channel, cc, value);
      mock?.feedCC(channel, cc, value);   // demo device records these (F6)
      store.state.live[`${channel}:${cc}`] = value;
    },

    // Program Change → the pedal chain (real wire on the MIDI transport only;
    // the firmware forwards USB PC out the DIN jack). Used to teach a Chase
    // Bliss pedal its MIDI channel: booted with both footswitches held, the
    // pedal adopts the channel of the first message it hears.
    sendPC(channel, program) {
      midi?.sendPC(channel, program);
    },
  };

  return link;
}
