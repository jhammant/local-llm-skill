import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve, can } from '../src/providers/index.mjs';
import * as shim from '../src/lmstudio.mjs';
import * as moved from '../src/providers/lmstudio.mjs';
import * as ollama from '../src/providers/ollama.mjs';
import { detectEndpoints, listEndpoints } from '../src/endpoints.mjs';
import { admit, budget, pinModel } from '../src/ration.mjs';
import { scoreCandidates, selectModel, JOB_CLASSES } from '../src/catalog.mjs';

const GB = 1024 ** 3;

const ollamaEndpoint = {
  id: 'ollama',
  kind: 'ollama',
  label: 'Ollama',
  baseUrl: 'http://fake-ollama.test',
  apiKey: null,
  control: 'cli',
  capacityGb: null,
};

// A fake provider that cannot report sizes or loaded state — the shape any
// generic OpenAI-compatible server has.
function unmanagedClient() {
  return {
    capabilities: Object.freeze({
      sizes: false,
      loadedState: false,
      load: false,
      unload: false,
      embed: false,
    }),
    async ps() {
      throw new Error('ps must never be called on an unmanaged backend');
    },
    async listModels() {
      throw new Error('listModels must never be called by admission on an unmanaged backend');
    },
  };
}

async function rationFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'local-llm-providers-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, 'config.json');
  const pinsPath = join(directory, 'pins.json');
  const lruPath = join(directory, 'lru.json');
  await writeFile(pinsPath, JSON.stringify([]));
  await writeFile(lruPath, JSON.stringify({}));
  return {
    totalMemBytes: 128 * GB,
    wiredLimitMb: 0,
    env: {},
    configPath,
    pinsPath,
    lruPath,
  };
}

function fakeFetch(routes, captured = []) {
  return async (url, init = {}) => {
    captured.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    const route = Object.entries(routes).find(([path]) => url.endsWith(path));
    if (!route) {
      return { ok: false, status: 404, async text() { return 'not found'; } };
    }
    return { ok: true, status: 200, async text() { return JSON.stringify(route[1]); } };
  };
}

// 1. back-compat: an endpoint with no `kind` resolves to the lmstudio
// provider, and the old import path still works.
test('an endpoint without a kind resolves to the lmstudio provider', () => {
  const legacy = { id: 'local', baseUrl: 'http://127.0.0.1:1234', control: 'cli' };
  assert.equal(resolve(legacy).kind, 'lmstudio');
  assert.equal(resolve({ kind: 'ollama' }).kind, 'ollama');
  assert.equal(resolve({ kind: 'openai' }).kind, 'openai');
  assert.equal(can(legacy, 'sizes'), true);
  assert.equal(can({ kind: 'openai' }, 'sizes'), false);
  assert.equal(can({ kind: 'openai' }, 'loadedState'), false);
  assert.throws(() => resolve({ kind: 'wat' }), /Unknown endpoint kind "wat"/);
});

test('src/lmstudio.mjs is a thin re-export of src/providers/lmstudio.mjs', () => {
  for (const name of [
    'listModels', 'ps', 'load', 'unload', 'chat', 'embed',
    'parsePsOutput', 'parseLsOutput', 'stripAnsi', 'resolveLms',
    'validateReasoningEffort', 'REASONING_EFFORTS',
  ]) {
    assert.equal(shim[name], moved[name], `shim must re-export ${name}`);
  }
});

// 2. ollama parsing: /api/tags sizes map bytes -> GB; an empty /api/ps is
// the normal "nothing resident" case.
test('ollama /api/tags maps byte sizes and details onto the model shape', async () => {
  const fetchFn = fakeFetch({
    '/api/tags': {
      models: [
        {
          name: 'qwen3:8b',
          size: 5_220_800_000,
          details: { family: 'qwen3', quantization_level: 'Q4_K_M', parameter_size: '8.2B' },
        },
        {
          name: 'nomic-embed-text:latest',
          size: 274_300_000,
          details: { family: 'nomic-bert', quantization_level: 'F16', parameter_size: '137M' },
        },
      ],
    },
  });
  const models = await ollama.listModels(ollamaEndpoint, { fetchFn });
  assert.equal(models.length, 2);
  assert.equal(models[0].id, 'qwen3:8b');
  assert.equal(models[0].sizeGb, 5.2208);
  assert.equal(models[0].quantization, 'Q4_K_M');
  assert.equal(models[0].type, 'llm');
  assert.equal(models[1].type, 'embeddings', 'nomic-bert family marks an embedding model');
});

