// Generic OpenAI-compatible provider — the lowest common denominator. It
// covers vLLM, llama.cpp server, LiteLLM and remote hosts. Such a server can
// serve requests but cannot report model sizes or loaded state, so admission
// control is impossible here and every management verb fails loudly rather
// than pretending.
import { requestJson, chat as httpChat, embed as httpEmbed } from './http.mjs';

export const kind = 'openai';
export const capabilities = Object.freeze({
  sizes: false,
  loadedState: false,
  load: false,
  unload: false,
  embed: false,
  toolInfo: false,
});

export async function listModels(endpoint, options = {}) {
  const payload = await requestJson(endpoint, '/v1/models', { method: 'GET' }, options);
  if (!Array.isArray(payload?.data)) {
    throw new Error(`Endpoint "${endpoint.id}" returned an invalid model list`);
  }
  return payload.data.map((model) => ({
    id: model.id,
    type: null,
    arch: null,
    quantization: null,
    state: null,
    maxContext: null,
    capabilities: [],
    sizeGb: null,
  }));
}

function unmanaged(endpoint, operation) {
  throw new Error(
    `Endpoint "${endpoint.id}" is a generic OpenAI-compatible server and does not report ${operation}`,
  );
}

export async function ps(endpoint) {
  unmanaged(endpoint, 'loaded state');
}

export async function load(endpoint) {
  unmanaged(endpoint, 'explicit model loading');
}

export async function unload(endpoint) {
  unmanaged(endpoint, 'explicit model unloading');
}

export async function chat(endpoint, req, options = {}) {
  return httpChat(endpoint, req, options);
}

export async function embed(endpoint, req, options = {}) {
  return httpEmbed(endpoint, req, options);
}
