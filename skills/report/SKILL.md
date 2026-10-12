---
name: report
description: Pull a finished side thread's hand-back digest into this session.
argument-hint: optional thread id
---

Current session id: ${CLAUDE_SESSION_ID}
If that line still shows a literal placeholder instead of a UUID, use the id from the "[thread plugin]" note at session start.

1. Call the `thread_report` tool with `session_id`. If the arguments contain a thread id, pass it as `id`. If they do not, leave `id` out and let the tool choose; do not pick a thread yourself.
2. If the tool lists threads instead of reporting one, show the list and ask the user which thread they want.
3. If the tool answers "CONFIRMATION REQUIRED", the thread was started by a different session. Ask the user with the AskUserQuestion tool, using exactly the question, header and options the tool gives. Never answer it yourself and never show any digest text before the user answers.
4. Only if the user chooses to continue, call `thread_report` again with the same `id`, the same `session_id` and the `confirm_code` from the tool. If the user cancels, say that nothing was reported and name the session that started the thread.
5. When a digest comes back, give it to the user under its four headings: Happened, Decided, Changed, Open.
6. State plainly that the digest is now part of this session's context.

If the thread is still running, say so and show only what the tool returned.
