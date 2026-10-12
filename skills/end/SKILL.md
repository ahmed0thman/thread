---
name: end
description: End a side thread and mark its card done.
argument-hint: thread id
---

Current session id: ${CLAUDE_SESSION_ID}
If that line still shows a literal placeholder instead of a UUID, use the id from the "[thread plugin]" note at session start.

Call the `thread_end` tool with the thread id from the arguments and `session_id`. If a turn is running it is stopped.

If the tool answers "CONFIRMATION REQUIRED", the thread was started by a different session. Ask the user with the AskUserQuestion tool, using exactly the question, header and options the tool gives. Never answer it yourself. Only if the user chooses to continue, call `thread_end` again with the same `id`, the same `session_id` and the `confirm_code` from the tool. If the user cancels, say that nothing was ended and name the session that started the thread.

Confirm in one line that the thread ended. If the result shows its last result was never reported, mention that; do not report it unless the user asks.
