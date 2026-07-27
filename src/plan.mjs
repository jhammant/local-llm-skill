// Pre-flight estimator for batch runs: item count, token estimate, and ETA.
//
// Every figure this module produces is labelled by its basis — 'measured'
// (a timed end-to-end sample of the actual job, or rates read from
// ~/.local/state/local-llm/throughput.json written by `bench`) or 'assumed'
// (a stated default or heuristic). A fabricated-looking estimate is worse
// than none, so the label travels with the number all the way to output.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { ITEM_LINE, normalizeAnswer, runBatch, substituteTemplate } from './batch.mjs';
import { resolve } from './providers/index.mjs';
import { requireRemoteDataOptIn } from './remote-data.mjs';

export const SAMPLE_SIZE = 20;
export const TIMING_SAMPLE_SIZE = 8;
export const PROBE_SAMPLE_SIZE = 3;
export const ASSUMED_COMPLETION_TOKENS = 300;
export const ASSUMED_TOK_PER_SEC = 30;
export const ASSUMED_BURST_TOK_PER_SEC = 340;

export function buildBurstComparison(
  localPlan,
  launchPlan,
  {
    tokPerSec = ASSUMED_BURST_TOK_PER_SEC,
    rateSource = `assumed default (${ASSUMED_BURST_TOK_PER_SEC} tok/s aggregate)`,
  } = {},
) {
  if (!localPlan || !Number.isFinite(Number(localPlan.totalTokens))) {
    throw new Error('A local plan with totalTokens is required for a burst comparison');
  }
  const rate = Number(tokPerSec);
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error('Burst aggregate tok/s must be a positive number');
  }
  const pricePerHour = Number(launchPlan?.pricePerHour);
  if (!Number.isFinite(pricePerHour) || pricePerHour < 0) {
    throw new Error('A burst launch plan with a live non-negative $/hr price is required');
  }
  const etaSeconds = Number(localPlan.totalTokens) / rate;
  const estimatedCost = pricePerHour * etaSeconds / 3_600;
  const localEtaSeconds = Number(localPlan.etaSeconds);
  const timeSavedSeconds = Number.isFinite(localEtaSeconds)
    ? localEtaSeconds - etaSeconds
    : null;
  return {
    local: {
      endpoint: localPlan.endpoint,
      model: localPlan.model,
      etaSeconds: localPlan.etaSeconds,
      estimatedCost: 0,
      basis: localPlan.etaMethod,
    },
    burst: {
      endpoint: 'burst',
      model: launchPlan.model ?? launchPlan.profile,
      gpu: launchPlan.gpu,
      pricePerHour,
      tokPerSec: rate,
      rateSource,
      etaSeconds,
      estimatedCost,
      idleMinutes: launchPlan.idleMinutes,
      ttlHours: launchPlan.ttlHours,
    },
    timeSavedSeconds,
  };
}

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

// Resolve the token rates for a model on an endpoint: measured rates from the
// throughput cache when present, else a clearly labelled assumption. A record
// bench flagged unreliable (e.g. an impossible aggregate-below-single-stream
// sample) is ignored — a noisy measurement is worse than none.
//
// Prompt and completion tokens have completely different throughput (prefill
// is compute-bound and fast, decode memory-bandwidth-bound and slow, often
// 10-30x per token), so the separate rates are surfaced alongside the legacy
// aggregate; planBatch picks between them. bench's itemsPerSec is deliberately
// NOT surfaced: bench measures items/s on its own long-generation prompt,
// which does not transfer to other tasks — it predicted 2h58m for a
// 3,803-item classification job that actually takes ~34 min.
export function rateForModel(throughput, endpointId, model) {
  const entry = throughput?.[throughputKey(endpointId, model)];
  const usable = entry
    && entry.warning == null
    && Number.isFinite(Number(entry.aggregateTokPerSec))
    && Number(entry.aggregateTokPerSec) > 0;
  const positive = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null);
  if (usable) {
    return {
      tokPerSec: Number(entry.aggregateTokPerSec),
      promptTokPerSec: positive(entry.promptTokPerSec),
      completionTokPerSec: positive(entry.completionTokPerSec),
      concurrency: Number.isFinite(Number(entry.concurrency)) ? Number(entry.concurrency) : null,
      source: `measured (bench ${entry.measuredAt ?? 'earlier'})`,
      measured: true,
    };
  }
  const reason = entry?.warning != null
    ? `unreliable bench measurement ignored (${entry.warning}); re-run "local-llm bench --model ${model}"`
    : `run "local-llm bench --model ${model}" to measure`;
  return {
    tokPerSec: ASSUMED_TOK_PER_SEC,
    promptTokPerSec: null,
    completionTokPerSec: null,
    concurrency: null,
    source: `assumed default (${ASSUMED_TOK_PER_SEC} tok/s aggregate) — ${reason}`,
    measured: false,
  };
}

