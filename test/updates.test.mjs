import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkUpdates, DISCLAIMER } from '../src/updates.mjs';

const GB = 1024 ** 3;
const endpoint = {
  id: 'test',
  label: 'Test',
  baseUrl: 'http://invalid.test',
  apiKey: null,
  control: 'cli',
  capacityGb: null,
};

// Budget maths: 128 GB total, wired limit 0 -> 75% ceiling = 96 GB, minus the
// 12 GB reserve => budgetGb = 84. Tests pin these so "fits" is deterministic.
function fakeClient(models = []) {
  return {
    capabilities: { sizes: true, loadedState: true },
    async ps() {
      return [];
    },
    async listModels() {
      return models.map((model) => ({ ...model }));
    },
  };
}

function response(payload) {
  return { ok: true, status: 200, json: async () => payload };
}

// Routes fake HuggingFace API calls by URL. `trending` maps format ('gguf' /
// 'mlx') to a list of { id, downloads }; `details` maps repo id to siblings.
function fakeFetch({ trending = {}, details = {} }) {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    const blobs = url.match(/^https:\/\/huggingface\.co\/api\/models\/(.+)\?blobs=true$/);
    if (blobs) {
      const id = decodeURIComponent(blobs[1]);
      if (!(id in details)) throw new Error(`no detail fixture for ${id}`);
      return response({ id, siblings: details[id] });
    }
    const format = new URL(url).searchParams.get('filter');
    return response(trending[format] ?? []);
  };
  return { calls, fetchFn };
}

async function fixture(t, { models = [], trending = {}, details = {} } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'local-llm-updates-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { calls, fetchFn } = fakeFetch({ trending, details });
  const options = {
    fetchFn,
    cachePath: join(directory, 'updates.json'),
    client: fakeClient(models),
    totalMemBytes: 128 * GB,
    wiredLimitMb: 0,
    env: {},
    configPath: join(directory, 'config.json'),
  };
  return { calls, fetchFn, options };
}

const ggufFile = (name, sizeGb) => ({ rfilename: name, size: Math.round(sizeGb * GB) });

test('a model larger than the memory budget is excluded', async (t) => {
  const { options } = await fixture(t, {
    trending: {
      gguf: [
        { id: 'acme/huge-llm-GGUF', downloads: 9000 },
        { id: 'acme/small-llm-GGUF', downloads: 100 },
      ],
    },
    details: {
      'acme/huge-llm-GGUF': [ggufFile('huge-llm-Q4_K_M.gguf', 100)],
      'acme/small-llm-GGUF': [ggufFile('small-llm-Q4_K_M.gguf', 10)],
    },
  });

  const result = await checkUpdates(endpoint, options);
  assert.equal(result.ok, true);
  assert.equal(result.budgetGb, 84);
  assert.deepEqual(result.updates.map((u) => u.id), ['acme/small-llm-GGUF']);
  assert.equal(result.updates[0].status, 'new');
  assert.equal(result.disclaimer, DISCLAIMER);
  assert.match(result.disclaimer, /not a quality judgement/);
});

test('the largest quantisation that fits is picked per repo', async (t) => {
  const { options } = await fixture(t, {
    trending: { gguf: [{ id: 'acme/multi-llm-GGUF', downloads: 500 }] },
    details: {
      'acme/multi-llm-GGUF': [
        ggufFile('multi-llm-Q4_K_M.gguf', 40),
        ggufFile('multi-llm-Q8_0.gguf', 80),
        ggufFile('multi-llm-F16.gguf', 120),
      ],
    },
  });

  const result = await checkUpdates(endpoint, options);
  assert.equal(result.ok, true);
  assert.equal(result.updates.length, 1);
  assert.equal(result.updates[0].quant, 'q8_0');
  assert.equal(result.updates[0].sizeGb, 80);
});

test('a model already installed at the same quant is not recommended', async (t) => {
  const { options } = await fixture(t, {
    models: [{ id: 'acme/solo-llm', quantization: 'Q4_K_M', sizeGb: 40 }],
    trending: { gguf: [{ id: 'acme/solo-llm-GGUF', downloads: 500 }] },
    details: {
      'acme/solo-llm-GGUF': [ggufFile('solo-llm-Q4_K_M.gguf', 40)],
    },
  });

  const result = await checkUpdates(endpoint, options);
  assert.equal(result.ok, true);
  assert.deepEqual(result.updates, []);
});

