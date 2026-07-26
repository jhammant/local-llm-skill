# Multi-backend support — LM Studio, Ollama, and any OpenAI-compatible server

Today `lmstudio.mjs` is the only client and every module imports it directly.
That hardcodes one backend into a tool whose entire premise — "run work on the
local pool" — is backend-agnostic. This spec generalises it without changing
behaviour for existing users.

## The capability problem (read this first)

The three backends do NOT offer the same surface:

| capability | LM Studio | Ollama | generic OpenAI-compatible |
|---|---|---|---|
| list models | `GET /api/v0/models` | `GET /api/tags` | `GET /v1/models` |
| **model sizes** | via `lms ls` | **in `/api/tags`** (`size` bytes) | **unavailable** |
| **loaded state** | `lms ps` | **`GET /api/ps`** | **unavailable** |
| explicit load | `lms load` | JIT on request | JIT, if at all |
| explicit unload | `lms unload` | `keep_alive: 0` in a request | **unavailable** |
| chat | `/v1/chat/completions` | `/v1/chat/completions` | `/v1/chat/completions` |
| embeddings | `/v1/embeddings` | `/v1/embeddings` | varies |

**Admission control is only possible where sizes AND loaded-state are both
available.** A generic OpenAI endpoint (vLLM, llama.cpp server, LiteLLM, a
remote host) can serve requests but cannot be memory-managed. `ration` must
report that honestly and step aside — never crash, and never invent a number.

## Layout

```
src/providers/
  index.mjs      resolve(endpoint) -> provider; capability queries
  lmstudio.mjs   moved from src/lmstudio.mjs, unchanged behaviour
  ollama.mjs     new
  openai.mjs     new — the lowest common denominator
  http.mjs       shared OpenAI-compatible chat/embed used by all three
```

Keep `src/lmstudio.mjs` as a thin re-export for one release so nothing breaks.

## The provider interface

Every provider exports the same shape:

```js
export const kind = 'ollama';
export const capabilities = Object.freeze({
  sizes: true,      // listModels returns sizeGb
  loadedState: true,// ps() works
  load: true,       // explicit load
  unload: true,     // explicit unload
  embed: true,
});

export async function listModels(endpoint) {}  // -> [{id,type,quantization,sizeGb,state,maxContext,capabilities}]
export async function ps(endpoint) {}          // -> [{identifier,model,sizeGb,context,parallel}]
export async function load(endpoint, modelId, opts) {}
export async function unload(endpoint, identifier) {}
export async function chat(endpoint, req) {}   // -> {message, usage, ms}
export async function embed(endpoint, req) {}
```

**Nothing outside `src/providers/` may know which backend it is talking to.**
No `if (endpoint.kind === 'ollama')` anywhere else. That is the whole point.

`index.mjs` exports `resolve(endpoint)` returning the provider module, and
`can(endpoint, 'load')` for capability checks.

## Endpoint registry changes

`endpoints.json` entries gain `kind`:

```json
{ "id": "ollama", "kind": "ollama", "label": "Ollama (this Mac)",
  "baseUrl": "http://127.0.0.1:11434" }
```

- **Back-compat is mandatory**: an entry with no `kind` defaults to `lmstudio`,
  so existing configs keep working untouched. Add a test for this.
- **Auto-detection** when no config file exists: probe `127.0.0.1:1234`
  (LM Studio) and `127.0.0.1:11434` (Ollama) in parallel with a short timeout,
  and register whichever answer. Both may be registered simultaneously.
- `kind: "openai"` takes `baseUrl` and optional `apiKey` (read from an env var
  name, never stored inline) — this covers vLLM, llama.cpp server, LiteLLM and
  remote hosts, and is what makes the tool useful beyond one machine.

## Ollama specifics

- `GET /api/tags` → `models[].{name, size (bytes), details.{family, quantization_level, parameter_size}}`.
  Map `size / 1e9` to `sizeGb`, `name` to `id`.
- `GET /api/ps` → currently-loaded models with `size` and `expires_at`. Empty
  `{"models":[]}` means nothing resident — the same "no models loaded" case
  LM Studio reports differently.
- **Load**: Ollama has no explicit load verb. Issue a chat request with an empty
  or minimal prompt and `keep_alive` set, which resident-loads the model.
- **Unload**: send a request for that model with `"keep_alive": 0`. There is no
  unload endpoint; this is the documented mechanism.
- Detect embedding models by family (`nomic-bert`, `bert`) or a `/api/show`
  lookup; `type` is not reported directly the way LM Studio reports it.
- Ollama's `/v1/chat/completions` is OpenAI-compatible, so `http.mjs` is reused
  as-is — including `reasoning_effort` passthrough.

## `ration` must degrade, not crash

```js
budget(endpoint) -> { managed: boolean, ... }
```

- `managed: false` when `!capabilities.sizes || !capabilities.loadedState`.
  Then `totalGb`/`ceilingGb` may still be reported (they describe the host), but
  `usedGb`/`freeGb` are `null`, and the CLI prints
  `memory: unmanaged (this backend does not report model sizes)`.
- `admit()` on an unmanaged endpoint returns
  `{ ok: true, action: 'unmanaged', reason: 'backend does not report sizes' }` —
  it must **not** block the run and must **not** pretend to have evicted anything.
- `pin`/`unpin` on an unmanaged endpoint fail with a clear message rather than
  silently doing nothing.
- Every existing admission test must still pass unchanged.

## `catalog` selection with partial information

`selectModel` currently scores on size. Where `sizeGb` is `null` for every
candidate:

- skip the size band and the admission filter entirely,
- fall back to family/quantization hints and declared capabilities,
- state in `why` that selection was made **without size information**.

Never treat a missing size as zero — that would make an unknown model look like
the smallest and win every `reflex` selection.

## CLI

- `--endpoint <id>` already exists and keeps working.
- `local-llm endpoints` — new: list configured endpoints with kind, reachability
  and declared capabilities. This is how a user diagnoses "why can't it evict?".
- `local-llm models`/`ps`/`budget` gain an endpoint column or header so output is
  unambiguous when several backends are registered.

## Tests

Fakes only, no network.

1. **back-compat**: an endpoint with no `kind` resolves to the lmstudio provider.
2. **ollama parsing**: `/api/tags` maps to sizes correctly; `{"models":[]}` from
   `/api/ps` yields an empty loaded list, not an error.
3. **ollama unload** issues `keep_alive: 0` rather than calling a nonexistent
   unload endpoint.
4. **unmanaged degradation**: a provider declaring `sizes:false, loadedState:false`
   produces `budget().managed === false` with null `usedGb`, and `admit()`
   returns `action:'unmanaged'` with `ok:true`. Assert nothing throws.
5. **catalog without sizes** still returns a model and says so in `why`; a null
   size never sorts as smallest.
6. **auto-detection** registers both backends when both probes succeed, and
   neither when both fail (without throwing).
7. every existing test passes unchanged.
