---
name: skyhop-back
description: Bring a full-resume Skyhop session home right away, from another window. Usually not needed, because a session comes home by itself when you open it with /resume and send a message.
argument-hint: "[--session ID] [--dry-run]"
disable-model-invocation: true
---

# Skyhop back

Arguments from the user: `$ARGUMENTS`

Run this, and allow up to 3 minutes:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/skyhop.mjs" --back $ARGUMENTS
```

Show the user what it reports, in a few lines. If it failed, show its message and stop.

If it brought the session home, tell them to type `/resume` and pick that session to carry on. They can do that in this window. Mention the `claude --resume` command it printed, for a new terminal.

If it says the cloud session is still working on a reply, tell them to wait for that reply, or to run `/skyhop-back` again to bring home everything saved before it.
