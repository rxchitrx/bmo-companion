# Pi versus Codex for BMO coding tasks

Measured 26 September 2026 on this Mac. Every model run used **GPT-6 Luna at low reasoning** through a subscription. No other model or API-key provider was used.

## Decision

Pi is a promising coding worker for BMO. It passed every small coding task and used far fewer reported input tokens than a successful direct Codex CLI run. BMO's **current Codex app-server coding path failed every run** under Luna low because the worker could not access editing tools. The direct Codex CLI succeeded, so this is a BMO integration/runtime-surface problem, not evidence that Luna cannot code.

The benchmark alone was insufficient for a default switch. The follow-up implementation and live checks below closed that gate; BMO now routes approved coding Tasks to Pi by default.

## Method

- Three synthetic JavaScript tasks: fix an inclusive-range bug, implement an ordered `uniqueBy` API, and correct a two-file cart calculation. Each task had visible tests and additional hidden tests added only after the agent finished.
- Three fresh runs per task and agent. Every run started from the same clean Git commit in a separate detached worktree. The benchmark allowed 240 seconds per run. Source checkouts stayed untouched in all 27 runs.
- Pi 0.85.1: `openai-codex/gpt-6-luna`, low reasoning, ephemeral JSON mode, only `read,bash,edit,write` visible, with extensions, skills, prompt templates, and context-file discovery disabled.
- Direct Codex CLI 0.155.0-alpha.16.4: `gpt-6-luna`, low reasoning, ephemeral JSON mode, `workspace-write` sandbox, approval policy `never`, current user Codex configuration.
- BMO Codex app-server: BMO's [`CodexTaskExecutor`](../electron/codex-adapter.ts), same model and effort, ephemeral thread, `workspace-write` sandbox, current BMO worker prompt and context packet.
- Success means the post-run visible **and hidden** tests passed. The agent's own completion text was not accepted as proof. Reported input includes cached input; uncached input is total minus cached input. These are usage counts, not subscription quota or money.

Pi and BMO app-server runs were interleaved by repetition. Direct Codex CLI runs followed as a separate diagnostic series, so elapsed times can also reflect changing network conditions.
The task requirements and base commits matched, but the surrounding prompts did not: Pi received a short BMO coding-worker instruction, direct Codex CLI received the task and worktree constraint, and BMO app-server received its production worker prompt and Context Packet. This measures the configured paths end to end, not a controlled attribution of every token to one component.

## Results

| Coding path | Hidden tests | Median input tokens (range) | Median uncached input | Median duration (range) | Median tool calls |
| --- | ---: | ---: | ---: | ---: | ---: |
| Pi | **9/9** | **10,642** (8,163–13,587) | **6,697** | **31.8 s** (23.7–150.9) | 7 |
| Direct Codex CLI | **9/9** | **121,234** (95,351–170,043) | **13,497** | **48.3 s** (30.9–64.4) | 4 |
| BMO Codex app-server | **0/9** | **77,833** (72,347–125,980) | **24,161** | **21.4 s** (16.8–29.3) | 0 |

Against the **successful direct Codex CLI** series, Pi's median reported input was **91.2% lower** (11.4× fewer tokens), median uncached input was **50.4% lower**, and median duration was **34.1% shorter**. Pi's duration was less predictable: one run took 150.9 seconds after a transient WebSocket error and another took 97.4 seconds. Direct Codex CLI's slowest run took 64.4 seconds. Most Codex CLI input was cached (median 115,456 tokens); the total-input ratio must not be interpreted as an equal reduction in subscription use or billable cost. Usage from a failed WebSocket attempt may also be missing from Pi's successful-message counters.

| Task | Pi passes | Direct Codex CLI passes | BMO Codex app-server passes | Pi median input | Direct Codex CLI median input |
| --- | ---: | ---: | ---: | ---: | ---: |
| Inclusive range fix | 3/3 | 3/3 | 0/3 | 10,642 | 143,592 |
| Ordered `uniqueBy` API | 3/3 | 3/3 | 0/3 | 8,220 | 95,417 |
| Two-file cart fix | 3/3 | 3/3 | 0/3 | 11,894 | 121,234 |

The BMO app-server worker repeatedly returned `UNVERIFIED` and said shell or editing tools were unavailable. Most runs attempted no tool call and changed no file. Counting its short, unsuccessful durations as a speed advantage would be misleading. A direct Codex CLI run with the same model could inspect, edit, and test the same fixture. A single exploratory direct Codex CLI run with plugins disabled and the skill catalog capped still passed but used 123,023 input tokens; one run is insufficient to infer a configuration effect.

