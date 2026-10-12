---
name: new
description: Start a side thread, a background copy of this session that works on a separate task and reports back only when asked.
argument-hint: what the thread should do
---

Start a side thread for the task the user described in the arguments.

1. Derive a short title (a few words).
2. Write the task so it stands alone: the user's request plus any constraint they gave. Do not assume the thread knows what you were about to do next.
3. Call the `thread_start` tool with `title`, `task`, `session_id` and `mode`.
4. Use mode `read` unless the user explicitly asked the thread to change files. Mode `write` edits the same working tree as this session.

Current session id: ${CLAUDE_SESSION_ID}
If that line still shows a literal placeholder instead of a UUID, use the id from the "[thread plugin]" note at session start.

After the tool returns, tell the user the card id in one sentence and carry on with the main task. Do not wait for the thread and do not poll it.
