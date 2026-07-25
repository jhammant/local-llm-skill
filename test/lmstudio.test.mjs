import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePsOutput, stripAnsi } from '../src/lmstudio.mjs';

test('ps parser strips ANSI spinner noise and parses real table rows', () => {
  const output = [
    '\u001b[?25l⠋\u001b[0m Inspecting loaded models',
    '\u001b[1mIDENTIFIER MODEL STATUS SIZE CONTEXT PARALLEL DEVICE TTL\u001b[0m',
    'qwen-worker qwen/qwen3-coder-next LOADED 44.86 GB 32768 4 GPU 55m',
  ].join('\n');

  assert.equal(stripAnsi('\u001b[31mred\u001b[0m'), 'red');
  assert.deepEqual(parsePsOutput(output), [{
    identifier: 'qwen-worker',
    model: 'qwen/qwen3-coder-next',
    status: 'LOADED',
    sizeGb: 44.86,
    context: 32_768,
    parallel: 4,
  }]);
});

test('ps parser returns an empty list for the no-models message', () => {
  assert.deepEqual(
    parsePsOutput('\u001b[36mNo models are currently loaded.\u001b[0m\n'),
    [],
  );
});

test('ps parser tolerates a row with no TTL column', () => {
  const output = [
    'IDENTIFIER MODEL STATUS SIZE CONTEXT PARALLEL DEVICE TTL',
    'gemma google/gemma-3-4b LOADED 3.20 GB 8192 2 GPU',
  ].join('\n');
  assert.deepEqual(parsePsOutput(output), [{
    identifier: 'gemma',
    model: 'google/gemma-3-4b',
    status: 'LOADED',
    sizeGb: 3.2,
    context: 8_192,
    parallel: 2,
  }]);
});
