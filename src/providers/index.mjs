// The ONLY place that maps an endpoint to a backend. Nothing outside
// src/providers/ may know which backend it is talking to — every other module
// goes through resolve() and can().
import * as lmstudio from './lmstudio.mjs';
import * as ollama from './ollama.mjs';
import * as openai from './openai.mjs';
import * as aiod from './aiod.mjs';

const PROVIDERS = Object.freeze({
  lmstudio,
  ollama,
  openai,
  aiod,
});

export const KINDS = Object.freeze(Object.keys(PROVIDERS));

// Back-compat is mandatory: an endpoint entry with no `kind` predates the
// multi-backend registry and is an LM Studio endpoint.
export function resolve(endpoint) {
  const kind = endpoint?.kind ?? 'lmstudio';
  const provider = PROVIDERS[kind];
  if (!provider) {
    throw new Error(
      `Unknown endpoint kind "${kind}"${endpoint?.id ? ` on endpoint "${endpoint.id}"` : ''}. Known kinds: ${KINDS.join(', ')}`,
    );
  }
  return provider;
}

export function can(endpoint, capability) {
  return resolve(endpoint).capabilities[capability] === true;
}
