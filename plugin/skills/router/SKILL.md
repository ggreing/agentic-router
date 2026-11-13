---
name: router
description: Use when the user types /router — the manual controls for Do It All Claude Code. /router level <L0|L1|L2|L3> overrides the difficulty of the current (or next) request; /router resume continues a subtask that was stopped for human input. Neither command is itself triaged as a new request.
---

# /router commands

Do It All Claude Code triages each request automatically. These two commands let the user steer it. When the user's message is one of these, treat it as a control command — it is **not** a new task to triage, and the daemon appends it to the existing task ledger rather than starting a new request.

## /router level <L0|L1|L2|L3>

Manually set the difficulty level for the current request (or the next one, if none is running). This overrides the router's own triage and picks that level's team preset. Use it when the user thinks the automatic level is too high or too low.

- `L0` — no team; handle it yourself (or a single `coder`).
- `L1` — one `coder` + one `reviewer`.
- `L2` — `architect` + 1–2 `coder` + `reviewer` + `tester`.
- `L3` — `architect` + optional `ui-designer` + 2 `coder` + `reviewer` + `tester`, starting higher on the ladder.

After the override, follow the **lead-orchestrator** skill to build and run the team. The manual choice is recorded as a learning signal.

## /router resume

Continue a subtask that was paused for human input (a HITL stop, a budget overrun, or a repeated conflict). The user runs this after answering the question the lead asked (the message that ended with `[router:awaiting-user]`). Pick up the paused subtask from the task ledger — re-call the same role with the step the router gives, carrying the user's answer and the prior failure in the handoff brief. Do not re-triage.

---

Any other message is a normal request: let the router triage it and, if a team is formed, follow the **lead-orchestrator** skill.
