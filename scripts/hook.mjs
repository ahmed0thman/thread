#!/usr/bin/env node
// Hook entry point for the thread plugin. Any failure exits 0 with no output.

const MAX_CONTEXT = 600;

function readStdin(ms) {
  return new Promise((resolve) => {
    let data = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(data);
    };
    const timer = setTimeout(finish, ms);
    try {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (c) => { data += c; });
      process.stdin.on('end', finish);
      process.stdin.on('error', finish);
    } catch {
      finish();
    }
  });
}

function emit(eventName, additionalContext) {
  const out = JSON.stringify({ hookSpecificOutput: { hookEventName: eventName, additionalContext } });
  return new Promise((resolve) => process.stdout.write(out + '\n', () => resolve()));
}

async function main() {
  if (process.env.THREAD_DEPTH) return;

  const raw = await readStdin(2000);
  let input;
  try { input = JSON.parse(raw); } catch { return; }
  if (!input || typeof input !== 'object') return;

  const event = process.argv[2] || input.hook_event_name;
  if (event !== 'SessionStart' && event !== 'UserPromptSubmit') return;
  const sessionId = typeof input.session_id === 'string' ? input.session_id : '';
  // Checked here, not through core, so the SessionStart note survives a core that fails to load.
  if (!/^[0-9A-Za-z-]{8,64}$/.test(sessionId)) return;

  let core = null;
  try { core = await import(new URL('../server/core.mjs', import.meta.url).href); } catch { /* the note below does not need it */ }

  // Register the session and its name. Never hold up the user's prompt waiting on the state lock.
  const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd;
  if (core && projectDir) {
    process.env.THREAD_LOCK_WAIT_MS = '1000';
    try {
      await core.touchSession(projectDir, sessionId, {
        transcriptPath: input.transcript_path,
        sessionTitle: input.session_title,
      });
    } catch {
      // naming is best effort
    }
  }

  if (event === 'SessionStart') {
    await emit('SessionStart',
      `[thread plugin] This session's id is ${sessionId}. Pass it as session_id to thread_start, thread_report, thread_end, thread_continue and thread_status.`);
    return;
  }

  if (event === 'UserPromptSubmit') {
    if (!core || !projectDir) return;
    const { reconcile, pendingAnnouncements, readState } = core;

    await reconcile(projectDir);
    const announced = await pendingAnnouncements(projectDir, sessionId);
    const state = readState(projectDir);
    const unseen = state.cards.filter((c) => c.seenByClaude === false);

    if (!announced.length && !unseen.length) return;

    const lines = [];
    for (const c of announced) {
      const verb = c.thread.runState === 'failed' ? 'failed' : 'finished';
      const tail = verb === 'failed'
        ? 'call thread_status for details if relevant'
        : 'not yet reported; call thread_report only if the user asks or it is relevant';
      lines.push(`Thread ${c.id} "${core.clip(c.title, 50)}" ${verb} — ${tail}`);
    }
    if (unseen.length) {
      lines.push(`${unseen.length} new board card${unseen.length === 1 ? '' : 's'} from the user — call board_list when the current task allows`);
    }
    let text = lines.join('\n');
    if (text.length > MAX_CONTEXT) text = text.slice(0, MAX_CONTEXT - 1) + '…';
    await emit('UserPromptSubmit', text);
  }
}

try {
  await main();
} catch {
  // swallow everything: a hook must never break the session
}
process.exit(0);
