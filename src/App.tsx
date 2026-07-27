import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type {
  CompanionState,
  ConversationUpdate,
  RealtimeVoiceUpdate,
  RecallAnswer,
  TaskSnapshot,
} from "./types";
import { clientDiagnostic } from "./diagnostics";
import {
  conciseSpeech,
} from "./voice-session";
import {
  CodexRealtimeVoiceSession,
  type MicrophoneTrackState,
  type RealtimeUiStatus,
} from "./realtime-voice-session";

const labels: Record<CompanionState, string> = {
  idle: "Ready when you are",
  listening: "Listening…",
  approval: "Waiting for you",
  thinking: "Thinking it through",
  working: "Working on it",
  speaking: "Talking with you",
  error: "I need a hand",
};

export function App() {
  const [goal, setGoal] = useState("");
  const [task, setTask] = useState<TaskSnapshot | null>(null);
  const [conversation, setConversation] = useState<ConversationUpdate | null>(null);
  const [voiceStatus, setVoiceStatus] = useState<RealtimeUiStatus>("idle");
  const [voiceMessage, setVoiceMessage] = useState("");
  const [microphones, setMicrophones] = useState<MediaDeviceInfo[]>([]);
  const [selectedMicId, setSelectedMicId] = useState(
    () => window.localStorage.getItem("bmo.microphone.deviceId") ?? "",
  );
  const [micEnabled, setMicEnabled] = useState(true);
  const [micWaveform, setMicWaveform] = useState<number[]>([]);
  const [micTrackState, setMicTrackState] =
    useState<MicrophoneTrackState | null>(null);
  const sessionRef = useRef<CodexRealtimeVoiceSession | null>(null);
  const lastSpokenRef = useRef("");
  const taskRef = useRef<TaskSnapshot | null>(null);
  const [recall, setRecall] = useState<RecallAnswer | null>(null);

  useEffect(() => { taskRef.current = task; }, [task]);

  useEffect(() => {
    clientDiagnostic("ui", "application.mounted", {
      online: navigator.onLine,
      userAgent: navigator.userAgent,
      language: navigator.language,
      peerConnection: "RTCPeerConnection" in window,
      mediaDevices: !!navigator.mediaDevices,
    });
    const online = () => clientDiagnostic("network", "browser.online", { online: true });
    const offline = () => clientDiagnostic("network", "browser.offline", { online: false });
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);

    const refreshMicrophones = async () => {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const inputs = devices.filter((device) => device.kind === "audioinput");
        setMicrophones(inputs);
        clientDiagnostic("ui.voice", "microphone.devices_refreshed", {
          count: inputs.length,
          labelledCount: inputs.filter((device) => !!device.label).length,
        });
      } catch (error) {
        clientDiagnostic("ui.voice", "microphone.devices_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };
    void refreshMicrophones();
    navigator.mediaDevices?.addEventListener?.("devicechange", refreshMicrophones);

    const unsubscribe = window.companion.onTaskUpdate((nextTask) => {
      clientDiagnostic("ui.task", "update.received", {
        taskId: nextTask.id,
        status: nextTask.status,
        state: nextTask.state,
        progressCount: nextTask.progress.length,
        latestProgress: nextTask.progress.at(-1),
        summary: nextTask.summary,
      });
      setTask(nextTask);
      if (nextTask.status === "running") speak(nextTask.progress.at(-1) ?? "Working on it.", "task_progress");
      if (nextTask.status === "completed") speak(nextTask.summary ?? "Your task is complete.", "task_completed");
      if (nextTask.status === "cancelled") speak("Task stopped. Completed actions were not undone.", "task_cancelled");
    });

    const unsubscribeConversation = window.companion.onConversationUpdate((nextConversation) => {
      clientDiagnostic("ui.conversation", "update.received", {
        requestId: nextConversation.requestId,
        status: nextConversation.status,
        transport: nextConversation.transport,
        assistantText: nextConversation.assistantText,
        warning: nextConversation.warning,
        error: nextConversation.error,
      });
      setConversation(nextConversation);
      if (nextConversation.status === "completed" && nextConversation.assistantText) {
        speak(nextConversation.assistantText, "conversation_completed");
      }
    });

    const voiceSession = new CodexRealtimeVoiceSession(
      window.companion,
      (event) => {
        clientDiagnostic("ui.voice", "state.received", { ...event });
        setVoiceStatus(event.status);
        if (event.message) setVoiceMessage(event.message);
        else if (event.status === "connecting") setVoiceMessage("Connecting to Codex Voice…");
        else if (event.status === "connected") setVoiceMessage("Voice is live — just talk.");
        else if (event.status === "listening") setVoiceMessage("Listening…");
        else if (event.status === "thinking") setVoiceMessage("Thinking…");
        else if (event.status === "speaking") setVoiceMessage("BMO is speaking…");
        else if (event.status === "idle") setVoiceMessage("");
        else if (event.status === "degraded") {
          setVoiceMessage(event.message ?? "Codex Voice failed. Select Retry voice.");
        }
        if (event.status === "connected") void refreshMicrophones();
      },
      setMicWaveform,
      setMicTrackState,
    );
    sessionRef.current = voiceSession;

    const unsubscribeRealtimeVoice = window.companion.onRealtimeVoiceUpdate(
      (update: RealtimeVoiceUpdate) => {
        clientDiagnostic("ui.voice", "server_update.received", {
          sessionId: update.sessionId,
          status: update.status,
          role: update.role,
          transcript: update.transcript,
          error: update.error,
          reason: update.reason,
        });
        voiceSession.applyServerUpdate(update);
        if (update.transcript) {
          setVoiceMessage(
            update.role === "user"
              ? `You: ${update.transcript}`
              : update.transcript,
          );
        }
        if (
          update.role === "user" &&
          update.transcript &&
          /^(?:(?:hey\s+)?bmo[,.! ]+)?(?:stop|cancel)(?:\s+(?:the\s+)?task)?[.! ]*$/i.test(update.transcript.trim())
        ) {
          const activeTask = taskRef.current;
          if (
            activeTask &&
            ["waiting_approval", "needs_decision", "suspended", "running"].includes(activeTask.status)
          ) {
            clientDiagnostic("ui.voice", "stop.forwarded_to_task", {
              taskId: activeTask.id,
              status: activeTask.status,
            });
            void window.companion.cancelTask(activeTask.id);
          }
        }
      },
    );
    return () => {
      unsubscribe();
      unsubscribeConversation();
      unsubscribeRealtimeVoice();
      voiceSession.dispose();
      sessionRef.current = null;
      navigator.mediaDevices?.removeEventListener?.("devicechange", refreshMicrophones);
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
      clientDiagnostic("ui", "application.unmounted");
    };
  }, []);

  const conversationBusy = !!conversation && ["connecting", "sending", "responding"].includes(conversation.status);
  const taskActive = !!task && ["waiting_approval", "needs_decision", "suspended", "running"].includes(task.status);
  const state: CompanionState =
    voiceStatus === "listening"
      ? "listening"
      : voiceStatus === "speaking"
        ? "speaking"
        : voiceStatus === "connecting" || voiceStatus === "thinking"
          ? "thinking"
      : conversationBusy
        ? conversation?.status === "responding" ? "speaking" : "thinking"
        : taskActive
          ? task!.state
          : "idle";
  const latestProgress = useMemo(
    () => {
      if (conversation?.status === "connecting") return "Connecting to BMO’s conversation service…";
      if (conversation?.status === "sending") return "Sending your message…";
      if (conversation?.status === "responding") return "BMO is responding…";
      if (conversation?.status === "failed") return conversation.error ?? "Conversation failed.";
      return taskActive ? task?.progress.at(-1) ?? labels[state] : labels[state];
    },
    [conversation, state, task, taskActive],
  );
  const microphoneWaveformPoints = useMemo(() => {
    const samples = micWaveform.length > 1 ? micWaveform : Array.from({ length: 24 }, () => 0);
    return samples
      .map((sample, index) => {
        const x = (index / (samples.length - 1)) * 100;
        const y = 12 - sample * 9;
        return `${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(" ");
  }, [micWaveform]);
  const microphoneSignal =
    !micEnabled
      ? "muted"
      : voiceStatus === "idle" || voiceStatus === "degraded"
        ? "idle"
        : !micTrackState
          ? "idle"
          : micTrackState.muted || micTrackState.readyState === "ended"
            ? "no-signal"
            : "live";

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = goal.trim();
    if (!trimmed || conversationBusy) return;
    await sendMessage(trimmed, "typed");
  }

  async function toggleVoice() {
    const session = sessionRef.current;
    if (!session) return;
    clientDiagnostic("ui.voice", "toggle.requested", {
      status: session.currentStatus,
      active: session.active,
    });
    if (session.active) {
      await session.stop();
      return;
    }
    try {
      await session.start(selectedMicId);
    } catch {
      // The session has already published a safe, visible degraded state.
    }
  }

  function toggleMicrophone() {
    const enabled = !micEnabled;
    setMicEnabled(enabled);
    sessionRef.current?.setMicrophoneEnabled(enabled);
    setVoiceMessage(
      enabled
        ? sessionRef.current?.active
          ? "Microphone on — BMO can hear you."
          : "Microphone ready."
        : "Microphone muted.",
    );
  }

  async function chooseMicrophone(deviceId: string) {
    const previousDeviceId = selectedMicId;
    setSelectedMicId(deviceId);
    window.localStorage.setItem("bmo.microphone.deviceId", deviceId);
    try {
      await sessionRef.current?.setInputDevice(deviceId);
      setVoiceMessage(
        sessionRef.current?.active
          ? "Microphone switched — BMO is listening."
          : "Microphone selected.",
      );
    } catch (error) {
      setSelectedMicId(previousDeviceId);
      window.localStorage.setItem("bmo.microphone.deviceId", previousDeviceId);
      const message =
        error instanceof Error ? error.message : "Could not switch microphones.";
      setVoiceMessage(message);
      clientDiagnostic("ui.voice", "microphone.device_change_failed", {
        error: message,
      });
    }
  }

  async function sendMessage(message: string, source: "typed" | "voice") {
    const trimmed = message.trim();
    if (!trimmed) {
      clientDiagnostic("ui.conversation", "send.ignored_empty", { source });
      return;
    }
    clientDiagnostic("ui.conversation", "send.requested", {
      source,
      text: trimmed,
      online: navigator.onLine,
      priorStatus: conversation?.status,
    });
    setRecall(null);
    setVoiceMessage("");
    setConversation({
      requestId: "pending",
      status: "connecting",
      transport: "codex-turn",
    });
    try {
      const result = await window.companion.sendConversation(trimmed);
      clientDiagnostic("ui.conversation", "send.resolved", {
        source,
        requestId: result.requestId,
        status: result.status,
        transport: result.transport,
        assistantText: result.assistantText,
        warning: result.warning,
      });
      setConversation(result);
      setGoal("");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Conversation failed.";
      clientDiagnostic("ui.conversation", "send.rejected", { source, error: message });
      setConversation({
        requestId: "failed",
        status: "failed",
        transport: "codex-turn",
        error: message,
      });
    }
  }

  async function runAsTask() {
    const trimmed = goal.trim();
    if (!trimmed || taskActive || conversationBusy) return;
    clientDiagnostic("ui.task", "create.requested", { goal: trimmed });
    setRecall(null);
    try {
      setTask(await window.companion.startTask(trimmed));
      setGoal("");
    } catch (error) {
      clientDiagnostic("ui.task", "create.rejected", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function recallPastWork() {
    const question = goal.trim();
    if (!question || conversationBusy) return;
    clientDiagnostic("ui.memory", "recall.requested", { text: question });
    try {
      const answer = await window.companion.recallMemory(question);
      clientDiagnostic("ui.memory", "recall.resolved", {
        answer: answer.answer,
        referenceCount: answer.references.length,
      });
      setVoiceMessage("");
      setConversation(null);
      setRecall(answer);
      setGoal("");
    } catch (error) {
      clientDiagnostic("ui.memory", "recall.rejected", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function speak(message: string, reason: string) {
    const concise = conciseSpeech(message);
    clientDiagnostic("audio.output", "speech.requested", {
      reason,
      text: concise,
      duplicate: concise === lastSpokenRef.current,
    });
    if (!concise || concise === lastSpokenRef.current) {
      clientDiagnostic("audio.output", "speech.skipped", {
        reason: !concise ? "empty" : "duplicate",
      });
      return;
    }
    lastSpokenRef.current = concise;
    if (!("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)) {
      clientDiagnostic("audio.output", "speech.unavailable", {
        speechSynthesis: "speechSynthesis" in window,
        utteranceConstructor: "SpeechSynthesisUtterance" in window,
      });
      return;
    }
    const synthesis = window.speechSynthesis;
    const voices = synthesis.getVoices();
    const utterance = new SpeechSynthesisUtterance(concise);
    const preferredVoice =
      voices.find((voice) => voice.lang.toLowerCase().startsWith("en-in")) ??
      voices.find((voice) => voice.lang.toLowerCase().startsWith("en"));
    if (preferredVoice) utterance.voice = preferredVoice;
    utterance.onstart = () =>
      clientDiagnostic("audio.output", "speech.started", {
        reason,
        voice: utterance.voice?.name,
        language: utterance.lang || utterance.voice?.lang,
      });
    utterance.onend = (event) =>
      clientDiagnostic("audio.output", "speech.ended", {
        reason,
        elapsedSeconds: event.elapsedTime,
      });
    utterance.onerror = (event) =>
      clientDiagnostic("audio.output", "speech.error", {
        reason,
        error: event.error,
        elapsedSeconds: event.elapsedTime,
      });
    utterance.onpause = () => clientDiagnostic("audio.output", "speech.paused", { reason });
    utterance.onresume = () => clientDiagnostic("audio.output", "speech.resumed", { reason });
    clientDiagnostic("audio.output", "speech.enqueued", {
      reason,
      voiceCount: voices.length,
      selectedVoice: preferredVoice?.name,
      selectedLanguage: preferredVoice?.lang,
      synthesisPending: synthesis.pending,
      synthesisSpeaking: synthesis.speaking,
      synthesisPaused: synthesis.paused,
    });
    synthesis.cancel();
    synthesis.resume();
    synthesis.speak(utterance);
    for (const delayMs of [100, 750, 2_500]) {
      window.setTimeout(() => {
        clientDiagnostic("audio.output", "speech.state_probe", {
          reason,
          delayMs,
          pending: synthesis.pending,
          speaking: synthesis.speaking,
          paused: synthesis.paused,
        });
      }, delayMs);
    }
  }

  const displayText =
    voiceMessage ||
    conversation?.assistantText ||
    recall?.answer ||
    (conversationBusy ? latestProgress : undefined) ||
    (taskActive ? task?.summary || latestProgress : latestProgress);

  return (
    <main className={`stage stage--${state}`} data-state={state}>
      <div className="grain" aria-hidden="true" />
      <header className="status-line">
        <span className="status-dot" />
        <span>{labels[state]}</span>
        {taskActive && task && <span className="task-id">TASK {task.id.slice(0, 6)}</span>}
        <div className="voice-controls">
          <div
            className={`microphone-control microphone-control--${microphoneSignal}`}
            data-signal={microphoneSignal}
          >
            <button
              type="button"
              className="microphone-toggle"
              onClick={toggleMicrophone}
              aria-pressed={micEnabled}
              aria-label={micEnabled ? "Mute microphone" : "Turn microphone on"}
              title={micEnabled ? "Mute microphone" : "Turn microphone on"}
            >
              <span className="microphone-icon" aria-hidden="true"><i /></span>
              <span>
                {microphoneSignal === "no-signal"
                  ? "No signal"
                  : micEnabled
                    ? "Mic on"
                    : "Mic off"}
              </span>
            </button>
            <svg
              className="microphone-waveform"
              viewBox="0 0 100 24"
              preserveAspectRatio="none"
              aria-hidden="true"
              data-active={microphoneSignal === "live"}
            >
              <line x1="0" y1="12" x2="100" y2="12" />
              <polyline points={microphoneWaveformPoints} />
            </svg>
            <label className="sr-only" htmlFor="microphone-device">Microphone input</label>
            <select
              id="microphone-device"
              className="microphone-select"
              value={selectedMicId}
              onChange={(event) => void chooseMicrophone(event.target.value)}
              disabled={voiceStatus === "connecting"}
              title="Choose microphone"
            >
              <option value="">System default</option>
              {microphones
                .filter((device) => device.deviceId && device.deviceId !== "default")
                .map((device, index) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label || `Microphone ${index + 1}`}
                  </option>
                ))}
            </select>
          </div>
          <button
            type="button"
            className="button-voice button-voice--header"
            onClick={() => void toggleVoice()}
            disabled={voiceStatus === "connecting"}
            aria-label={voiceStatus === "idle" || voiceStatus === "degraded" ? "Start Codex Voice" : "End Codex Voice"}
          >
            {voiceStatus === "connecting"
              ? "Connecting…"
              : voiceStatus === "idle"
                ? "Start voice"
                : voiceStatus === "degraded"
                  ? "Retry voice"
                  : "End voice"}
          </button>
        </div>
      </header>

      <section className="console" aria-live="polite">
        <div className="console-screen">
          <div className="eyes" aria-hidden="true">
            <span />
            <span />
          </div>
          <div className="mouth" aria-hidden="true"><i /></div>
          <p className="thought">{displayText}</p>
          {conversation?.warning && <small className="transport-warning">{conversation.warning}</small>}
        </div>
      </section>

      {task && ["waiting_approval", "needs_decision", "suspended"].includes(task.status) ? (
        <section className="approval-panel">
          <div>
            <small>ONE TASK · UP TO TWO HOURS</small>
            <strong>{task.status === "waiting_approval" ? "Let Codex control this Mac for this task?" : task.summary}</strong>
            <p>{task.goal}</p>
          </div>
          <div className="approval-actions">
            <button className="button-text" onClick={() => window.companion.denyTask(task.id)}>
              Keep Mac unchanged
            </button>
            <button className="button-primary" onClick={() => task.status === "waiting_approval" ? window.companion.approveTask(task.id) : task.status === "needs_decision" ? window.companion.extendTaskApproval(task.id) : window.companion.recoverTask(task.id)}>
              {task.status === "waiting_approval" ? "Allow this task" : task.status === "needs_decision" ? "Extend approval" : "Check and continue"}
            </button>
          </div>
        </section>
      ) : (
        <section className="command-dock">
          <form onSubmit={submit}>
            <label className="sr-only" htmlFor="goal">Ask BMO anything</label>
            <input
              id="goal"
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              placeholder="Ask BMO anything…"
              disabled={task?.status === "running" || conversationBusy}
            />
            <div className="command-actions">
              {task?.status === "running" ? (
                <button type="button" className="button-stop button-compact" onClick={() => window.companion.cancelTask(task.id)}>
                  Stop task
                </button>
              ) : (
                <>
                  <button
                    className="button-text button-compact"
                    type="button"
                    onClick={() => void runAsTask()}
                    disabled={conversationBusy || !goal.trim()}
                    title="Give this to a Codex worker"
                  >
                    Task
                  </button>
                  <button
                    className="button-text button-compact"
                    type="button"
                    onClick={() => void recallPastWork()}
                    disabled={conversationBusy || !goal.trim()}
                    title="Search BMO's memory"
                  >
                    Recall
                  </button>
                  <button className="button-primary button-compact" type="submit" disabled={conversationBusy || !goal.trim()}>
                    Send
                  </button>
                </>
              )}
            </div>
          </form>
        </section>
      )}
    </main>
  );
}
