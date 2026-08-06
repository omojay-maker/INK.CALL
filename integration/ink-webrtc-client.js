import { io } from "../node_modules/socket.io/client-dist/socket.io.esm.min.js";

export class InkWebRtcClient extends EventTarget {
  constructor({ tokenEndpoint = "/call_token.php" } = {}) {
    super();
    this.tokenEndpoint = tokenEndpoint;
    this.socket = null;
    this.peer = null;
    this.localStream = null;
    this.remoteStream = new MediaStream();
    this.call = null;
    this.iceServers = [];
    this.pendingCandidates = [];
    this.storageKey = "ink.activeCall";
    this.failureTimer = null;
  }

  async connect() {
    const authResponse = await fetch(this.tokenEndpoint, {
      credentials: "same-origin",
      headers: { Accept: "application/json" }
    });
    if (!authResponse.ok) throw new Error("Could not authorize calling");
    const auth = await authResponse.json();
    const serviceUrl = new URL(auth.service_url, window.location.origin);
    const servicePath = serviceUrl.pathname.replace(/\/+$/, "");

    const iceResponse = await fetch(`${serviceUrl.origin}${servicePath}/api/v1/ice-servers`, {
      headers: { Authorization: `Bearer ${auth.token}` }
    });
    if (!iceResponse.ok) throw new Error("Could not load TURN configuration");
    this.iceServers = (await iceResponse.json()).iceServers;

    this.socket = io(serviceUrl.origin, {
      path: `${servicePath}/socket.io`,
      transports: ["websocket"],
      auth: { token: auth.token }
    });
    this.bindSocketEvents();
    await new Promise((resolve, reject) => {
      this.socket.once("connect", resolve);
      this.socket.once("connect_error", reject);
    });
    await this.restoreCall();
  }

  bindSocketEvents() {
    this.socket.on("call:incoming", (detail) => {
      this.call = {
        id: detail.callId,
        peerId: detail.caller.id,
        type: detail.callType,
        direction: "incoming",
        status: "ringing",
        peerName: detail.caller.name || "Someone",
        peerAvatar: detail.caller.avatar || ""
      };
      this.saveCall();
      this.emit("incoming", detail);
    });

    this.socket.on("call:accepted", async ({ callId }) => {
      if (callId !== this.call?.id) return;
      this.call.status = "active";
      this.call.startedAt = Date.now();
      this.saveCall();
      if (!this.localStream) await this.openMedia(this.call.type);
      await this.createPeer();
      await this.sendOffer();
      this.emit("accepted", { callId });
    });

    this.socket.on("call:peer-resumed", async ({ callId }) => {
      if (callId !== this.call?.id || this.call.status !== "active") return;
      if (this.call.direction !== "outgoing") return;
      if (!this.localStream) await this.openMedia(this.call.type);
      await this.createPeer();
      await this.sendOffer();
    });

    this.socket.on("webrtc:description", async ({ callId, fromUserId, description }) => {
      if (callId !== this.call?.id || fromUserId !== this.call.peerId) return;
      await this.createPeer();
      await this.peer.setRemoteDescription(description);
      await this.flushCandidates();

      if (description.type === "offer") {
        const answer = await this.peer.createAnswer();
        await this.peer.setLocalDescription(answer);
        this.socket.emit("webrtc:description", {
          callId,
          targetUserId: this.call.peerId,
          description: this.peer.localDescription
        });
      }
    });

    this.socket.on("webrtc:ice-candidate", async ({ callId, fromUserId, candidate }) => {
      if (callId !== this.call?.id || fromUserId !== this.call.peerId) return;
      if (!this.peer?.remoteDescription) {
        this.pendingCandidates.push(candidate);
        return;
      }
      await this.peer.addIceCandidate(candidate);
    });

    this.socket.on("call:ended", ({ callId, reason }) => {
      if (callId !== this.call?.id) return;
      const endedCall = { ...this.call };
      this.cleanup();
      this.emit("ended", { callId, reason, call: endedCall });
    });
  }

