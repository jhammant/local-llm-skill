# local-llm — build spec (v1 core)

A CLI that turns a local LM Studio install into a managed batch-inference worker.
The machine is an Apple M5 Max, 128 GB unified memory, with 23 models on disk
(3 GB → 100 GB each). Only ~96 GB is usable for inference, so **the scarce
resource is memory, not tokens** — the core of this tool is an admission
controller that stops us over-committing RAM.

## House style (match `~/dev/quotamax` exactly)

- Node ≥ 18, **ESM** (`"type": "module"`), **zero runtime dependencies**.
- Tests: `node --test`, run via `npm test`. Deterministic — never require a live
  LM Studio server; inject a fake client.
- Every command accepts `--json` for machine output.
- `bin: { "local-llm": "src/cli.mjs" }`, shebang `#!/usr/bin/env node`.
- Errors: fail fast with context. Never print secrets.

## Environment facts (verified — rely on these)

- LM Studio server: `http://127.0.0.1:1234`, already running.
- `GET /api/v0/models` → `{data:[{id, type, publisher, arch, compatibility_type,
  quantization, state:"loaded"|"not-loaded", max_context_length, capabilities:[]}]}`
  `type` is `llm` | `vlm` | `embeddings`. `capabilities` may contain `tool_use`.
- `POST /v1/chat/completions` — OpenAI-compatible (messages, tools, temperature,
  max_tokens, stream). Returns `choices[0].message` + `usage`.
- `POST /v1/embeddings` — OpenAI-compatible.
- CLI binary: `~/.lmstudio/bin/lms` (NOT on PATH — always resolve it, see below).
  - `lms ps` → table: IDENTIFIER, MODEL, STATUS, SIZE (e.g. `44.86 GB`), CONTEXT,
    PARALLEL, DEVICE, TTL.
  - `lms ls` → table incl. per-model SIZE on disk.
  - `lms load <model> --gpu max --context-length N --identifier <id>` (~19 s for 45 GB)
  - `lms unload <identifier>`
- A loaded model exposes `PARALLEL` slots (observed: 4) — concurrent requests to
  the *same* model are fine and are the main throughput lever.

## Module layout

```
src/endpoints.mjs   endpoint registry (the v2/remote seam)
src/lmstudio.mjs    HTTP client: listModels, chat, embed  (+ CLI: ps, load, unload)
src/ration.mjs      memory budget + admission control + eviction   <-- the heart
src/catalog.mjs     model metadata, job classes, model selection
src/batch.mjs       resumable batch runner                          <-- the point
src/ask.mjs         one-shot prompt
src/cli.mjs         arg parsing + command dispatch
test/*.test.mjs
```

### `endpoints.mjs` — plan for remote from day one

An endpoint is:

```js
{ id: 'local', label: 'LM Studio (this Mac)', baseUrl: 'http://127.0.0.1:1234',
  apiKey: null, control: 'cli', capacityGb: null }
```

`control` is `'cli'` (can load/unload via `lms`), `'jit'` (HTTP only — model loads
on first request, cannot evict), or `'none'`. Registry lives at
`~/.config/local-llm/endpoints.json`; if absent, synthesize the `local` default
above. Export `listEndpoints()`, `getEndpoint(id)`, `defaultEndpoint()`.

**Every other module takes an endpoint object as a parameter.** Nothing may
hardcode `127.0.0.1:1234` or shell out to `lms` outside `lmstudio.mjs`. This is
what makes v2 (remote hosts) a config change rather than a rewrite.

### `lmstudio.mjs`

- `resolveLms()` → `process.env.LMS_BIN || <first of: which lms, ~/.lmstudio/bin/lms>`.
  Throw a clear error if missing. **Never rely on a bare `lms` being on PATH.**
- `listModels(endpoint)` → normalized `[{id, type, arch, quantization, state,
  maxContext, capabilities, sizeGb}]`. `sizeGb` comes from `lms ls` when
  `control === 'cli'`, else `null`.
