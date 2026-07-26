import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordThroughput, runBench } from '../src/bench.mjs';

const endpoint = {
  id: 'local',
  label: 'Test',
  baseUrl: 'http://invalid.test',
  apiKey: null,
  control: 'cli',
  capacityGb: null,
};

function fakeClient({ completionTokens = 64, parallel = 4 } = {}) {
  const calls = [];
  return {
    calls,
    async chat(receivedEndpoint, payload) {
      calls.push(payload);
      return {
        message: { role: 'assistant', content: 'bench output' },
        usage: { prompt_tokens: 12, completion_tokens: completionTokens, total_tokens: 12 + completionTokens },
        ms: 1,
      };
    },
    async ps() {
      return [{ identifier: 'bench-model', model: 'bench-model', parallel }];
    },
  };
}

function sequencedClient({ sequence, parallel = 4 }) {
  const calls = [];
  let index = 0;
  return {
    calls,
    async chat(receivedEndpoint, payload) {
      calls.push(payload);
      const tokens = sequence[Math.min(index, sequence.length - 1)];
      index += 1;
      return {
        message: { role: 'assistant', content: 'bench output' },
        usage: { prompt_tokens: 12, completion_tokens: tokens, total_tokens: 12 + tokens },
        ms: 1,
      };
    },
    async ps() {
      return [{ identifier: 'bench-model', model: 'bench-model', parallel }];
    },
  };
}

async function fakeAdmit() {
  return { ok: true, action: 'already-loaded', evicted: [], reason: 'already loaded' };
}

// A deterministic clock: each call advances exactly one second, so every
// measured phase (load, single run, concurrent) takes exactly 1s.
function fakeClock() {
  let now = 0;
  return () => {
    now += 1_000;
    return now;
  };
}

test('runBench measures load, single-stream, and concurrent aggregate rates', async () => {
  const client = fakeClient({ completionTokens: 64, parallel: 4 });
  const result = await runBench({
    endpoint,
    model: 'bench-model',
    client,
    admitFn: fakeAdmit,
    nowFn: fakeClock(),
  });

  assert.equal(result.model, 'bench-model');
  assert.equal(result.loadSeconds, 1);
  // 64 completion tokens in 1s on one stream, mean of the default 3 runs.
  assert.equal(result.singleTokPerSec, 64);
  // 4 concurrent streams x 64 tokens in the same 1s wall clock.
  assert.equal(result.aggregateTokPerSec, 256);
  // Prefill probe: 12 prompt tokens in 1s against the long prefill prompt.
  assert.equal(result.promptTokPerSec, 12);
  // Decode rate is the single-stream generation figure.
  assert.equal(result.completionTokPerSec, 64);
  // 4 realistic end-to-end requests in the 1s concurrent wall clock.
  assert.equal(result.itemsPerSec, 4);
  assert.equal(result.concurrency, 4);
  assert.equal(result.maxTokens, 256);
  assert.equal(result.runs, 3);
  assert.equal(result.warning, null);
  // 1 warm-up call + 1 prefill probe + 3 single-stream runs + 4 concurrent calls.
  assert.equal(client.calls.length, 9);
});

test('runBench warms up first and excludes the warm-up call from timing', async () => {
  // The warm-up returns 1000 tokens; if it were included in the single-stream
  // figure the mean would jump far above 64 tok/s.
  const client = sequencedClient({ sequence: [1_000, 64, 64, 64, 64, 64, 64, 64], parallel: 4 });
  const result = await runBench({
    endpoint,
    model: 'bench-model',
    client,
    admitFn: fakeAdmit,
    nowFn: fakeClock(),
    runs: 2,
  });

  // 1 warm-up + 1 prefill + 2 single runs + 4 concurrent = 8 calls; warm-up first.
  assert.equal(client.calls.length, 8);
  assert.equal(result.singleTokPerSec, 64);
  assert.equal(result.aggregateTokPerSec, 256);
});

test('runBench reports the mean of the configured single-stream runs', async () => {
  // Warm-up 64, prefill 64, then single runs of 64 and 32 tokens (1s each) -> mean 48.
  const client = sequencedClient({ sequence: [64, 64, 64, 32, 64, 64, 64, 64], parallel: 4 });
  const result = await runBench({
    endpoint,
    model: 'bench-model',
    client,
    admitFn: fakeAdmit,
    nowFn: fakeClock(),
    runs: 2,
  });

  assert.equal(result.runs, 2);
  assert.equal(result.singleTokPerSec, 48);
  assert.equal(result.aggregateTokPerSec, 256);
});

test('runBench flags a still-inverted aggregate as unreliable after one retry', async () => {
  // Single stream 64 tok/s; 4-way aggregate 32 tok/s — impossible for a
  // batching server, so the sample is retried once with double the token
  // budget and, still inverted, flagged unreliable rather than silently kept.
  const client = sequencedClient({
    sequence: [64, 64, 64, 8, 8, 8, 8, 64, 8, 8, 8, 8],
    parallel: 4,
  });
  const ticks = [0, 1_000, 2_000, 3_000, 4_000, 5_000, 6_000, 7_000, 8_000, 9_000, 10_000, 11_000];
  let index = 0;
  const nowFn = () => ticks[index++];

  const result = await runBench({
    endpoint,
    model: 'bench-model',
    client,
    admitFn: fakeAdmit,
    nowFn,
    runs: 1,
    maxTokens: 10,
  });

  assert.equal(result.singleTokPerSec, 64);
  assert.equal(result.aggregateTokPerSec, 32);
  assert.equal(result.warning, 'unreliable (aggregate below single-stream)');
  // The retry doubled the token budget; the recorded maxTokens says so.
  assert.equal(result.maxTokens, 20);
  // 1 warm-up + 1 prefill + (1 single + 4 concurrent) x 2 attempts.
  assert.equal(client.calls.length, 12);
  assert.equal(client.calls.at(-1).maxTokens, 20);
});

