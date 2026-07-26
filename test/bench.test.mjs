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

async function fakeAdmit() {
  return { ok: true, action: 'already-loaded', evicted: [], reason: 'already loaded' };
}

// A deterministic clock: each call advances exactly one second, so every
// measured phase (load, single, concurrent) takes exactly 1s.
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
  // 64 completion tokens in 1s on one stream.
  assert.equal(result.singleTokPerSec, 64);
  // 4 concurrent streams x 64 tokens in the same 1s wall clock.
  assert.equal(result.aggregateTokPerSec, 256);
  assert.equal(result.concurrency, 4);
  // 1 single-stream call + 4 concurrent calls.
  assert.equal(client.calls.length, 5);
});

test('runBench aggregates concurrently rather than multiplying single rate by slots', async () => {
  // If the aggregate were estimated as singleRate x slots it would be 4x no
  // matter what the concurrent phase actually returned; measuring it directly
  // is what captures sub-linear scaling on unified memory.
  let completionTokens = 64;
  const client = {
    async chat() {
      const usage = { completion_tokens: completionTokens };
      completionTokens = 16; // concurrent phase returns fewer tokens per stream
      return { message: { content: 'x' }, usage, ms: 1 };
    },
    async ps() {
      return [{ model: 'm', identifier: 'm', parallel: 4 }];
    },
  };
  // Clock: load=1s, single=1s, concurrent=2s wall.
  const ticks = [0, 1_000, 2_000, 3_000, 5_000, 7_000];
  let index = 0;
  const nowFn = () => ticks[index++];

  const result = await runBench({ endpoint, model: 'm', client, admitFn: fakeAdmit, nowFn });
  assert.equal(result.singleTokPerSec, 64);
  // aggregate = 4 x 16 tokens / 2s = 32 tok/s — measured, not 64 x 4 = 256.
  assert.equal(result.aggregateTokPerSec, 32);
  assert.ok(result.aggregateTokPerSec < result.singleTokPerSec * result.concurrency);
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
