// Throughput benchmark: measures a model's real rates on an endpoint and
// caches them in ~/.local/state/local-llm/throughput.json for `plan` to use.
//
// Measures single-stream tok/s and the concurrent AGGREGATE tok/s separately.
// Concurrency scales sub-linearly on Apple unified memory (it is memory-
// bandwidth-bound, not compute-bound), so the aggregate is measured directly —
// never estimated as singleRate × slots, which overstates it badly.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import * as lmstudio from './lmstudio.mjs';
import { admit } from './ration.mjs';
import { throughputKey, throughputPath } from './plan.mjs';

const BENCH_PROMPT = 'Explain, in a few sentences, how a hash map resolves collisions.';
const BENCH_MAX_TOKENS = 128;
const DEFAULT_CONCURRENCY = 4;

function completionTokens(usage) {
  const value = usage?.completion_tokens ?? usage?.output_tokens ?? 0;
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

async function resolveConcurrency(endpoint, model, client) {
  if (typeof client.ps !== 'function') return DEFAULT_CONCURRENCY;
  const loaded = await client.ps(endpoint);
  const match = loaded.find((entry) => entry.model === model || entry.identifier === model);
  const parallel = Number(match?.parallel);
  return Number.isInteger(parallel) && parallel > 0 ? parallel : DEFAULT_CONCURRENCY;
}

export async function runBench({
  endpoint,
  model,
  client = lmstudio,
  admitFn = admit,
  admissionOptions = {},
  concurrency,
  prompt = BENCH_PROMPT,
  maxTokens = BENCH_MAX_TOKENS,
  nowFn = () => Date.now(),
} = {}) {
  if (!endpoint || typeof endpoint !== 'object' || typeof endpoint.id !== 'string') {
    throw new Error('An endpoint object is required for a bench');
  }
  if (typeof model !== 'string' || model.length === 0) {
    throw new Error('A model id is required for a bench');
  }
  if (typeof client.chat !== 'function') {
    throw new Error('The bench client must implement chat()');
  }

  // Time the load separately — first-request latency on a cold model would
  // otherwise be mistaken for slow inference.
  const loadStarted = nowFn();
  const admission = await admitFn(endpoint, model, { ...admissionOptions, client });
  if (!admission.ok) {
    throw new Error(`Cannot admit model "${model}" for bench: ${admission.reason}`);
  }
  const loadSeconds = Math.max(0, (nowFn() - loadStarted) / 1_000);

  const messages = [{ role: 'user', content: prompt }];

  // Single stream.
  const singleStarted = nowFn();
  const single = await client.chat(endpoint, { model, messages, maxTokens });
  const singleSeconds = Math.max(0.001, (nowFn() - singleStarted) / 1_000);
  const singleTokens = completionTokens(single.usage);
  const singleTokPerSec = singleTokens / singleSeconds;

  // Concurrent aggregate across the model's advertised PARALLEL slots.
  const slots = concurrency == null
    ? await resolveConcurrency(endpoint, model, client)
    : concurrency;
  if (!Number.isInteger(slots) || slots <= 0) {
    throw new Error(`Bench concurrency must be a positive integer; received "${slots}"`);
  }
  const concurrentStarted = nowFn();
  const results = await Promise.all(
    Array.from({ length: slots }, () => client.chat(endpoint, { model, messages, maxTokens })),
  );
  const concurrentSeconds = Math.max(0.001, (nowFn() - concurrentStarted) / 1_000);
  const concurrentTokens = results.reduce((sum, result) => sum + completionTokens(result.usage), 0);
  const aggregateTokPerSec = concurrentTokens / concurrentSeconds;

  return {
    endpoint: endpoint.id,
    model,
    singleTokPerSec,
    aggregateTokPerSec,
    concurrency: slots,
    loadSeconds,
    prompt,
    maxTokens,
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
