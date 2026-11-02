---
name: skyhop-status
description: List past Skyhop handoffs with their branches and session links.
disable-model-invocation: true
---

# Skyhop status

Run this and show the user its output:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/skyhop.mjs" --status
```

This lists handoffs recorded on this machine. It can't show live progress, so point the user to the session links for that.
