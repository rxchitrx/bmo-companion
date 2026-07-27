import { clientDiagnostic } from "./diagnostics";

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
    clientDiagnostic("voice.session", "constructed");
    this.unsubscribe = [
      recognition.onResult((transcript) => this.handleTranscript(transcript)),
      recognition.onError((message) => this.degrade(message)),
      recognition.onEnd(() => {
        clientDiagnostic("voice.session", "transport.ended", { status: this.status });
        if (this.status === "listening") this.setIdle();
      }),
    ];
  }

  get currentStatus(): VoiceStatus { return this.status; }

  startPushToTalk(): void {
    clientDiagnostic("voice.session", "push_to_talk.started", { priorStatus: this.status });
    if (this.status === "listening") {
      clientDiagnostic("voice.session", "push_to_talk.ignored_already_listening");
      return;
    }
    // This event intentionally precedes microphone transport startup.
    this.status = "listening";
    this.emit({ type: "listening" });
    try {
      clientDiagnostic("voice.session", "transport.start.requested");
      this.recognition.start();
      clientDiagnostic("voice.session", "transport.start.returned");
    } catch (error) {
      clientDiagnostic("voice.session", "transport.start.threw", {
        error: error instanceof Error ? error.message : String(error),
      });
      this.degrade(error instanceof Error ? error.message : "Voice transport is unavailable.");
    }
  }

  releasePushToTalk(): void {
    clientDiagnostic("voice.session", "push_to_talk.released", { status: this.status });
    if (this.status !== "listening") {
      clientDiagnostic("voice.session", "transport.stop.skipped_not_listening");
      return;
    }
    clientDiagnostic("voice.session", "transport.stop.requested");
    this.recognition.stop();
  }

  dispose(): void {
    clientDiagnostic("voice.session", "disposed", { status: this.status });
    this.unsubscribe.forEach((remove) => remove());
  }

  private handleTranscript(transcript: string): void {
    const clean = transcript.trim();
    clientDiagnostic("voice.session", "transcript.received", {
      transcript,
      status: this.status,
      emptyAfterTrim: clean.length === 0,
    });
    if (!clean || this.status !== "listening") {
      clientDiagnostic("voice.session", "transcript.ignored", {
        reason: !clean ? "empty" : "not_listening",
      });
      return;
    }
    this.recognition.stop();
    this.status = "idle";
    if (/^(?:(?:hey\s+)?bmo[,.! ]+)?(?:stop|cancel)(?:\s+(?:the\s+)?task)?[.! ]*$/i.test(clean)) {
      clientDiagnostic("voice.session", "transcript.classified", { classification: "stop" });
      this.emit({ type: "stop" });
      this.emit({ type: "idle" });
      return;
    }
    const goal = clean.replace(/^hey\s+bmo[,.! ]*/i, "");
    clientDiagnostic("voice.session", "transcript.classified", {
      classification: "conversation",
      goal,
    });
    this.emit({ type: "goal", goal });
    this.emit({ type: "idle" });
  }

  private degrade(message: string): void {
    clientDiagnostic("voice.session", "degraded", { error: message, priorStatus: this.status });
    this.status = "degraded";
    this.emit({ type: "degraded", message: message || "Voice transport is unavailable." });
  }

  private setIdle(): void {
    clientDiagnostic("voice.session", "state.idle", { priorStatus: this.status });
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
  clientDiagnostic("voice.browser", "capability.checked", {
    speechRecognition: "SpeechRecognition" in window,
    webkitSpeechRecognition: "webkitSpeechRecognition" in window,
    language: navigator.language,
    online: navigator.onLine,
  });
  if (!Recognition) {
    clientDiagnostic("voice.browser", "capability.unavailable");
    return null;
  }

  const recognition = new Recognition();
  recognition.continuous = false;
  recognition.interimResults = false;
  recognition.lang = navigator.language || "en-US";
  clientDiagnostic("voice.browser", "transport.created", {
    continuous: recognition.continuous,
    interimResults: recognition.interimResults,
    language: recognition.lang,
  });
  return {
    start: () => {
      clientDiagnostic("voice.browser", "recognition.start");
      recognition.start();
    },
    stop: () => {
      clientDiagnostic("voice.browser", "recognition.stop");
      recognition.stop();
    },
    onResult(listener) {
      recognition.onresult = (event) => {
        const transcript = event.results[0]?.[0]?.transcript ?? "";
        clientDiagnostic("voice.browser", "recognition.result", {
          transcript,
          resultGroups: event.results.length,
        });
        listener(transcript);
      };
      return () => { recognition.onresult = null; };
    },
    onError(listener) {
      recognition.onerror = (event) => {
        const message = event.message || event.error || "Voice transport failed.";
        clientDiagnostic("voice.browser", "recognition.error", {
          error: message,
          browserError: event.error,
          online: navigator.onLine,
        });
        listener(message);
      };
      return () => { recognition.onerror = null; };
    },
    onEnd(listener) {
      recognition.onend = () => {
        clientDiagnostic("voice.browser", "recognition.end");
        listener();
      };
      return () => { recognition.onend = null; };
    },
  };
}

export function conciseSpeech(text: string): string {
  const normalized = text.replace(/^VERIFIED OUTCOME:\s*/i, "").replace(/\s+/g, " ").trim();
  return normalized.length > 220 ? `${normalized.slice(0, 217).trimEnd()}…` : normalized;
}
