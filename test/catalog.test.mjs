import test from 'node:test';
import assert from 'node:assert/strict';
import { selectModel } from '../src/catalog.mjs';

const endpoint = {
  id: 'test',
  label: 'Test',
  baseUrl: 'http://invalid.test',
  apiKey: null,
  control: 'none',
  capacityGb: null,
};

const admissible = async (_endpoint, _id, options) => {
  assert.equal(options.dryRun, true);
  return { ok: true, action: 'already-loaded', evicted: [], reason: 'test' };
};

function clientWith(models) {
  return {
    async listModels(receivedEndpoint) {
      assert.equal(receivedEndpoint, endpoint);
      return models;
    },
  };
}

test('selection uses the next preference when the first model is absent', async () => {
  const secondPreference = {
    id: 'qwen/qwen3.6-27b',
    type: 'llm',
    capabilities: [],
    sizeGb: 17,
  };
  const result = await selectModel({
    class: 'workhorse',
    endpoint,
    client: clientWith([secondPreference]),
    admitFn: admissible,
  });
  assert.equal(result.id, secondPreference.id);
  assert.equal(result.class, 'workhorse');
});

test('selection falls back to the next smaller class', async () => {
  const reflex = {
    id: 'google/gemma-3-4b',
    type: 'llm',
    capabilities: [],
    sizeGb: 4,
  };
  const result = await selectModel({
    class: 'coder',
    endpoint,
    client: clientWith([reflex]),
    admitFn: admissible,
  });
  // The coder class requires tool_use, which this model lacks, so selection must
  // fall back rather than fail. Which lower class it lands in is an implementation
  // detail; what matters is that it picked the one admissible model and said so.
  assert.equal(result.id, reflex.id);
  assert.equal(result.requestedClass, 'coder');
  assert.notEqual(result.class, 'coder');
  assert.match(result.why, /fell back from coder/);
});

test('selection works on a catalog of models it has never seen', async () => {
  // The whole point of capability-based selection: unknown ids must still work.
  const unknown = [
    { id: 'someorg/brand-new-70b', type: 'llm', capabilities: ['tool_use'], sizeGb: 40, quantization: '4bit' },
    { id: 'someorg/brand-new-3b', type: 'llm', capabilities: [], sizeGb: 2, quantization: '4bit' },
  ];
  const coder = await selectModel({ class: 'coder', endpoint, client: clientWith(unknown), admitFn: admissible });
  assert.equal(coder.id, 'someorg/brand-new-70b', 'coder needs tool_use, only the 70b has it');

  const reflex = await selectModel({ class: 'reflex', endpoint, client: clientWith(unknown), admitFn: admissible });
  assert.equal(reflex.id, 'someorg/brand-new-3b', 'reflex prefers the smallest viable model');
});

test('an empty catalog fails with a clear message, not a crash', async () => {
  await assert.rejects(
    () => selectModel({ class: 'workhorse', endpoint, client: clientWith([]), admitFn: admissible }),
    /no models reported by the endpoint/,
  );
});

test('a backend with toolInfo:false does not hard-filter on tool_use and says so in why', async () => {
  // A generic OpenAI-compatible server cannot report capabilities. That must
  // not exclude every model from tool-requiring classes — absence of
  // information is not denial.
  const client = {
    capabilities: Object.freeze({
      sizes: false, loadedState: false, load: false, unload: false,
      embed: false, toolInfo: false,
    }),
    async listModels() {
      return [
        { id: 'some/chat-model', type: 'llm', capabilities: [], sizeGb: null },
        { id: 'other/coder-model', type: 'llm', capabilities: [], sizeGb: null },
      ];
    },
  };
  const selected = await selectModel({ class: 'coder', endpoint, client });
  assert.equal(selected.id, 'other/coder-model');
  assert.equal(selected.class, 'coder', 'no fall-through to a lesser class');
  assert.match(selected.why, /tool support unverified \(backend does not report capabilities\)/);
});

test('security models are never selected unless security is explicit', async () => {
  const security = {
    id: 'qwen3.6-35b-a3b-abliterated-heretic-mlx',
    type: 'llm',
    capabilities: [],
    sizeGb: 30,
  };
  const client = clientWith([security]);

  await assert.rejects(
    selectModel({
      endpoint,
      client,
      admitFn: admissible,
    }),
    /No admissible model found for class "workhorse"/,
  );

  const selected = await selectModel({
    class: 'security',
    endpoint,
    client,
    admitFn: admissible,
  });
  assert.equal(selected.id, security.id);
  assert.equal(selected.class, 'security');
});