function probeCompletionTokens(usage) {
  const value = usage?.completion_tokens ?? usage?.output_tokens;
  const tokens = Number(value);
  if (!Number.isFinite(tokens) || tokens < 0) {
    throw new Error('chat response did not report completion tokens');
  }
  return tokens;
}

// One probe request, mirroring runBatch's request shape exactly: same system
// message, same rendered user prompt, same reasoning effort (a thinking model
// can emit ~190x the completion tokens without it), and — when `allowed` is
// set — the same constrained-output repair (show the model its out-of-set
// answer, restate the constraint, retry). The measured completion length only
// reflects reality if the probe walks the same path the batch will.
async function probeChat(
  client,
  endpoint,
  model,
  messages,
  allowed,
  reasoningEffort,
  allowRemoteData,
  signal,
) {
  const allowedSet = Array.isArray(allowed) && allowed.length > 0;
  let lastRaw = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const attemptMessages = [...messages];
    if (lastRaw != null && allowedSet) {
      attemptMessages.push({ role: 'assistant', content: lastRaw });
      attemptMessages.push({
        role: 'user',
        content:
          'That is not one of the permitted answers. Reply with exactly one of: '
          + `${allowed.join(', ')}. Output only that word, nothing else.`,
      });
    }
    const result = await client.chat(endpoint, {
      model,
      messages: attemptMessages,
      reasoningEffort,
      allowRemoteData,
      signal,
    });
    const raw = result.message?.content ?? result.message;
    if (!allowedSet || normalizeAnswer(raw, allowed) != null) return result;
    lastRaw = raw;
  }
  throw new Error('probe response was not in the allowed set');
}

// Measure the real completion length instead of assuming it. A small sample
// of the ACTUAL rendered prompts goes to the model and the mean of the API's
// completion_tokens is the estimate. This exists because the old 300-token
// assumption dominated short-output jobs: on a 3,803-item one-word
// classification job it predicted ~16h against ~25m actual (38x over).
// Returns null when there is nothing to sample; throws on probe failure so
// the caller can fall back to the stated assumption.
export async function measureCompletionTokens({
  endpoint,
  model,
  template,
  items,
  system,
  allowed = null,
  reasoningEffort,
  sampleSize = PROBE_SAMPLE_SIZE,
  client = null,
  allowRemoteData = false,
  signal,
} = {}) {
  requireRemoteDataOptIn(endpoint, allowRemoteData);
  const provider = client ?? resolve(endpoint);
  const sample = sampleItems(items, sampleSize);
  if (sample.length === 0) return null;
  let total = 0;
  for (const item of sample) {
    const prompt = substituteTemplate(template, item, item?.[ITEM_LINE] ?? '?');
    const messages = [
      ...(system == null ? [] : [{ role: 'system', content: system }]),
      { role: 'user', content: prompt },
    ];
    const result = await probeChat(
      provider,
      endpoint,
      model,
      messages,
      allowed,
      reasoningEffort,
      allowRemoteData,
      signal,
    );
    total += probeCompletionTokens(result.usage);
  }
  return {
    sampled: sample.length,
    completionTokensPerItem: Math.round((total / sample.length) * 10) / 10,
  };
}

