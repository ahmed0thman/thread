// Stands in for the delegate skills' `config.mjs load`. Prints lanes in the real shape.
// FAKE_DELEGATE_MODE: ok (default), untrusted (project config not approved), fail (exit 1),
// garbage (not JSON), hang (never answers). FAKE_DELEGATE_LOG: a file to append one line per run to.
// FAKE_DELEGATE_SANDBOX: the sandbox dial of the code-codex lane (read-only, workspace-write or danger-full-access).
// FAKE_DELEGATE_LONG_LANE: adds a project lane with a very long name.
// FAKE_DELEGATE_CODEX_MODEL: the model of the code-codex lane (to see a lane change between turns).
// FAKE_DELEGATE_SHADOWED: comma-separated names of project lanes that also exist in the global config. A load for the filesystem root (no
// repository, so no project config) lists the global lanes only, the shadowed ones included.
import fs from 'node:fs';
import path from 'node:path';

const mode = process.env.FAKE_DELEGATE_MODE || 'ok';
if (process.env.FAKE_DELEGATE_LOG) fs.appendFileSync(process.env.FAKE_DELEGATE_LOG, `${process.argv.slice(2).join(' ')}\n`);

if (mode === 'hang') setInterval(() => {}, 1000);
else if (mode === 'fail') { process.stderr.write('fake failure\n'); process.exit(1); }
else if (mode === 'garbage') process.stdout.write('this is not json\n');
else {
  const argv = process.argv.slice(2);
  const cwd = argv[argv.indexOf('--cwd') + 1] || '';
  const globalOnly = cwd !== '' && cwd === path.parse(cwd).root;
  const shadowed = (process.env.FAKE_DELEGATE_SHADOWED || '').split(',').filter(Boolean);
  const out = {
    version: 'delegate-fleet.v1',
    globalPath: '/fake/global.json',
    projectPath: '/fake/project.json',
    globalPresent: true,
    projectPresent: true,
    projectTrusted: mode !== 'untrusted',
    lanes: LANES(),
  };
  if (globalOnly) {
    out.lanes = Object.fromEntries(Object.entries(out.lanes).filter(([, l]) => l.source === 'global'));
    for (const name of shadowed) out.lanes[name] = { implementer: 'claude', model: 'claude-global', effort: 'low', source: 'global' };
  }
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

function LANES() {
  return {
    'code-codex': { implementer: 'codex', model: process.env.FAKE_DELEGATE_CODEX_MODEL || 'gpt-fake', effort: 'high', ...(process.env.FAKE_DELEGATE_SANDBOX ? { sandbox: process.env.FAKE_DELEGATE_SANDBOX } : {}), source: 'global' },
    'ui-open': { implementer: 'opencode', model: 'vendor/model-x', variant: 'max', source: 'global' },
    'review-ro': { implementer: 'claude', model: 'claude-fake', effort: 'medium', readOnly: true, source: 'project' },
    'agy-fast': { implementer: 'agy', model: 'gemini-fake', source: 'project' },
    'claude-edit': { implementer: 'claude', model: 'claude-fake', effort: 'medium', source: 'global' },
    ...(process.env.FAKE_DELEGATE_LONG_LANE ? { 'a-project-lane-with-an-extremely-long-name-for-review-work': { implementer: 'claude', model: 'claude-fake', effort: 'low', source: 'project' } } : {}),
    'other-cli': { implementer: 'grok', model: 'grok-x', source: 'global' },
  };
}
