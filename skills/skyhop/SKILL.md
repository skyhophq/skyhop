---
name: skyhop
description: Move this session to a Claude Code cloud session, with its code and full history, so the work carries on after the laptop closes. /skyhop-back brings it home.
argument-hint: "[--summary] [--name X] [--dry-run] [--yes] [--mode auto|acceptEdits|plan] [--no-sync] [--allow-secrets]"
disable-model-invocation: true
---

# Skyhop handoff

Arguments from the user: `$ARGUMENTS`

Follow these steps in order.

1. **Write the brief.** Read `${CLAUDE_PLUGIN_ROOT}/skills/skyhop-brief/SKILL.md` and follow it. Save the brief to `~/.skyhop/briefs/${CLAUDE_SESSION_ID}.md`, creating the folder if needed. Keep it out of the repository.

2. **Preview.** Run this, and allow up to 3 minutes:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/skyhop.mjs" --brief ~/.skyhop/briefs/${CLAUDE_SESSION_ID}.md --session ${CLAUDE_SESSION_ID} --dry-run $ARGUMENTS
   ```

   If it fails, show the user its message and stop. Do not work around a secret scan failure. Only the user can decide to add `--allow-secrets`.

3. **Confirm.** If the arguments include `--dry-run`, show the plan and stop. If they include `--yes`, go to step 4. Otherwise show the user the plan, including the branch, what will be uploaded and the permission mode, and ask whether to go ahead. Stop if they say no.

4. **Hand off.** Run the same command without `--dry-run` and with `--yes`, and allow up to 10 minutes, because a large upload takes time:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/skyhop.mjs" --brief ~/.skyhop/briefs/${CLAUDE_SESSION_ID}.md --session ${CLAUDE_SESSION_ID} --yes $ARGUMENTS
   ```

5. **Report** in one or two lines: the branch and the session link.

   This usually starts by itself. If it printed a command for the user's own terminal instead, give them that command exactly, in a code block. Tell them to run it in a separate terminal window, not with `!` here, because it needs a real terminal.
