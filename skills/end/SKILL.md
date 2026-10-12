---
name: end
description: End a side thread and mark its card done.
argument-hint: thread id
---

Call the `thread_end` tool with the thread id from the arguments. If a turn is running it is stopped.

Confirm in one line that the thread ended. If the result shows its last result was never reported, mention that; do not report it unless the user asks.
