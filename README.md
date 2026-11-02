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

Skyhop needs Node.js 20 or later, git, and a claude.ai sign-in on a plan that includes cloud sessions. It's built on macOS. Its full test suite also passes on Linux, but a real handoff from a Linux machine hasn't been run yet. Windows isn't supported.

## Usage

```text
/skyhop                      Hand off with a brief and recent conversation
/skyhop --dry-run            Show the plan and first prompt, and do nothing else
/skyhop --full-resume        Resume the real session inside the cloud VM
/skyhop --name login-fix     Choose the branch name
/skyhop-back                 Bring a full-resume session home
/skyhop-back --dry-run       Show what would come back, and change nothing
/skyhop-status               List past handoffs and their links
```

| Flag | What it does |
| --- | --- |
| `--name X` | Names the branch `skyhop/X-<timestamp>`. Defaults to your current branch name |
| `--dry-run` | Pushes nothing, starts nothing, and prints the plan and first prompt |
| `--yes` | Skips the confirmation |
| `--full-resume` | Uses full resume instead of the brief handoff |
| `--mode M` | Sets the starting permission mode for full resume: `auto` (default), `acceptEdits` or `plan` |
| `--no-sync` | Full resume only. Pushes nothing to GitHub and uploads directly instead, so `/skyhop-back` has nothing to bring home |
| `--allow-secrets` | Continues even though the secret scan found something |

**Handoffs start by themselves** from any repository you've already trusted in Claude Code. Skyhop runs `--cloud` from a temporary git worktree, which shares your repository's trust, and removes the worktree afterward. If you haven't trusted the repository, Skyhop prints a command to run in your own terminal, and you choose **Yes, I trust this folder**.

## The two modes

| | Brief handoff (`/skyhop`) | Full resume (`/skyhop --full-resume`) |
| --- | --- | --- |
| **Conversation** | A brief plus recent turns, written by Claude | The real session transcript, resumed inside the VM |
| **Chat experience** | A normal cloud session with live tool activity | Normal-looking replies, but no live tool activity |
| **Code travels by** | A `skyhop/...` branch pushed to your remote | A `skyhop-run/...` branch, with the transcript encrypted |
| **Permission mode** | Set in the chat | Set at handoff, and changed by sending a message |
| **Usage** | Normal | Each reply is generated twice |
| **Coming home** | `claude --teleport` brings a separate copy | `/skyhop-back` puts it back in your original session |

### Brief handoff

Skyhop snapshots your work to a new branch and starts a cloud session on it. The first prompt holds a brief: your goal, current state, decisions, remaining work, gotchas, and the last several exchanges.

**The cloud session starts with that brief, not your exact history.** It's a new session that has been told what happened.

### Full resume

Skyhop pushes your code and the session's transcript to a `skyhop-run/...` branch, with the transcript encrypted. The key goes only in the first message of the cloud session, never through GitHub. A hook in the VM decrypts the transcript and starts a second Claude Code process with `--resume`, which loads the real conversation. That process does the work, and the chat Claude repeats each reply.

**This is a copy of your session running inside a relay. It is not your original session, and Skyhop can't load a local session into Anthropic's own cloud session.** The limits are:

- **No live tool activity.** You see the final reply to each message, followed by a **Steps taken** list of what it did.
- **Replies are generated twice**, once by the resumed session and once by the chat Claude repeating them. The chat Claude runs on Haiku to keep this cheap, and it could change the wording slightly.
- **The mode picker in the chat has no effect.** Send `skyhop mode auto`, `skyhop mode acceptEdits` or `skyhop mode plan` as a message instead.
- **The resumed session can't ask you for approval.** If it needs a tool its mode doesn't allow, the reply says what was blocked and how to allow it.
- **Long single messages are unproven.** Skyhop allows a message up to six hours, but tests have only confirmed messages of a few minutes, and a task of about 20 minutes gave no result within 40 minutes. Break big jobs into several messages.
- **It depends on an internal file format.** The transcript format can change on any Claude Code release. If the VM can't load it, the session falls back to the brief and says so.
- **Long sessions use more of your plan on every message.**
- **The first message of the cloud session shows the decryption key.** It only opens this handoff's transcript, which `/skyhop-back` deletes from GitHub. Don't share that session publicly before then.
- **With no remote, or with `--no-sync`,** Skyhop uploads the repository directly instead. That upload is capped at 100 MB after compression, may include your other local branches, and leaves nothing for `/skyhop-back`.

