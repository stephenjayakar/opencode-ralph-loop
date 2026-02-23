---
name: ralph-loop
description: >
  Run a kimaki agent autonomously in a loop until all checkboxes in a PLAN.md
  file are checked off. Uses kimaki send --wait to fire one session at a time,
  checks PLAN.md progress after each session, and repeats until done or no
  progress is made. Good for multi-session autonomous implementation of a
  backlog tracked in PLAN.md.
---

# ralph-loop

The "ralph loop" pattern runs a kimaki agent session in a loop, one at a time,
until all `- [ ]` items in a `PLAN.md` are checked off (`- [x]`).

Named after Ralph — the spirit of autonomous, relentless progress.

---

## How It Works

```
while unchecked items remain in PLAN.md:
    pick the first N unchecked items
    fire: kimaki send --wait --channel <lt-web-channel> --prompt "implement these"
    wait for session to finish
    re-read PLAN.md to count progress
    if no progress for 3 sessions in a row: stop
```

One session runs at a time. The loop blocks on `--wait` until the agent finishes,
then checks how many items got checked off before starting the next session.

---

## The Script

The loop is implemented in `run-until-done.js` (included in this repo).

Configure the constants at the top of the script before running:

```js
const PLAN_MD  = '/path/to/your/PLAN.md';
const CHANNEL  = '<discord-channel-id>';  // from: kimaki project list --json
const USER     = 'your-discord-username';
```

### Usage

```bash
# Run in a tmux session so it survives terminal close
tmux new-session -d -s ralph-loop
tmux send-keys -t ralph-loop "node run-until-done.js 2>&1 | tee /tmp/ralph-loop.log" Enter

# Watch progress
tail -f /tmp/ralph-loop.log
tmux capture-pane -t ralph-loop -p

# Dry run (see what prompt would be sent without firing sessions)
node run-until-done.js --dry-run

# Options
node run-until-done.js --batch 8         # items per session (default: 5)
node run-until-done.js --max-sessions 10 # cap total sessions (default: 50)

# If it crashed and left a stale lock:
rm /tmp/ralph-loop.lock
```

---

## Key Design Decisions

### 1. Prompt must stay under 2000 chars

Discord has a 2000-char message limit. If the prompt exceeds it, kimaki
automatically sends it as a file attachment (`prompt.md`). The agent then
receives:

> "Prompt attached as file (N chars) > [preview]..."

...and may not parse the attachment correctly, causing sessions to complete
instantly without doing any work.

**Fix:** Keep the prompt short. Pass only item *titles* (not full descriptions),
and tell the agent to read `PLAN.md` itself for details.

```js
const titles = uncheckedItems.slice(0, BATCH_SIZE).map((item, idx) => {
  const title = item.replace(/\*\*/g, '').split('.')[0].trim().slice(0, 80);
  return `${idx + 1}. ${title}`;
}).join('\n');
```

Typical prompt size with 5 items: ~700 chars. Well under the limit.

### 2. Lock file prevents double-runs

```js
const LOCK_FILE = '/tmp/ralph-loop.lock';

if (fs.existsSync(LOCK_FILE)) {
  const pid = fs.readFileSync(LOCK_FILE, 'utf8').trim();
  try {
    process.kill(parseInt(pid), 0); // check if alive
    console.error(`Already running (pid ${pid})`);
    process.exit(1);
  } catch {
    fs.unlinkSync(LOCK_FILE); // stale lock, remove it
  }
}
fs.writeFileSync(LOCK_FILE, String(process.pid));
```

### 3. Autonomy via prompt, not flags

There is no `--no-questions` flag in `kimaki send`. Autonomous behavior is
enforced entirely through the prompt:

```
Rules:
- Do NOT use the question tool or ask for confirmation at any point.
- Make decisions yourself.
- Read the Python source in lt-maker/ before implementing each feature.
- Keep the build passing (npm run build).
- Check off each item in PLAN.md when done (- [ ] -> - [x]).
- Do the real implementation, not stubs.
- Do NOT git push.
```

### 4. No-progress guard

If 3 consecutive sessions check off zero items, the loop stops to avoid
burning sessions on a stuck state (e.g. build broken, agent confused):

```js
if (completed === 0) {
  noProgressCount++;
  if (noProgressCount >= 3) {
    log('Stopping: 3 consecutive sessions with no progress.');
    break;
  }
}
```

### 5. Each session gets a fresh thread

Do NOT pass `--thread` or `--session` to reuse an existing thread. Each
`kimaki send` without `--thread` creates a new Discord thread. This prevents
sessions from piling context into a single thread and confusing the agent with
prior conversation history.

### 6. Timeout: 30 minutes per session

`spawnSync` timeout is set to 30 minutes (`1800000ms`). Sessions doing real
implementation work (reading source, writing TypeScript, running `tsc`) can
easily take 15-20 minutes.

---

## Adapting to a New Project

To use the ralph loop on a different project:

1. Copy `run-until-done.js` to the home project (or anywhere accessible)
2. Update these constants at the top:
   ```js
   const PLAN_MD  = '/path/to/your/PLAN.md';
   const CHANNEL  = '<discord-channel-id>';  // from: kimaki project list --json
   const USER     = 'your-discord-username';
   ```
3. Make sure `PLAN.md` uses `- [ ]` / `- [x]` checkbox syntax
4. Run in tmux as shown above

---

## Monitoring

```bash
# Live log
tail -f /tmp/ralph-loop.log

# Check how many unchecked items remain
grep -c '^- \[ \]' /path/to/PLAN.md

# Check tmux session
tmux capture-pane -t ralph-loop -p

# List active processes
ps aux | grep run-until-done
```
