// Translate one provider turn's JSON events into the thread activity format, and read a turn's events file as it grows.
// Provider output is data we do not control: the translator uses only values that are strings and never throws.
import { closeSync, openSync, readSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { MAX_TEXT, resultText, summarize } from './runs.mjs';

export const MAX_LANE_LINE = 8 * 1024 * 1024;       // a longer events line is skipped
export const MAX_LANE_EVENTS = 50 * 1024 * 1024;    // the most of an events file that is read
const MAX_ID = 200;
const MAX_NAME = 100;

const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const cut = (s, n) => s.length > n ? s.slice(0, n - 1) + '…' : s;
const preview = (v) => cut(resultText(v).replace(/\s+/g, ' ').trim(), 300);
const str = (v) => (typeof v === 'string' ? v : '');
const strings = (v) => (Array.isArray(v) ? v : []).filter((x) => typeof x === 'string');
const textEvent = (text) => typeof text === 'string' && text.trim() ? [{ kind: 'text', text: cut(text, MAX_TEXT) }] : [];

export function laneTranslator(implementer) {
  if (implementer !== 'codex' && implementer !== 'opencode') return null;
  const tools = new Set();
  const results = new Set();
  const texts = new Set();
  const toolEvents = (id, name, summary, completed, ok, output) => {
    if (typeof id !== 'string' || typeof name !== 'string') return [];
    id = cut(id, MAX_ID);
    name = cut(name, MAX_NAME);
    const out = [];
    if (!tools.has(id)) {
      tools.add(id);
      out.push({ kind: 'tool', id, name, summary });
    }
    if (completed && !results.has(id)) {
      results.add(id);
      out.push({ kind: 'tool_result', id, ok, preview: preview(output) });
    }
    return out;
  };
  const translate = (obj) => {
    if (!object(obj)) return [];
    if (implementer === 'opencode') {
      const p = obj.part;
      if (!object(p)) return [];
      if (obj.type === 'text' && p.type === 'text') {
        if (p.time && p.time.end == null) return [];
        if (typeof p.id !== 'string' || texts.has(p.id)) return [];
        texts.add(p.id);
        return textEvent(p.text);
      }
      if (obj.type !== 'tool_use' || p.type !== 'tool' || !object(p.state)) return [];
      const s = p.state;
      if (s.status !== 'completed' && s.status !== 'error') return [];
      const input = object(s.input) ? s.input : {};
      const summary = Object.keys(input).length ? summarize({ ...input, file_path: str(input.file_path) || str(input.filePath) }) : summarize({ description: str(s.title) });
      return toolEvents(p.callID, p.tool, summary, true, s.status === 'completed', str(s.output) || str(s.error));
    }
    if (obj.type !== 'item.started' && obj.type !== 'item.completed') return [];
    const i = obj.item;
    if (!object(i)) return [];
    const completed = obj.type === 'item.completed';
    if (i.type === 'agent_message') return completed ? textEvent(i.text) : [];
    if (i.type === 'command_execution') {
      const command = Array.isArray(i.command) ? strings(i.command).join(' ') : str(i.command);
      return toolEvents(i.id, 'shell', summarize({ command }), completed, i.exit_code === 0 && i.status !== 'failed', i.aggregated_output);
    }
    if (i.type === 'file_change' && completed) {
      const summary = (Array.isArray(i.changes) ? i.changes : []).filter(object).map((c) => `${str(c.kind)} ${str(c.path)}`.trim()).join(', ');
      return toolEvents(i.id, 'edit', summarize({ description: summary }), true, i.status === 'completed', '');
    }
    if (i.type === 'mcp_tool_call') {
      const name = [str(i.server), str(i.tool)].filter(Boolean).join('.') || 'mcp';
      return toolEvents(i.id, name, summarize(i.arguments), completed, i.status === 'completed', (object(i.error) && str(i.error.message)) || resultText(object(i.result) ? i.result.content : undefined));
    }
    // Codex's web_search item has a query but no status or result payload.
    if (i.type === 'web_search') return toolEvents(i.id, 'web_search', summarize({ query: i.query }), completed, true, '');
    return [];
  };
  return (obj) => {
    try { return translate(obj); } catch { return []; }
  };
}

// Reads a provider's events file from where it stopped, one whole line at a time: drain() reads the new bytes and calls onLine for each
// complete line; end() hands over a last line that has no newline. An incomplete line or UTF-8 character waits for the next drain. A line over
// maxLine is skipped, and nothing past maxBytes is read. A line is taken out of the buffer before onLine sees it, and onLine throwing
// loses only that line. A file that is not there yet is not an error.
export function laneReader(file, onLine, { maxBytes = MAX_LANE_EVENTS, maxLine = MAX_LANE_LINE, chunk = 64 * 1024 } = {}) {
  const decoder = new StringDecoder('utf8');
  let offset = 0;
  let partial = '';
  let lineBytes = 0;
  let skipping = false;
  const handle = (line) => { try { onLine(line); } catch { /* one bad line is not worth the turn */ } };
  const take = (text) => {
    const parts = text.split('\n');
    for (let n = 0; n < parts.length; n++) {
      lineBytes += Buffer.byteLength(parts[n]);
      if (lineBytes > maxLine) { skipping = true; partial = ''; }
      if (!skipping) partial += parts[n];
      if (n < parts.length - 1) {
        const line = skipping ? '' : partial;
        partial = '';
        lineBytes = 0;
        skipping = false;
        if (line) handle(line);
      }
    }
  };
  return {
    drain() {
      if (offset >= maxBytes) return;
      let fd;
      try {
        fd = openSync(file, 'r');
        const buffer = Buffer.alloc(chunk);
        while (offset < maxBytes) {
          const n = readSync(fd, buffer, 0, Math.min(buffer.length, maxBytes - offset), offset);
          if (!n) break;
          offset += n;
          take(decoder.write(buffer.subarray(0, n)));
        }
      } catch { /* missing means not yet */ }
      finally { if (fd !== undefined) closeSync(fd); }
    },
    end() {
      take(decoder.end());
      const line = skipping ? '' : partial;
      partial = '';
      skipping = false;
      lineBytes = 0;
      if (line) handle(line);
    },
  };
}