- `ps(endpoint)` → `[{identifier, model, status, sizeGb, context, parallel}]`
  by parsing `lms ps`. Parse defensively: whitespace-split columns, tolerate a
  missing TTL column, and return `[]` on the "No models are currently loaded"
  message.
- `load(endpoint, modelId, {contextLength, identifier, gpu='max'})`,
  `unload(endpoint, identifier)`.
- `chat(endpoint, {model, messages, tools, temperature, maxTokens, signal})` →
  `{message, usage, ms}`. On non-2xx, throw including the response body.
- `embed(endpoint, {model, input})`.
- Strip ANSI escapes from all `lms` output before parsing (it emits spinners).

### `ration.mjs` — the admission controller (most important module)

```js
budget(endpoint, opts) -> { totalGb, ceilingGb, reserveGb, budgetGb, usedGb, freeGb, loaded[] }
```

- `totalGb` = `os.totalmem()`.
- `ceilingGb` = macOS GPU wired limit: read `sysctl -n iogpu.wired_limit_mb`;
  **`0` means unset → default to `0.75 * totalGb`**. Non-zero → that value.
- `reserveGb` = headroom left for the OS/apps. Default **12**, overridable via
  `~/.config/local-llm/config.json` `{reserveGb}` or `LOCAL_LLM_RESERVE_GB`.
- `budgetGb = ceilingGb - reserveGb`; `usedGb` = sum of loaded model sizes.

```js
admit(endpoint, modelId, {pin, dryRun}) -> { ok, action, evicted[], reason }
```

Algorithm:
1. Already loaded → `{ok:true, action:'already-loaded'}`.
2. Model size unknown → `{ok:false, reason:'unknown size'}`.
3. Model size alone exceeds `budgetGb` → `{ok:false, action:'too-big', reason}`
   including the suggested remedy (`sudo sysctl iogpu.wired_limit_mb=<N>`).
   **This is a real case: `minimax-m2.7` is 100 GB vs a ~84 GB default budget.**
4. Fits in `freeGb` → load it.
5. Otherwise evict **least-recently-used, never-pinned** loaded models until it
   fits. If it still doesn't fit after evicting everything evictable → `{ok:false}`.

- LRU state: `~/.local/state/local-llm/lru.json`, `{identifier: lastUsedEpochMs}`,
  touched on every successful request.
- **Pinning**: `~/.config/local-llm/pins.json` — a list of model ids that must
  never be auto-evicted. `pin`/`unpin` commands manage it.
- Eviction is autonomous by default; pins are the only exception.
- `dryRun` must return the identical plan without mutating anything — the tests
  depend on this and `--dry-run` on the CLI exposes it.

### `catalog.mjs` — job classes

Map a job class to an ordered preference list of model ids; pick the first that
is present on disk AND admissible. Classes (fall back to the next class down if
none available):

| class | prefers | note |
|---|---|---|
| `reflex` | `google/gemma-3-4b`, `openai/gpt-oss-20b` | 3–12 GB, classify/tag/extract |
| `workhorse` | `qwen3.6-27b@4bit`, `qwen/qwen3.6-27b` | 16–18 GB, the batch default |
| `coder` | `qwen/qwen3-coder-next`, `qwen/qwen3-next-80b` | 45 GB, tool_use |
| `heavy` | `openai/gpt-oss-120b`, `minimax-m2.5` | 63–99 GB, hard reasoning |
| `vision` | `qwen/qwen3-vl-8b`, `google/gemma-3-4b` | `type: vlm` |
| `embed` | `text-embedding-nomic-embed-text-v1.5` | uses `/v1/embeddings` |
| `security` | `qwen3.6-35b-a3b-abliterated-heretic-mlx`, `qwen3.6-27b-abliterated-heretic-uncensored-mlx` | uncensored; **opt-in only** (see below) |

`selectModel({class, endpoint, requireTools})` → the chosen model + why.
`requireTools: true` filters to `capabilities.includes('tool_use')`.

**`security` is never auto-selected.** It is reachable only via an explicit
`--class security` / `--uncensored` flag. Document in the README that these
models trade instruction-following and factual accuracy for the absence of
refusals, so they are a fallback for false-refusals on authorized security work,
not a general-purpose choice.

