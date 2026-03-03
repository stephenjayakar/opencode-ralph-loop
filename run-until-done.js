#!/usr/bin/env node
// @ts-check
/**
 * run-until-done.js
 *
 * Keeps firing kimaki sessions at a project until every checkbox in PLAN.md
 * is checked off (- [ ] -> - [x]).
 *
 * Usage:
 *   node run-until-done.js --channel <discord-channel-id> [options]
 *
 * Options:
 *   --channel ID        Required. Kimaki channel ID (not thread/session)
 *   --plan PATH         PLAN.md path (default: ./PLAN.md)
 *   --user NAME         Optional kimaki --user value
 *   --dry-run          Print what would be sent without launching sessions
 *   --max-sessions N   Stop after N sessions regardless (default: 50)
 *   --batch N          Number of unchecked items to include per session (default: 5)
 *   --max-hours N      Optional runtime cap in hours (example: 5)
 *   --extra-prompt TXT Additional instruction line (repeatable)
 *   --help             Show usage
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/** @typedef {{
 * channel: string;
 * planPath: string;
 * user: string | null;
 * dryRun: boolean;
 * maxSessions: number;
 * batchSize: number;
 * sessionTimeoutMs: number;
 * maxRuntimeMs: number | null;
 * extraPrompts: string[];
 * logFile: string;
 * lockFile: string;
 * }} Config */

const DEFAULT_MAX_SESSIONS = 50;
const DEFAULT_BATCH_SIZE = 5;
const DEFAULT_SESSION_TIMEOUT_MS = 30 * 60 * 1000;
const CHECKBOX_PATTERN = /^- \[ \]/gm;

/** @param {string} message */
function fail(message) {
  console.error(`ERROR: ${message}`);
  printUsage(1);
}

/** @param {number} code */
function printUsage(code) {
  console.log(`Usage:
  node run-until-done.js --channel <discord-channel-id> [options]

Options:
  --channel ID         Required. Kimaki channel ID
  --plan PATH          PLAN.md path (default: ./PLAN.md)
  --user NAME          Optional kimaki --user value
  --dry-run            Print prompt without launching sessions
  --max-sessions N     Session cap (default: ${DEFAULT_MAX_SESSIONS})
  --batch N            Unchecked item titles per prompt (default: ${DEFAULT_BATCH_SIZE})
  --max-hours N        Optional runtime cap in hours (example: 5)
  --extra-prompt TXT   Extra instruction line (repeatable)
  --help               Show this message`);
  process.exit(code);
}

/**
 * @param {string[]} argv
 * @returns {Config}
 */
function parseArgs(argv) {
  const valueOptions = new Set(['--channel', '--plan', '--user', '--max-sessions', '--batch', '--max-hours', '--extra-prompt']);
  const flagOptions = new Set(['--dry-run', '--help']);

  /** @type {Map<string, string[]>} */
  const values = new Map();
  /** @type {Set<string>} */
  const flags = new Set();

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      fail(`Unexpected positional argument: ${token}`);
    }

    if (token === '--help') printUsage(0);
    if (token === '--dry-run') {
      flags.add(token);
      continue;
    }

    if (token === '--thread' || token === '--session') {
      fail('Do not pass --thread or --session. This loop is channel-only and creates fresh threads per run.');
    }

    if (!valueOptions.has(token) && !flagOptions.has(token)) {
      fail(`Unknown option: ${token}`);
    }

    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      fail(`Missing value for ${token}`);
    }
    i++;

    const arr = values.get(token) ?? [];
    arr.push(next);
    values.set(token, arr);
  }

  const getLast = (key, fallback = null) => {
    const arr = values.get(key);
    return arr && arr.length > 0 ? arr[arr.length - 1] : fallback;
  };

  const parsePositiveInt = (raw, key, fallback) => {
    if (raw == null) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
      fail(`${key} must be a positive integer, received: ${raw}`);
    }
    return n;
  };

  const parsePositiveNumber = (raw, key, fallback) => {
    if (raw == null) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      fail(`${key} must be a positive number, received: ${raw}`);
    }
    return n;
  };

  const channel = getLast('--channel');
  if (!channel) fail('--channel is required');

  const planPath = path.resolve(getLast('--plan', path.join(process.cwd(), 'PLAN.md')));
  if (!fs.existsSync(planPath)) {
    fail(`PLAN.md not found at ${planPath}`);
  }

  const maxSessions = parsePositiveInt(getLast('--max-sessions'), '--max-sessions', DEFAULT_MAX_SESSIONS);
  const batchSize = parsePositiveInt(getLast('--batch'), '--batch', DEFAULT_BATCH_SIZE);
  const maxHours = parsePositiveNumber(getLast('--max-hours'), '--max-hours', null);
  const maxRuntimeMs = maxHours == null ? null : Math.floor(maxHours * 60 * 60 * 1000);
  const extraPrompts = values.get('--extra-prompt') ?? [];

  const lockSafeChannel = channel.replace(/[^a-zA-Z0-9_-]/g, '_');
  return {
    channel,
    planPath,
    user: getLast('--user'),
    dryRun: flags.has('--dry-run'),
    maxSessions,
    batchSize,
    sessionTimeoutMs: DEFAULT_SESSION_TIMEOUT_MS,
    maxRuntimeMs,
    extraPrompts,
    logFile: '/tmp/ralph-loop.log',
    lockFile: `/tmp/ralph-loop-${lockSafeChannel}.lock`,
  };
}

