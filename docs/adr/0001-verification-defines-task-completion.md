# Verification defines Task completion

The Companion records a Task as complete only after it has a Verified Outcome; a task that lacks required information becomes Needs Decision, unavailable access or external state becomes Blocked, and an unsuccessful attempt becomes Failed. We chose this over best-effort completion because the Companion operates external systems and must preserve a trustworthy distinction between attempted and achieved work.
