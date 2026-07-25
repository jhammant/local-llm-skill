---
name: local-llm
description: >-
  Run work on local LM Studio models instead of burning metered/subscription quota — a pool
  that is free but memory-bound. Use above all for BATCH jobs (classify, summarize, extract,
  score, embed hundreds or thousands of items, especially overnight), for one-shot asks a
  smaller model handles fine, for agentic coding on a local model, for security work where
  an aligned model false-refuses authorized testing, and for bursting a too-large batch onto
  a rented GPU. Triggers: "run this locally", "use the local model", "batch these", "crunch
  these overnight", "don't burn quota on this", "local llm", "lm studio", "rent a GPU for this".
---

# /local-llm — run work on local (and rented) models

Drives a local **LM Studio** install through the `local-llm` CLI. This pool has **no
quota and no per-token cost** — the scarce resources are **memory** and **throughput**.

**Never assume what hardware or models are available — ask the tool.** Machines and
model libraries differ, and the user's changes over time:

```bash
local-llm budget          # memory ceiling, reserve, used, free, and what's loaded
local-llm models --fit    # models on disk, and which can actually load right now
```

Run these before planning any sizeable job, and base your recommendation on what they
return, not on what was true last time.

> LM Studio's CLI (`lms`) is often **not on PATH** in an agent tool shell. The
> `local-llm` CLI resolves it internally; if you must call it directly, use
> `command -v lms || echo "$HOME/.lmstudio/bin/lms"`.

## When to use this vs. a frontier model

| Reach for | When |
|---|---|
| **`local-llm batch`** | many similar items, mechanical judgement, no conversation context. **The primary use.** |
| **`local-llm ask`** | a quick one-shot a mid-size local model handles fine |
| **`local-llm agent`** | self-contained coding on a repo you can branch |
| a frontier coding agent | a genuinely *hard* self-contained task — much stronger than local models |
| stay in this conversation | anything needing this conversation's context, taste, or cross-repo orchestration |

Rule of thumb: **local is for volume and the cheap tail, not the hard middle.** A local
27B is a poor substitute for a frontier model on one difficult task, and an excellent
substitute for running one easy prompt four thousand times.

## 1. Batch — the main event

```bash
local-llm plan  items.jsonl --template t.md                    # estimate FIRST
local-llm batch items.jsonl --template t.md --out results.jsonl --class workhorse
```

- **Input** JSONL, one object per line; `--field text` wraps plain-text lines.
- **Template** uses `{{field}}` placeholders; a missing field fails fast with the line number.
- **Output** JSONL written incrementally — `{i, id, ok, response, usage, ms, error}`.
- **Resumable** — re-running the same `--out` skips completed ids, so an overnight run
  survives a crash, a sleep, or a power cut. `--restart` forces a clean run.
- **Concurrency** defaults to the model's advertised parallel slots. A single bad item is
  recorded and skipped; it never kills the run.

**Always run `plan` first and show the user the estimate** before starting a long job.

Choose `--class` by how hard the *per-item* judgement is — `reflex` for classify/tag/extract,
`workhorse` for summarize/score, `heavy` only when genuinely needed. On thousands of items,
an oversized model costs hours for no gain. The tool picks a concrete model for the class
from what's installed and reports which and why.

## 2. Memory is what actually breaks

Models range from ~3 GB to ~100 GB; the budget is finite and shared with the OS. `local-llm`
runs every load through admission control: it will evict least-recently-used models to make
room, refuse a model larger than the whole budget, and tell you the remedy.

```bash
local-llm pin <model>     # protect a model you're actively using elsewhere
```

**Before a long batch, run `local-llm budget` and tell the user what will be evicted.**
If a model is too large for the budget the tool reports the exact fix rather than failing
obscurely.

## 3. Agentic coding on a local model

Many local models support tool calling (`local-llm models` shows which). Quality varies a
lot — probe before trusting a new one for multi-step work.

**There is no sandbox. Branch first, always.**

```bash
git -C "<dir>" switch -c "local/<slug>"
local-llm agent -C "<dir>" --class coder "<self-contained task + acceptance criteria>"
```

Then **verify it yourself**: `git diff`, run the tests, and judge the real deliverable
against the task's intent. Green tests are necessary, not sufficient — a change can pass
its own tests and still be wrong. Cap at 2 fix passes, then stop and report. Never
auto-commit; show the diff and let the user decide.

## 4. Security work — uncensored models, on request only

Aligned models routinely **false-refuse benign authorized work** — analysing a payload
from your own scan, writing a PoC against a repo you own. If the user has uncensored
variants installed, `--class security` / `--uncensored` routes to them.

- **Explicit request only** — never auto-selected, never a fallback the router reaches on
  its own. These models trade instruction-following and factual accuracy for the absence
  of refusals, so they're a remedy for a false refusal, not a default.
- Scope is unchanged: **systems the user owns or is authorised to test.** This removes a
  false-positive tax on legitimate work; it is not a route around judgement.

## 5. Burst to a rented GPU — spends real money

If [`aiod`](https://github.com/jhammant/AIonDemandCluster) is installed, it rents a GPU
serving an OpenAI-compatible endpoint, which `local-llm` treats as just another endpoint.
Optional — if `aiod` isn't present, burst simply doesn't appear.

```bash
local-llm plan items.jsonl --template t.md   # compares local (free, slow) vs burst ($, fast)
local-llm burst status                        # IS ANYTHING BILLING RIGHT NOW?
local-llm batch … --endpoint burst --yes
```

**Hard rules:**
- **Never start a rented box without showing $/hr and estimated total and getting an
  explicit yes — every time.** Not configurable, and no autonomous process may trigger it.
- Always set an idle timeout and a TTL; teardown runs in a `finally` and on SIGINT.
- **Billing continues until teardown.** If anything is live, say so loudly and unprompted.
- The endpoint is a public IP behind a single bearer token, so batch items — which are
  often private — don't go remote without `--allow-remote-data` per run. Local is the
  default for the user's data.

## 6. Report what it cost

Local runs are free in money but not in *time*: report wall-clock and items/sec so the
user can judge whether it was worth doing locally. For burst runs, report actual spend.

## Why this pattern

Subscription pools are **quota**-bound and expire on a cycle. Local is **memory**-bound and
never expires. Rented GPUs are **money**-bound and effectively uncapped. Routing each job to
whichever constraint is loosest is the whole point — and high-volume batch work should
almost always land on the free pool.