const config = parseArgs(process.argv.slice(2));

// ── Lock file (prevent two instances running simultaneously) ──────────────────

if (fs.existsSync(config.lockFile)) {
  const pid = fs.readFileSync(config.lockFile, 'utf8').trim();
  try {
    process.kill(parseInt(pid, 10), 0); // throws if pid not alive
    console.error(`ERROR: Another instance is already running (pid ${pid}). Delete ${config.lockFile} to force.`);
    process.exit(1);
  } catch {
    // Process is gone — stale lock, remove it
    fs.unlinkSync(config.lockFile);
  }
}

fs.writeFileSync(config.lockFile, String(process.pid), 'utf8');

function removeLock() {
  try { fs.unlinkSync(config.lockFile); } catch {}
}
process.on('exit', removeLock);
process.on('SIGINT', () => { removeLock(); process.exit(130); });
process.on('SIGTERM', () => { removeLock(); process.exit(143); });

// ── Helpers ───────────────────────────────────────────────────────────────────

/** @param {string} planPath */
function getUncheckedItems(planPath) {
  const content = fs.readFileSync(planPath, 'utf8');
  const lines   = content.split('\n');
  /** @type {string[]} */
  const items   = [];
  let   i       = 0;

  while (i < lines.length) {
    if (/^- \[ \]/.test(lines[i])) {
      // Collect multi-line item (continuation lines are indented)
      let block = lines[i].replace(/^- \[ \]\s*/, '').trim();
      i++;
      while (i < lines.length && /^  /.test(lines[i])) {
        block += ' ' + lines[i].trim();
        i++;
      }
      items.push(block);
    } else {
      i++;
    }
  }
  return items;
}

/** @param {string[]} uncheckedItems */
function buildPrompt(uncheckedItems) {
  // Keep titles short (strip markdown bold) so the prompt stays under
  // Discord's 2000-char limit and is never sent as a file attachment
  // (which confuses the agent and causes sessions to complete instantly).
  const titles = uncheckedItems
    .slice(0, config.batchSize)
    .map((item, idx) => {
      const title = item.replace(/\*\*/g, '').split('.')[0].trim().slice(0, 80);
      return `${idx + 1}. ${title}`;
    })
    .join('\n');

  const extraPromptBlock = config.extraPrompts.length === 0
    ? ''
    : `\nAdditional instructions:\n${config.extraPrompts.map((line) => `- ${line}`).join('\n')}`;

  return `Kimaki autonomous coding session.

Candidate unchecked tasks (read PLAN.md for full details):

${titles}

Base rules (always follow):
1. Use PLAN.md always as the source of truth.
2. Feel free to add to PLAN.md.
3. Cross off tasks as you finish them.
4. Stop when there are no more blank checkboxes.
5. Read AGENTS.md if it exists.
6. Pick one task and finish it.

Execution rules:
- Do NOT use the question tool or ask for confirmation at any point.
- Keep the build passing.
- Do real implementation work, not stubs.
- Commit completed work before ending the session (do not push).
- Do NOT git push.${extraPromptBlock}`;
}

