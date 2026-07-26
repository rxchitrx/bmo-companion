# Personal BMO Companion

A design and prototype repository for a private, full-screen macOS AI Companion: an animated BMO Stage on a selected display, realtime conversation, Codex-backed general computer/browser/coding Tasks, durable local memory, controlled automation, and connected personal services.

## Current status

This repository contains the accepted product architecture, ADRs, implementation PRD, editable architecture diagram, and early Codex Computer Use/realtime protocol proofs. The first build target is a complete vertical slice:

1. Full-screen BMO Stage.
2. Realtime voice via ChatGPT-authenticated Codex WebRTC where available.
3. A general natural-language Codex Task.
4. One scoped approval, visible progress, Verified Outcome, and an Activity Ledger entry.

The implementation decisions and safety model are in [the PRD](docs/COMPANION_PRD.md). The shared domain vocabulary is in [CONTEXT.md](CONTEXT.md), and durable rationale lives in [docs/adr](docs/adr).

## Repository contents

- `docs/COMPANION_PRD.md` — complete build specification and test plan.
- `docs/adr/` — accepted architecture decisions.
- `outputs/AI_AGENT_IMPLEMENTATION_ARCHITECTURE.md` — source/reuse analysis and build sequence.
- `outputs/full-agent-architecture.excalidraw` — editable system diagram; PNG/SVG previews are alongside it.
- `outputs/*.mjs` — early local Codex app-server, Computer Use, and realtime proofs.

## Important boundaries

- Codex is used as the high-trust execution engine; BMO owns the user relationship, state, memory, approvals, and presentation.
- Connected services remain canonical; the Companion stores references and learned context rather than a default raw mirror.
- The project prohibits permanent deletion of files or source content and requires fresh confirmation for Reserved Actions.
- `work/` is intentionally ignored: it contains third-party research clones and local protocol artifacts, not project source.
- The BMO artwork direction is for a private local build. Sharing or public distribution requires a separate rights review.

## Prototype caveat

The proof scripts expect a local Codex/ChatGPT installation and may require local environment variables. They are research artifacts, not a supported SDK or production interface.
