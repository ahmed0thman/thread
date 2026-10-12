---
name: report
description: Pull a finished side thread's hand-back digest into this session.
argument-hint: optional thread id
---

1. If the arguments contain a thread id, use it. Otherwise call the `thread_status` tool and pick the only finished thread that has not been reported. If there is more than one, or none, list them and ask the user which one.
2. Call the `thread_report` tool with that id.
3. Give the user the digest under its four headings: Happened, Decided, Changed, Open.
4. State plainly that the digest is now part of this session's context.

If the thread is still running, say so and show only what the tool returned.
