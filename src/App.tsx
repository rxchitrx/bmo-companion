import { FormEvent, useEffect, useMemo, useState } from "react";
import type { CompanionState, TaskSnapshot } from "./types";

const labels: Record<CompanionState, string> = {
  idle: "Ready when you are",
  approval: "Waiting for you",
  thinking: "Thinking it through",
  working: "Working on it",
  speaking: "All wrapped up",
  error: "I need a hand",
};

export function App() {
  const [goal, setGoal] = useState("");
  const [task, setTask] = useState<TaskSnapshot | null>(null);

  useEffect(() => window.companion.onTaskUpdate(setTask), []);

  const state = task?.state ?? "idle";
  const latestProgress = useMemo(
    () => task?.progress.at(-1) ?? labels[state],
    [state, task],
  );

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = goal.trim();
    if (!trimmed || (task && ["waiting_approval", "running"].includes(task.status))) return;
    setTask(await window.companion.startTask(trimmed));
  }

  return (
    <main className={`stage stage--${state}`} data-state={state}>
      <div className="grain" aria-hidden="true" />
      <header className="status-line">
        <span className="status-dot" />
        <span>{labels[state]}</span>
        {task && <span className="task-id">TASK {task.id.slice(0, 6)}</span>}
      </header>

      <section className="console" aria-live="polite">
        <div className="console-screen">
          <div className="eyes" aria-hidden="true">
            <span />
            <span />
          </div>
          <div className="mouth" aria-hidden="true"><i /></div>
          <p className="thought">{task?.summary || latestProgress}</p>
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

      {task?.status === "waiting_approval" ? (
        <section className="approval-panel">
          <div>
            <small>ONE TASK · UP TO TWO HOURS</small>
            <strong>Let Codex control this Mac for this task?</strong>
            <p>{task.goal}</p>
          </div>
          <div className="approval-actions">
            <button className="button-text" onClick={() => window.companion.denyTask(task.id)}>
              Keep Mac unchanged
            </button>
            <button className="button-primary" onClick={() => window.companion.approveTask(task.id)}>
              Allow this task
            </button>
          </div>
        </section>
      ) : (
        <form className="command-bar" onSubmit={submit}>
          <label htmlFor="goal">What should I take care of?</label>
          <div>
            <input
              id="goal"
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              placeholder="Open a browser, research something, or work on a file…"
              disabled={task?.status === "running"}
            />
            {task?.status === "running" ? (
              <button
                type="button"
                className="button-stop"
                onClick={() => window.companion.cancelTask(task.id)}
              >
                Stop task
              </button>
            ) : (
              <button className="button-primary" type="submit">Ask BMO</button>
            )}
          </div>
        </form>
      )}
    </main>
  );
}