  async startCall(peerId, callType = "audio", metadata = {}) {
    this.assertConnected();
    const callId = crypto.randomUUID();
    this.call = {
      id: callId,
      peerId,
      type: callType,
      direction: "outgoing",
      status: "ringing",
      peerName: metadata.name || "Friend",
      peerAvatar: metadata.avatar || ""
    };
    this.saveCall();
    await this.openMedia(callType);

    const result = await this.emitWithAck("call:invite", {
      callId,
      calleeId: peerId,
      callType
    });
    if (!result.ok) {
      this.cleanup();
      throw new Error(result.error || "Call could not start");
    }
    this.emit("ringing", { callId, peerId, callType });
    return callId;
  }

  async acceptCall() {
    if (!this.call || this.call.direction !== "incoming") throw new Error("No incoming call");
    await this.openMedia(this.call.type);
    await this.createPeer();
    const result = await this.emitWithAck("call:accept", {
      callId: this.call.id,
      targetUserId: this.call.peerId
    });
    if (!result.ok) throw new Error(result.error || "Call could not be accepted");
    this.call.status = "active";
    this.call.startedAt = Date.now();
    this.saveCall();
  }

  async declineCall() {
    return this.endCall("declined");
  }

  async endCall(reason = "completed") {
    if (!this.call) return;
    await this.emitWithAck("call:end", {
      callId: this.call.id,
      targetUserId: this.call.peerId,
      reason
    });
    const callId = this.call.id;
    const endedCall = { ...this.call };
    this.cleanup();
    this.emit("ended", { callId, reason, call: endedCall });
  }

  setMuted(muted) {
    this.localStream?.getAudioTracks().forEach((track) => {
      track.enabled = !muted;
    });
  }

  setCameraEnabled(enabled) {
    this.localStream?.getVideoTracks().forEach((track) => {
      track.enabled = enabled;
    });
  }

  switchCamera() {
    const track = this.localStream?.getVideoTracks()[0];
    if (!track) return Promise.resolve();
    const current = track.getSettings().facingMode;
    track.stop();
    return navigator.mediaDevices.getUserMedia({
      video: { facingMode: current === "user" ? { exact: "environment" } : "user" }
    }).then((stream) => {
      const replacement = stream.getVideoTracks()[0];
      const sender = this.peer?.getSenders().find((item) => item.track?.kind === "video");
      sender?.replaceTrack(replacement);
      this.localStream.removeTrack(track);
      this.localStream.addTrack(replacement);
      this.emit("localstream", { stream: this.localStream });
    });
  }

