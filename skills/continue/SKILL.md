---
name: continue
description: Send a follow-up message to an existing side thread so it does another turn.
argument-hint: thread id and a follow-up message
---

The first word of the arguments is the thread id (for example `c4`); the rest is the follow-up message.

Current session id: ${CLAUDE_SESSION_ID}
If that line still shows a literal placeholder instead of a UUID, use the id from the "[thread plugin]" note at session start.

Call the `thread_continue` tool with `id`, `message` and `session_id`. Write the message so it stands alone, since the thread only knows its own history. When things that matter to the thread changed in this session since the thread's last turn (a decision, a file it read that was edited, a changed requirement), start the message with a short catch-up headed `Since your last turn:` and then the request. Leave the catch-up out when nothing relevant changed.

Tell the user in one sentence that the thread is running again. Do not wait for it and do not poll it. If the tool says the thread belongs to another session, pass that on: its finished notice goes to that session. If the tool reports that the thread is still running, ended, or unknown, pass that on plainly. A thread that runs on a delegation lane continues the provider's own session; if the tool says the provider gave no session to continue, or that its lane is now unknown, not approved or missing its relay, pass that on and suggest starting a new thread with `/thread:new`.
