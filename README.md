# Skyhop

Skyhop is a Claude Code plugin that hands off a running terminal session to a cloud session. Run `/skyhop`, close your laptop, and carry on from [claude.ai/code](https://claude.ai/code) or the Claude app.

## The problem

Claude Code has no terminal command that pushes a running session up to the cloud:

| Option | What it does | Why it isn't enough |
| --- | --- | --- |
| `claude --teleport` | Pulls a cloud session down to your terminal | Only goes one way |
| `claude --cloud` | Starts a new cloud session | Doesn't carry over your conversation |
| Remote Control | Lets you steer a local session from your phone | Your computer has to stay on |
| Desktop app **Open in > Cloud** | Sends a session to the cloud | Carries the conversation as a summary, and needs manual clicks |

If you have to leave mid-task and shut your laptop, the cloud session starts without what you and Claude have done so far.

## Install

```text
/plugin marketplace add arya232006/skyhop
/plugin install skyhop@skyhop
```

Skyhop needs Node.js 20 or later, git, and a claude.ai sign-in on a plan that includes cloud sessions. It runs on macOS. The Linux path is written but untested, and Windows isn't supported.

## Usage

```text
/skyhop                      Hand off with a brief and recent conversation
/skyhop --dry-run            Show the plan and first prompt, and do nothing else
/skyhop --full-resume        Resume the real session inside the cloud VM
/skyhop --name login-fix     Choose the branch name
/skyhop-status               List past handoffs and their links
```

| Flag | What it does |
| --- | --- |
| `--name X` | Names the branch `skyhop/X-<timestamp>`. Defaults to your current branch name |
| `--dry-run` | Pushes nothing, starts nothing, and prints the plan and first prompt |
| `--yes` | Skips the confirmation |
| `--full-resume` | Uses full resume instead of the brief handoff |
| `--mode M` | Sets the permission mode for full resume: `auto` (default), `acceptEdits` or `plan` |
| `--allow-secrets` | Continues even though the secret scan found something |

**Handoffs start by themselves** from any repository you've already trusted in Claude Code. Skyhop runs `--cloud` from a temporary git worktree, which shares your repository's trust, and removes the worktree afterward. If you haven't trusted the repository, Skyhop prints a command to run in your own terminal, and you choose **Yes, I trust this folder**.

## The two modes

| | Brief handoff (`/skyhop`) | Full resume (`/skyhop --full-resume`) |
| --- | --- | --- |
| **Conversation** | A brief plus recent turns, written by Claude | The real session transcript, resumed inside the VM |
| **Chat experience** | A normal cloud session with live tool activity | Normal-looking replies, but no live tool activity |
| **Code travels by** | A `skyhop/...` branch pushed to your remote | A direct upload, with nothing pushed to GitHub |
| **Permission mode** | Set in the chat | Set at handoff, and fixed after that |
| **Usage** | Normal | Each reply is generated twice |

### Brief handoff

Skyhop snapshots your work to a new branch and starts a cloud session on it. The first prompt holds a brief: your goal, current state, decisions, remaining work, gotchas, and the last several exchanges.

**The cloud session starts with that brief, not your exact history.** It's a new session that has been told what happened.

### Full resume

Skyhop uploads the session's transcript with your code. A hook in the VM starts a second Claude Code process with `--resume`, which loads the real conversation. That process does the work, and the chat Claude repeats each reply.

**This is a copy of your session running inside a relay. It is not your original session, and Skyhop can't load a local session into Anthropic's own cloud session.** The limits are:

- **No live tool activity.** You only see the final reply to each message.
- **Replies are generated twice**, once by the resumed session and once by the chat Claude repeating them. The chat Claude runs on Haiku to keep this cheap, and it could change the wording slightly.
- **The mode picker in the chat has no effect.** The mode is set at handoff with `--mode`, and it can't change afterward.
- **The resumed session can't ask you for approval.** If it needs a tool its mode doesn't allow, the reply says what was blocked.
- **A single message has a one-hour limit.** The work so far is saved if it runs out, and your next message carries on.
- **Your full transcript is uploaded**, including everything Claude read and ran and your private file paths. It goes directly to the session and is taken out of git history on the first message, so a later push can't carry it to GitHub.
- **It depends on an internal file format.** The transcript format can change on any Claude Code release. If the VM can't load it, the session falls back to the brief and says so.
- **Uploads are capped at 100 MB.** Skyhop refuses larger transcripts, and long sessions use more of your plan on every message.
- **With no remote, or no push access, the session can't push its work back.**

## What doesn't carry over

In either mode, the cloud VM won't have:

- Gitignored files, and `.env`-style files
- Local services and databases
- MCP servers set up only on your machine
- Running processes
- Your local environment variables and credentials

## Safety guarantees

- **Your checkout stays exactly as it was.** Your branch, working tree and index are unchanged. Skyhop builds the snapshot with a temporary index and never switches branches.
- **Skyhop never force-pushes.** It only creates a new `skyhop/...` branch.
- **Gitignored and `.env`-style files are left out.** This also covers keys, certificates and files like `.npmrc`, and the plan lists what was left out.
- **Secrets stop the handoff.** Skyhop scans everything your remote doesn't already have, including unpushed commits on every local branch, plus the brief and any transcript. If it finds a likely secret, nothing leaves your machine. The scanner matches known patterns, so it can miss things.
- **You confirm first.** Skyhop shows the branch, remote, changes and upload before anything leaves your machine, unless you pass `--yes`.
- **Private paths are removed from the brief.** The full-resume transcript can't be edited, so the confirmation warns you about it.
- **Skyhop never answers the trust prompt or changes your trust settings.** It relies on the trust a worktree shares with its repository.
- **A failed handoff tells you how to retry.** The brief is kept in `~/.skyhop/briefs/`.

Skyhop keeps its files in `~/.skyhop/`: briefs, a history of handoffs, and a temporary launch worktree. The worktree and its local `skyhop/...` branch are removed after the launch. If a handoff is waiting on you, they stay until your next handoff from that repository.

## Known limitations

- `/skyhop-status` lists links from this machine. It can't show live progress, so open the link for that.
- Pushed `skyhop/...` branches stay on your remote until you delete them.
- Direct uploads may include your other local branches. Claude Code's docs say they do, although another branch wasn't visible in the VM when this was tested, so Skyhop scans all of them.
- If the Claude GitHub App isn't installed on your repository, `--cloud` uploads the repository directly instead of cloning. The session can then push back only if your GitHub connection has access.
- Full resume leaves unreachable copies of the transcript in your repository's `.git` folder until git cleans them up. They are never pushed.
- If Skyhop can't take its commit out of git history in the VM, it warns you in the chat. Don't push that branch.

## Development

```bash
npm test
claude plugin validate .
claude --plugin-dir .
```

The tests use a stand-in `claude` command and a local bare remote, so they never touch GitHub or the cloud.

## License

MIT
