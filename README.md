# local-llm

`local-llm` turns LM Studio into a memory-aware batch-inference worker. It can
select a model for a job, keep loaded models inside a safe unified-memory
budget, evict the least-recently-used unpinned model when necessary, and resume
long JSONL jobs after interruption.

It requires Node.js 18 or newer and has no runtime dependencies. LM Studio's
server should be running, and CLI-controlled endpoints need the `lms` binary.
The binary is resolved from `LMS_BIN`, `which lms`, or
`~/.lmstudio/bin/lms`, in that order.

## Install

From this directory:

```sh
npm link
local-llm --version
```

No package install step is otherwise required.

## Commands

```text
local-llm models [--fit] [--class <c>] [--json]
local-llm ps [--json]
local-llm budget [--json]
local-llm ask <prompt…> [--class c] [--model m] [--uncensored] [--json]
local-llm batch <items.jsonl> (--template f | --prompt s) [--out f]
    [--class c] [--model m] [--field name] [--system f]
    [--concurrency n] [--restart] [--dry-run] [--json]
local-llm load <model> [--dry-run] [--json]
local-llm unload <identifier | --all> [--json]
local-llm pin <model>
local-llm unpin <model>
local-llm pins
```

Every command accepts `--endpoint <id>` and `--json`. Without an endpoint
registry, the default is the local LM Studio server. Additional endpoints can
be registered in `~/.config/local-llm/endpoints.json`:

```json
{
  "default": "local",
  "endpoints": [
    {
      "id": "local",
      "label": "LM Studio (this Mac)",
      "baseUrl": "http://127.0.0.1:1234",
      "apiKey": null,
      "control": "cli",
      "capacityGb": null
    }
  ]
}
```

`control` can be `cli`, `jit`, or `none`. Only `cli` endpoints can be
explicitly loaded or evicted.

## Worked batch example

Create `reviews.jsonl`:

```jsonl
{"id":"review-001","title":"A practical keyboard","body":"Solid and quiet."}
{"id":"review-002","title":"A noisy mouse","body":"Good tracking, loud clicks."}
```

Create `classify.txt`:

```text
Classify this review as positive, mixed, or negative.
Title: {{title}}
Review: {{body}}
Return only the label.
```

Run it:

```sh
local-llm batch reviews.jsonl \
  --template classify.txt \
  --class workhorse \
  --out reviews.out.jsonl
```

The output is appended and flushed after every item:

```jsonl
{"i":0,"id":"review-001","ok":true,"response":"positive","usage":{"prompt_tokens":31,"completion_tokens":1,"total_tokens":32},"ms":412,"error":null}
```

If the process or machine stops, run the same command again. Existing ids in
`reviews.out.jsonl` are skipped. `--restart` intentionally discards that resume
state and starts a fresh output file. A failed request is retried twice (after
1 second and 4 seconds); a permanently failing item is recorded with
`"ok":false`, and the other items continue.

The loaded model's LM Studio `PARALLEL` value sets the default worker count,
with a fallback of 4. Use `--concurrency N` to override it. On `Ctrl-C`, no new
items are scheduled, active requests finish, and the command exits with status
130 after printing the exact output path to resume.

For a plain-text input file, wrap each line in a named template field:

```sh
local-llm batch notes.txt \
  --field text \
  --prompt 'Summarize: {{text}}' \
  --out notes.out.jsonl
```

Use `--system path/to/system.txt` for a system message. If the argument does
not name a file, it is treated as literal system text. Use `--dry-run` to
validate input and show the admission plan without loading, unloading, or
creating output.

## Memory budget and admission

The limiting resource is unified memory, not a token quota. `local-llm`
calculates:

```text
inference budget = GPU wired-memory ceiling - OS/app reserve
free budget      = inference budget - sizes of loaded models
```

The wired-memory ceiling comes from
`sysctl -n iogpu.wired_limit_mb`. A value of `0` means no explicit setting, so
the ceiling defaults to 75% of physical RAM. The reserve defaults to 12 GB.
Override it with `LOCAL_LLM_RESERVE_GB` or place the following in
`~/.config/local-llm/config.json`:

```json
{"reserveGb":16}
```

When a requested model does not fit, the tool evicts loaded models from the
least recently used upward until enough memory is free. State is kept in
`~/.local/state/local-llm/lru.json`. Models listed in
`~/.config/local-llm/pins.json` are never automatically evicted; manage that
list with `local-llm pin`, `unpin`, and `pins`. Explicit `unload` remains under
the operator's control.

A model larger than the entire inference budget is rejected before any
eviction. The error reports the `iogpu.wired_limit_mb` value required to admit
it. Inspect the calculation with `local-llm budget` and preview admission with
`local-llm load <model> --dry-run`.

## Model classes

The default batch class is `workhorse`. Other classes are `reflex`, `coder`,
`heavy`, `vision`, `embed`, and `security`. Each class has an ordered preference
list and can fall back to a smaller general-purpose class when its preferred
models are absent or inadmissible. Tool-requiring callers only select models
that advertise `tool_use`.

The `security` class contains abliterated or uncensored models and is never
auto-selected. It requires an explicit `--class security` or `--uncensored`.
These models trade instruction-following and factual accuracy for the absence
of refusals. They are a fallback for false refusals during authorized security
work, not a general-purpose model choice.

## Tests

```sh
npm test
```

Tests use injected clients and temporary state. They do not contact a network
endpoint or execute the real `lms` binary.
