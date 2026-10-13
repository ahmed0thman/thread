---
name: status
description: Show all side threads and whether each is running, finished or failed.
---

Current session id: ${CLAUDE_SESSION_ID}
If that line still shows a literal placeholder instead of a UUID, use the id from the "[thread plugin]" note at session start.

Call the `thread_status` tool with `session_id` and no id.

Show the result as a compact list, one line per thread: id, title, state, mode, context (brief or full), agent or model, turns, tokens, whether it was reported, and which session started it. If there are no threads, say so in one line. Do not call any other tool.
