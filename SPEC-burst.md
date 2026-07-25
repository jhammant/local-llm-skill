# local-llm ↔ aiod bridge ("burst") — phase 2 spec

Links `local-llm` (this repo) to **`~/dev/AIonDemandCluster` (`aiod`)**, which rents a
vast.ai GPU, serves the model with vLLM on an OpenAI-compatible `/v1` behind a bearer
token, and tears it down again.

The insight: **`aiod` produces exactly the endpoint shape `local-llm` already speaks.**
So bursting to a rented H100 is not a new code path — it is a third `control` mode on
the existing endpoint registry.

## The two pools have opposite constraints

| | local (this Mac) | burst (aiod / vast.ai) |
|---|---|---|
| cost | **free** | **real money, $/hr, billed until teardown** |
| ceiling | ~84 GB budget → ~45 GB models in practice | rent whatever fits (H100/B200) |
| speed | one box, ~4 parallel slots | fast, and scalable by renting bigger |
| latency to start | ~19 s model load | minutes (rent → boot → download weights) |
| risk | none | **forgetting to tear down burns money silently** |

That table is the whole product: *local is free but slow and capped; burst is fast and
uncapped but costs money.* `local-llm` should make choosing between them quantitative.

## Endpoint shape

```js
{ id: 'burst', label: 'aiod (vast.ai)', control: 'aiod',
  profile: 'qwen3-coder-30b',     // an aiod profile name
  model: null,                    // or an explicit HF id instead of a profile
  quant: 'fp8',
  maxPricePerHour: 3,             // hard ceiling — passed to aiod --max-price
  idleMinutes: 20,                // aiod --idle: auto-destroy when quiet
  ttlHours: 2,                    // hard backstop
  baseUrl: null, apiKey: null }   // discovered from `aiod status` after spin
```

`control: 'aiod'` means: not currently running, but provisionable. `lmstudio.mjs` is
untouched — add `src/aiod.mjs` implementing the same client interface, so `batch.mjs`
and `ask.mjs` need **zero** changes.

## `src/aiod.mjs`

Shell out to the `aiod` CLI (resolve it like `lms`: `AIOD_BIN` → `which aiod` →
`~/dev/AIonDemandCluster/.venv/bin/aiod`). Never reimplement vast.ai calls.

- `estimate(model, {quant})` → parse `aiod estimate` → `{vramGb, gpu, pricePerHour}`
- `status()` → parse `aiod status` → `{running, baseUrl, apiKey, model, costSoFar,
  ttlRemaining, idleRemaining}`; prefer `GET http://127.0.0.1:4000/aiod/status` when
  the proxy is up (structured, no parsing).
- `spin(opts)` → `aiod spin … --max-price N --idle M --ttl H -y`, then poll `status()`
  until it serves. **Guarded — see Safety.**
- `teardown()` → `aiod teardown`. Must be idempotent and safe to call twice.
- `chat()/embed()` → plain OpenAI `/v1` against `baseUrl` with the bearer token. This is
  the same code as `lmstudio.chat` — factor the shared OpenAI client into
  `src/openai-client.mjs` and have both call it.

## The feature that makes this worth building: `local-llm plan`

```
$ local-llm plan items.jsonl --template summarize.md

  4,812 items · ~1.4k prompt tokens each · ~300 completion

  local    qwen3.6-27b@4bit    ~38 tok/s × 4 slots   ~6h 20m    $0.00
  burst    Qwen3-Coder-30B fp8  ~340 tok/s × 8 slots  ~28m       ~$1.12  (1×H100 @ $2.40/hr)

  → local finishes before morning; burst saves 5h 50m for ~$1.12
```

Sizing inputs: a real measured tok/s from `local-llm bench` (local) and `aiod bench`
(burst), item count and a token estimate from sampling ~20 items through the template.
Cache measured rates in `~/.local/state/local-llm/throughput.json` keyed by model+endpoint
so the estimate sharpens with use. **Label every number an estimate** and show the basis
(measured vs. assumed default) — a fabricated-looking cost estimate is worse than none.

### Estimator maths — get this exactly right

Measure **items/sec end-to-end**, not tokens/sec-per-stream:

```
itemsPerSec = itemsCompleted / wallClockSeconds     // already includes concurrency
etaSeconds  = remainingItems / itemsPerSec          // do NOT divide by slots again
```

A draft of this double-divided by the slot count and under-estimated a 5,000-item run
as 0.2 h when the measured rate implied ~0.6 h. Add a regression test that asserts
`eta(5000 items, 8 done in 3.5 s) ≈ 2190 s`.

### Measured baseline (M5 Max, 2026-07-25) — seed values

| model | single stream | 4-way parallel | speedup |
|---|---|---|---|
| `qwen3-coder-next` (80B-A3B 4-bit, 45 GB) | 59.0 tok/s | 86.8 tok/s | **1.47×** |

**Concurrency scales sub-linearly on Apple unified memory** — it is memory-bandwidth-
bound, not compute-bound. 4 slots buy ~1.5×, not 4×. So: do not raise default
concurrency above the model's advertised `PARALLEL`, and have `plan` use the *measured
aggregate* rate rather than `singleRate × slots`, which would overstate local throughput
by ~2.7× and wrongly argue against bursting.

This is the same "make the cost visible" move as `quotamax runcost`, and it should reuse
that vocabulary.

## CLI additions

```
local-llm plan <items.jsonl> (--template f|--prompt s) [--json]
local-llm burst status                  # is anything billing right now?
local-llm burst up   [--profile p] [--max-price N] [--idle M] [--ttl H]
local-llm burst down                    # aiod teardown
local-llm batch … --endpoint burst      # run the batch on a rented box
local-llm batch … --overflow burst      # local if it fits the budget, else burst
```

## Safety — this spends real money

Non-negotiable, and stricter than the rest of the tool:

1. **Never spin a box without explicit per-invocation confirmation.** `burst up`,
   `--endpoint burst` and `--overflow burst` must each print the plan — GPU, $/hr,
   estimated runtime, estimated total, TTL — and require an interactive `y` or an
   explicit `--yes`. No config flag may make this permanent, and nothing in
   TokenMaxing's autonomous worker may ever trigger a spin. Auto-routing (which the
   user enabled for *local*) stops at the free pool.
2. **Always pass `--idle` and `--ttl`.** Refuse to spin without both set.
3. **Teardown is guaranteed, not best-effort.** Wrap every burst run in
   try/finally → `teardown()`. Also handle SIGINT/SIGTERM. Default
   `--teardown-after` = true for one-shot batch runs.
4. **A loud running-cost warning.** `local-llm ps`, `budget`, and `status` must show a
   prominent line whenever a burst box is live, with cost-so-far. Same line goes in the
   quotamax provider output later. Silence here is how money leaks.
5. `aiod`'s own docs note the endpoint sits on a public IP behind only a bearer token —
   so **never send local file contents or transcripts to a burst endpoint** unless the
   user explicitly opts in per run (`--allow-remote-data`). Batch items frequently *are*
   private data; local is the safe default and that asymmetry must be enforced in code,
   not just documented.

## Test requirements

Fakes only — **no test may call `aiod`, vast.ai, or spend anything.**

- `plan` maths: item count × token estimate ÷ measured rate; falls back to a labelled
  default rate when unmeasured.
- endpoint resolution: `control:'aiod'` + not running → spin is *proposed*, never
  executed without `--yes`.
- try/finally teardown fires on a thrown error mid-batch, and on SIGINT.
- `--overflow burst` picks local when the model is admissible locally.
- a burst endpoint refuses items when `--allow-remote-data` is absent.
