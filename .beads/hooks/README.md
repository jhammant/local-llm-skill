# Global git hooks

Hooks under this directory are wired in via `git config --global core.hooksPath`.
They run on every git operation in every repo on this dev machine.

## Install

One time, per dev machine:

```bash
git config --global core.hooksPath ~/.claude/scripts/git-hooks
```

Verify:

```bash
git config --global --get core.hooksPath
# → /home/simon/.claude/scripts/git-hooks
```

Test:

```bash
cd ~/Github/AgentArchaeologist  # any repo with .tool-output/
# stage a small change and commit; the hook should run
```

## Hooks

| Hook | Purpose | Spec |
|---|---|---|
| `pre-commit` | M9 build-output discipline: content-signature-gates `.tool-output/` (unstages unchanged blobs) and warns on selective staging of source without fresh tool output. Block-after-24h-of-AA-enrolment escalation built in. | [AA `docs/build-output-discipline.md`](https://git.bagofholding.co.uk/foolycooly/AgentArchaeologist/src/branch/main/docs/build-output-discipline.md) |

## Adding more hooks

Drop a new executable file named after the git event (`commit-msg`,
`prepare-commit-msg`, `pre-push`, etc.) into this directory and make it
executable. `core.hooksPath` will discover it automatically.

If you need multiple checks under a single hook, the cleanest pattern is
to make the hook a dispatcher:

```bash
# Example: pre-commit becomes a dispatcher
#!/usr/bin/env bash
set -euo pipefail
for h in $HOME/.claude/scripts/git-hooks/pre-commit.d/*.sh; do
  [[ -x "$h" ]] && "$h" || exit $?
done
```

Then individual checks live under `pre-commit.d/`. Not needed yet (single
pre-commit check today); upgrade pattern when a second check arrives.

## Sync with AA's canonical template

`pre-commit` here is a copy of
`docs/build-hooks/templates/pre-commit-tool-output.sh` in the
AgentArchaeologist repo. When the AA template changes, mirror it here
in the same PR cycle (or via a follow-up `chore(hook-sync):` commit).

The AA template is the canonical source because it's the spec
artifact; this copy is the operational install.

## Bypass

`git commit --no-verify` skips all hooks. This is appropriate for:

- Genuine emergencies where the hook is itself broken
- Initial bootstrap commits before tools exist in the repo
- Re-running a commit after fixing a hook bug

It is **not** appropriate as a daily workaround for "the hook is annoying
right now." If you're tempted to use `--no-verify` regularly, file a bead
to fix the underlying issue instead.
