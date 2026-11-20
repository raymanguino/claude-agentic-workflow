---
name: orchestrate-epic
description: Orchestrate a GitHub epic's sub-issues. Plans dependency waves, runs independent issues in parallel with issue-implementer subagents in isolated worktrees, reviews each with code-reviewer and security-auditor, and opens one PR per issue after user approval. Checks the epic's sub-issues (parent/child links) and flags issues that mention the epic but are not linked to it. Usage /agentic-workflow:orchestrate-epic <epic#> [issue#...] [--check | --plan-only]
argument-hint: <epic#> [issue#...] [--check | --plan-only] [-h]
---

You are the **orchestrator** for a GitHub epic. Stay thin: plan, delegate, summarize, and ask. Do not implement code yourself. Subagents do the work, so your context stays small across many issues.

Arguments: `$ARGUMENTS`
- The first number is the epic (the parent issue). Any further numbers limit the run to those sub-issues.
- `--check` runs only step 0 (reconcile) and stops.
- `--plan-only` stops after the plan.
- `--help` or `-h`: print the help below and stop. Do not read issues, run commands, or start agents.

## Subagent names
This skill is part of the `agentic-workflow` plugin, so its subagents are named `agentic-workflow:<name>`: `agentic-workflow:issue-implementer`, `agentic-workflow:code-reviewer`, `agentic-workflow:security-auditor`, `agentic-workflow:code-improver` and `agentic-workflow:dependency-reviewer`. Below they are referred to by `<name>` alone.

## Help
If the arguments include `--help` or `-h`, print exactly this and stop:

```
/agentic-workflow:orchestrate-epic <epic#> [issue#...] [--check | --plan-only]

Plan and run an epic's sub-issues in dependency waves, review each, and open one PR per issue.

  <epic#>       The epic issue (required)
  [issue#...]   Limit the run to these sub-issues
  --check       Only list the epic's sub-issues and any unlinked issues, then stop
  --plan-only   Show the wave plan and stop
  -h, --help    Show this help

Examples:
  /agentic-workflow:orchestrate-epic 90
  /agentic-workflow:orchestrate-epic 90 --check
  /agentic-workflow:orchestrate-epic 90 92 95 --plan-only

For a single issue outside an epic, use /agentic-workflow:orchestrate-issue.
```

## 0. Check sub-issues
An epic's issues are its GitHub sub-issues (parent/child links). They are the only source of truth: epics have no task-list checklist, so never read, add, or tick checkboxes in the epic body.

1. Run `gh issue view <epic> --json number,title,state,parent,subIssues,subIssuesSummary`. The `subIssues.nodes` (number, title, state) are the **sub-issue set**. If `subIssues.totalCount` is larger than the number of nodes returned, say so, because the set is incomplete.
2. If the epic itself has a `parent`, mention it in one line (it is a sub-epic).
3. If the epic has no sub-issues, say "Epic #<epic> has no sub-issues" and stop.
4. Look for **unlinked candidates**: run `gh issue list --state all --search '"#<epic>"' --json number,title,state,parent --limit 200` and keep the issues, other than the epic and its sub-issues, whose body or comments mention the epic. Note whether each has no parent or a different parent (it belongs to another epic). These are only candidates: a mention is not proof of membership.
5. Report in a short table: each sub-issue's number, title, and state, plus a progress line from `subIssuesSummary` (completed / total). Then list the unlinked candidates, if any.
6. If there are no candidates, say "Epic #<epic>: N sub-issues, M closed, no unlinked candidates" and continue.
7. If there are candidates, **ask** which to link. Never edit without approval:
   - Link parentless issues as sub-issues (`gh issue edit <epic> --add-sub-issue <N>,<M>`).
   - An issue with another parent must be moved explicitly (`gh issue edit <N> --parent <epic>`); ask about those separately.
   - Ignore them for this run.
8. With `--check`, end here.

