---
name: skyhop-status
description: List Skyhop sessions in the cloud and past handoffs, and tidy up branches that earlier handoffs left behind.
disable-model-invocation: true
---

# Skyhop status

Run this and show the user its output:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/skyhop.mjs" --status
```

It lists sessions waiting in the cloud and handoffs recorded on this machine. It can't show live progress, so point the user to the session links for that.

If the output has a "Safe to remove" list, ask the user whether to remove those branches. Name them. Only if they agree, run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/skyhop.mjs" --status --clean
```

Then report what it removed. Never remove anything from the "Kept" list. Those branches hold work that exists nowhere else, so leave them for the user to deal with.
