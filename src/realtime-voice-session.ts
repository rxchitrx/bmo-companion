import { clientDiagnostic } from "./diagnostics";
import type {
  CompanionApi,
  RealtimeVoiceStartResult,
  RealtimeVoiceUpdate,
  TokenUsage,
} from "./types";

export type RealtimeUiStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "listening"
  | "thinking"
  | "speaking"
  | "degraded";

export interface RealtimeUiEvent {
  status: RealtimeUiStatus;
  message?: string;
}

export type MicrophoneWaveform = number[];
export interface MicrophoneTrackState {
  label: string;
  muted: boolean;
  readyState: MediaStreamTrackState;
}

export function createMicrophoneConstraints(
  deviceId?: string,
): MediaTrackConstraints {
  return {
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };
}

export function classifyRealtimeDataEvent(type: string): RealtimeUiStatus | null {
  const normalized = type.toLowerCase();
  if (normalized.includes("speech_started")) return "listening";
  if (normalized.includes("speech_stopped")) return "thinking";
  if (
    normalized.includes("audio.delta") ||
    normalized.includes("audio_delta") ||
    normalized.includes("output_audio_buffer.started")
  ) return "speaking";
  if (
    normalized.includes("audio.done") ||
    normalized.includes("audio_done") ||
    normalized.includes("output_audio_buffer.stopped") ||
    normalized.includes("response.done") ||
    normalized.includes("turn.done")
  ) return "connected";
  return null;
}

export function normalizeRealtimeTokenUsage(value: unknown): TokenUsage | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, any>;
  const candidate =
    source.usage ??
    source.session?.usage ??
    source.response?.usage ??
    source.turn?.usage ??
    source.tokenUsage?.total ??
    source.token_usage?.total ??
    source.turn?.tokenUsage?.total ??
    source.turn?.token_usage?.total ??
    source;
  if (!candidate || typeof candidate !== "object") return null;
  const usage = candidate as Record<string, any>;
  const number = (...keys: string[]) => {
    for (const key of keys) {
      if (typeof usage[key] === "number" && Number.isFinite(usage[key])) {
        return Math.max(0, Math.round(usage[key]));
      }
    }
    return 0;
  };
  const detailNumber = (
    details: Record<string, unknown>,
    ...keys: string[]
  ) => {
    for (const key of keys) {
      if (
        typeof details[key] === "number" &&
        Number.isFinite(details[key] as number)
      ) {
        return Math.max(0, Math.round(details[key] as number));
      }
    }
    return 0;
  };
  const inputTokens = number("inputTokens", "input_tokens");
  const cachedInputTokens =
    number("cachedInputTokens", "cached_input_tokens") ||
    detailNumber(
      usage.input_token_details ?? usage.inputTokensDetails ?? {},
      "cachedTokens",
      "cached_tokens",
    );
  const outputTokens = number("outputTokens", "output_tokens");
  const reasoningOutputTokens =
    number("reasoningOutputTokens", "reasoning_output_tokens") ||
    (() => {
      const details =
        usage.output_token_details ?? usage.outputTokensDetails ?? {};
      const reasoning =
        details.reasoningTokens ?? details.reasoning_tokens;
      return typeof reasoning === "number" && Number.isFinite(reasoning)
        ? Math.max(0, Math.round(reasoning))
        : 0;
    })();
  const totalTokens =
    number("totalTokens", "total_tokens") || inputTokens + outputTokens;
  return totalTokens > 0
    ? {
        inputTokens,
        cachedInputTokens,
        outputTokens,
        reasoningOutputTokens,
        totalTokens,
      }
    : null;
}

export function normalizeRealtimeAudioDurationMs(value: unknown): number | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const usage =
    source.usage && typeof source.usage === "object"
      ? (source.usage as Record<string, unknown>)
      : source;
  const durationMs = usage.audio_duration_ms;
  return typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs > 0
    ? Math.round(durationMs)
    : null;
}

/** A rough transcript-only estimate; it does not count audio or hidden context. */
export function estimateTranscriptTokens(text: string): number {
  const normalized = text.trim();
  return normalized ? Math.ceil(normalized.length / 4) : 0;
}

export class CodexRealtimeVoiceSession {
  private peer: RTCPeerConnection | null = null;
  private stream: MediaStream | null = null;
  private audio: HTMLAudioElement | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private inputAudioContext: AudioContext | null = null;
  private inputAnalyser: AnalyserNode | null = null;
  private inputMeterFrame: number | null = null;
  private status: RealtimeUiStatus = "idle";
  private starting: Promise<void> | null = null;
  private sessionId: string | null = null;
  private selectedDeviceId = "";
  private micEnabled = true;