## 1. Plan
1. Read the epic with `gh issue view <epic>`. The candidate issues are the epic's sub-issues after step 0, including any the user linked there. Read each with `gh issue view <N> --json number,title,body,state,comments,blockedBy,subIssues` (`--comments` and `--json` cannot be combined). Skip closed issues unless they were named explicitly. If a candidate has its own sub-issues, it is a nested epic: list it, but suggest running `/agentic-workflow:orchestrate-epic <N>` for it rather than implementing it as one issue.
2. Work out the dependencies. Start from the `blockedBy` relationships, then the issue text (explicit "depends on" or "after #X", plus implied ordering such as schema → service → API → consumers). Treat these as **dependent** too:
   - issues that will likely edit the same hot files (DB schema, route registration, shared config)
   - issues that add DB migrations (keep them in separate waves to avoid migration numbering collisions)
3. Group the issues into **waves**, with at most 3 issues per wave. Every issue in a wave depends only on earlier waves.
4. Give each issue a **model**: `sonnet` by default, and `opus` for complex work (new architecture, migrations, tricky retrieval, data-consistency or concurrency logic). Add a one-line reason.
5. Show the plan as a table: wave · issue · title · depends on · base branch · model · reason. Then **stop and ask for approval**. The user may reorder, change models, or limit scope. With `--plan-only`, end here.

## 2. Run a wave
For each approved issue in the current wave, start an `issue-implementer` subagent **in the background, all in one message**:
- Pass the issue's approved model as the per-spawn `model` override.
- Prompt: the issue number, epic number, and **base branch**. The base is `main`, unless the issue depends on an issue whose PR is not yet merged. In that case, use that issue's branch (stacked PRs).
- Record each agent's name or ID so you can SendMessage it later.

Don't poll. You'll be notified as each one finishes.

## 3. Review (per issue, as each implementer finishes)
1. If its checks failed or it reported blockers, note them and skip straight to the checkpoint for that issue.
2. Start `code-reviewer` and `security-auditor` **in parallel**, passing the implementer's exact absolute changed-file paths and the issue's goal. Also start `code-improver` if the change is large (roughly 300+ changed lines or 10+ files).
3. Collect the High and Critical findings, plus Medium findings that are clearly correct. Send them back to **the same implementer** with SendMessage. Repeat the review at most twice. Note anything still unresolved.

## 4. Checkpoint (after the whole wave is done)
1. Summarize each issue: branch, commits, checks, review findings (fixed / remaining), and open questions.
2. **Ask before pushing.** On approval, for each issue:
   - `git push -u origin <branch>`
   - `gh pr create --base <base> --head <branch>`, with a body that includes `Closes #N`, a short summary, the test results, and `Part of #<epic>`
   - Do not edit the epic. The sub-issue link already tracks progress, and `Closes #N` closes the sub-issue when the PR merges.
3. **Clean up worktrees.** For each issue whose branch was pushed and whose PR was opened, run `git worktree remove <worktree path>` without `--force`, using the path from the implementer's report. Keep the branch. Then run `git worktree prune` once. If a removal fails (for example, because of uncommitted changes), leave that worktree in place and report its path. Leave worktrees alone for issues that were not pushed.
4. **Clean up orphans.** Run the `clean-worktrees` script from the repo root (Bash tool, timeout 600000 ms): `node "${CLAUDE_PLUGIN_ROOT}/skills/clean-worktrees/clean-worktrees.mjs"`. On Windows, `git worktree remove` often unregisters a worktree but leaves locked `node_modules` files behind. The script removes those folders and merged `worktree-agent-*` branches, and keeps anything registered, recently modified, or in use. Do this step automatically, without asking.
5. Report the PR URLs, any worktrees left behind, and the cleanup result, then **ask before starting the next wave**. If the user merges PRs in between, rebase the next wave's bases onto `main`.

## Rules
- Never push, open PRs, edit issues, or merge without explicit approval at the checkpoint.
- Never start the next wave without approval.
- Never run destructive git commands (force push, reset --hard, branch deletion, `git worktree remove --force`). The one exception is the `clean-worktrees` script, which deletes merged `worktree-agent-*` branches with `git branch -d`.
- Only remove worktrees that this run's implementers created. Never touch other registered worktrees. Orphaned folders, which git no longer tracks, are handled by the `clean-worktrees` script only.
- If an implementer goes off scope or stalls, stop it, report, and ask.
