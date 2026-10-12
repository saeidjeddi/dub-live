(() => {
  if (window.__dubMeetingInjected || !window.RTCPeerConnection) return;
  window.__dubMeetingInjected = true;

  let cfg = { enabled: false, workletUrl: null };
  const tracks = new WeakMap();
  const playback = new Map();
  const originalAddTrack = RTCPeerConnection.prototype.addTrack;
  const originalAddTransceiver = RTCPeerConnection.prototype.addTransceiver;
  const senderPrototype = globalThis.RTCRtpSender?.prototype;
  const originalReplaceTrack = senderPrototype?.replaceTrack;
  const routes = new Set();
  const pcs = new Set(); // WeakRef<RTCPeerConnection> for every connection the page creates
  const ours = new WeakSet(); // output tracks we created, so they are never routed again

  // Track every RTCPeerConnection so that, when translation is switched on while a call is
  // already open, we can swap the live microphone sender instead of requiring a rejoin.
  const NativePC = window.RTCPeerConnection;
  window.RTCPeerConnection = new Proxy(NativePC, {
    construct(target, args, newTarget) {
      const pc = Reflect.construct(target, args, newTarget);
      pcs.add(new WeakRef(pc));
      return pc;
    },
  });

  function rerouteExisting() {
    for (const ref of pcs) {
      const pc = ref.deref();
      if (!pc || pc.connectionState === "closed") { pcs.delete(ref); continue; }
      let senders = [];
      try { senders = pc.getSenders(); } catch { continue; }
      for (const sender of senders) {
        const track = sender.track;
        if (!track || ours.has(track) || !isMicrophone(track)) continue;
        let route;
        try { route = routeMicrophone(track); }
        catch (error) {
          window.postMessage({ dubExt: true, type: "micHookError", error: String(error.message || error) }, "*");
          continue;
        }
        route.senders.push(sender);
        routes.add(route);
        originalReplaceTrack.call(sender, route.outputTrack).catch(() => {});
        window.postMessage({ dubExt: true, type: "micHookActive", trackId: route.trackId }, "*");
      }
    }
  }

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (event.source !== window || !data?.dubExt) return;
    if (data.type === "cfg") {
      cfg = { ...cfg, ...data };
      if (!cfg.enabled) {
        for (const route of routes) {
          for (const sender of route.senders) {
            try { sender.replaceTrack(route.sourceTrack); } catch {}
          }
          try { route.outputTrack.stop(); } catch {}
          route.ctx.close().catch(() => {});
          playback.delete(route.trackId);
          tracks.delete(route.sourceTrack);
        }
        routes.clear();
      } else {
        rerouteExisting();
      }
      return;
    }
    if (data.type === "translatedMic") {
      const output = playback.get(data.trackId);
      if (!output) return;
      if (data.interrupted) output.state.next = output.ctx.currentTime;
      if (!data.pcm) return;
      try {
        __DubKit.playPcm(output.ctx, output.gain, data.pcm, data.rate || 24000, output.state);
      } catch (error) {
        console.warn("[Dub Live] could not play translated microphone audio", error);
      }
    }
  });

  function isMicrophone(track) {
    if (track.kind !== "audio") return false;
    const settings = track.getSettings?.() || {};
    if (settings.displaySurface || settings.logicalSurface) return false;
    return !/screen|display|system|tab audio/i.test(track.label || "");
  }

  function routeMicrophone(track) {
    if (tracks.has(track)) return tracks.get(track);
    let ctx;
    try { ctx = new AudioContext({ sampleRate: 16000 }); }
    catch { ctx = new AudioContext(); }
    const destination = ctx.createMediaStreamDestination();
    const input = ctx.createMediaStreamSource(new MediaStream([track]));
    const translated = ctx.createGain();
    translated.gain.value = 1;
    translated.connect(destination);
    const outputTrack = destination.stream.getAudioTracks()[0];
    ours.add(outputTrack);
    const trackId = crypto.randomUUID();
    const state = { next: 0 };
    playback.set(trackId, { ctx, gain: translated, state });

    ctx.resume().catch(() => {});
    __DubKit.tap(ctx, input, null, {
      onFrame: (frame) => {
        if (!cfg.enabled) return;
        const ratio = ctx.sampleRate / 16000;
        const pcm = new Int16Array(Math.max(1, Math.floor(frame.length / ratio)));
        for (let i = 0; i < pcm.length; i++) {
          const start = Math.floor(i * ratio);
          const end = Math.min(frame.length, Math.max(start + 1, Math.floor((i + 1) * ratio)));
          let total = 0;
          for (let j = start; j < end; j++) total += frame[j];
          const sample = Math.max(-1, Math.min(1, total / (end - start)));
          pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
        }
        const bytes = new Uint8Array(pcm.buffer);
        let binary = "";
        for (let i = 0; i < bytes.length; i += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        }
        window.postMessage({
          dubExt: true,
          type: "micFrame",
          trackId,
          sourceLang: cfg.sourceLang,
          targetLang: cfg.targetLang,
          pcm: btoa(binary),
        }, "*");
      },
    }, cfg.workletUrl).catch((error) => {
      console.error("[Dub Live] microphone audio worklet failed", error);
      window.postMessage({ dubExt: true, type: "micHookError", error: String(error.message || error) }, "*");
    });

    const route = { sourceTrack: track, outputTrack, trackId, ctx, destination, senders: [] };
    tracks.set(track, route);
    track.addEventListener("ended", () => {
      try { outputTrack.stop(); } catch {}
      ctx.close().catch(() => {});
      playback.delete(trackId);
    }, { once: true });
    return route;
  }

  RTCPeerConnection.prototype.addTrack = function (track, ...streams) {
    if (!cfg.enabled || !isMicrophone(track)) return originalAddTrack.call(this, track, ...streams);
    let route;
    try { route = routeMicrophone(track); }
    catch (error) {
      window.postMessage({ dubExt: true, type: "micHookError", error: String(error.message || error) }, "*");
      return originalAddTrack.call(this, track, ...streams);
    }
    const sender = originalAddTrack.call(this, route.outputTrack, ...streams);
    route.senders.push(sender);
    routes.add(route);
    window.postMessage({ dubExt: true, type: "micHookActive", trackId: route.trackId }, "*");
    return sender;
  };

  if (originalAddTransceiver) {
    RTCPeerConnection.prototype.addTransceiver = function (trackOrKind, init) {
      if (typeof trackOrKind !== "string" && cfg.enabled && isMicrophone(trackOrKind)) {
        let route;
        try { route = routeMicrophone(trackOrKind); }
        catch (error) {
          window.postMessage({ dubExt: true, type: "micHookError", error: String(error.message || error) }, "*");
          return originalAddTransceiver.call(this, trackOrKind, init);
        }
        const transceiver = originalAddTransceiver.call(this, route.outputTrack, init);
        route.senders.push(transceiver.sender);
        routes.add(route);
        window.postMessage({ dubExt: true, type: "micHookActive", trackId: route.trackId }, "*");
        return transceiver;
      }
      return originalAddTransceiver.call(this, trackOrKind, init);
    };
  }

  if (originalReplaceTrack) {
    senderPrototype.replaceTrack = function (track) {
      if (!cfg.enabled || !track || !isMicrophone(track)) {
        return originalReplaceTrack.call(this, track);
      }
      let route;
      try { route = routeMicrophone(track); }
      catch (error) {
        window.postMessage({ dubExt: true, type: "micHookError", error: String(error.message || error) }, "*");
        return originalReplaceTrack.call(this, track);
      }
      route.senders.push(this);
      routes.add(route);
      window.postMessage({ dubExt: true, type: "micHookActive", trackId: route.trackId }, "*");
      return originalReplaceTrack.call(this, route.outputTrack);
    };
  }

  window.postMessage({ dubExt: true, type: "ready" }, "*");
})();
