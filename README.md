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
/skyhop                      Move this session to the cloud, with its full history
/skyhop --summary            Start a new cloud session from a brief instead
/skyhop --dry-run            Show the plan and first message, and do nothing else
/skyhop --name login-fix     Choose the branch name
/skyhop --new-chat           Use a new cloud chat instead of this session's earlier one
/skyhop-back                 Bring the session home right away, from another window
/skyhop-back --dry-run       Show what would come back, and change nothing
/skyhop-status               List sessions in the cloud, past handoffs and leftover branches
/skyhop-status --clean       Remove leftover branches that hold nothing you'd lose
```

| Flag | What it does |
| --- | --- |
| `--name X` | Names the branch `skyhop/X-<timestamp>`. Defaults to your current branch name |
| `--dry-run` | Pushes nothing, starts nothing, and prints the plan and first prompt |
| `--yes` | Skips the confirmation |
| `--summary` | Starts a new cloud session from a brief instead of moving this one. Before version 0.3.0 this was the default, and `--full-resume` chose the other mode. `--full-resume` still works |
| `--mode M` | Sets the starting permission mode for full resume: `auto` (default), `acceptEdits` or `plan` |
| `--new-chat` | Full resume only. Starts a new cloud chat even if this session already has one |
| `--no-sync` | Full resume only. Pushes nothing to GitHub and uploads directly instead, so `/skyhop-back` has nothing to bring home |
| `--allow-secrets` | Continues even though the secret scan found something |

**Handoffs start by themselves** from any repository you've already trusted in Claude Code. Skyhop runs `--cloud` from a temporary git worktree, which shares your repository's trust, and removes the worktree afterward. If you haven't trusted the repository, Skyhop prints a command to run in your own terminal, and you choose **Yes, I trust this folder**.

## The two modes

| | Summary handoff (`/skyhop --summary`) | Full resume (`/skyhop`, the default) |
| --- | --- | --- |
| **Conversation** | A brief plus recent turns, written by Claude | The real session transcript, resumed inside the VM |
| **Chat experience** | A normal cloud session with live tool activity | Normal-looking replies, with a progress line about every 100 seconds instead of live tool activity |
| **Code travels by** | A `skyhop/...` branch pushed to your remote | A `skyhop-run/...` branch, with the transcript encrypted |
| **Permission mode** | Set in the chat | Set at handoff, and changed by sending a message |
| **Usage** | Normal | Each reply is generated twice |
| **Coming home** | `claude --teleport` brings a separate copy | Open the session with `/resume` and send a message |

### Summary handoff

Skyhop snapshots your work to a new branch and starts a cloud session on it. The first prompt holds a brief: your goal, current state, decisions, remaining work, gotchas, and the last several exchanges.

**The cloud session starts with that brief, not your exact history.** It's a new session that has been told what happened.

### Full resume

Skyhop pushes your code and the session's transcript to a `skyhop-run/...` branch, with the transcript encrypted. The key goes only in the first message of the cloud session, never through GitHub. A hook in the VM decrypts the transcript and starts a second Claude Code process with `--resume`, which loads the real conversation. That process does the work in the background. Meanwhile the chat Claude waits by running a short Skyhop command about every 100 seconds, then repeats the reply.

**Your session continues in the cloud, from a copy of its transcript.** The cloud chat you type into is a new chat that passes your messages to it, because Anthropic's cloud can't adopt a local session. That chat can't show your old messages, so its first message is a recap of where you left off, ending with your last 15 or so messages and Claude's replies, word for word from the session file (tool steps left out, home folders and likely secrets hidden). The session itself has the full history, and it comes back to your machine as the same session.

**To read the whole earlier conversation on your phone, turn on Remote Control before you hand off.** Run `/remote-control` in the session, or set **Enable Remote Control for all sessions** in `/config` once. Remote Control keeps every message of the session in its own entry on claude.ai, and the entry stays readable after you quit, under **Archived** in the Claude app. Skyhop finds that entry in the session file and puts its link at the top of the cloud chat's recap, so the full conversation is one tap away. The plan shows the link, or says how to get one, and `/skyhop` asks before going ahead without it. If Remote Control was off for your last messages, the recap says the entry may be missing them.

**Claude's memory notes for the project go along.** Claude Code keeps notes about each project on your machine (auto memory, `~/.claude/projects/<project>/memory/`). Cloud sessions run with auto memory off, so Skyhop sends the notes encrypted with the handoff, gives them to the cloud session with the instructions for keeping them, and brings back the notes it adds or changes. A note that also changed on your machine meanwhile keeps your machine's version, and the cloud's copy goes to `~/.skyhop/memory-aside/`. The notes get the same secret scan as everything else. If you turned auto memory off, nothing is sent. The limits are:

- **Progress instead of live tool activity.** While a message runs, the chat shows a `node .skyhop/relay.mjs wait` command about every 100 seconds, each with how long it has run and its latest steps. The reply then appears with a **Steps taken** list of what it did.
- **Replies are generated twice**, once by the resumed session and once by the chat Claude repeating them. The chat Claude runs on Haiku to keep this cheap, and it could change the wording slightly. Each wait is also a small Haiku call, so a long message uses a little more.
- **The mode picker in the chat has no effect.** Send `skyhop mode auto`, `skyhop mode acceptEdits` or `skyhop mode plan` as a message instead. It applies from the next message.
- **The resumed session can't ask you for approval.** If it needs a tool its mode doesn't allow, the reply says what was blocked and how to allow it.
- **One message can run for up to six hours.** A single 36-minute message has been tested through Skyhop. Before version 0.6.0, a message stopped at about 25 minutes, because the cloud stops a machine whose reply shows no activity for that long. The wait commands are that activity.
- **Send one message at a time.** A message sent while a reply is running isn't passed on, and the reply tells you to send it again.
- **To stop a long reply,** press stop in the chat, then send `skyhop stop`. The session's work so far is kept and saved.
- **To see what Skyhop did in the cloud,** send `skyhop log`. The chat shows the last 40 lines of the cloud machine's Skyhop log, without passing anything to the session.
- **If the chat stops waiting before the reply,** the session keeps going until the cloud shuts the idle machine down, a few minutes later. The machine keeps its files but not the running work. Your next message then shows the reply if it finished in time, or says the message stopped before it finished.
- **It depends on an internal file format.** The transcript format can change on any Claude Code release. If the VM can't load it, the session falls back to the brief and says so.
- **Long sessions use more of your plan on every message.**
- **The first message of the cloud session shows the decryption key.** It only opens this handoff's transcript, which Skyhop deletes from GitHub once the session is home. Don't share that session publicly before then.
- **With no remote, or with `--no-sync`,** Skyhop uploads the repository directly instead. That upload is capped at 100 MB after compression, may include your other local branches, and nothing comes back to your machine.

### Coming home

After each reply, a full-resume session pushes its code and the new messages to `skyhop-sync/...` branches, with the conversation encrypted. If the VM is cleared while it's idle, the session rebuilds its history from those saves.

Coming home takes no command, and it's always the same session:

1. **Quit the window you handed off from.** `/skyhop` reminds you.
2. **When you're back, open `claude` in the same repository.** Skyhop adds the cloud conversation to your session and says so. The cloud chat stays open, because opening Claude Code there doesn't mean you've finished on your phone.
3. **Type `/resume` and pick the session.** It's at the top, with the cloud messages inside.
4. **Send a message.** That brings the session home for good: the cloud chat closes, and the cloud's code arrives in your files.

To hand it off again later, run `/skyhop` in it again. The session keeps its ID through every round trip, and **it goes back to the same cloud chat**, so each session has one chat in the cloud too. Skyhop pushes the new handoff to that chat's branch and sends the chat a message, which switches it over to the new handoff. You'll see that message in the chat, with a recap, and the reply carries on from your latest work on the Mac.

- **If the chat was archived or deleted,** Skyhop starts a new one.
- **If the chat's cloud machine was shut down for being idle,** it has to start again first, which can take a few minutes. If the chat can't reconnect, it says so, and `/skyhop --new-chat` starts a new chat.
- **Chats started before version 0.5.0 can't switch over,** so the first handoff after updating starts a new chat, and later ones reuse it.

| What comes back | Where it goes |
| --- | --- |
| **The conversation** | Added to your original session, so `/resume` shows it with the cloud messages inside |
| **The code** | Into your files on your current branch, uncommitted, the way you left your own work. No new branch and no commits |
| **The cloud chat** | Closed. A message sent there gets a note that the session has gone home, and nothing is saved |

Skyhop won't overwrite anything or hide anything to do this:

- **A window opened too early is stopped.** A window reads a session only when it opens it. If a window opened the session before the cloud part arrived, or the cloud has newer messages, your first message there is stopped with a note to quit and pick the session in `/resume` again.
- **A reply still running in the cloud waits.** Skyhop doesn't bring a session home halfway through a reply. If a reply never finishes, sending your message again brings home everything saved before it.
- **If you typed in the session on this machine while the cloud kept going,** the cloud part becomes a separate session, and yours stays as it was.
- **If your files changed after the handoff,** the cloud's code waits on a new `skyhop/back-...` branch and your files stay as they are.
- **A session open in another window is left alone,** and Skyhop tells you to quit that window.
- **Your original session is backed up** to `~/.skyhop/backups/` before anything is added.

`/skyhop-back` does all of this at once from another window, if you'd rather not wait for a message. A summary handoff is a separate session, so `/skyhop-back` tells you how to bring it down with `claude --teleport` instead.

Handoffs, round trips and summary sessions can leave `skyhop` branches on your remote. `/skyhop-status` lists them and removes the ones that hold nothing you'd lose: Skyhop's encrypted copies from finished handoffs, and branches whose work is already on another branch. It never removes a branch with work that exists nowhere else.

## What doesn't carry over

In either mode, the cloud VM won't have:

- Gitignored files, and `.env`-style files
- Local services and databases
- MCP servers set up only on your machine
- Running processes
- Your local environment variables and credentials

## Safety guarantees

- **Handing off leaves your checkout exactly as it was.** Your branch, working tree and index are unchanged. Skyhop builds the snapshot with a temporary index and never switches branches.
- **Coming home only changes files that still match the handoff.** It never moves your branch, commits, or changes your index. If anything differs, the cloud's code goes on a branch instead.
- **Coming home only writes code your cloud session saved.** Each save seals a fingerprint of its code with the encrypted conversation. If the code branch on GitHub doesn't match, because someone else with push access changed it, the code goes on a branch and Skyhop tells you to check it.
- **Skyhop never force-pushes.** It only creates its own `skyhop`, `skyhop-run` and `skyhop-sync` branches.
- **Gitignored and `.env`-style files are left out.** This also covers keys, certificates and files like `.npmrc`, and the plan lists what was left out.
- **Secrets stop the handoff.** Skyhop scans everything your remote doesn't already have, including unpushed commits on every local branch, plus the brief, any transcript and the project's memory notes. If it finds a likely secret, nothing leaves your machine. The cloud session runs the same scan before saving code, and holds back that save if it finds one. The scanner matches known patterns, so it can miss things.
- **Your conversation and memory notes are encrypted on GitHub, and the brief isn't pushed at all.** They use AES-256-GCM, and the key is never pushed. The brief only travels in the cloud chat's first message. Your code is not encrypted, so a public repository means public `skyhop-run` and `skyhop-sync` code branches.
- **You confirm first.** Skyhop shows the branch, remote, changes and upload before anything leaves your machine, unless you pass `--yes`.
- **Private paths are removed from the brief.** The full-resume transcript can't be edited, so the confirmation warns you about it.
- **Skyhop never answers the trust prompt or changes your trust settings.** It relies on the trust a worktree shares with its repository.
- **The cloud chat can't be switched by a pasted message.** Handing off again to an earlier chat only works with that chat's key and the exact commit Skyhop pushed.
- **On the cloud machine, `.env`-style files are hidden from git, and the chat is told never to commit or push.** The cloud has its own hook that asks a chat to commit and push leftover changes. Skyhop saves the work itself, after its secret scan.
- **`~/.skyhop` is private to your account,** because it holds the keys for handoffs in progress, briefs and session copies.
- **Memory notes stay in their folder.** Only markdown notes directly in it go up or come back, never through a link, and only your own settings, not a repository's, can choose the folder.
- **A failed handoff tells you how to retry.** The brief is kept in `~/.skyhop/briefs/`.

Skyhop keeps its files in `~/.skyhop/`: briefs, a history of handoffs, the keys for handoffs in progress, session backups, logs, and a temporary launch worktree. The worktree and its local branch are removed after the launch. If a handoff is waiting on you, they stay until your next handoff from that repository.

## Reporting a problem

Skyhop logs what it does to `~/.skyhop/logs/`, so a bug report can show where something went wrong:

- **`skyhop.log`** covers this machine: each handoff step, the secret scan's result, the launch, and every message that brought a session home.
- **`cloud-<session>.log`** is the cloud machine's log for that session, as of its last save. It travels home encrypted with the conversation. In the cloud chat, `skyhop log` shows the same log live.

The logs hold steps, outcomes, errors and Skyhop's own messages, never your conversation, prompts, replies or keys. Home folders, credentials in URLs and known token formats are hidden too. Each log starts over past 512 KB and keeps one older file. Attach the `logs` folder to a bug report, along with what you did and the output of `claude --version`.

## Known limitations

- `/skyhop-status` lists links from this machine. It can't show live progress, so open the link for that.
- Summary handoff branches with work on them stay on your remote until you delete them. `/skyhop-status --clean` removes the rest.
- If the Claude GitHub App isn't installed on your repository, `--cloud` uploads it directly instead of cloning, and that session can't push. Full resume still works, but each reply warns that nothing is being saved for your machine.
- The desktop app groups cloud sessions by their GitHub repo, so a handoff from a repo you have open in the app appears under that project. A session uploaded directly has no repo link and appears under **Cloud**. That happens with `--no-sync`, with no remote, or when the Claude GitHub App isn't set up on the repo.
- If Skyhop can't take its commit out of git history in the VM, it warns you in the chat. Don't push that branch.
- Going back to a chat has been tested while its cloud machine was still running, two hours after the last message. Going back after the machine has been shut down for being idle is untested. Skyhop then relies on the new machine starting from the chat's branch.

## Development

```bash
npm test
claude plugin validate .
claude --plugin-dir .
```

The tests use a stand-in `claude` command and a local bare remote, so they never touch GitHub or the cloud.

## License

MIT
