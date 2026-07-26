# Restart recovery re-observes state

After the Companion, its managed Codex process, or the Mac restarts, unfinished Tasks may be restored from durable Activity Ledger state. Before any action resumes, Restart Recovery observes the current external state and revalidates the Task's scope and authority. It never blindly replays prior Mac or browser actions. This preserves continuity without turning a crash into duplicated or stale external work.