// The only reliable way to predict a real batch is to time a real slice of
// it. A sample of the ACTUAL items goes through runBatch itself — same
// template, same concurrency detection, same --allow constrained-output
// retries, same reasoning effort — and the wall clock is timed around it.
// Retries are part of the real cost, so they must happen inside the timed
// region, and the sample runs at the target concurrency, so the resulting
// items/s already includes it (never divide by the slot count again).
//
// This exists because every token-rate extrapolation failed against ground
// truth on a real 3,803-item classification job (laguna-s-2.1, ~1.87 items/s,
// ~34 min): the single aggregate rate predicted 1h44m (3x over), bench's
// items/s — measured on bench's own long-generation prompt — predicted 2h58m
// (5x over), and separate prefill/decode rates predicted 7m (5x under, because
// short requests are dominated by fixed per-request overhead no token-rate
// model captures).
//
// Throws when the sample is not a valid measurement (any sampled item failed,
// or a non-positive wall clock) so the caller can fall back to the token-rate
// estimate. Returns null only when there is nothing to sample.
export async function measureItemsPerSec({
  endpoint,
  model,
  template,
  items,
  system,
  allowed = null,
  reasoningEffort,
  sampleSize = TIMING_SAMPLE_SIZE,
  concurrency = null,
  client = null,
  sleep,
  now = Date.now,
  allowRemoteData = false,
  signal,
} = {}) {
  requireRemoteDataOptIn(endpoint, allowRemoteData);
  const provider = client ?? resolve(endpoint);
  const sample = sampleItems(items, sampleSize);
  if (sample.length === 0) return null;
  const directory = await mkdtemp(join(tmpdir(), 'local-llm-plan-sample-'));
  const out = join(directory, 'sample.out.jsonl');
  try {
    const started = now();
    const result = await runBatch({
      endpoint,
      model,
      template,
      system,
      items: sample,
      out,
      concurrency,
      reasoningEffort,
      allowed,
      allowRemoteData,
      signal,
      client: provider,
      // A plan must not mutate ration/LRU state as a side effect of estimating.
      touchFn: async () => {},
      ...(sleep == null ? {} : { sleep }),
    });
    const wallClockSeconds = (now() - started) / 1000;
    if (result.ok < sample.length) {
      throw new Error(`${result.failed} of ${sample.length} sampled item(s) failed`);
    }
    if (!Number.isFinite(wallClockSeconds) || wallClockSeconds <= 0) {
      throw new Error(`sample wall clock was not positive (${wallClockSeconds}s)`);
    }

    // Reuse the sample's API-reported usage for measured prompt/completion
    // tokens per item, replacing the chars/4 heuristic and the 300-token
    // assumption. null when the API did not report usage for every record.
    const records = (await readFile(out, 'utf8'))
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line));
    let promptTotal = 0;
    let promptCount = 0;
    let completionTotal = 0;
    let completionCount = 0;
    for (const record of records) {
      const promptTokens = Number(record.usage?.prompt_tokens ?? record.usage?.input_tokens);
      const completionTokens = Number(record.usage?.completion_tokens ?? record.usage?.output_tokens);
      if (Number.isFinite(promptTokens)) {
        promptTotal += promptTokens;
        promptCount += 1;
      }
      if (Number.isFinite(completionTokens)) {
        completionTotal += completionTokens;
        completionCount += 1;
      }
    }
    const round1 = (value) => Math.round(value * 10) / 10;
    return {
      sampled: sample.length,
      itemsPerSec: sample.length / wallClockSeconds,
      wallClockSeconds,
      promptTokensPerItem:
        records.length > 0 && promptCount === records.length ? round1(promptTotal / promptCount) : null,
      completionTokensPerItem:
        records.length > 0 && completionCount === records.length ? round1(completionTotal / completionCount) : null,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function planBatch({
  endpoint,
  model,
  template,
  items,
  sampleSize = SAMPLE_SIZE,
  completionTokensPerItem = null,
  probe = true,
  probeSampleSize = PROBE_SAMPLE_SIZE,
  sample = true,
  timingSampleSize = TIMING_SAMPLE_SIZE,
  concurrency = null,
  system,
  allowed = null,
  reasoningEffort,
  client = null,
  sleep,
  now,
  allowRemoteData = false,
  signal,
  ...options
} = {}) {
  if (!endpoint || typeof endpoint !== 'object' || typeof endpoint.id !== 'string') {
    throw new Error('An endpoint object is required for a plan');
  }
  if (typeof model !== 'string' || model.length === 0) {
    throw new Error('A model id is required for a plan');
  }
  if (!Array.isArray(items)) throw new Error('Plan items must be an array');
  requireRemoteDataOptIn(endpoint, allowRemoteData);

  const provider = client ?? resolve(endpoint);
  const itemCount = items.length;
  const throughput = await readThroughput(options);
  const rate = rateForModel(throughput, endpoint.id, model);
  const measuredSource = (n) => `measured (end-to-end sample of ${n} items)`;

  // ETA, in order of preference:
  // (a) a timed end-to-end sample of the ACTUAL job — the only reliable
  //     predictor, because short requests are dominated by fixed per-request
  //     overhead that no token-rate model captures (see measureItemsPerSec);
  // (b) separate prefill/decode rates — prefill is compute-bound and fast,
  //     decode memory-bandwidth-bound and slow, so seconds/item is
  //     promptTokens/promptTokPerSec + completionTokens/completionTokPerSec,
  //     scaled down by the model's parallel slots;
  // (c) the legacy single aggregate rate — least accurate, because it bills
  //     prompt tokens at the decode rate (this over-estimated a real
  //     3,803-item job by 3x: 1h44m predicted vs ~34m actual).
  // bench's itemsPerSec is deliberately absent from this list (see
  // rateForModel). A failed sample must never crash the plan — fall back to
  // the token-rate methods and say so in the label.
  let measured = null;
  let sampleError = null;
  if (sample && itemCount > 0) {
    try {
      measured = await measureItemsPerSec({
        endpoint,
        model,
        template,
        items,
        system,
        allowed,
        reasoningEffort,
        sampleSize: timingSampleSize,
        concurrency,
        client: provider,
        allowRemoteData,
        signal,
        ...(sleep == null ? {} : { sleep }),
        ...(now == null ? {} : { now }),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      sampleError = error;
    }
  }

  // Completion tokens/item: an explicit override, else the measured sample,
  // else a live probe of the model, else the stated 300-token assumption.
  let completion;
  if (completionTokensPerItem != null) {
    completion = { value: completionTokensPerItem, source: 'assumed default' };
  } else if (measured?.completionTokensPerItem != null) {
    completion = {
      value: measured.completionTokensPerItem,
      source: measuredSource(measured.sampled),
    };
  } else if (!probe) {
    completion = { value: ASSUMED_COMPLETION_TOKENS, source: 'assumed default' };
  } else {
    try {
      const probed = await measureCompletionTokens({
        endpoint,
        model,
        template,
        items,
        system,
        allowed,
        reasoningEffort,
        sampleSize: probeSampleSize,
        client: provider,
        allowRemoteData,
        signal,
      });
      completion = probed == null
        ? { value: ASSUMED_COMPLETION_TOKENS, source: 'assumed default' }
        : {
          value: probed.completionTokensPerItem,
          source: `measured (n=${probed.sampled} sample)`,
        };
    } catch (error) {
      if (signal?.aborted) throw error;
      completion = {
        value: ASSUMED_COMPLETION_TOKENS,
        source: `assumed default (probe failed: ${error.message})`,
      };
    }
  }

  // Prompt tokens/item: the sample's API-reported prompt_tokens when
  // available, else the chars/4 heuristic (always labelled 'assumed').
  const prompt = measured?.promptTokensPerItem != null
    ? {
      sampled: measured.sampled,
      promptTokensPerItem: measured.promptTokensPerItem,
      source: measuredSource(measured.sampled),
    }
    : samplePromptTokens(items, template, sampleSize);

  const tokensPerItem = prompt.promptTokensPerItem + completion.value;
  const totalTokens = tokensPerItem * itemCount;

  let etaSeconds = null;
  let etaMethod;
  let itemsPerSec = null;
  if (measured != null) {
    const eta = estimateEtaSeconds({
      totalItems: itemCount,
      itemsCompleted: measured.sampled,
      wallClockSeconds: measured.wallClockSeconds,
    });
    etaSeconds = eta.etaSeconds;
    etaMethod = measuredSource(measured.sampled);
    itemsPerSec = { value: eta.itemsPerSec, source: etaMethod };
  } else {
    const sampleNote = sampleError ? ` (end-to-end sample failed: ${sampleError.message})` : '';
    if (rate.promptTokPerSec != null && rate.completionTokPerSec != null) {
      const secondsPerItem = prompt.promptTokensPerItem / rate.promptTokPerSec
        + completion.value / rate.completionTokPerSec;
      etaSeconds = (secondsPerItem * itemCount) / (rate.concurrency ?? 1);
      etaMethod = 'separate prefill/decode rates (token-rate estimate; misses fixed per-request overhead)'
        + sampleNote;
    } else {
      etaSeconds = rate.tokPerSec > 0 ? totalTokens / rate.tokPerSec : null;
      etaMethod = 'single aggregate rate (least accurate — prompt tokens billed at the decode rate)'
        + sampleNote;
    }
  }

  return {
    endpoint: endpoint.id,
    model,
    items: itemCount,
    sample: prompt,
    completionTokensPerItem: completion,
    rate,
    itemsPerSec,
    tokensPerItem,
    totalTokens,
    etaSeconds,
    etaMethod,
  };
}
