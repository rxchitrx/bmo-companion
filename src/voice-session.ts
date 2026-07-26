export type VoiceStatus = "idle" | "listening" | "degraded";

export interface VoiceRecognitionPort {
  start(): void;
  stop(): void;
  onResult(listener: (transcript: string) => void): () => void;
  onError(listener: (message: string) => void): () => void;
  onEnd(listener: () => void): () => void;
}

export type VoiceEvent =
  | { type: "listening" }
  | { type: "goal"; goal: string }
  | { type: "stop" }
  | { type: "degraded"; message: string }
  | { type: "idle" };

/**
 * Keeps browser speech transport at the edge of the Companion. The only
 * meaningful outputs are a goal for the existing Task path or an owner Stop.
 */
export class VoiceSession {
  private status: VoiceStatus = "idle";
  private readonly unsubscribe: Array<() => void>;

  constructor(
    private readonly recognition: VoiceRecognitionPort,
    private readonly emit: (event: VoiceEvent) => void,
  ) {
    this.unsubscribe = [
      recognition.onResult((transcript) => this.handleTranscript(transcript)),
      recognition.onError((message) => this.degrade(message)),
      recognition.onEnd(() => {
        if (this.status === "listening") this.setIdle();
      }),
    ];
  }

  get currentStatus(): VoiceStatus { return this.status; }

  startPushToTalk(): void {
    if (this.status === "listening") return;
    // This event intentionally precedes microphone transport startup.
    this.status = "listening";
    this.emit({ type: "listening" });
    try {
      this.recognition.start();
    } catch (error) {
      this.degrade(error instanceof Error ? error.message : "Voice transport is unavailable.");
    }
  }

  releasePushToTalk(): void {
    if (this.status !== "listening") return;
    this.recognition.stop();
  }

  dispose(): void { this.unsubscribe.forEach((remove) => remove()); }

  private handleTranscript(transcript: string): void {
    const clean = transcript.trim();
    if (!clean || this.status !== "listening") return;
    this.recognition.stop();
    this.status = "idle";
    if (/^(?:(?:hey\s+)?bmo[,.! ]+)?(?:stop|cancel)(?:\s+(?:the\s+)?task)?[.! ]*$/i.test(clean)) {
      this.emit({ type: "stop" });
      this.emit({ type: "idle" });
      return;
    }
    this.emit({ type: "goal", goal: clean.replace(/^hey\s+bmo[,.! ]*/i, "") });
    this.emit({ type: "idle" });
  }

  private degrade(message: string): void {
    this.status = "degraded";
    this.emit({ type: "degraded", message: message || "Voice transport is unavailable." });
  }

  private setIdle(): void {
    this.status = "idle";
    this.emit({ type: "idle" });
  }
}

interface SpeechRecognitionEventLike {
  results: ArrayLike<ArrayLike<{ transcript: string }>>;
}

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error?: string; message?: string }) => void) | null;
  onend: (() => void) | null;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

/** Browser adapter. It never persists raw audio or transcripts. */
export function createBrowserRecognition(): VoiceRecognitionPort | null {
  const Recognition = (window as Window & {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }).SpeechRecognition ?? (window as Window & {
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }).webkitSpeechRecognition;
  if (!Recognition) return null;

  const recognition = new Recognition();
  recognition.continuous = false;
  recognition.interimResults = false;
  recognition.lang = navigator.language || "en-US";
  return {
    start: () => recognition.start(),
    stop: () => recognition.stop(),
    onResult(listener) {
      recognition.onresult = (event) => listener(event.results[0]?.[0]?.transcript ?? "");
      return () => { recognition.onresult = null; };
    },
    onError(listener) {
      recognition.onerror = (event) => listener(event.message || event.error || "Voice transport failed.");
      return () => { recognition.onerror = null; };
    },
    onEnd(listener) {
      recognition.onend = listener;
      return () => { recognition.onend = null; };
    },
  };
}

export function conciseSpeech(text: string): string {
  const normalized = text.replace(/^VERIFIED OUTCOME:\s*/i, "").replace(/\s+/g, " ").trim();
  return normalized.length > 220 ? `${normalized.slice(0, 217).trimEnd()}…` : normalized;
}