/** @param {string} planPath */
function countUnchecked(planPath) {
  const content = fs.readFileSync(planPath, 'utf8');
  return (content.match(CHECKBOX_PATTERN) || []).length;
}

/** @param {string} msg */
function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const line = `[${ts}] ${msg}`;
  console.log(line);
  fs.appendFileSync(config.logFile, line + '\n');
}

// ── Main loop ─────────────────────────────────────────────────────────────────

async function main() {
  const startMs = Date.now();
  const maxHoursText = config.maxRuntimeMs == null
    ? 'none'
    : String((config.maxRuntimeMs / (60 * 60 * 1000)).toFixed(2));

  log(`Starting ralph loop. PLAN.md: ${config.planPath}`);
  log(`Channel: ${config.channel}, Max sessions: ${config.maxSessions}, Batch size: ${config.batchSize}, Dry run: ${config.dryRun}, Max hours: ${maxHoursText}, PID: ${process.pid}`);

  let sessionCount    = 0;
  let noProgressCount = 0;

  while (sessionCount < config.maxSessions) {
    if (config.maxRuntimeMs != null && Date.now() - startMs >= config.maxRuntimeMs) {
      log('Stopping: reached max runtime limit.');
      break;
    }

    const unchecked = getUncheckedItems(config.planPath);
    const count     = unchecked.length;

    log(`Unchecked items remaining: ${count}`);

    if (count === 0) {
      log('All items in PLAN.md are checked off. Done!');
      break;
    }

    sessionCount++;
    log(`Starting session ${sessionCount}/${config.maxSessions} (working on up to ${config.batchSize} item titles)...`);

    const prompt = buildPrompt(unchecked);

    if (config.dryRun) {
      log('[DRY RUN] Would send this prompt:');
      console.log('─'.repeat(60));
      console.log(prompt);
      console.log('─'.repeat(60));
      log('[DRY RUN] Stopping after first iteration.');
      break;
    }

    const beforeCount = count;

    try {
      log(`Launching kimaki send (timeout: ${config.sessionTimeoutMs / 1000}s)...`);

      // Each session gets a fresh thread — do NOT pass --thread/--session,
      // which would pile context into one thread and confuse the agent.
      /** @type {string[]} */
      const kimakiArgs = ['-y', 'kimaki', 'send', '--channel', config.channel, '--prompt', prompt, '--wait'];
      if (config.user) {
        kimakiArgs.push('--user', config.user);
      }

      const result = spawnSync('npx', kimakiArgs,
        {
          timeout:   config.sessionTimeoutMs,
          encoding:  'utf8',
          stdio:     ['ignore', 'pipe', 'pipe'],
          maxBuffer: 20 * 1024 * 1024, // 20 MB
        }
      );

      if (result.error) {
        log(`Session spawn error: ${result.error.message}`);
      } else if (result.status !== 0) {
        log(`Session exited with status ${result.status}`);
        if (result.stderr) log(`stderr: ${result.stderr.slice(0, 500)}`);
      } else {
        log('Session completed successfully.');
      }
    } catch (err) {
      const error = /** @type {Error} */ (err);
      log(`Session exception: ${error.message}`);
    }

    const afterCount = countUnchecked(config.planPath);
    const completed  = beforeCount - afterCount;

    log(`Items completed this session: ${completed} (${beforeCount} -> ${afterCount} remaining)`);

    if (completed === 0) {
      noProgressCount++;
      log(`No progress (${noProgressCount} consecutive zero-progress sessions).`);

      if (noProgressCount >= 3) {
        log('Stopping: 3 consecutive sessions with no progress. Check kimaki output for errors.');
        break;
      }

      log('Waiting 10s before retry...');
      await new Promise(r => setTimeout(r, 10_000));
    } else {
      noProgressCount = 0;
    }
  }

  const finalCount = countUnchecked(config.planPath);
  log(`─── Run complete ───`);
  log(`Total sessions run: ${sessionCount}`);
  log(`Unchecked items remaining: ${finalCount}`);

  if (finalCount === 0) {
    log('SUCCESS: All PLAN.md items are complete!');
  } else {
    log(`Stopped with ${finalCount} items remaining.`);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