test('ollama /api/ps with {"models":[]} yields an empty loaded list, not an error', async () => {
  const fetchFn = fakeFetch({ '/api/ps': { models: [] } });
  assert.deepEqual(await ollama.ps(ollamaEndpoint, { fetchFn }), []);

  const busy = fakeFetch({
    '/api/ps': { models: [{ name: 'qwen3:8b', model: 'qwen3:8b', size: 5_220_800_000 }] },
  });
  const loaded = await ollama.ps(ollamaEndpoint, { fetchFn: busy });
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].identifier, 'qwen3:8b');
  assert.equal(loaded[0].sizeGb, 5.2208);
});

// 3. ollama unload issues keep_alive: 0 — there is no unload endpoint.
test('ollama unload sends keep_alive: 0, never an unload endpoint', async () => {
  const captured = [];
  const fetchFn = fakeFetch({ '/api/chat': {} }, captured);
  await ollama.unload(ollamaEndpoint, 'qwen3:8b', { fetchFn });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].body.keep_alive, 0);
  assert.equal(captured[0].body.model, 'qwen3:8b');
  assert.ok(!captured[0].url.includes('unload'), 'Ollama has no unload endpoint');

  captured.length = 0;
  await ollama.load(ollamaEndpoint, 'qwen3:8b', {}, { fetchFn });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].body.keep_alive, '5m');
  assert.equal(captured[0].body.model, 'qwen3:8b');
});

// 4. unmanaged degradation: budget reports managed:false with nulls, admit
// steps aside with ok:true, nothing throws, nothing is invented.
test('an unmanaged backend degrades budget and admit without throwing', async (t) => {
  const options = await rationFixture(t);
  const endpoint = { id: 'remote', kind: 'openai', baseUrl: 'http://fake.test', control: 'none' };
  const client = unmanagedClient();

  const report = await budget(endpoint, { ...options, client });
  assert.equal(report.managed, false);
  assert.equal(report.usedGb, null);
  assert.equal(report.freeGb, null);
  assert.equal(report.totalGb, 128, 'host-level figures may still be reported');
  assert.deepEqual(report.loaded, []);

  const plan = await admit(endpoint, 'any/model', { ...options, client });
  assert.deepEqual(plan, {
    ok: true,
    action: 'unmanaged',
    evicted: [],
    reason: 'backend does not report sizes',
  });

  // The same degradation holds when the provider is resolved from the
  // endpoint kind, with no client injected and no network touched.
  const resolved = await admit(endpoint, 'any/model', options);
  assert.equal(resolved.ok, true);
  assert.equal(resolved.action, 'unmanaged');

  await assert.rejects(
    pinModel(endpoint, 'any/model', { ...options, client }),
    /does not report model sizes or loaded state/,
  );
});

// 5. catalog selection without sizes still returns a model, says so in why,
// and a null size never sorts as smallest.
test('catalog without sizes selects on hints and says so in why', async () => {
  const endpoint = { id: 'remote', kind: 'openai', baseUrl: 'http://fake.test', control: 'none' };
  const client = {
    ...unmanagedClient(),
    async listModels() {
      return [
        { id: 'some/chat-model', type: 'llm', capabilities: [], sizeGb: null, quantization: 'Q4_K_M' },
        { id: 'other/instruct-model', type: 'llm', capabilities: [], sizeGb: null, quantization: null },
      ];
    },
  };
  const selected = await selectModel({
    class: 'reflex',
    endpoint,
    client,
    admitFn: async () => {
      throw new Error('admission must be skipped when sizes are unavailable');
    },
  });
  assert.equal(selected.id, 'some/chat-model');
  assert.match(selected.why, /without size information/);
});

test('a null size never sorts as smallest', () => {
  const ranked = scoreCandidates(
    [
      { id: 'unknown-size', sizeGb: null },
      { id: 'known-size', sizeGb: 5 },
    ],
    JOB_CLASSES.reflex,
    Infinity,
  );
  assert.equal(ranked[0].model.id, 'known-size');
  assert.equal(ranked[1].model.id, 'unknown-size');
});

// 6. auto-detection registers whichever backends answer, both or neither.
test('auto-detection registers both backends when both probes succeed', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'local-llm-detect-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fetchFn = async () => ({ ok: true });

  const detected = await detectEndpoints({ fetchFn });
  assert.deepEqual(detected.map((endpoint) => endpoint.id), ['local', 'ollama']);
  assert.equal(detected[0].kind, 'lmstudio');
  assert.equal(detected[1].kind, 'ollama');

  const endpoints = await listEndpoints({ configPath: join(directory, 'missing.json'), fetchFn });
  assert.deepEqual(endpoints.map((endpoint) => endpoint.id), ['local', 'ollama']);
});

test('auto-detection registers nothing when both probes fail, without throwing', async () => {
  const fetchFn = async () => {
    throw new Error('connection refused');
  };
  assert.deepEqual(await detectEndpoints({ fetchFn }), []);
});
