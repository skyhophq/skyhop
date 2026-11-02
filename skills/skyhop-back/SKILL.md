---
name: skyhop-back
description: Bring a full-resume Skyhop session home, adding its cloud conversation to the original session and its code to a new local branch.
argument-hint: "[--session ID] [--dry-run]"
disable-model-invocation: true
---

# Skyhop back

Arguments from the user: `$ARGUMENTS`

Run this, and allow up to 3 minutes:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/skyhop.mjs" --back $ARGUMENTS
```

Show the user what it reports, in a few lines, including the exact `claude --resume` command if it printed one. If it failed, show its message and stop.

Tell them to quit this window before running that command, so the session loads the cloud conversation.
