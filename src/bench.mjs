// Throughput benchmark: measures a model's real rates on an endpoint and
// caches them in ~/.local/state/local-llm/throughput.json for `plan` to use.
//
// Measures single-stream tok/s and the concurrent AGGREGATE tok/s separately.
// Concurrency scales sub-linearly on Apple unified memory (it is memory-
// bandwidth-bound, not compute-bound), so the aggregate is measured directly —
// never estimated as singleRate × slots, which overstates it badly.
//
// Short samples are noise: a single 128-token generation is dominated by
// startup latency and prompt processing, and once produced a 4-way aggregate
// BELOW the single-stream rate — physically impossible for a batching server.
// So: warm up first (the first call after load pays one-off costs), generate
// at least 256 tokens against a prompt that reliably produces a long answer,
// and average the single-stream figure over several runs. If the aggregate
// still comes out below the single-stream rate the sample was too noisy —
// retry once with double the token budget, and if it still inverts, record
// the figures flagged UNRELIABLE rather than silently caching an impossible
// measurement.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { resolve } from './providers/index.mjs';
import { admit } from './ration.mjs';
import { throughputKey, throughputPath } from './plan.mjs';

const BENCH_PROMPT = 'Write a detailed essay of at least 300 words explaining how a hash map resolves collisions, covering both chaining and open addressing with worked examples.';
const BENCH_MAX_TOKENS = 256;
// Prefill probe: a deliberately long prompt with a tiny token budget, so the
// wall time is almost entirely prompt processing. Prompt and completion rates
// differ wildly (prefill is compute-bound, decode memory-bandwidth-bound, often
// 10-30x slower per token), so they are measured and recorded separately —
// billing prompt tokens at the decode rate made plan over-estimate a real
// 3,803-item job by 3x.
const PREFILL_PROMPT = `${BENCH_PROMPT} `.repeat(40).trim();
const PREFILL_MAX_TOKENS = 8;
const DEFAULT_RUNS = 3;
const DEFAULT_CONCURRENCY = 4;
export const UNRELIABLE_WARNING = 'unreliable (aggregate below single-stream)';