### `batch.mjs` — THE PRIORITY. Build this most carefully.

```js
runBatch({endpoint, model, template, items, out, concurrency, onProgress, signal})
```

- **Input**: JSONL, one JSON object per line. A `--field <name>` option means
  plain-text lines are wrapped as `{[field]: line}` so text files work too.
- **Template**: a file (or `--prompt` string) containing `{{field}}` placeholders
  substituted from each item. Unknown placeholder → fail fast, naming the field
  and the line number. Support an optional `--system <file|string>`.
- **Output**: JSONL to `--out`, one record per item:
  `{i, id, ok, response, usage, ms, error}` where `id` is the item's `id` field
  if present else its 0-based index. **Write incrementally (append + flush per
  record)** so a crash or an overnight power-cut loses at most one item.
- **Resumable**: on start, if `--out` exists, read the ids/indices already
  present and skip them. `--restart` forces a fresh run. This is the single most
  important property — these runs are long.
- **Concurrency**: default = the loaded model's `PARALLEL` value (fall back 4),
  overridable with `--concurrency`. Implement a simple worker pool over the item
  list — do NOT `Promise.all` the whole file (a 10k-item file would open 10k
  sockets).
- **Retry**: on a failed request, retry up to 2× with exponential backoff
  (1 s, 4 s). After that record `{ok:false, error}` and keep going — one bad
  item must never kill an overnight run.
- **Progress**: call `onProgress({done, total, ok, failed, etaMs, tokensPerSec})`
  at most ~1×/sec. CLI renders a single updating line; `--json` suppresses it.
- **Graceful stop**: on SIGINT, stop scheduling new items, let in-flight ones
  finish, flush, and exit 130 with a resume hint naming the `--out` file.

### `ask.mjs`

One-shot: pick a model for the class (or `--model`), admit it via `ration`,
send one chat request, print the text. `--json` prints `{model, response, usage, ms}`.

## CLI surface

```
local-llm models [--fit] [--class <c>] [--json]   # on disk; --fit = admissible now
local-llm ps [--json]                             # loaded + memory budget
local-llm budget [--json]                         # the ration report
local-llm ask <prompt…> [--class c] [--model m] [--uncensored] [--json]
local-llm batch <items.jsonl> (--template f | --prompt s) [--out f]
        [--class c] [--model m] [--field name] [--system f]
        [--concurrency n] [--restart] [--dry-run] [--json]
local-llm load <model> [--dry-run]                # goes through admission control
local-llm unload <identifier|--all>
local-llm pin <model> / local-llm unpin <model> / local-llm pins
local-llm --version
```

`--endpoint <id>` is accepted globally (default `local`).

## Tests (`node --test`) — required

Inject a fake client; **no test may touch the network or the real `lms`**.

1. `ration`: fits-in-free → load, no eviction. Needs-eviction → evicts LRU first.
   Pinned model is never evicted. Model bigger than budget → `too-big` with the
   `sysctl` remedy in the reason. `iogpu.wired_limit_mb: 0` → ceiling is 75 % of RAM.
   `dryRun` mutates nothing.
2. `lms ps` parser: real sample output incl. ANSI spinner noise, the
   "No models are currently loaded" case, and a missing TTL column.
3. `batch`: template substitution incl. a missing-placeholder error; **resume
   skips already-present ids**; a failing item is recorded and the run continues;
   concurrency never exceeds the cap (assert with a counting fake).
4. `catalog`: class selection falls back when the preferred model is absent;
   `security` is never returned unless explicitly asked for.

## Deliverables

`package.json`, `src/*.mjs`, `test/*.test.mjs`, `README.md` (usage + a worked
batch example + the memory-budget explanation + the abliterated-model caveat),
`.gitignore` (node_modules, `*.out.jsonl`, `reports/`).

Run `npm test` and report the results. Do not commit.

## Out of scope for this build

The agentic file-editing runner, the HuggingFace update-checker, and the
quotamax/TokenMaxing provider integration are separate later phases — do not
build them, but do not architect anything that blocks them.
