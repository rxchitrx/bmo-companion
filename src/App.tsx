import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type { CompanionState, RecallAnswer, TaskSnapshot } from "./types";
import {
  conciseSpeech,
  createBrowserRecognition,
  VoiceSession,
  type VoiceStatus,
} from "./voice-session";

const labels: Record<CompanionState, string> = {
  idle: "Ready when you are",
  listening: "Listening…",
  approval: "Waiting for you",
  thinking: "Thinking it through",
  working: "Working on it",
  speaking: "All wrapped up",
  error: "I need a hand",
};

export function App() {
  const [goal, setGoal] = useState("");
  const [task, setTask] = useState<TaskSnapshot | null>(null);
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>("idle");
  const [voiceMessage, setVoiceMessage] = useState("");
  const sessionRef = useRef<VoiceSession | null>(null);
  const lastSpokenRef = useRef("");
  const taskRef = useRef<TaskSnapshot | null>(null);
  const [recallQuestion, setRecallQuestion] = useState("");
  const [recall, setRecall] = useState<RecallAnswer | null>(null);

  useEffect(() => { taskRef.current = task; }, [task]);

  useEffect(() => {
    const unsubscribe = window.companion.onTaskUpdate((nextTask) => {
      setTask(nextTask);
      const say = (message: string) => {
        const concise = conciseSpeech(message);
        if (!concise || concise === lastSpokenRef.current) return;
        lastSpokenRef.current = concise;
        if (!("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)) return;
        window.speechSynthesis?.cancel();
        window.speechSynthesis?.speak(new SpeechSynthesisUtterance(concise));
      };
      if (nextTask.status === "running") say(nextTask.progress.at(-1) ?? "Working on it.");
      if (nextTask.status === "completed") say(nextTask.summary ?? "Your task is complete.");
      if (nextTask.status === "cancelled") say("Task stopped. Completed actions were not undone.");
    });

    const recognition = createBrowserRecognition();
    if (!recognition) {
      setVoiceStatus("degraded");
      setVoiceMessage("Voice is unavailable here. You can keep using typed requests.");
      return unsubscribe;
    }
    const session = new VoiceSession(recognition, (event) => {
      if (event.type === "listening") {
        setVoiceStatus("listening");
        setVoiceMessage("Listening — say what you need, or say Stop.");
      } else if (event.type === "goal") {
        setGoal(event.goal);
        void window.companion.startTask(event.goal).then(setTask).catch((error: Error) => setVoiceMessage(error.message));
      } else if (event.type === "stop") {
        const activeTask = taskRef.current;
        if (activeTask && ["waiting_approval", "needs_decision", "suspended", "running"].includes(activeTask.status)) {
          void window.companion.cancelTask(activeTask.id);
        }
      } else if (event.type === "degraded") {
        setVoiceStatus("degraded");
        setVoiceMessage(`${event.message} You can keep using typed requests.`);
      } else {
        setVoiceStatus("idle");
        setVoiceMessage("");
      }
    });
    sessionRef.current = session;
    return () => { unsubscribe(); session.dispose(); sessionRef.current = null; };
  }, []);

  const state = voiceStatus === "listening" ? "listening" : task?.state ?? "idle";
  const latestProgress = useMemo(
    () => task?.progress.at(-1) ?? labels[state],
    [state, task],
  );

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = goal.trim();
    if (!trimmed || (task && ["waiting_approval", "needs_decision", "suspended", "running"].includes(task.status))) return;
    setTask(await window.companion.startTask(trimmed));
  }

  async function recallPastWork(event: FormEvent) {
    event.preventDefault();
    const question = recallQuestion.trim();
    if (!question) return;
    setRecall(await window.companion.recallMemory(question));
  }

  return (
    <main className={`stage stage--${state}`} data-state={state}>
      <div className="grain" aria-hidden="true" />
      <header className="status-line">
        <span className="status-dot" />
        <span>{labels[state]}</span>
        {task && <span className="task-id">TASK {task.id.slice(0, 6)}</span>}
        <button
          type="button"
          className="button-voice button-voice--header"
          onPointerDown={() => sessionRef.current?.startPushToTalk()}
          onPointerUp={() => sessionRef.current?.releasePushToTalk()}
          onPointerCancel={() => sessionRef.current?.releasePushToTalk()}
          disabled={voiceStatus === "degraded"}
          aria-label="Hold to talk to BMO"
        >
          {voiceStatus === "listening" ? "Listening…" : "Hold to talk"}
        </button>
      </header>

      <section className="console" aria-live="polite">
        <div className="console-screen">
          <div className="eyes" aria-hidden="true">
            <span />
            <span />
          </div>
          <div className="mouth" aria-hidden="true"><i /></div>
          <p className="thought">{voiceMessage || task?.summary || latestProgress}</p>
        </div>
        <div className="controls" aria-hidden="true">
          <div className="speaker" />
          <div className="button button--blue" />
          <div className="dpad"><span /><span /></div>
          <div className="button button--pink" />
          <div className="button button--green" />
          <div className="button button--yellow" />
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
        <section className="command-stack">
          <form className="command-bar" onSubmit={submit}>
            <label htmlFor="goal">What should I take care of?</label>
            <div>
              <input id="goal" value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="Open a browser, research something, or work on a file…" disabled={task?.status === "running"} />
              {task?.status === "running" ? <button type="button" className="button-stop" onClick={() => window.companion.cancelTask(task.id)}>Stop task</button> : <button className="button-primary" type="submit">Ask BMO</button>}
            </div>
          </form>
          <form className="recall-bar" onSubmit={recallPastWork}>
            <label htmlFor="recall">Ask about a completed Task</label>
            <div><input id="recall" value={recallQuestion} onChange={(event) => setRecallQuestion(event.target.value)} placeholder="What did we finish for the website last week?" /><button type="submit">Recall</button></div>
            {recall && <p className="recall-answer">{recall.answer}{recall.references.length > 0 && <small>{recall.references.map((reference) => ` Task ${reference.taskId.slice(0, 6)}${reference.source ? ` · ${reference.source.sourceName}` : " · Activity Ledger"}`).join(" ·")}</small>}</p>}
          </form>
        </section>
      )}
    </main>
  );
}
