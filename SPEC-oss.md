# Making `local-llm` publishable — phase 1.5 spec

Apply **after** the v1 core (SPEC.md) lands. The v1 build is allowed to be
shaped around one machine; this pass makes it correct for a stranger with a different
machine and a different set of models.

Target: publish as **`local-llm-skill`** — verified free on both npm and GitHub,
and consistent with the existing `codex-skill` / `kimi-skill` repos. (Bare
`local-llm` is taken on npm.) The repo ships the skill *and* the CLI that backs
it, mirroring how `quotamax` (npm) and `codex-skill` (skill repo) already ship.

Rename `~/dev/local-llm` → `~/dev/local-llm-skill` once the v1 build finishes —
**not while an agent is writing into it.**

## 1. Never hardcode the author's models  ← the big one

v1's `catalog.mjs` maps job classes to a literal list of the 23 models on this
Mac. On anyone else's machine every one of those lookups misses and the tool is
dead on arrival.

Replace with **capability-based selection over whatever `/api/v0/models` returns**:

```js
selectModel({ jobClass, endpoint, requireTools, budgetGb }) -> { model, why }
```

Score each *available* model and pick the best:

- **hard filters** — `type` matches the class need (`embeddings` for `embed`,
  `vlm` for `vision`); `capabilities` includes `tool_use` when `requireTools`;
  `sizeGb` admissible under the current budget.
- **size band per class** — `reflex` prefers the smallest viable, `heavy` the
  largest admissible, `workhorse` the largest under ~40 % of budget.
- **family hints** — a small pattern table (`/coder|code/` → coder,
  `/embed/` → embed, `/vl|vision/` → vision, `/instruct|chat/` → general) used
  only to *break ties*, never as a hard requirement.
- **quantization preference** — prefer 4–8 bit over bf16 for throughput; prefer
  MLX over GGUF when both exist *and the host is Apple Silicon*.

Ship `data/model-hints.json` (patterns → hints, no exact ids) so unknown and
future models degrade gracefully instead of failing. Let users override
everything with `~/.config/local-llm/classes.json`.

**Test on an empty catalog and on a catalog of models the code has never seen.**
Both must return a sensible pick or a clear "no model fits this class" — never a
crash and never a silent wrong answer.

## 2. Don't assume macOS or Apple Silicon

LM Studio also runs on Linux and Windows with discrete NVIDIA GPUs, where the
memory model is completely different (dedicated VRAM, not unified).

`ration.mjs` must resolve its ceiling per platform:

| host | ceiling |
|---|---|
| macOS (Apple Silicon) | `sysctl iogpu.wired_limit_mb`; `0` → 75 % of `os.totalmem()` |
| Linux / Windows + NVIDIA | total VRAM from `nvidia-smi --query-gpu=memory.total` |
| anything else / detection fails | `os.totalmem() × 0.6`, clearly labelled a fallback |

Always overridable: `~/.config/local-llm/config.json` `{ceilingGb, reserveGb}` or
`LOCAL_LLM_CEILING_GB` / `LOCAL_LLM_RESERVE_GB`. Print which source was used in
`local-llm budget` so a user on an unsupported host can see why the number is
what it is. Unit-test each branch with an injected platform probe.

Likewise the measured "4 slots ≈ 1.47×" finding is an *Apple unified-memory*
property — document it as such, don't bake it in as a universal constant.

## 3. `aiod` burst must be strictly optional

`aiod` (github.com/jhammant/AIonDemandCluster — public) is a separate Python
tool. Resolve it via `AIOD_BIN` → `PATH` only. **Never** reference a local dev
path like `~/dev/AIonDemandCluster` in shipped code.

If `aiod` is absent: the `burst` endpoint simply does not appear, `plan` shows
the local row only, and `burst` subcommands exit with a one-line install hint.
Same "a pool doesn't appear unless it's installed" convention quotamax already
uses. No import of it, no dependency on it, no failure because of it.

## 4. Repo hygiene for publication

- `LICENSE` — MIT, matching quotamax and claude-profiler.
- `README.md` — what it is, install, the batch quickstart, the memory-budget
  explanation, a worked example, the platform-support table, and a
  Privacy section stating: **reads your local files, sends prompts only to the
  endpoint you configure, makes no other network calls, never transmits
  credentials.** Anyone running a batch over private data needs that stated plainly.
- `package.json`: `name: "local-llm-skill"`, `bin: {"local-llm": "src/cli.mjs"}`,
  `files: ["src","data","SKILL.md","README.md","LICENSE"]`, MIT, repo URLs,
  `engines: {node: ">=18"}`, keywords (lm-studio, local-llm, batch, inference,
  mlx, gguf, claude-code, skill).
- `.gitignore` must cover `*.out.jsonl`, `reports/`, `throughput.json`,
  `node_modules`, and anything under `~/.config`-style local state.
- **Scrub before publish**: no absolute `/Users/<name>/…` paths, no API keys, no
  model ids private to this machine, no sample data drawn from real transcripts.
  Add a `npm run check:publishable` script that greps the tree for `/Users/` and
  fails the build if it hits anything outside docs.

## 5. Ship the skill in the same repo

Put the Claude Code skill at `skill/SKILL.md` (frontmatter `name: local-llm`) and
document one-line installation:

```bash
ln -s "$(npm root -g)/local-llm-cli/skill" ~/.claude/skills/local-llm
```

The skill must be **written to auto-detect** — it should tell Claude to run
`local-llm budget` / `local-llm models --fit` to discover the host's memory and
models, and must never state a specific machine's RAM or model list as fact.
That keeps it true on any machine, including this one as models change.

## 6. Keep the `security` class defensible in public

Keep the class — false refusals on authorized security work are a real problem
and this is a real fix. But for a public repo:

- Detect uncensored variants **by pattern** (`abliterated`, `uncensored`,
  `heretic`) among the user's own installed models. Do **not** ship a curated
  list of recommended abliterated models, and do not help acquire them.
- Explicit opt-in only (`--class security` / `--uncensored`); never auto-selected,
  never a fallback the router reaches on its own.
- README states plainly: intended for **systems you own or are authorised to
  test**, these models trade instruction-following and factual accuracy for the
  absence of refusals, and they are a remedy for false positives on legitimate
  work — not a route around judgement.

Keep it one honest subsection. It shouldn't be a headline feature of the project.
