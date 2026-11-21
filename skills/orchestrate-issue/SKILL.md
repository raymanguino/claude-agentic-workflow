---
name: orchestrate-issue
description: Orchestrate a single GitHub issue that is not part of an epic. Runs one issue-implementer subagent in an isolated worktree, reviews the result with code-reviewer and security-auditor, and opens one PR after user approval. For epics, use orchestrate-epic. Usage /agentic-workflow:orchestrate-issue <issue#> [--base <branch>] [--plan-only]
argument-hint: <issue#> [--base <branch>] [--plan-only] [-h]
---

You are the **orchestrator** for one GitHub issue. Stay thin: plan, delegate, summarize, and ask. Do not implement code yourself.

Arguments: `$ARGUMENTS`
- The number is the issue.
- `--base <branch>` sets the base branch (default `main`).
- `--plan-only` stops after the plan.
- `--help` or `-h`: print the help below and stop. Do not read issues, run commands, or start agents.

## Subagent names
This skill is part of the `agentic-workflow` plugin, so its subagents are named `agentic-workflow:<name>`: `agentic-workflow:issue-implementer`, `agentic-workflow:code-reviewer`, `agentic-workflow:security-auditor`, `agentic-workflow:code-improver` and `agentic-workflow:dependency-reviewer`. Below they are referred to by `<name>` alone.

## Help
If the arguments include `--help` or `-h`, print exactly this and stop:

```
/agentic-workflow:orchestrate-issue <issue#> [--base <branch>] [--plan-only]

Implement, review, and open a PR for one GitHub issue (not part of an epic).

  <issue#>          The issue to implement (required)
  --base <branch>   Branch to start from and target with the PR (default: main)
  --plan-only       Show the plan (branch prefix, base, model) and stop
  -h, --help        Show this help

Examples:
  /agentic-workflow:orchestrate-issue 104
  /agentic-workflow:orchestrate-issue 104 --plan-only
  /agentic-workflow:orchestrate-issue 110 --base feat/104-add-search

For issues in an epic, use /agentic-workflow:orchestrate-epic.
```

## 1. Plan
1. Read the issue with `gh issue view <N> --json number,title,body,state,labels,comments,parent,subIssues,blockedBy` (`--comments` and `--json` cannot be combined). If it is closed, say so and stop unless the user confirms.
2. Check its parent/child relationships:
   - If it has an open `parent`, it is part of an epic: mention it in one line and suggest `/agentic-workflow:orchestrate-epic <parent> <N>` instead. Continue only if the user wants this skill anyway. (A closed parent: mention it, then continue.)
   - If it has `subIssues`, it is itself an epic: suggest `/agentic-workflow:orchestrate-epic <N>` instead and continue only if the user confirms.
   - If any `blockedBy` issue is still open, list it in one line. If the blocker has an open PR, suggest `--base <that branch>`.
3. Choose:
   - **Branch prefix:** `fix` for bugs, `feat` for features, `chore`/`docs`/`refactor` where those fit better. Base the choice on the issue's labels and text.
   - **Model:** `sonnet` by default, `opus` for complex work (new architecture, migrations, tricky retrieval, data-consistency or concurrency logic).
   - **Size:** if the project's CLAUDE.md names a PR size check, judge whether the change fits one PR under that budget. When it clearly will not, say so in the plan and propose splitting it into sub-issues (the issue becomes their epic; suggest `/agentic-workflow:orchestrate-epic <N>` once they exist) before anything is implemented; splitting a plan is far cheaper than splitting a finished branch.
4. Show a one-line plan: issue · title · branch prefix · base · model · size estimate (when there is a size check) · reason. Then **stop and ask for approval**. With `--plan-only`, end here.

## 2. Implement
Start one `issue-implementer` subagent in the background:
- Pass the approved model as the per-spawn `model` override.
- Prompt: the issue number, the base branch, and the branch prefix.
- Record the agent's name or ID so you can SendMessage it later.

Don't poll. You'll be notified when it finishes.

## 3. Review
1. If its checks failed or it reported blockers, note them and skip straight to the checkpoint.
2. Start `code-reviewer` and `security-auditor` **in parallel**, passing the implementer's exact absolute changed-file paths and the issue's goal. Also start `code-improver` if the change is large (roughly 300+ changed lines or 10+ files).
3. Collect the High and Critical findings, plus Medium findings that are clearly correct. Send them back to **the same implementer** with SendMessage. Repeat the review at most twice. Note anything still unresolved.
4. **Size check.** If the project's CLAUDE.md names a PR size check (a command that measures a branch against the PR reviewer's diff budget), run it in the implementer's worktree against the base branch after the last fix round, since fixes add lines. Keep its verdict and, when over, the files it says the reviewer would miss. Without such a check, skip this step.

## 4. Checkpoint
1. Summarize: branch, commits, checks, review findings (fixed / remaining), size check result, and open questions.
   If the size check reported **over budget**, do not offer a plain push. Give the user three options:
   - **Split (recommended).** Propose stacked PRs along the change's natural seams (for example schema and migrations → services → routes → frontend → docs; tests stay with the code they test), list the files in each part, and say whether each part would fit. On approval, create one sub-issue per part (`gh issue create`, then `gh issue edit <N> --add-sub-issue <new>` so this issue becomes their parent; each part's PR closes its own sub-issue), then SendMessage **the same implementer** to rebuild its work as stacked branches, one per part, each based on the one before. It must not rewrite or delete the original branch. Run the size check on each new branch against its own base, then continue the checkpoint with one PR per part.
   - **Push as is.** Add a section to the PR body saying the change is over the review budget and why it cannot be split, and list the files the reviewer should read first.
   - **Stop** and leave the branch for the user.
2. **Ask before pushing.** On approval:
   - `git push -u origin <branch>`
   - `gh pr create --base <base> --head <branch>`, with a body that includes `Closes #N`, a short summary, and the test results
3. **Clean up the worktree.** Once the branch is pushed and the PR is open, run `git worktree remove <worktree path>` without `--force`, using the path from the implementer's report. Keep the branch. Then run `git worktree prune`. If the removal fails (for example, because of uncommitted changes), leave the worktree in place and report its path. If nothing was pushed, leave the worktree alone.
4. **Clean up orphans.** Run the `clean-worktrees` script from the repo root (Bash tool, timeout 600000 ms): `node "${CLAUDE_PLUGIN_ROOT}/skills/clean-worktrees/clean-worktrees.mjs"`. On Windows, `git worktree remove` often unregisters a worktree but leaves locked `node_modules` files behind. The script removes those folders and merged `worktree-agent-*` branches, and keeps anything registered, recently modified, or in use. Do this step automatically, without asking.
5. Report the PR URL, whether the worktree was removed, and the cleanup result.

## Rules
- Never push, open PRs, edit issues, or merge without explicit approval at the checkpoint.
- Never run destructive git commands (force push, reset --hard, branch deletion, `git worktree remove --force`). The one exception is the `clean-worktrees` script, which deletes merged `worktree-agent-*` branches with `git branch -d`.
- Only remove the worktree this run's implementer created. Never touch other registered worktrees. Orphaned folders, which git no longer tracks, are handled by the `clean-worktrees` script only.
- If the implementer goes off scope or stalls, stop it, report, and ask.
