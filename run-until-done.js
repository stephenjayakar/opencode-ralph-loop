#!/usr/bin/env node
/**
 * run-until-done.js
 *
 * Keeps firing kimaki sessions at a project until every checkbox in PLAN.md
 * is checked off (- [ ] -> - [x]).
 *
 * Usage:
 *   node run-until-done.js [--dry-run] [--max-sessions N] [--batch N]
 *
 * Options:
 *   --dry-run          Print what would be sent without launching sessions
 *   --max-sessions N   Stop after N sessions regardless (default: 50)
 *   --batch N          Number of unchecked items to include per session (default: 5)
 */

const { spawnSync } = require('child_process');
const fs = require('fs');

// ── Config — edit these for your project ─────────────────────────────────────

const PLAN_MD   = '/path/to/your/PLAN.md';
const CHANNEL   = '<discord-channel-id>';   // from: kimaki project list --json
const USER      = 'your-discord-username';
const LOCK_FILE = '/tmp/ralph-loop.lock';

// ── Options ───────────────────────────────────────────────────────────────────

const args         = process.argv.slice(2);
const DRY_RUN      = args.includes('--dry-run');
const MAX_SESSIONS = parseInt(args[args.indexOf('--max-sessions') + 1] ?? '50', 10) || 50;
const BATCH_SIZE   = parseInt(args[args.indexOf('--batch') + 1] ?? '5', 10) || 5;
// 30 minutes per session — enough time for real implementation work
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

// ── Lock file (prevent two instances running simultaneously) ──────────────────

if (fs.existsSync(LOCK_FILE)) {
  const pid = fs.readFileSync(LOCK_FILE, 'utf8').trim();
  try {
    process.kill(parseInt(pid, 10), 0); // throws if pid not alive
    console.error(`ERROR: Another instance is already running (pid ${pid}). Delete ${LOCK_FILE} to force.`);
    process.exit(1);
  } catch {
    // Process is gone — stale lock, remove it
    fs.unlinkSync(LOCK_FILE);
  }
}

fs.writeFileSync(LOCK_FILE, String(process.pid), 'utf8');

function removeLock() {
  try { fs.unlinkSync(LOCK_FILE); } catch {}
}
process.on('exit', removeLock);
process.on('SIGINT', () => { removeLock(); process.exit(130); });
process.on('SIGTERM', () => { removeLock(); process.exit(143); });

// ── Helpers ───────────────────────────────────────────────────────────────────

function getUncheckedItems(planPath) {
  const content = fs.readFileSync(planPath, 'utf8');
  const lines   = content.split('\n');
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

function buildPrompt(uncheckedItems) {
  // Keep titles short (strip markdown bold) so the prompt stays under
  // Discord's 2000-char limit and is never sent as a file attachment
  // (which confuses the agent and causes sessions to complete instantly).
  const titles = uncheckedItems
    .slice(0, BATCH_SIZE)
    .map((item, idx) => {
      const title = item.replace(/\*\*/g, '').split('.')[0].trim().slice(0, 80);
      return `${idx + 1}. ${title}`;
    })
    .join('\n');

  return `Autonomous coding session.

Read PLAN.md for full details on each item. Implement as many of these unchecked items as you can:

${titles}

Rules:
- Do NOT use the question tool or ask for confirmation at any point. Make decisions yourself.
- Keep the build passing.
- Check off each item in PLAN.md when done (- [ ] -> - [x]) and update any changelog/Recent Changes section.
- Do the real implementation, not stubs. If an item is too large, implement as much as possible.
- Do NOT git push.`;
}

function countUnchecked(planPath) {
  const content = fs.readFileSync(planPath, 'utf8');
  return (content.match(/^- \[ \]/gm) || []).length;
}

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const line = `[${ts}] ${msg}`;
  console.log(line);
  fs.appendFileSync('/tmp/ralph-loop.log', line + '\n');
}

// ── Main loop ─────────────────────────────────────────────────────────────────

async function main() {
  log(`Starting ralph loop. PLAN.md: ${PLAN_MD}`);
  log(`Max sessions: ${MAX_SESSIONS}, Batch size: ${BATCH_SIZE}, Dry run: ${DRY_RUN}, PID: ${process.pid}`);

  let sessionCount    = 0;
  let noProgressCount = 0;

  while (sessionCount < MAX_SESSIONS) {
    const unchecked = getUncheckedItems(PLAN_MD);
    const count     = unchecked.length;

    log(`Unchecked items remaining: ${count}`);

    if (count === 0) {
      log('All items in PLAN.md are checked off. Done!');
      break;
    }

    sessionCount++;
    log(`Starting session ${sessionCount}/${MAX_SESSIONS} (working on up to ${BATCH_SIZE} items)...`);

    const prompt = buildPrompt(unchecked);

    if (DRY_RUN) {
      log('[DRY RUN] Would send this prompt:');
      console.log('─'.repeat(60));
      console.log(prompt);
      console.log('─'.repeat(60));
      log('[DRY RUN] Stopping after first iteration.');
      break;
    }

    const beforeCount = count;

    try {
      log(`Launching kimaki session (timeout: ${SESSION_TIMEOUT_MS / 1000}s)...`);

      // Each session gets a fresh thread — do NOT pass --thread/--session,
      // which would pile context into one thread and confuse the agent.
      const result = spawnSync(
        'npx',
        [
          '-y', 'kimaki', 'send',
          '--channel', CHANNEL,
          '--prompt',  prompt,
          '--user',    USER,
          '--wait',
        ],
        {
          timeout:   SESSION_TIMEOUT_MS,
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
      log(`Session exception: ${err.message}`);
    }

    const afterCount = countUnchecked(PLAN_MD);
    const completed  = beforeCount - afterCount;

    log(`Items completed this session: ${completed} (${beforeCount} -> ${afterCount} remaining)`);

    if (completed === 0) {
      noProgressCount++;
      log(`No progress (${noProgressCount} consecutive zero-progress sessions).`);

      if (noProgressCount >= 3) {
        log('Stopping: 3 consecutive sessions with no progress. Check the Discord thread for errors.');
        break;
      }

      log('Waiting 10s before retry...');
      await new Promise(r => setTimeout(r, 10_000));
    } else {
      noProgressCount = 0;
    }
  }

  const finalCount = countUnchecked(PLAN_MD);
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