## Project checks

- BMO TypeScript tests: **154/154 passed**.
- Python reliability tests: **12/12 passed**.
- Typecheck and production build: passed.
- Deterministic five-canary suite: **5/5 passed in each of three repetitions**.

## Follow-up: BMO Pi coding worker

BMO now sends approved coding Tasks through [`PiCodingTaskExecutor`](../electron/pi-coding-adapter.ts). The worker uses an isolated Git worktree, GPT-6 Luna at low reasoning, Pi 0.85.1 with only four BMO file tools, and a macOS sandbox that limits writes to the worktree, task scratch directory, and Pi's own configuration. Pi has no shell, connectors, browser, project extensions, skills, context files, or built-in tools in this path. If BMO's tool extension fails to load, Pi has no file tools. BMO cancels the process group on owner Stop, tool deadline, or overall deadline; incomplete and crashed turns remain unverified and require review.

After Pi settles, BMO checks the worktree diff, rejects changed tests or test configuration, and runs the original `npm test` script in a separate sandbox without outbound network. Passing tests and Pi's completion claim are both required before BMO marks the Task verified. Changes remain in the isolated worktree for owner review; BMO does not auto-merge them. Interrupted coding Tasks are never replayed on recovery. The coding model default is now GPT-6 Luna at low reasoning, including a migration of the former saved coding default.

Six fresh runs on a real BMO bug fix (redacting `access_token` in `electron/diagnostics.ts`) passed the original repository's 129 tests, an additional hidden assertion, and source-checkout isolation. The final runs also passed the adapter's own approval check and verified the worktree stayed unchanged during tests. Reported input ranged from 3,748 to 3,772 tokens; elapsed time ranged from 11.8 to 18.1 seconds. These are a different task and prompt from the benchmark above, so do not treat the token figures as a matched Pi-versus-Codex comparison. They show the integrated path works on this Mac.

One further live run used BMO's actual TaskRuntime, approval transition, execution kernel, task engine, and Pi worker together. Before approval, the Task was pending and no worktree existed. After approval, the Task completed and the activity ledger recorded creation, approval, and completion. The original 129 tests and hidden assertion passed; the source checkout stayed clean. This run reported 3,772 input tokens and 12.3 seconds end to end. See the [Task path report](../outputs/evaluation/pi-coding-task-live-2026-09-26.json).

The full current workspace suite passed: 165 TypeScript tests, 12 Python reliability tests, typecheck, and production build. Three repetitions of the five deterministic canaries also passed. The live script and reports are in [`evaluation/pi-coding-adapter-live.ts`](../evaluation/pi-coding-adapter-live.ts) and [`outputs/evaluation/`](../outputs/evaluation/).

## Limits

The original 27-run benchmark used three small JavaScript fixtures and Pi's unrestricted built-in shell; the follow-up uses a different, safer tool set. The follow-up covers one real BMO change across seven live runs, not arbitrary large tasks or every repository build system. The integrated verifier currently requires an original `npm test` script; projects without one remain unverified. Changing tests or package scripts also requires review. BMO still needs a project picker; its coding worker targets the current project directory and requires a clean Git checkout. Pi still uses the OpenAI Codex **model subscription**, so it removes the Codex agent runtime from coding work, not dependence on the model provider.

## Evidence and reproduction

- [Pi and BMO app-server raw runs](../outputs/evaluation/coding-agent-comparison-2026-09-26.json)
- [Direct Codex CLI raw runs](../outputs/evaluation/coding-agent-codex-cli-2026-09-26.json)
- [Benchmark source and hidden graders](../evaluation/coding-agent-compare.ts)

```bash
npm run eval:coding-agents -- --repeat 3
npm run eval:coding-agents -- --repeat 3 --arms codex-cli --output outputs/evaluation/coding-agent-codex-cli-recheck.json
npm run eval:pi-coding-live
npm run eval:pi-coding-live -- --through-runtime --output outputs/evaluation/pi-coding-task-live-2026-09-26.json
npm run typecheck
npm run build
npm test
npm run test:reliability
npm run eval:canaries -- --repeat 3 --json
```

The live commands consume subscription usage. The benchmark creates temporary Git repositories and worktrees, and writes aggregate usage and grading results to JSON; it does not persist full model transcripts.