### Coming home

`/resume` only lists sessions stored on your machine, so a cloud session never appears there by itself. After each reply, a full-resume session pushes its code and the new messages to `skyhop-sync/...` branches, with the conversation encrypted. If the VM is cleared while it's idle, the session rebuilds its history from those saves.

When you're back at your machine, run `/skyhop-back` from the same repository, then quit that window and run the `claude --resume` command it prints. Stop using the cloud session once you do.

| What comes back | Where it goes |
| --- | --- |
| **The conversation** | Added to your original session, so `/resume` shows it with the cloud messages inside |
| **The code** | A new local `skyhop/back-...` branch, checked out for you. Your original branch doesn't change |

Skyhop won't overwrite anything to do this:

- **If you typed in the original session after the handoff, or it's still open,** the cloud conversation becomes a new session in `/resume`, and your original stays as it was.
- **If your files changed after the handoff,** the code waits on the branch and your files stay as they are.
- **Your original session is backed up** to `~/.skyhop/backups/` first.

The `skyhop-run` and `skyhop-sync` branches are deleted from your remote afterward.

A brief handoff is a separate session, so `/skyhop-back` tells you how to bring it down with `claude --teleport` instead.

## What doesn't carry over

In either mode, the cloud VM won't have:

- Gitignored files, and `.env`-style files
- Local services and databases
- MCP servers set up only on your machine
- Running processes
- Your local environment variables and credentials

## Safety guarantees

- **Your checkout stays exactly as it was.** Your branch, working tree and index are unchanged. Skyhop builds the snapshot with a temporary index and never switches branches.
- **Skyhop never force-pushes.** It only creates its own `skyhop`, `skyhop-run` and `skyhop-sync` branches.
- **Gitignored and `.env`-style files are left out.** This also covers keys, certificates and files like `.npmrc`, and the plan lists what was left out.
- **Secrets stop the handoff.** Skyhop scans everything your remote doesn't already have, including unpushed commits on every local branch, plus the brief and any transcript. If it finds a likely secret, nothing leaves your machine. The cloud session runs the same scan before saving code, and holds back that save if it finds one. The scanner matches known patterns, so it can miss things.
- **Your conversation is encrypted on GitHub.** It uses AES-256-GCM, and the key is never pushed. Your code is not encrypted, so a public repository means public `skyhop-run` and `skyhop-sync` code branches.
- **You confirm first.** Skyhop shows the branch, remote, changes and upload before anything leaves your machine, unless you pass `--yes`.
- **Private paths are removed from the brief.** The full-resume transcript can't be edited, so the confirmation warns you about it.
- **Skyhop never answers the trust prompt or changes your trust settings.** It relies on the trust a worktree shares with its repository.
- **A failed handoff tells you how to retry.** The brief is kept in `~/.skyhop/briefs/`.

Skyhop keeps its files in `~/.skyhop/`: briefs, a history of handoffs, the keys for handoffs in progress, session backups, and a temporary launch worktree. The worktree and its local branch are removed after the launch. If a handoff is waiting on you, they stay until your next handoff from that repository.

## Known limitations

- `/skyhop-status` lists links from this machine. It can't show live progress, so open the link for that.
- Brief handoff branches, and full-resume branches you never bring home, stay on your remote until you delete them.
- If the Claude GitHub App isn't installed on your repository, `--cloud` uploads it directly instead of cloning, and that session can't push. Full resume still works, but each reply warns that nothing is being saved for `/skyhop-back`.
- Sessions land in the app's **Cloud** list, not under their project folder. Starting the message with the project name gives Claude a hint for the title, but only sessions started inside the app get a folder.
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
