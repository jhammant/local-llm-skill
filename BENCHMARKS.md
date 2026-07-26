# Measured benchmarks

Apple M5 Max, 128 GB unified memory, LM Studio 0.4.20+1.
Ceiling 96 GB, reserve 12 GB, **inference budget 84 GB**.

All figures measured, not estimated. Reproduce with `local-llm bench` and
`local-llm batch`.

## Throughput

| model | size | single | 4-way aggregate | speedup | load |
|---|---|---|---|---|---|
| `qwen3-coder-next` (80B-A3B, 4bit) | 44.9 GB | 59.0 tok/s | 86.8 tok/s | 1.47× | 19 s |
| `laguna-s-2.1` (118B MoE, Q4_K_M) | 68.3 GB | 57.5 tok/s | 67.7 tok/s | 1.18× | 28 s |
| `laguna-xs-2.1` (Q4_K_M) | 20.3 GB | — | — | — | 17 s |

**Concurrency scales sub-linearly** — 4 slots buy 1.2–1.5×, not 4×. Apple
unified memory is memory-bandwidth-bound, not compute-bound. Never estimate
aggregate throughput as single-stream rate × slot count; it overstates by ~3×.

## Quality: 88 hard classification items

The eval set is the 88 items (of 3,803) that defeated a naive single-word
prompt — a deliberately pessimistic set, not representative of general accuracy.

| config | in-set | completion tok/item | s/item | 88 items |
|---|---|---|---|---|
| `laguna-s-2.1` + thinking (default) | **88/88 (100%)** | 482 | 59.8 | 88 min |
| `laguna-s-2.1` + `reasoning_effort=none` | 79/88 (89.8%) | 2.5 | **0.61** | 54 s |
| `qwen3-coder-next` | 86/88 (97.7%) | 2 | 1.4 | ~2 min |

**The thinking is the capability.** Disabling it costs Laguna 10 points of
accuracy and drops it *below* qwen, while buying only ~2× speed over qwen.
There is no configuration where Laguna is both more accurate and faster.

**Routing conclusion:** `qwen3-coder-next` is the default for bulk
classification. `laguna-s-2.1` with thinking is for the hard tail where 100%
justifies 43× latency. The two models agreed on only 48% of these hard items.

## Reasoning-effort control (thinking models)

Measured on `laguna-s-2.1`, same prompt, answer `feature` in every passing case:

| method | tokens | time | result |
|---|---|---|---|
| default (thinking on) | 419 | 13.6 s | `feature` |
| `chat_template_kwargs: {enable_thinking: false}` | 512 | 14.6 s | **`''` — broken** |
| `/no_think` suffix in prompt | 3 | 0.5 s | `feature` |
| **`reasoning_effort: "none"`** | **2** | **0.1 s** | `feature` |
| `reasoning_effort: "low"` | 364 | 9.9 s | `feature` |

Use `reasoning_effort`. The intuitive `enable_thinking: false` silently returns
an **empty string** while still billing 512 tokens — a trap worth knowing.

`reasoning_effort: "low"` is barely a reduction (364 vs 419); the useful step is
`none`.

## Gotchas found the hard way

- **`lms load <ambiguous-prefix>` opens an interactive picker** and hangs
  forever in a non-interactive shell — 0% CPU, no output, no timeout.
  `laguna-s-2.1` prefix-matches `laguna-xs-2.1`. Prefer JIT loading via an API
  request, which is what this tool does.
- **`lms get <bare-repo-id>` exits 0 while doing nothing** if the id is not in
  LM Studio's own catalog; it lowercases the name and fails to resolve. Use the
  full HuggingFace URL. Always verify bytes landed rather than trusting the
  exit code.
- **MLX cannot run Laguna.** `mlx-lm` has no `laguna` architecture
  ([PR #1223](https://github.com/ml-explore/mlx-lm/pull/1223),
  [issue #1378](https://github.com/ml-explore/mlx-lm/issues/1378)), so every
  MLX build fails with `Model type laguna not supported` regardless of
  quantization. GGUF via llama.cpp works. Test architecture support with the
  smallest available sibling before downloading a large model.
