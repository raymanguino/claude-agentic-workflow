---
name: clean-worktrees
description: Remove orphaned folders under ~/.claude/worktrees (left behind when `git worktree remove` unregisters a worktree but cannot delete locked files on Windows) and merged worktree-agent-* branches. Never touches a registered worktree, a folder modified in the last 15 minutes, or a folder a running process references. Usage /agentic-workflow:clean-worktrees [--dry-run]
argument-hint: [--dry-run] [-h]
---

Clean up orphaned agent worktrees. All safety checks live in the script; do not reimplement them or delete anything by hand.

Arguments: `$ARGUMENTS`
- `--dry-run`: report what would be removed without removing it.
- `--help` or `-h`: print the help below and stop.

## Help
If the arguments include `--help` or `-h`, print exactly this and stop:

```
/agentic-workflow:clean-worktrees [--dry-run]

Remove orphaned folders in ~/.claude/worktrees and merged worktree-agent-* branches.

  --dry-run    Show what would be removed, remove nothing
  -h, --help   Show this help

Safe by construction: registered worktrees, folders modified in the last 15 minutes,
and folders referenced by a running process are always kept.
```

## Run
1. From the current repository, run with the Bash tool (it can take a minute or two for large `node_modules` trees):
   ```sh
   node "${CLAUDE_PLUGIN_ROOT}/skills/clean-worktrees/clean-worktrees.mjs" [--dry-run]
   ```
   Pass `--dry-run` through only if the user gave it. Use a timeout of 600000 ms.
2. Report the result in a few lines: folders removed, folders kept and why, branches deleted, and anything that failed. Exit code 1 means some folder could not be fully removed (usually a locked file); say so and suggest rerunning later.
3. Do not delete anything the script kept, and do not retry with other tools.
