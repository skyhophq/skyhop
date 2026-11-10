---
name: skyhop
description: Move this session to a Claude Code cloud session, with its code and full history, so the work carries on after the laptop closes. It comes home when you open it here again, and a later handoff goes back to the same cloud chat.
argument-hint: "[--summary] [--name X] [--dry-run] [--yes] [--mode auto|acceptEdits|plan] [--history N|off] [--new-chat] [--no-sync] [--allow-secrets]"
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

   If the plan's History line says Remote Control is off, say so in the same question. The cloud chat then shows only the last exchanges the plan names, and there will be no link to the whole conversation. To get the link, the user can type `/remote-control` now and then tell you to go ahead. Step 4 picks up the link by itself. Only the user can turn Remote Control on, so don't try to do it yourself.

4. **Hand off.** Run the same command without `--dry-run` and with `--yes`, and allow up to 15 minutes. A large upload takes time, and after the chat starts Skyhop posts the session's earlier messages into it one by one, which the plan's History line estimates:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/skyhop.mjs" --brief ~/.skyhop/briefs/${CLAUDE_SESSION_ID}.md --session ${CLAUDE_SESSION_ID} --yes $ARGUMENTS
   ```

5. **Report** in one or two lines: the branch and the session link, and whether the chat shows the earlier conversation or fell back to a recap, as the output says. If it printed the line about quitting this window, pass that on too: the session comes home as the same session when the user opens it again on this machine and sends a message.

   This usually starts by itself. If it printed a command for the user's own terminal instead, give them that command exactly, in a code block. Tell them to run it in a separate terminal window, not with `!` here, because it needs a real terminal.
