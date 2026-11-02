---
name: skyhop-brief
description: How to write a Skyhop handoff brief. Used by the /skyhop command, and not useful on its own.
user-invocable: false
---

# Writing a Skyhop handoff brief

The brief is what a fresh Claude needs to carry on this work in a cloud VM. That Claude has the repository but none of this conversation. Write markdown with these sections, tight and specific:

- **Goal:** what the user is ultimately trying to achieve.
- **Current state:** what is done, with file paths relative to the repository root.
- **Decisions made:** and why, so the cloud session doesn't redo or reverse them.
- **Remaining work:** an ordered checklist, the next step first.
- **Gotchas:** things that failed, flaky tests, constraints, conventions, commands to build and test.
- **Environment caveats:** anything not in the repository that the cloud VM won't have, such as gitignored files, local services, environment variables and MCP servers. The cloud session must not assume these exist.
- **Handoff note:** one line saying this is a Skyhop handoff from a local session, and that the cloud session should confirm the plan before large changes.
- **Recent conversation:** the last several exchanges, oldest first. Quote the user's messages word for word, and keep your own replies short. Show tool calls as one-line notes such as `Edited src/auth.ts`.

Keep everything before **Recent conversation** under about 1,500 words, and the whole brief under about 5,000 words.

Never include secrets, tokens or passwords. Use repository-relative paths, not paths under the user's home folder.
