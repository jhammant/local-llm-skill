// Constrained-output repair. Observed on a real 3,803-item classification run:
// 88 items (2.3%) came back unusable because a 4-bit local model wrapped the
// answer in punctuation, markdown, or a sentence despite "reply with one word".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAnswer } from '../src/batch.mjs';

const CATS = ['feature', 'bugfix', 'refactor', 'docs', 'test', 'infra', 'release'];

test('exact answers pass through', () => {
  assert.equal(normalizeAnswer('bugfix', CATS), 'bugfix');
  assert.equal(normalizeAnswer('  BUGFIX\n', CATS), 'bugfix');
});

test('punctuation and markdown are stripped', () => {
  for (const raw of ['bugfix.', '**bugfix**', '`bugfix`', '"bugfix"', 'bugfix,']) {
    assert.equal(normalizeAnswer(raw, CATS), 'bugfix', `failed on ${raw}`);
  }
});

test('a leading answer followed by chatter is recovered', () => {
  assert.equal(normalizeAnswer('bugfix\n\nThis fixes a broken window.', CATS), 'bugfix');
});

test('a single answer embedded in a sentence is recovered', () => {
  assert.equal(normalizeAnswer('The category is bugfix', CATS), 'bugfix');
});

test('genuinely ambiguous answers are REJECTED, not guessed', () => {
  // two permitted values present — guessing here would silently corrupt the data
  assert.equal(normalizeAnswer('could be feature or bugfix', CATS), null);
  assert.equal(normalizeAnswer('', CATS), null);
  assert.equal(normalizeAnswer('banana', CATS), null);
  assert.equal(normalizeAnswer(null, CATS), null);
});

test('canonical casing from the allowed list is returned, not the model casing', () => {
  assert.equal(normalizeAnswer('BugFix', ['bugFix', 'feature']), 'bugFix');
});

test('no allowed list means no normalization', () => {
  assert.equal(normalizeAnswer('anything', []), null);
  assert.equal(normalizeAnswer('anything', null), null);
});