test('the same family at a different quantisation is marked newer-quant', async (t) => {
  const { options } = await fixture(t, {
    models: [{ id: 'acme/multi-llm', quantization: 'Q4_K_M', sizeGb: 40 }],
    trending: { gguf: [{ id: 'acme/multi-llm-GGUF', downloads: 500 }] },
    details: {
      'acme/multi-llm-GGUF': [
        ggufFile('multi-llm-Q4_K_M.gguf', 40),
        ggufFile('multi-llm-Q8_0.gguf', 80),
      ],
    },
  });

  const result = await checkUpdates(endpoint, options);
  assert.equal(result.ok, true);
  assert.equal(result.updates.length, 1);
  assert.equal(result.updates[0].status, 'newer-quant');
  assert.equal(result.updates[0].quant, 'q8_0');
  assert.equal(result.updates[0].installedId, 'acme/multi-llm');
  assert.equal(result.updates[0].installedQuant, 'q4_k_m');
});

test('mlx repos are sized from their safetensors and fit-checked', async (t) => {
  const { options } = await fixture(t, {
    trending: { mlx: [{ id: 'mlx-community/fresh-7b-4bit', downloads: 700 }] },
    details: {
      'mlx-community/fresh-7b-4bit': [
        { rfilename: 'model.safetensors', size: 3 * GB },
        { rfilename: 'model-00002.safetensors', size: 1 * GB },
        { rfilename: 'README.md', size: 1234 },
      ],
    },
  });

  const result = await checkUpdates(endpoint, options);
  assert.equal(result.ok, true);
  assert.equal(result.updates.length, 1);
  assert.equal(result.updates[0].format, 'mlx');
  assert.equal(result.updates[0].quant, '4bit');
  assert.ok(Math.abs(result.updates[0].sizeGb - 4) < 0.01);
});

test('a failing fetch produces a message and does not throw', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'local-llm-updates-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = {
    fetchFn: async () => {
      throw new Error('network is down');
    },
    cachePath: join(directory, 'updates.json'),
    client: fakeClient(),
    totalMemBytes: 128 * GB,
    wiredLimitMb: 0,
    env: {},
    configPath: join(directory, 'config.json'),
  };

  const result = await checkUpdates(endpoint, options);
  assert.equal(result.ok, false);
  assert.match(result.message, /network is down/);
  assert.deepEqual(result.updates, []);
});

test('an HTTP error response degrades gracefully', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'local-llm-updates-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = {
    fetchFn: async () => ({ ok: false, status: 429, json: async () => ({}) }),
    cachePath: join(directory, 'updates.json'),
    client: fakeClient(),
    totalMemBytes: 128 * GB,
    wiredLimitMb: 0,
    env: {},
    configPath: join(directory, 'config.json'),
  };

  const result = await checkUpdates(endpoint, options);
  assert.equal(result.ok, false);
  assert.match(result.message, /rate limit/i);
  assert.deepEqual(result.updates, []);
});

test('cached results inside 24h do not trigger a second fetch', async (t) => {
  const fixtureData = {
    trending: { gguf: [{ id: 'acme/small-llm-GGUF', downloads: 100 }] },
    details: { 'acme/small-llm-GGUF': [ggufFile('small-llm-Q4_K_M.gguf', 10)] },
  };
  const first = await fixture(t, fixtureData);

  const fresh = await checkUpdates(endpoint, first.options);
  assert.equal(fresh.ok, true);
  assert.equal(fresh.cached, false);
  assert.ok(first.calls.length > 0);

  // Second call: the fetch fake now throws on ANY call, so a cache miss
  // would degrade — a cached answer proves no fetch happened.
  const cached = await checkUpdates(endpoint, {
    ...first.options,
    fetchFn: async () => {
      throw new Error('must not be called');
    },
  });
  assert.equal(cached.ok, true);
  assert.equal(cached.cached, true);
  assert.deepEqual(cached.updates.map((u) => u.id), ['acme/small-llm-GGUF']);
});

test('a stale cache (older than 24h) is refetched', async (t) => {
  const fixtureData = {
    trending: { gguf: [{ id: 'acme/small-llm-GGUF', downloads: 100 }] },
    details: { 'acme/small-llm-GGUF': [ggufFile('small-llm-Q4_K_M.gguf', 10)] },
  };
  const { calls, fetchFn, options } = await fixture(t, fixtureData);
  const start = Date.now();

  await checkUpdates(endpoint, { ...options, now: start });
  const callsAfterFirst = calls.length;

  const result = await checkUpdates(endpoint, {
    ...options,
    fetchFn,
    now: start + 25 * 60 * 60 * 1_000,
  });
  assert.equal(result.ok, true);
  assert.equal(result.cached, false);
  assert.ok(calls.length > callsAfterFirst);
});