  async openMedia(callType) {
    const audio = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    };
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio,
        video: callType === "video" ? {
          facingMode: "user",
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 24, max: 30 }
        } : false
      });
    } catch (primaryError) {
      if (callType === "video") {
        try {
          this.localStream = await navigator.mediaDevices.getUserMedia({
            audio,
            video: false
          });
          this.emit("mediawarning", {
            message: "Camera unavailable; joined with audio only",
            error: primaryError
          });
        } catch (audioError) {
          this.localStream = new MediaStream();
          this.emit("mediawarning", {
            message: "Camera and microphone unavailable; joined receive-only",
            error: audioError
          });
        }
      } else {
        this.localStream = new MediaStream();
        this.emit("mediawarning", {
          message: "Microphone unavailable; joined receive-only",
          error: primaryError
        });
      }
    }
    this.emit("localstream", { stream: this.localStream });
  }

  async createPeer() {
    if (this.peer) return;
    this.peer = new RTCPeerConnection({
      iceServers: this.iceServers,
      iceCandidatePoolSize: 10,
      bundlePolicy: "max-bundle"
    });
    this.localStream.getTracks().forEach((track) => {
      this.peer.addTrack(track, this.localStream);
    });
    this.peer.ontrack = ({ track }) => {
      this.remoteStream.addTrack(track);
      this.emit("remotestream", { stream: this.remoteStream });
    };
    this.peer.onicecandidate = ({ candidate }) => {
      if (!candidate || !this.call) return;
      this.socket.emit("webrtc:ice-candidate", {
        callId: this.call.id,
        targetUserId: this.call.peerId,
        candidate: candidate.toJSON()
      });
    };
    this.peer.onconnectionstatechange = () => {
      const state = this.peer?.connectionState;
      this.emit("connectionstate", { state });
      if (state === "connected") {
        clearTimeout(this.failureTimer);
        this.failureTimer = null;
      } else if (state === "failed" && !this.failureTimer) {
        this.failureTimer = setTimeout(() => {
          this.failureTimer = null;
          if (this.peer?.connectionState === "failed") void this.endCall("failed");
        }, 30_000);
      }
    };
  }

  async sendOffer() {
    if (!this.peer || !this.call) return;
    const offer = await this.peer.createOffer();
    await this.peer.setLocalDescription(offer);
    this.socket.emit("webrtc:description", {
      callId: this.call.id,
      targetUserId: this.call.peerId,
      description: this.peer.localDescription
    });
  }

  saveCall() {
    if (!this.call) return;
    try {
      sessionStorage.setItem(this.storageKey, JSON.stringify(this.call));
    } catch {
      // Storage can be unavailable in hardened/private browser contexts.
    }
  }

  clearSavedCall() {
    try {
      sessionStorage.removeItem(this.storageKey);
    } catch {
      // Nothing else is required when storage is unavailable.
    }
  }

  async restoreCall() {
    let restored = null;
    try {
      restored = JSON.parse(sessionStorage.getItem(this.storageKey) || "null");
    } catch {
      this.clearSavedCall();
    }
    if (!restored?.id || !restored?.peerId || !restored?.type) return;

    this.call = restored;
    const result = await this.emitWithAck("call:resume", {
      callId: restored.id,
      targetUserId: Number(restored.peerId)
    });
    if (!result?.ok) {
      this.cleanup();
      this.emit("resume-failed", {});
      return;
    }

    this.call.status = result.status;
    this.call.type = result.callType;
    this.call.direction = result.direction;
    this.call.peerId = Number(result.peerId);
    if (result.answeredAt) {
      const answeredAt = new Date(result.answeredAt).getTime();
      if (Number.isFinite(answeredAt)) this.call.startedAt = answeredAt;
    }
    this.saveCall();
    if (result.status === "active" || this.call.direction === "outgoing") {
      await this.openMedia(this.call.type);
    }
    if (result.status === "active") {
      await this.createPeer();
      const readyResult = await this.emitWithAck("call:resume-ready", {
        callId: this.call.id,
        targetUserId: this.call.peerId
      });
      if (!readyResult?.ok) {
        this.cleanup();
        this.emit("resume-failed", {});
        return;
      }
    }
    this.emit("resumed", { call: { ...this.call } });
    if (result.status === "active" && this.call.direction === "outgoing") {
      await this.sendOffer();
    }
  }

  async flushCandidates() {
    const candidates = this.pendingCandidates.splice(0);
    for (const candidate of candidates) await this.peer.addIceCandidate(candidate);
  }

  emitWithAck(event, payload) {
    return new Promise((resolve) => {
      this.socket.timeout(8000).emit(event, payload, (error, response) => {
        resolve(error ? { ok: false, error: "Signalling timeout" } : response);
      });
    });
  }

  emit(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail }));
  }

  assertConnected() {
    if (!this.socket?.connected) throw new Error("Call service is disconnected");
  }

  cleanup() {
    clearTimeout(this.failureTimer);
    this.failureTimer = null;
    this.peer?.close();
    this.peer = null;
    this.localStream?.getTracks().forEach((track) => track.stop());
    this.localStream = null;
    this.remoteStream = new MediaStream();
    this.pendingCandidates = [];
    this.call = null;
    this.clearSavedCall();
  }
}
