import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type {
  AccountUsage,
  CompanionState,
  ConversationUpdate,
  ModelCatalogEntry,
  ModelRole,
  ModelSettings,
  RealtimeVoiceUpdate,
  RecallAnswer,
  TaskSnapshot,
  TaskKind,
  TokenUsage,
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

const modelRoleLabels: Record<ModelRole, { label: string; detail: string }> = {
  conversation: { label: "Talking", detail: "Typed chat and BMO's personality" },
  general: { label: "General tasks", detail: "Research and mixed work" },
  coding: { label: "Coding", detail: "Repositories, debugging, and code changes" },
  computer: { label: "Mac control", detail: "Visible desktop applications" },
  browser: { label: "Browser", detail: "Web navigation and browser actions" },
  memory: { label: "Memory", detail: "Synthesizing retrieved local memories" },
};

function compactTokens(value: number) {
  return new Intl.NumberFormat("en", {
    notation: value >= 1_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(value);
}

function usageTitle(label: string, usage: TokenUsage) {
  const freshTokens =
    Math.max(0, usage.inputTokens - usage.cachedInputTokens) +
    usage.outputTokens;
  return `${label}: ${freshTokens.toLocaleString()} new · ${usage.cachedInputTokens.toLocaleString()} cached input · ${usage.totalTokens.toLocaleString()} processed total · ${usage.inputTokens.toLocaleString()} input · ${usage.outputTokens.toLocaleString()} output · ${usage.reasoningOutputTokens.toLocaleString()} reasoning`;
}

function usageBadge(usage: TokenUsage) {
  const freshTokens =
    Math.max(0, usage.inputTokens - usage.cachedInputTokens) +
    usage.outputTokens;
  return usage.cachedInputTokens > 0
    ? `${compactTokens(freshTokens)} NEW`
    : compactTokens(usage.totalTokens);
}

function UsagePill({ text, detail }: { text: string; detail: string }) {
  return (
    <span
      className="usage-pill"
      tabIndex={0}
      aria-label={detail}
      data-tooltip={detail}
    >
      {text}
    </span>
  );
}

function accountUsageTitle(usage: AccountUsage) {
  const parts = [
    usage.planType ? `Plan: ${usage.planType}` : "",
    usage.primaryUsedPercent != null
      ? `Primary window: ${usage.primaryUsedPercent}% used`
      : "",
    usage.primaryResetsAt
      ? `resets ${new Date(usage.primaryResetsAt * 1_000).toLocaleString()}`
      : "",
    usage.secondaryUsedPercent != null
      ? `Secondary window: ${usage.secondaryUsedPercent}% used`
      : "",
  ].filter(Boolean);
  return parts.join(" · ");
}

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
  const [voiceUsage, setVoiceUsage] = useState<TokenUsage | null>(null);
  const [modelSettings, setModelSettings] = useState<ModelSettings | null>(null);
  const [modelCatalog, setModelCatalog] = useState<ModelCatalogEntry[]>([]);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [modelsSaving, setModelsSaving] = useState(false);
  const [modelsError, setModelsError] = useState("");
  const [taskKind, setTaskKind] = useState<TaskKind>("general");
  const sessionRef = useRef<CodexRealtimeVoiceSession | null>(null);
  const lastSpokenRef = useRef("");
  const lastTaskStatusRef = useRef<TaskSnapshot["status"] | null>(null);
  const [recall, setRecall] = useState<RecallAnswer | null>(null);

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
      const statusChanged = lastTaskStatusRef.current !== nextTask.status;
      lastTaskStatusRef.current = nextTask.status;
      if (!sessionRef.current?.active && statusChanged) {
        if (nextTask.status === "running") speak("Approved. I’ve started the task.", "task_started");
        if (nextTask.status === "completed") speak(nextTask.summary ?? "Your task is complete.", "task_completed");
        if (nextTask.status === "failed") speak(nextTask.summary ?? "The task could not be completed.", "task_failed");
        if (nextTask.status === "cancelled") speak("Task stopped. Completed actions were not undone.", "task_cancelled");
      }
    });
    void window.companion.getCurrentTask().then((currentTask) => {
      if (currentTask) setTask(currentTask);
    }).catch((error) => {
      clientDiagnostic("ui.task", "initial_snapshot_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
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
      setVoiceUsage,
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

  useEffect(() => {
    void Promise.all([
      window.companion.getModelSettings(),
      window.companion.listModels(),
    ]).then(([settings, catalog]) => {
      setModelSettings(settings);
      setModelCatalog(catalog);
      clientDiagnostic("ui.models", "loaded", {
        modelCount: catalog.length,
        settings,
      });
    }).catch((error) => {
      const message = error instanceof Error ? error.message : "Could not load models.";
      setModelsError(message);
      clientDiagnostic("ui.models", "load_failed", { error: message });
    });
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
      setVoiceUsage(null);
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
      setTask(await window.companion.startTask(trimmed, taskKind));
      setGoal("");
    } catch (error) {
      clientDiagnostic("ui.task", "create.rejected", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function changeModel(role: ModelRole, model: string) {
    if (!modelSettings) return;
    const entry = modelCatalog.find((candidate) => candidate.model === model);
    const currentEffort = modelSettings[role].effort;
    const effort = entry?.supportedReasoningEfforts.includes(currentEffort)
      ? currentEffort
      : entry?.defaultReasoningEffort ?? "medium";
    setModelSettings({
      ...modelSettings,
      [role]: { model, effort },
    });
  }

  function changeEffort(role: ModelRole, effort: string) {
    if (!modelSettings) return;
    setModelSettings({
      ...modelSettings,
      [role]: { ...modelSettings[role], effort },
    });
  }

  async function saveModels() {
    if (!modelSettings || modelsSaving) return;
    setModelsSaving(true);
    setModelsError("");
    try {
      setModelSettings(await window.companion.updateModelSettings(modelSettings));
      setModelsOpen(false);
    } catch (error) {
      setModelsError(error instanceof Error ? error.message : "Could not save models.");
    } finally {
      setModelsSaving(false);
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
        {taskActive && task?.model && (
          <span className="task-model" title={`This ${task.kind ?? "general"} Task is using ${task.model} at ${task.effort ?? "default"} reasoning`}>
            {task.kind ?? "general"} · {task.model.replace("gpt-", "")} · {task.effort ?? "default"}
          </span>
        )}
        <div className="usage-strip" aria-label="Token usage">
          <UsagePill
            text={`VOICE ${voiceUsage ? usageBadge(voiceUsage) : "—"}`}
            detail={voiceUsage ? usageTitle("Current voice session", voiceUsage) : "No voice usage received yet"}
          />
          <UsagePill
            text={`TASK ${task?.usage ? usageBadge(task.usage) : "—"}`}
            detail={task?.usage ? usageTitle("Latest Codex task", task.usage) : "No Codex task usage received yet"}
          />
          <UsagePill
            text={`LIMIT ${task?.accountUsage?.primaryUsedPercent != null ? `${task.accountUsage.primaryUsedPercent}%` : "—"}`}
            detail={task?.accountUsage ? accountUsageTitle(task.accountUsage) : "No account limit update received yet"}
          />
          <UsagePill
            text={`MEMORY ${recall?.usage ? usageBadge(recall.usage) : "—"}`}
            detail={recall?.usage ? usageTitle("Latest memory lookup", recall.usage) : "No model-assisted memory usage received yet"}
          />
        </div>
        <div className="voice-controls">
          <button
            type="button"
            className="button-models"
            onClick={() => setModelsOpen(true)}
            aria-label="Choose models"
          >
            Models
          </button>
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

      {modelsOpen && (
        <section className="model-panel" aria-label="Model routing settings">
          <div className="model-panel__header">
            <div>
              <small>MODEL ROUTING</small>
              <strong>Choose the brain for each job</strong>
            </div>
            <button type="button" className="button-text" onClick={() => setModelsOpen(false)}>Close</button>
          </div>
          <div className="model-row model-row--managed">
            <div>
              <strong>Live speech</strong>
              <small>Listening, speaking, and realtime conversation</small>
            </div>
            <span>Codex Realtime · managed</span>
          </div>
          {modelSettings && (Object.keys(modelRoleLabels) as ModelRole[]).map((role) => {
            const selected = modelCatalog.find((entry) => entry.model === modelSettings[role].model);
            return (
              <div className="model-row" key={role}>
                <div>
                  <strong>{modelRoleLabels[role].label}</strong>
                  <small>{modelRoleLabels[role].detail}</small>
                </div>
                <select
                  value={modelSettings[role].model}
                  onChange={(event) => changeModel(role, event.target.value)}
                  aria-label={`${modelRoleLabels[role].label} model`}
                >
                  {modelCatalog.map((entry) => (
                    <option key={entry.model} value={entry.model}>{entry.displayName}</option>
                  ))}
                </select>
                <select
                  value={modelSettings[role].effort}
                  onChange={(event) => changeEffort(role, event.target.value)}
                  aria-label={`${modelRoleLabels[role].label} reasoning`}
                >
                  {(selected?.supportedReasoningEfforts ?? [modelSettings[role].effort]).map((effort) => (
                    <option key={effort} value={effort}>{effort}</option>
                  ))}
                </select>
              </div>
            );
          })}
          {modelsError && <p className="model-panel__error">{modelsError}</p>}
          <div className="model-panel__footer">
            <small>New tasks freeze the selected model when they are created.</small>
            <button className="button-primary" type="button" onClick={() => void saveModels()} disabled={!modelSettings || modelsSaving}>
              {modelsSaving ? "Saving…" : "Save models"}
            </button>
          </div>
        </section>
      )}

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
                  <select
                    className="task-kind-select"
                    value={taskKind}
                    onChange={(event) => setTaskKind(event.target.value as TaskKind)}
                    title="Choose this Task's execution type"
                    aria-label="Task execution type"
                  >
                    <option value="general">General</option>
                    <option value="coding">Coding</option>
                    <option value="computer">Mac</option>
                    <option value="browser">Browser</option>
                  </select>
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
