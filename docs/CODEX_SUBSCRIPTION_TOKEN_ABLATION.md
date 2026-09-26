# Codex subscription token ablation

Measured on 24 September 2026 (India time) with the installed Codex app-server, GPT-6 Luna at low effort, BMO's current typed-chat prompt, and BMO's three dynamic tool schemas. Each sample used a new read-only ephemeral Codex thread and process. No Platform API was called.

## Result

| Typed-chat startup setting | Median input tokens | Change from baseline |
| --- | ---: | ---: |
| Current BMO typed chat | 23,400 | — |
| Plugins disabled | 22,057 | −1,343 (5.7%) |
| Skill catalog capped at 128 tokens | 17,708 | −5,692 (24.3%) |
| Both changes | **16,491** | **−6,909 (29.5%)** |

Each row has five completed samples. Input totals were identical within each row; cached input varied. The combined setting also passed three task-state tool probes: each run made exactly one authorized `get_task_state` read. The tool-using exchange measured 46,870 input tokens with current settings and 33,052 with the combined setting, a difference of 13,818 tokens (29.5%).

The combined setting is now scoped to BMO's typed-chat and memory-synthesis Codex processes in `electron/conversation-client.ts`. It does not change task execution or realtime voice. The production typed-chat and memory paths both completed a live smoke run. The full project suite passed 129 of 129 tests, and TypeScript checks passed.

## Other settings

Disabling skill search, host skill discovery, the two configured MCP servers, or browser use produced no median input-token reduction in the three-sample comparison. Disabling apps or memories timed out on the second sample, so neither result was used. The skill catalog cap caused Codex to omit most skill descriptions; that is appropriate for BMO's typed-chat and memory processes, which supply their own bounded tools, but it should not be applied to the general task executor without separate evaluation.

## Limits

- The remaining 16,491 input tokens are still delivered through the subscription-backed Codex runtime. This test cannot separate its private instructions and built-in tools into exact token amounts.
- These are input-token counts, not a direct estimate of subscription quota or monetary cost. Cached input fluctuated substantially across samples.
- The original ablation measured fresh typed-chat threads and an empty Task state. The ten-turn follow-up below measures short persistent history. Much longer conversations, realtime voice, and general or Computer Use tasks need separate measurements.
- A future switch to Codex plugin-backed conversation capabilities would require revisiting the typed-chat plugin setting.

## Persistent typed conversation follow-up

Two matched ten-turn conversations were run on 24 September 2026 with the same model and effort, BMO prompt builder, empty Task state, and dynamic tool schemas. Each arm kept one Codex thread open for all ten turns. The conversations included four later-turn memory checks for a code word and number; all eight checks per arm passed. No external tools were called. Raw per-turn measurements and answers are saved in `outputs/evaluation/conversation-growth-2026-09-24.json` and `outputs/evaluation/conversation-growth-repeat-2026-09-24.json`.

| Setting | Mean input tokens per ten-turn conversation | Turn 1 | Turn 10 | Mean uncached input tokens per conversation |
| --- | ---: | ---: | ---: | ---: |
| Previous baseline | 302,042 | 23,414 | 31,555 | 35,290 |
| Lean BMO setting | 171,868 | 16,505 | 17,858 | 23,132 |

The lean setting saved **130,174 input tokens (43.1%)** over ten turns, including **12,158 uncached input tokens (34.5%)**. The baseline's second turn jumped to about 30,350 tokens in both runs, while the lean setting rose by roughly 150 tokens per turn. The protocol reports total and cached input, but does not identify the internal source of the baseline jump; attributing it to a specific plugin or instruction would be an inference.

No automatic ten-turn history reset was added. The lean thread accumulated only about 1,353 input tokens from turn 1 to turn 10, and it retained the facts needed for the memory checks. A reset would discard conversational context. A longer conversation or an actual failure to recall is needed to choose a safe compaction threshold.

Reproduce with `./node_modules/.bin/tsx evaluation/conversation-growth-lab.ts`; set `BMO_EVAL_OUTPUT_PATH` to preserve an additional run.

## Reproduce

```bash
BMO_EVAL_ABLATION=1 BMO_EVAL_ABLATION_ARMS=plugins-off,skill-catalog-128,lean-conversation BMO_EVAL_REPEAT=5 ./node_modules/.bin/tsx evaluation/overhead-lab.ts > /tmp/bmo-codex-lean.json
BMO_EVAL_ABLATION=1 BMO_EVAL_TOOL_PROBE=1 BMO_EVAL_ABLATION_ARMS=lean-conversation ./node_modules/.bin/tsx evaluation/overhead-lab.ts > /tmp/bmo-codex-tool-probe.json
```

The saved source reports are in `outputs/evaluation/`. Codex's [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference) documents `skills.max_context_tokens` and its maximum catalog budget.