test('runBench recovers without a warning when the retry un-inverts', async () => {
  const client = sequencedClient({
    sequence: [64, 64, 64, 8, 8, 8, 8, 64, 64, 64, 64, 64],
    parallel: 4,
  });
  const ticks = [0, 1_000, 2_000, 3_000, 4_000, 5_000, 6_000, 7_000, 8_000, 9_000, 10_000, 11_000];
  let index = 0;
  const nowFn = () => ticks[index++];

  const result = await runBench({
    endpoint,
    model: 'bench-model',
    client,
    admitFn: fakeAdmit,
    nowFn,
    runs: 1,
    maxTokens: 10,
  });

  assert.equal(result.aggregateTokPerSec, 256);
  assert.equal(result.warning, null);
  assert.equal(result.maxTokens, 20);
});

test('runBench aggregates concurrently rather than multiplying single rate by slots', async () => {
  // If the aggregate were estimated as singleRate x slots it would be 4x no
  // matter what the concurrent phase actually returned; measuring it directly
  // is what captures sub-linear scaling on unified memory.
  let call = 0;
  const client = {
    async chat() {
      call += 1;
      // Warm-up, prefill, and the single-stream run return 64 tokens; the
      // concurrent phase returns fewer tokens per stream.
      const usage = { prompt_tokens: 12, completion_tokens: call <= 3 ? 64 : 16 };
      return { message: { content: 'x' }, usage, ms: 1 };
    },
    async ps() {
      return [{ model: 'm', identifier: 'm', parallel: 4 }];
    },
  };
  // Clock: load=1s, prefill=1s, single run=2s, concurrent=1s wall.
  const ticks = [0, 1_000, 2_000, 3_000, 4_000, 6_000, 7_000, 8_000];
  let index = 0;
  const nowFn = () => ticks[index++];

  const result = await runBench({ endpoint, model: 'm', client, admitFn: fakeAdmit, nowFn, runs: 1 });
  assert.equal(result.singleTokPerSec, 32);
  // aggregate = 4 x 16 tokens / 1s = 64 tok/s — measured, not 32 x 4 = 128.
  assert.equal(result.aggregateTokPerSec, 64);
  assert.ok(result.aggregateTokPerSec < result.singleTokPerSec * result.concurrency);
  assert.equal(result.warning, null);
});

test('runBench refuses a model that fails admission', async () => {
  const client = fakeClient();
  await assert.rejects(
    runBench({
      endpoint,
      model: 'too-big',
      client,
      admitFn: async () => ({ ok: false, action: 'too-big', evicted: [], reason: 'too big' }),
      nowFn: fakeClock(),
    }),
    /too big/,
  );
  assert.equal(client.calls.length, 0);
});

test('recordThroughput merges results into the cache keyed by endpoint+model', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'local-llm-bench-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const throughputPath = join(directory, 'state', 'throughput.json');

  await recordThroughput(
    { endpoint: 'local', model: 'model-a', aggregateTokPerSec: 50, measuredAt: 't0' },
    { throughputPath },
  );
  await recordThroughput(
    { endpoint: 'local', model: 'model-b', aggregateTokPerSec: 80, measuredAt: 't1' },
    { throughputPath },
  );

  const cache = JSON.parse(await readFile(throughputPath, 'utf8'));
  assert.equal(cache['local/model-a'].aggregateTokPerSec, 50);
  assert.equal(cache['local/model-b'].aggregateTokPerSec, 80);
});

test('recordThroughput persists maxTokens, runs, and any reliability warning', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'local-llm-bench-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const throughputPath = join(directory, 'throughput.json');

  await recordThroughput(
    {
      endpoint: 'local',
      model: 'model-a',
      singleTokPerSec: 64,
      aggregateTokPerSec: 32,
      concurrency: 4,
      maxTokens: 512,
      runs: 3,
      warning: 'unreliable (aggregate below single-stream)',
      measuredAt: 't0',
    },
    { throughputPath },
  );

  const cache = JSON.parse(await readFile(throughputPath, 'utf8'));
  const entry = cache['local/model-a'];
  assert.equal(entry.maxTokens, 512);
  assert.equal(entry.runs, 3);
  assert.equal(entry.warning, 'unreliable (aggregate below single-stream)');
});

test('recordThroughput writes the cache file owner-only', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'local-llm-bench-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const throughputPath = join(directory, 'throughput.json');
  await recordThroughput(
    { endpoint: 'local', model: 'model-a', aggregateTokPerSec: 50, measuredAt: 't0' },
    { throughputPath },
  );
  const { mode } = await stat(throughputPath);
  assert.equal(mode & 0o777, 0o600);
});
