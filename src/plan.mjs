// Pre-flight estimator for batch runs: item count, token estimate, and ETA.
//
// Every figure this module produces is labelled by its basis — 'measured'
// (read from ~/.local/state/local-llm/throughput.json, written by `bench`) or
// 'assumed' (a stated default or heuristic). A fabricated-looking estimate is
// worse than none, so the label travels with the number all the way to output.
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ITEM_LINE, substituteTemplate } from './batch.mjs';

export const SAMPLE_SIZE = 20;
export const ASSUMED_COMPLETION_TOKENS = 300;
export const ASSUMED_TOK_PER_SEC = 30;

export function throughputPath(options = {}) {
  return options.throughputPath
    ?? process.env.LOCAL_LLM_THROUGHPUT_FILE
    ?? join(homedir(), '.local', 'state', 'local-llm', 'throughput.json');
}

export function throughputKey(endpointId, model) {
  return `${endpointId}/${model}`;
}

export async function readThroughput(options = {}) {
  const path = throughputPath(options);
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    if (error instanceof SyntaxError) {
      throw new Error(`Could not parse throughput cache ${path}: ${error.message}`, {
        cause: error,
      });
    }
    throw new Error(`Could not read throughput cache ${path}: ${error.message}`, {
      cause: error,
    });
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error(`Throughput cache ${path} must be a JSON object`);
  }
  return parsed;
}

// ETA from an in-progress run. itemsPerSec = itemsCompleted / wallClockSeconds
// ALREADY includes the effect of concurrency — it is an end-to-end item rate,
// so etaSeconds must never be divided by the slot count again. A draft that
// did so under-estimated a 5,000-item run by 4×; the regression test in
// test/plan.test.mjs pins this down.
export function estimateEtaSeconds({ totalItems, itemsCompleted, wallClockSeconds }) {
  if (!Number.isFinite(totalItems) || totalItems < 0) {
    throw new Error(`totalItems must be a non-negative number; received "${totalItems}"`);
  }
  if (!Number.isFinite(itemsCompleted) || itemsCompleted <= 0) {
    throw new Error(`itemsCompleted must be a positive number; received "${itemsCompleted}"`);
  }
  if (!Number.isFinite(wallClockSeconds) || wallClockSeconds <= 0) {
    throw new Error(`wallClockSeconds must be a positive number; received "${wallClockSeconds}"`);
  }
  const itemsPerSec = itemsCompleted / wallClockSeconds;
  const remainingItems = Math.max(0, totalItems - itemsCompleted);
  return {
    itemsPerSec,
    remainingItems,
    etaSeconds: remainingItems / itemsPerSec,
  };
}

// Rough token estimate: ~4 characters per token for English prose. Always
// labelled 'assumed' — it is a sizing heuristic, not a measurement.
export function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text).length / 4));
}

// Evenly spaced sample so the estimate is not skewed by a run of similar
// items at the head of the file.
export function sampleItems(items, sampleSize = SAMPLE_SIZE) {
  if (!Array.isArray(items)) throw new Error('items must be an array');
  if (items.length <= sampleSize) return items.slice();
  const step = items.length / sampleSize;
  const sample = [];
  for (let index = 0; index < sampleSize; index += 1) {
    sample.push(items[Math.floor(index * step)]);
  }
  return sample;
}

export function samplePromptTokens(items, template, sampleSize = SAMPLE_SIZE) {
  if (typeof template !== 'string' || template.length === 0) {
    throw new Error('A batch template is required for a plan');
  }
  const sample = sampleItems(items, sampleSize);
  if (sample.length === 0) {
    return { sampled: 0, promptTokensPerItem: 0, source: 'assumed' };
  }
  let total = 0;
  for (const item of sample) {
    const prompt = substituteTemplate(template, item, item?.[ITEM_LINE] ?? '?');
    total += estimateTokens(prompt);
  }
  return {
    sampled: sample.length,
    promptTokensPerItem: total / sample.length,
    source: 'assumed (chars/4 heuristic)',
  };
}

// Resolve the end-to-end rate for a model on an endpoint: a measured rate
// from the throughput cache when present, else a clearly labelled assumption.
export function rateForModel(throughput, endpointId, model) {
  const entry = throughput?.[throughputKey(endpointId, model)];
  if (entry && Number.isFinite(Number(entry.aggregateTokPerSec)) && Number(entry.aggregateTokPerSec) > 0) {
    return {
      tokPerSec: Number(entry.aggregateTokPerSec),
      concurrency: Number.isFinite(Number(entry.concurrency)) ? Number(entry.concurrency) : null,
      source: `measured (bench ${entry.measuredAt ?? 'earlier'})`,
      measured: true,
    };
  }
  return {
    tokPerSec: ASSUMED_TOK_PER_SEC,
    concurrency: null,
    source: `assumed default (${ASSUMED_TOK_PER_SEC} tok/s aggregate) — run "local-llm bench --model ${model}" to measure`,
    measured: false,
  };
}

export async function planBatch({
  endpoint,
  model,
  template,
  items,
  sampleSize = SAMPLE_SIZE,
  completionTokensPerItem = ASSUMED_COMPLETION_TOKENS,
  ...options
} = {}) {
  if (!endpoint || typeof endpoint !== 'object' || typeof endpoint.id !== 'string') {
    throw new Error('An endpoint object is required for a plan');
  }
  if (typeof model !== 'string' || model.length === 0) {
    throw new Error('A model id is required for a plan');
  }
  if (!Array.isArray(items)) throw new Error('Plan items must be an array');

  const prompt = samplePromptTokens(items, template, sampleSize);
  const throughput = await readThroughput(options);
  const rate = rateForModel(throughput, endpoint.id, model);

  const itemCount = items.length;
  const tokensPerItem = prompt.promptTokensPerItem + completionTokensPerItem;
  const totalTokens = tokensPerItem * itemCount;
  const etaSeconds = rate.tokPerSec > 0 ? totalTokens / rate.tokPerSec : null;

  return {
    endpoint: endpoint.id,
    model,
    items: itemCount,
    sample: prompt,
    completionTokensPerItem: {
      value: completionTokensPerItem,
      source: 'assumed default',
    },
    rate,
    tokensPerItem,
    totalTokens,
    etaSeconds,
  };
}
