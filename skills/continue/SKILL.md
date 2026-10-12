---
name: continue
description: Send a follow-up message to an existing side thread so it does another turn.
argument-hint: thread id and a follow-up message
---

The first word of the arguments is the thread id (for example `c4`); the rest is the follow-up message.

Call the `thread_continue` tool with `id` and `message`. Write the message so it stands alone, since the thread only knows its own history.

Tell the user in one sentence that the thread is running again. Do not wait for it and do not poll it. If the tool reports that the thread is still running, ended, or unknown, pass that on plainly.
