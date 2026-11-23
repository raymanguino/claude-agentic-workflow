# Agentic Workflow for Claude Code

A Claude Code plugin that turns GitHub work into reviewed pull requests. You write the issues; subagents plan, implement and review them in isolated git worktrees; you approve every plan, push and merge.

I built it for my own platform, [six7swe](https://github.com/raymanguino/six7swe), where agents now write nearly all of the code. My time goes into writing issues, refining these prompts and reviewing diffs.

## What's in it

**Skills (orchestrators).** Each one stays thin: it plans, delegates, summarizes and asks. It never writes code itself, so its context stays small across many issues.

| Skill | What it does |
| --- | --- |
| `/agentic-workflow:orchestrate-epic <epic#>` | Plans an epic's sub-issues into dependency waves, runs each wave's issues in parallel, reviews every change, and opens one PR per issue |
| `/agentic-workflow:orchestrate-issue <issue#>` | The same flow for a single issue outside an epic |
| `/agentic-workflow:orchestrate-prs --dependabot` | Triages a batch of dependency-update PRs, deep-reviews majors and CI failures, then merges, fixes, defers, ignores or closes each one |
| `/agentic-workflow:clean-worktrees` | Removes orphaned agent worktree folders and merged `worktree-agent-*` branches, with safety checks in a script |

Every skill takes `-h` for its options.

**Subagents.** Each has its own model and an explicit tool allowlist.

| Agent | Model | Tools | Role |
| --- | --- | --- | --- |
| `issue-implementer` | Sonnet (Opus for complex work) | All, inside its own worktree | Implements one issue: branch, code, tests, lint/test/build, commit. Never pushes or opens PRs |
| `code-reviewer` | Sonnet | Read, Grep, Glob | Read-only correctness review, using the built-in `code-review` skill's method |
| `security-auditor` | Sonnet | Read, Grep, Glob | Read-only security audit, using the built-in `security-review` skill's method |
| `code-improver` | Haiku | Read, Grep, Glob | Read-only quality pass, run on large changes |
| `dependency-reviewer` | Sonnet | Read-only shell, web | Researches one dependency upgrade: why it's pinned, the upstream changelog, which call sites break, and why CI failed |

## How an epic becomes pull requests

1. **Plan.** The orchestrator reads the epic's GitHub sub-issues and their `blockedBy` links, flags issues that mention the epic but aren't linked to it, and infers the remaining order (schema, then service, then API, then consumers; migrations in separate waves). It groups issues into waves of at most three and picks a model for each with a one-line reason. **It stops for your approval.**
2. **Implement.** The approved issues in a wave run in parallel, each `issue-implementer` in its own git worktree. An issue that depends on unmerged work stacks on its parent's branch.
3. **Review.** As each implementer finishes, `code-reviewer` and `security-auditor` run in parallel on its exact changed files (`code-improver` too, for large changes). High and critical findings go back to the same implementer, at most twice; anything unresolved is reported to you.
4. **Checkpoint.** The orchestrator summarizes branches, checks and remaining findings, then **asks before pushing**. On approval it opens one PR per issue with `Closes #N`, and cleans up the worktrees.
5. **Merge.** You review and merge each PR. The next wave starts only when you approve it.

## Guardrails

- **Human approval at the points that are hard to undo:** the plan, each push and PR, and each next wave. The orchestrators never merge their own work, force-push, reset or delete branches. The one exception is the cleanup script, which deletes only merged `worktree-agent-*` branches with `git branch -d`.
- **Least privilege per agent:** reviewers can only read; the implementer edits and runs checks only inside its own worktree, and never pushes.
- **Bounded loops:** at most three issues per wave and two review-fix rounds. An agent that goes off scope or stalls is stopped and reported, not retried.
- **PRs sized for review (opt-in):** if a project's CLAUDE.md names a PR size check (a command that measures a branch against the PR reviewer's diff budget), the orchestrators plan splits for issues that will not fit, run the check before each push, and offer to split an over-budget branch into stacked PRs instead of pushing it whole.
- **Untrusted input stays data:** PR bodies, release notes and CI logs are never followed as instructions.

A setup that works well with this: run the orchestration as a separate bot GitHub account, so the bot opens PRs and you approve them from your own account. That satisfies a one-approval branch rule without approving your own work, and a bot token without `workflow` scope means an agent can't change your CI.

## Install

```sh
/plugin marketplace add raymanguino/claude-agentic-workflow
/plugin install agentic-workflow@raymanguino
```

Requirements:

- [GitHub CLI](https://cli.github.com/) (`gh`), signed in, with access to the repository. The skills read issues, sub-issues and PRs through it.
- Node.js, for the worktree cleanup script.
- A `CLAUDE.md` in your repository that names your conventions and your lint, test and build commands. The implementer follows it rather than assuming a stack.

`dependency-reviewer` and `/agentic-workflow:orchestrate-prs` are written for JavaScript and TypeScript projects (npm, pnpm or yarn) using Dependabot or Renovate.

## Notes

- The worktree cleanup exists because on Windows `git worktree remove` can unregister a worktree but leave locked `node_modules` files behind. The script never touches a registered worktree, a folder modified in the last 15 minutes, or a folder a running process references. Run it with `--dry-run` first to see what it would remove.
- When something an agent produces looks wrong, fix the issue description, the skill or your `CLAUDE.md` rather than the code. A fix to the spec corrects every later run.
