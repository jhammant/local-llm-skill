import { open, readFile, mkdir, truncate } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { resolve as resolveProvider } from './providers/index.mjs';
import { touch } from './ration.mjs';
import { requireRemoteDataOptIn } from './remote-data.mjs';

export const ITEM_LINE = Symbol('local-llm input line');
const RETRY_DELAYS_MS = [1_000, 4_000];

function requireEndpoint(endpoint) {
  if (!endpoint || typeof endpoint !== 'object' || typeof endpoint.id !== 'string') {
    throw new Error('An endpoint object is required for a batch');
  }
}

function itemLine(item, index) {
  return item?.[ITEM_LINE] ?? index + 1;
}

function attachLine(item, line) {
  Object.defineProperty(item, ITEM_LINE, {
    value: line,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return item;
}

export async function readItems(path, { field } = {}) {
  const contents = await readFile(path, 'utf8');
  const lines = contents.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  const items = [];

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index];
    if (field != null) {
      if (typeof field !== 'string' || field.length === 0) {
        throw new Error('--field requires a non-empty field name');
      }
      items.push(attachLine({ [field]: line }, lineNumber));
      continue;
    }
    if (line.trim() === '') continue;

    let item;
    try {
      item = JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid JSON on input line ${lineNumber}: ${error.message}`, {
        cause: error,
      });
    }
    if (!item || Array.isArray(item) || typeof item !== 'object') {
      throw new Error(`Input line ${lineNumber} must be a JSON object`);
    }
    items.push(attachLine(item, lineNumber));
  }
  return items;
}

function stringifyTemplateValue(value) {
  if (value == null) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function substituteTemplate(template, item, lineNumber) {
  if (typeof template !== 'string') throw new Error('Batch template must be a string');
  if (!item || Array.isArray(item) || typeof item !== 'object') {
    throw new Error(`Batch item on line ${lineNumber} must be an object`);
  }
  return template.replace(/{{\s*([^{}]+?)\s*}}/g, (_match, field) => {
    if (!Object.hasOwn(item, field)) {
      throw new Error(`Unknown template field "${field}" on input line ${lineNumber}`);
    }
    return stringifyTemplateValue(item[field]);
  });
}

function itemId(item, index) {
  return Object.hasOwn(item, 'id') ? item.id : index;
}

function identityKey(id) {
  return `${typeof id}:${JSON.stringify(id)}`;
}

function matchCompletedItems(items, records) {
  const matches = new Map();
  const claimed = new Set();
  const explicitCounts = new Map();

  for (const item of items) {
    if (item && typeof item === 'object' && Object.hasOwn(item, 'id')) {
      const key = identityKey(item.id);
      explicitCounts.set(key, (explicitCounts.get(key) ?? 0) + 1);
    }
  }

  function claim(inputIndex, predicate) {
    const recordIndex = records.findIndex(
      (record, index) => !claimed.has(index) && predicate(record),
    );
    if (recordIndex < 0) return;
    claimed.add(recordIndex);
    matches.set(inputIndex, records[recordIndex]);
  }

  // Index-derived ids are matched first and must retain both their index and id.
  // This keeps an explicit numeric id from colliding with another item's index.
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item || typeof item !== 'object' || Object.hasOwn(item, 'id')) continue;
    claim(index, (record) => record.i === index && record.id === index);
  }

  // Duplicate explicit ids cannot be identified by id alone, so retain their
  // original index. Unique explicit ids remain stable if the input is reordered.
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item || typeof item !== 'object' || !Object.hasOwn(item, 'id')) continue;
    const key = identityKey(item.id);
    if (explicitCounts.get(key) > 1) {
      claim(index, (record) => record.i === index && identityKey(record.id) === key);
    }
  }
  for (let index = 0; index < items.length; index += 1) {
    if (matches.has(index)) continue;
    const item = items[index];
    if (!item || typeof item !== 'object' || !Object.hasOwn(item, 'id')) continue;
    const key = identityKey(item.id);
    if (explicitCounts.get(key) === 1) {
      claim(index, (record) => identityKey(record.id) === key);
    }
  }
  return matches;
}

async function inspectOutput(path) {
  let buffer;
  try {
    buffer = await readFile(path);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        records: [],
        repairBytes: null,
        needsLeadingNewline: false,
      };
    }
    throw new Error(`Could not read batch output ${path}: ${error.message}`, { cause: error });
  }

  const text = buffer.toString('utf8');
  const lines = text.split('\n');
  const endsWithNewline = buffer.length === 0 || buffer.at(-1) === 0x0a;
  const records = [];
  let repairBytes = null;

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index].replace(/\r$/, '');
    if (raw.trim() === '') continue;
    try {
      const record = JSON.parse(raw);
      if (!record || typeof record !== 'object') {
        throw new Error('record is not an object');
      }
      records.push(record);
    } catch (error) {
      const isIncompleteTail = index === lines.length - 1 && !endsWithNewline;
      if (isIncompleteTail) {
        repairBytes = buffer.lastIndexOf(0x0a) + 1;
        break;
      }
      throw new Error(`Invalid JSON in batch output ${path} on line ${index + 1}: ${error.message}`, {
        cause: error,
      });
    }
  }

  return {
    records,
    repairBytes,
    needsLeadingNewline: repairBytes == null && buffer.length > 0 && !endsWithNewline,
  };
}

export async function inspectBatch({ endpoint, items, out, restart = false } = {}) {
  requireEndpoint(endpoint);
  if (!Array.isArray(items)) throw new Error('Batch items must be an array');
  if (typeof out !== 'string' || out.length === 0) {
    throw new Error('A batch output path is required');
  }
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item || Array.isArray(item) || typeof item !== 'object') {
      throw new Error(`Batch item on line ${itemLine(item, index)} must be an object`);
    }
  }
  const outputState = restart
    ? { records: [], repairBytes: null, needsLeadingNewline: false }
    : await inspectOutput(out);
  const completed = matchCompletedItems(items, outputState.records);
  let ok = 0;
  let failed = 0;
  for (const record of completed.values()) {
    if (record.ok) ok += 1;
    else failed += 1;
  }
  return {
    done: completed.size,
    total: items.length,
    ok,
    failed,
    pending: items.length - completed.size,
    out,
  };
}

function outputText(message) {
  if (message && typeof message === 'object' && Object.hasOwn(message, 'content')) {
    return message.content;
  }
  return message;
}

// Constrained-output repair. Small quantized models routinely obey "reply with
// one word" ~97% of the time and wrap the rest in punctuation, markdown, or a
// sentence. Rather than discard those, canonicalise what is recoverable and
// only fail the genuinely ambiguous ones.
//
// Three passes, narrowest first:
//   1. the whole answer matches a permitted value
//   2. the FIRST token matches (handles "bugfix." / "**bugfix**" / "bugfix\n...")
//   3. exactly ONE permitted value appears anywhere (handles "The category is
//      bugfix") — rejected if two or more appear, since that is a real ambiguity
//      and guessing would silently corrupt the dataset.
export function normalizeAnswer(raw, allowed) {
  if (raw == null || !Array.isArray(allowed) || allowed.length === 0) return null;
  const canonical = new Map(allowed.map((a) => [String(a).toLowerCase(), a]));
  const strip = (s) => s.replace(/[`*_"'“”‘’.,:;!?()\[\]]/g, '').trim().toLowerCase();

  const whole = strip(String(raw));
  if (canonical.has(whole)) return canonical.get(whole);

  const tokens = String(raw).split(/\s+/).map(strip).filter(Boolean);
  if (tokens.length && canonical.has(tokens[0])) return canonical.get(tokens[0]);

  const present = [...new Set(tokens.filter((t) => canonical.has(t)))];
  return present.length === 1 ? canonical.get(present[0]) : null;
}

function tokenCount(usage) {
  const value = usage?.completion_tokens ?? usage?.output_tokens ?? usage?.total_tokens ?? 0;
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function wait(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

async function determineParallel(endpoint, model, client) {
  if (typeof client.ps !== 'function' || client.capabilities?.loadedState === false) {
    return { concurrency: 4, identifier: model };
  }
  const loaded = await client.ps(endpoint);
  const match = loaded.find((entry) => entry.model === model || entry.identifier === model);
  const parallel = Number(match?.parallel);
  return {
    concurrency: Number.isInteger(parallel) && parallel > 0 ? parallel : 4,
    identifier: match?.identifier ?? model,
  };
}

function validateConcurrency(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Batch concurrency must be a positive integer; received "${value}"`);
  }
  return parsed;
}

export async function runBatch({
  endpoint,
  model,
  template,
  system,
  items,
  out,
  concurrency,
  reasoningEffort,
  restart = false,
  onProgress,
  signal,
  client = null,
  sleep = wait,
  touchFn = touch,
  touchOptions = {},
  allowed = null,
  allowRemoteData = false,
} = {}) {
  requireEndpoint(endpoint);
  requireRemoteDataOptIn(endpoint, allowRemoteData);
  const provider = client ?? resolveProvider(endpoint);
  if (typeof model !== 'string' || model.length === 0) {
    throw new Error('A model id is required for a batch');
  }
  if (!Array.isArray(items)) throw new Error('Batch items must be an array');
  if (typeof out !== 'string' || out.length === 0) {
    throw new Error('A batch output path is required');
  }
  if (system != null && typeof system !== 'string') {
    throw new Error('Batch system prompt must be a string');
  }
  if (allowed != null && (!Array.isArray(allowed) || allowed.length === 0)) {
    throw new Error('Batch allowed values must be a non-empty array');
  }
  const allowedSet = allowed != null;

  const outputState = restart
    ? { records: [], repairBytes: null, needsLeadingNewline: false }
    : await inspectOutput(out);
  const completedItems = matchCompletedItems(items, outputState.records);
  const prepared = [];
  let initialDone = completedItems.size;
  let initialOk = 0;
  let initialFailed = 0;

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item || Array.isArray(item) || typeof item !== 'object') {
      throw new Error(`Batch item on line ${itemLine(item, index)} must be an object`);
    }
    const id = itemId(item, index);
    const completed = completedItems.get(index);
    if (completed) {
      if (completed.ok) initialOk += 1;
      else initialFailed += 1;
      continue;
    }
    prepared.push({
      i: index,
      id,
      prompt: substituteTemplate(template, item, itemLine(item, index)),
    });
  }

  let effectiveConcurrency = concurrency == null ? 4 : validateConcurrency(concurrency);
  let lruIdentifier = model;
  if (prepared.length > 0) {
    const detected = await determineParallel(endpoint, model, provider);
    lruIdentifier = detected.identifier;
    if (concurrency == null) effectiveConcurrency = detected.concurrency;
  }

  await mkdir(dirname(resolve(out)), { recursive: true });
  if (!restart && outputState.repairBytes != null) {
    await truncate(out, outputState.repairBytes);
  }
  const output = await open(out, restart ? 'w' : 'a');
  let writeQueue = Promise.resolve();
  let prefixNewline = !restart
    && outputState.repairBytes == null
    && outputState.needsLeadingNewline;

  function appendRecord(record) {
    const operation = writeQueue.then(async () => {
      const prefix = prefixNewline ? '\n' : '';
      prefixNewline = false;
      await output.write(`${prefix}${JSON.stringify(record)}\n`);
      await output.sync();
    });
    writeQueue = operation.catch(() => {});
    return operation;
  }

  const startedAt = Date.now();
  let done = initialDone;
  let succeeded = initialOk;
  let failed = initialFailed;
  let completedTokens = 0;
  let cursor = 0;
  let lastProgressAt = 0;

  function emitProgress(force = false) {
    if (typeof onProgress !== 'function') return;
    const now = Date.now();
    if (!force && now - lastProgressAt < 1_000) return;
    lastProgressAt = now;
    const elapsedMs = Math.max(1, now - startedAt);
    const completedThisRun = done - initialDone;
    const remaining = Math.max(0, items.length - done);
    const itemsPerMs = completedThisRun / elapsedMs;
    const etaMs = itemsPerMs > 0 ? Math.round(remaining / itemsPerMs) : null;
    try {
      onProgress({
        done,
        total: items.length,
        ok: succeeded,
        failed,
        etaMs,
        tokensPerSec: completedTokens / (elapsedMs / 1_000),
      });
    } catch {
      // Rendering progress must never interrupt a batch.
    }
  }

  async function requestWithRetries(entry) {
    const requestStarted = Date.now();
    let lastError;
    let lastRaw = null;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        const messages = [
          ...(system == null ? [] : [{ role: 'system', content: system }]),
          { role: 'user', content: entry.prompt },
        ];
        // On a retry caused by an out-of-set answer, show the model what it said
        // and restate the constraint. A bare re-ask tends to reproduce the same
        // stray preamble; naming the mistake is what actually fixes it.
        if (lastRaw != null && allowedSet) {
          messages.push({ role: 'assistant', content: lastRaw });
          messages.push({
            role: 'user',
            content:
              `That is not one of the permitted answers. Reply with exactly one of: ` +
              `${allowed.join(', ')}. Output only that word, nothing else.`,
          });
        }
        const result = await provider.chat(endpoint, {
          model,
          messages,
          reasoningEffort,
          signal,
          allowRemoteData,
        });
        const raw = outputText(result.message);

        if (allowedSet) {
          const canonical = normalizeAnswer(raw, allowed);
          if (canonical == null) {
            lastRaw = raw;
            lastError = new Error(`response not in allowed set: ${JSON.stringify((raw ?? '').slice(0, 80))}`);
            if (attempt < RETRY_DELAYS_MS.length) continue; // retry immediately; this is not a rate problem
            break;
          }
          return {
            ok: true,
            response: canonical,
            raw: raw === canonical ? undefined : raw,
            usage: result.usage ?? null,
            ms: result.ms ?? (Date.now() - requestStarted),
            error: null,
          };
        }

        return {
          ok: true,
          response: raw,
          usage: result.usage ?? null,
          ms: result.ms ?? (Date.now() - requestStarted),
          error: null,
        };
      } catch (error) {
        lastError = error;
        if (signal?.aborted) break;
        if (attempt < RETRY_DELAYS_MS.length) {
          await sleep(RETRY_DELAYS_MS[attempt]);
        }
      }
    }
    return {
      ok: false,
      response: null,
      raw: lastRaw ?? undefined,
      usage: null,
      ms: Date.now() - requestStarted,
      error: lastError?.message ?? String(lastError),
    };
  }

  function takeNext() {
    if (signal?.aborted || cursor >= prepared.length) return null;
    const entry = prepared[cursor];
    cursor += 1;
    return entry;
  }

  async function worker() {
    while (true) {
      const entry = takeNext();
      if (!entry) return;
      const result = await requestWithRetries(entry);
      if (result.ok) {
        await touchFn(endpoint, lruIdentifier, touchOptions);
      }
      await appendRecord({
        i: entry.i,
        id: entry.id,
        ok: result.ok,
        response: result.response,
        usage: result.usage,
        ms: result.ms,
        error: result.error,
      });
      done += 1;
      if (result.ok) {
        succeeded += 1;
        completedTokens += tokenCount(result.usage);
      } else {
        failed += 1;
      }
      emitProgress();
    }
  }

  try {
    const workerCount = Math.min(effectiveConcurrency, prepared.length);
    const workerResults = await Promise.allSettled(
      Array.from({ length: workerCount }, () => worker()),
    );
    await writeQueue;
    const rejected = workerResults.find((result) => result.status === 'rejected');
    if (rejected) throw rejected.reason;
  } finally {
    await output.close();
  }
  emitProgress(true);

  return {
    done,
    total: items.length,
    ok: succeeded,
    failed,
    skipped: initialDone,
    stopped: Boolean(signal?.aborted && done < items.length),
    out,
  };
}