function completionTokens(usage) {
  const value = usage?.completion_tokens ?? usage?.output_tokens ?? 0;
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function promptTokens(usage) {
  const value = usage?.prompt_tokens ?? usage?.input_tokens ?? 0;
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

async function resolveConcurrency(endpoint, model, client) {
  if (typeof client.ps !== 'function' || client.capabilities?.loadedState === false) {
    return DEFAULT_CONCURRENCY;
  }
  const loaded = await client.ps(endpoint);
  const match = loaded.find((entry) => entry.model === model || entry.identifier === model);
  const parallel = Number(match?.parallel);
  return Number.isInteger(parallel) && parallel > 0 ? parallel : DEFAULT_CONCURRENCY;
}

export async function runBench({
  endpoint,
  model,
  client = null,
  admitFn = admit,
  admissionOptions = {},
  concurrency,
  prompt = BENCH_PROMPT,
  maxTokens = BENCH_MAX_TOKENS,
  runs = DEFAULT_RUNS,
  nowFn = () => Date.now(),
  allowRemoteData = false,
  signal,
} = {}) {
  if (!endpoint || typeof endpoint !== 'object' || typeof endpoint.id !== 'string') {
    throw new Error('An endpoint object is required for a bench');
  }
  if (typeof model !== 'string' || model.length === 0) {
    throw new Error('A model id is required for a bench');
  }
  const provider = client ?? resolve(endpoint);
  if (typeof provider.chat !== 'function') {
    throw new Error('The bench client must implement chat()');
  }
  if (!Number.isInteger(runs) || runs <= 0) {
    throw new Error(`Bench runs must be a positive integer; received "${runs}"`);
  }
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
    throw new Error(`Bench maxTokens must be a positive integer; received "${maxTokens}"`);
  }

  // Time the load separately — first-request latency on a cold model would
  // otherwise be mistaken for slow inference.
  const loadStarted = nowFn();
  const admission = await admitFn(endpoint, model, { ...admissionOptions, client: provider });
  if (!admission.ok) {
    throw new Error(`Cannot admit model "${model}" for bench: ${admission.reason}`);
  }
  const loadSeconds = Math.max(0, (nowFn() - loadStarted) / 1_000);

  const messages = [{ role: 'user', content: prompt }];

  // Warm-up: the first call after load pays one-off costs (cache fills, JIT-
  // style warm paths). Discard it — it is never timed.
  await provider.chat(endpoint, {
    model,
    messages,
    maxTokens,
    allowRemoteData,
    signal,
  });

  const slots = concurrency == null
    ? await resolveConcurrency(endpoint, model, provider)
    : concurrency;
  if (!Number.isInteger(slots) || slots <= 0) {
    throw new Error(`Bench concurrency must be a positive integer; received "${slots}"`);
  }

  // Prefill rate: long prompt, tiny generation budget — the wall clock is
  // dominated by prompt processing, so prompt_tokens / seconds is the prefill
  // rate. Single-stream, like the decode figure below.
  const prefillStarted = nowFn();
  const prefill = await provider.chat(endpoint, {
    model,
    messages: [{ role: 'user', content: PREFILL_PROMPT }],
    maxTokens: PREFILL_MAX_TOKENS,
    allowRemoteData,
    signal,
  });
  const prefillSeconds = Math.max(0.001, (nowFn() - prefillStarted) / 1_000);
  const promptTokPerSec = promptTokens(prefill.usage) / prefillSeconds;

  const measure = async (tokenBudget) => {
    // Single stream, averaged over `runs` runs to damp sample noise.
    let singleTokPerSec = 0;
    for (let run = 0; run < runs; run += 1) {
      const singleStarted = nowFn();
      const single = await provider.chat(endpoint, {
        model,
        messages,
        maxTokens: tokenBudget,
        allowRemoteData,
        signal,
      });
      const singleSeconds = Math.max(0.001, (nowFn() - singleStarted) / 1_000);
      singleTokPerSec += completionTokens(single.usage) / singleSeconds;
    }
    singleTokPerSec /= runs;

    // Concurrent aggregate across the model's advertised PARALLEL slots. This
    // is also `slots` realistic end-to-end requests, so itemsPerSec — the most
    // reliable ETA predictor — comes straight from the same wall clock.
    const concurrentStarted = nowFn();
    const results = await Promise.all(
      Array.from(
        { length: slots },
        () => provider.chat(endpoint, {
          model,
          messages,
          maxTokens: tokenBudget,
          allowRemoteData,
          signal,
        }),
      ),
    );
    const concurrentSeconds = Math.max(0.001, (nowFn() - concurrentStarted) / 1_000);
    const concurrentTokens = results.reduce((sum, result) => sum + completionTokens(result.usage), 0);
    return {
      singleTokPerSec,
      aggregateTokPerSec: concurrentTokens / concurrentSeconds,
      itemsPerSec: slots / concurrentSeconds,
    };
  };

  let tokenBudget = maxTokens;
  let { singleTokPerSec, aggregateTokPerSec, itemsPerSec } = await measure(tokenBudget);
  let warning = null;
  if (aggregateTokPerSec < singleTokPerSec) {
    // Impossible for a batching server — the sample was too noisy. Retry once
    // with double the token budget so generation dominates the fixed costs.
    tokenBudget = maxTokens * 2;
    ({ singleTokPerSec, aggregateTokPerSec, itemsPerSec } = await measure(tokenBudget));
    if (aggregateTokPerSec < singleTokPerSec) warning = UNRELIABLE_WARNING;
  }

  return {
    endpoint: endpoint.id,
    model,
    singleTokPerSec,
    aggregateTokPerSec,
    promptTokPerSec,
    completionTokPerSec: singleTokPerSec,
    itemsPerSec,
    concurrency: slots,
    loadSeconds,
    prompt,
    maxTokens: tokenBudget,
    runs,
    warning,
    measuredAt: new Date().toISOString(),
  };
}

// Merge one bench result into the throughput cache, keyed by endpoint+model.
export async function recordThroughput(result, options = {}) {
  if (!result || typeof result !== 'object' || typeof result.model !== 'string') {
    throw new Error('A bench result is required to record throughput');
  }
  const path = throughputPath(options);
  let existing = {};
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    if (parsed && !Array.isArray(parsed) && typeof parsed === 'object') existing = parsed;
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw new Error(`Could not read throughput cache ${path}: ${error.message}`, { cause: error });
    }
  }
  existing[throughputKey(result.endpoint, result.model)] = result;
  await writeJsonAtomic(path, existing);
  return path;
}