  constructor(
    private readonly api: CompanionApi,
    private readonly emit: (event: RealtimeUiEvent) => void,
    private readonly emitWaveform: (waveform: MicrophoneWaveform) => void = () => {},
    private readonly emitMicrophoneState: (
      state: MicrophoneTrackState | null,
    ) => void = () => {},
    private readonly emitUsage: (usage: TokenUsage) => void = () => {},
    private readonly emitAudioDuration: (durationMs: number) => void = () => {},
  ) {}

  get currentStatus() {
    return this.status;
  }

  get active() {
    return this.status !== "idle" && this.status !== "degraded";
  }

  get microphoneEnabled() {
    return this.micEnabled;
  }

  get inputDeviceId() {
    return this.selectedDeviceId;
  }

  start(deviceId = this.selectedDeviceId): Promise<void> {
    if (this.starting) return this.starting;
    if (this.active) {
      clientDiagnostic("voice.webrtc", "start.ignored_already_active", {
        status: this.status,
        sessionId: this.sessionId,
      });
      return Promise.resolve();
    }
    this.selectedDeviceId = deviceId;
    this.starting = this.startInternal().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  setMicrophoneEnabled(enabled: boolean) {
    this.micEnabled = enabled;
    for (const track of this.stream?.getAudioTracks() ?? []) {
      track.enabled = enabled;
    }
    if (!enabled) this.emitWaveform([]);
    clientDiagnostic("voice.webrtc", "microphone.enabled_changed", {
      enabled,
      sessionId: this.sessionId,
      trackCount: this.stream?.getAudioTracks().length ?? 0,
    });
  }

  async setInputDevice(deviceId: string): Promise<void> {
    clientDiagnostic("voice.webrtc", "microphone.device_change_requested", {
      deviceId: deviceId || "default",
      active: this.active,
      sessionId: this.sessionId,
    });
    if (!this.stream || !this.peer) {
      this.selectedDeviceId = deviceId;
      return;
    }

    const replacement = await this.openMicrophone(deviceId);
    const nextTrack = replacement.getAudioTracks()[0];
    if (!nextTrack) {
      for (const track of replacement.getTracks()) track.stop();
      throw new Error("The selected microphone did not return an audio track.");
    }
    nextTrack.enabled = this.micEnabled;
    const sender = this.peer
      .getSenders()
      .find((candidate) => candidate.track?.kind === "audio");
    if (!sender) {
      for (const track of replacement.getTracks()) track.stop();
      throw new Error("The live voice connection has no microphone sender.");
    }
    await sender.replaceTrack(nextTrack);
    const previous = this.stream;
    this.selectedDeviceId = deviceId;
    this.stream = replacement;
    this.watchInputTrack(nextTrack);
    this.startInputMeter(replacement);
    for (const track of previous.getTracks()) track.stop();
    clientDiagnostic("voice.webrtc", "microphone.device_changed", {
      deviceId: deviceId || "default",
      label: nextTrack.label,
      enabled: nextTrack.enabled,
      readyState: nextTrack.readyState,
      sessionId: this.sessionId,
    });
  }

  async stop(reason = "user ended voice chat"): Promise<void> {
    clientDiagnostic("voice.webrtc", "stop.requested", {
      reason,
      status: this.status,
      sessionId: this.sessionId,
    });
    const sessionId = this.sessionId;
    this.cleanupLocal();
    this.setStatus("idle");
    try {
      await this.api.stopRealtimeVoice();
      clientDiagnostic("voice.webrtc", "stop.completed", { reason, sessionId });
    } catch (error) {
      clientDiagnostic("voice.webrtc", "stop.failed", {
        reason,
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  applyServerUpdate(update: RealtimeVoiceUpdate) {
    if (this.sessionId && update.sessionId !== this.sessionId) {
      clientDiagnostic("voice.webrtc", "server_update.ignored_stale", {
        activeSessionId: this.sessionId,
        incomingSessionId: update.sessionId,
        status: update.status,
      });
      return;
    }
    clientDiagnostic("voice.webrtc", "server_update.received", {
      sessionId: update.sessionId,
      status: update.status,
      role: update.role,
      transcript: update.transcript,
      error: update.error,
      reason: update.reason,
    });
    if (update.status === "failed") {
      this.cleanupLocal();
      this.setStatus("degraded", update.error ?? "Codex realtime voice failed.");
    } else if (update.status === "closed") {
      this.cleanupLocal();
      const reason =
        update.reason === "requested" ||
        update.reason === "renderer requested stop"
          ? "Voice ended."
          : update.reason;
      this.setStatus("idle", reason);
    } else {
      this.setStatus(update.status);
    }
  }

  dispose() {
    clientDiagnostic("voice.webrtc", "disposed", {
      status: this.status,
      sessionId: this.sessionId,
    });
    this.cleanupLocal();
    void this.api.stopRealtimeVoice().catch(() => {});
  }

  private async startInternal() {
    this.setStatus("connecting", "Connecting to Codex Voice…");
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("Microphone capture is unavailable in this Electron build.");
      }
      clientDiagnostic("voice.webrtc", "microphone.requested", {
        secureContext: window.isSecureContext,
        online: navigator.onLine,
      });
      const stream = await this.openMicrophone(this.selectedDeviceId);
      this.stream = stream;
      const audioTracks = stream.getAudioTracks();
      for (const track of audioTracks) track.enabled = this.micEnabled;
      clientDiagnostic("voice.webrtc", "microphone.granted", {
        trackCount: audioTracks.length,
        tracks: audioTracks.map((track) => ({
          enabled: track.enabled,
          muted: track.muted,
          readyState: track.readyState,
          settings: track.getSettings(),
        })),
      });
      if (audioTracks.length === 0) throw new Error("No microphone audio track was returned.");
      this.watchInputTrack(audioTracks[0]);
      this.startInputMeter(stream);

      const peer = new RTCPeerConnection();
      this.peer = peer;
      for (const track of audioTracks) peer.addTrack(track, stream);

      const audio = new Audio();
      audio.autoplay = true;
      this.audio = audio;
      peer.ontrack = (event) => {
        const remoteStream = event.streams[0] ?? new MediaStream([event.track]);
        audio.srcObject = remoteStream;
        clientDiagnostic("voice.webrtc", "remote_audio.track_received", {
          trackKind: event.track.kind,
          trackMuted: event.track.muted,
          streamTrackCount: remoteStream.getTracks().length,
        });
        void audio.play()
          .then(() => clientDiagnostic("voice.webrtc", "remote_audio.playing"))
          .catch((error) => {
            clientDiagnostic("voice.webrtc", "remote_audio.play_failed", {
              error: error instanceof Error ? error.message : String(error),
            });
          });
      };

      const channel = peer.createDataChannel("oai-events");
      this.dataChannel = channel;
      channel.onopen = () => {
        clientDiagnostic("voice.webrtc", "data_channel.open");
        this.setStatus("connected", "Voice is live — just talk.");
      };
      channel.onclose = () =>
        clientDiagnostic("voice.webrtc", "data_channel.closed");
      channel.onerror = () =>
        clientDiagnostic("voice.webrtc", "data_channel.error");
      channel.onmessage = (event) => this.handleDataMessage(event.data);

      peer.onconnectionstatechange = () => {
        clientDiagnostic("voice.webrtc", "peer.connection_state", {
          connectionState: peer.connectionState,
          iceConnectionState: peer.iceConnectionState,
          signalingState: peer.signalingState,
        });
        if (peer.connectionState === "connected") {
          this.setStatus("connected", "Voice is live — just talk.");
        } else if (peer.connectionState === "failed") {
          this.cleanupLocal();
          this.setStatus("degraded", "The Codex Voice WebRTC connection failed.");
        }
      };
      peer.oniceconnectionstatechange = () =>
        clientDiagnostic("voice.webrtc", "peer.ice_state", {
          iceConnectionState: peer.iceConnectionState,
        });
      peer.onicegatheringstatechange = () =>
        clientDiagnostic("voice.webrtc", "peer.ice_gathering_state", {
          iceGatheringState: peer.iceGatheringState,
        });

      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      await waitForIceGathering(peer);
      const offerSdp = peer.localDescription?.sdp;
      if (!offerSdp) throw new Error("WebRTC failed to create a local SDP offer.");
      clientDiagnostic("voice.webrtc", "offer.ready", {
        sdp: offerSdp,
        signalingState: peer.signalingState,
      });

      const result: RealtimeVoiceStartResult =
        await this.api.startRealtimeVoice(offerSdp);
      this.sessionId = result.sessionId;
      clientDiagnostic("voice.webrtc", "answer.received", {
        sessionId: result.sessionId,
        sdp: result.answerSdp,
      });
      await peer.setRemoteDescription({
        type: "answer",
        sdp: result.answerSdp,
      });
      clientDiagnostic("voice.webrtc", "answer.applied", {
        sessionId: result.sessionId,
        signalingState: peer.signalingState,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      clientDiagnostic("voice.webrtc", "start.failed", { error: message });
      this.cleanupLocal();
      this.setStatus("degraded", message);
      await this.api.stopRealtimeVoice().catch(() => {});
      throw error;
    }
  }

  private handleDataMessage(raw: unknown) {
    const rawText = typeof raw === "string" ? raw : "";
    let type = "unknown";
    let role: string | undefined;
    try {
      const event = JSON.parse(rawText) as {
        type?: string;
        role?: string;
        item?: { role?: string };
        turn?: { role?: string };
      };
      type = event.type ?? "unknown";
      role = event.role ?? event.item?.role ?? event.turn?.role;
      if (
        type === "session.usage.updated" ||
        type === "response.done" ||
        type === "turn.done"
      ) {
        const audioDurationMs = normalizeRealtimeAudioDurationMs(event);
        if (audioDurationMs != null) this.emitAudioDuration(audioDurationMs);
        const usage = normalizeRealtimeTokenUsage(event);
        if (usage) {
          clientDiagnostic("voice.webrtc", "usage.updated", { usage });
          this.emitUsage(usage);
        }
      }
    } catch {
      type = "unparsed";
    }
    clientDiagnostic("voice.webrtc", "data_channel.message", {
      type,
      role,
      byteLength: rawText.length,
    });
    const nextStatus = classifyRealtimeDataEvent(type);
    if (nextStatus) this.setStatus(nextStatus);
  }

  private cleanupLocal() {
    const peer = this.peer;
    const stream = this.stream;
    const audio = this.audio;
    const dataChannel = this.dataChannel;
    this.peer = null;
    this.stream = null;
    this.audio = null;
    this.dataChannel = null;
    this.sessionId = null;
    this.stopInputMeter();
    this.emitMicrophoneState(null);
    if (dataChannel && dataChannel.readyState !== "closed") dataChannel.close();
    if (peer && peer.connectionState !== "closed") peer.close();
    for (const track of stream?.getTracks() ?? []) track.stop();
    if (audio) {
      audio.pause();
      audio.srcObject = null;
    }
  }

  private openMicrophone(deviceId: string): Promise<MediaStream> {
    return navigator.mediaDevices.getUserMedia({
      audio: createMicrophoneConstraints(deviceId),
      video: false,
    });
  }

  private startInputMeter(stream: MediaStream) {
    this.stopInputMeter();
    const audioContext = new AudioContext();
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 128;
    analyser.smoothingTimeConstant = 0.68;
    audioContext.createMediaStreamSource(stream).connect(analyser);
    this.inputAudioContext = audioContext;
    this.inputAnalyser = analyser;
    const samples = new Uint8Array(analyser.fftSize);
    let lastEmission = 0;
    const draw = (timestamp: number) => {
      if (this.inputAnalyser !== analyser) return;
      this.inputMeterFrame = window.requestAnimationFrame(draw);
      if (timestamp - lastEmission < 50) return;
      lastEmission = timestamp;
      if (!this.micEnabled) {
        this.emitWaveform([]);
        return;
      }
      analyser.getByteTimeDomainData(samples);
      const step = Math.max(1, Math.floor(samples.length / 24));
      const waveform: number[] = [];
      for (let index = 0; index < samples.length && waveform.length < 24; index += step) {
        const normalized = ((samples[index] - 128) / 128) * 4.5;
        waveform.push(Math.max(-1, Math.min(1, normalized)));
      }
      this.emitWaveform(waveform);
    };
    this.inputMeterFrame = window.requestAnimationFrame(draw);
    clientDiagnostic("voice.webrtc", "microphone.meter_started", {
      fftSize: analyser.fftSize,
      sampleRate: audioContext.sampleRate,
    });
  }

  private watchInputTrack(track: MediaStreamTrack) {
    const publish = () => {
      const state: MicrophoneTrackState = {
        label: track.label,
        muted: track.muted,
        readyState: track.readyState,
      };
      this.emitMicrophoneState(state);
      clientDiagnostic("voice.webrtc", "microphone.track_state", { ...state });
    };
    track.onmute = publish;
    track.onunmute = publish;
    track.onended = publish;
    publish();
  }

  private stopInputMeter() {
    if (this.inputMeterFrame !== null) {
      window.cancelAnimationFrame(this.inputMeterFrame);
      this.inputMeterFrame = null;
    }
    this.inputAnalyser?.disconnect();
    this.inputAnalyser = null;
    const audioContext = this.inputAudioContext;
    this.inputAudioContext = null;
    if (audioContext && audioContext.state !== "closed") {
      void audioContext.close().catch(() => {});
    }
    this.emitWaveform([]);
  }

  private setStatus(status: RealtimeUiStatus, message?: string) {
    if (this.status === status && !message) return;
    const priorStatus = this.status;
    this.status = status;
    clientDiagnostic("voice.webrtc", "state.changed", {
      priorStatus,
      status,
      message,
      sessionId: this.sessionId,
    });
    this.emit({ status, message });
  }
}

export async function waitForIceGathering(
  peer: Pick<RTCPeerConnection, "iceGatheringState" | "addEventListener" | "removeEventListener">,
  timeoutMs = 5_000,
): Promise<void> {
  if (peer.iceGatheringState === "complete") return;
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      peer.removeEventListener("icegatheringstatechange", onStateChange);
      resolve();
    };
    const onStateChange = () => {
      if (peer.iceGatheringState === "complete") finish();
    };
    const timer = window.setTimeout(finish, timeoutMs);
    peer.addEventListener("icegatheringstatechange", onStateChange);
  });
}
