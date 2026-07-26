// Ollama provider. Discovery is the native API: /api/tags reports sizes in
// bytes and /api/ps reports resident models. There is NO explicit load or
// unload endpoint — a model is resident-loaded by issuing a request with
// keep_alive set, and evicted by issuing a request with keep_alive: 0.
// Chat and embeddings ride the shared OpenAI-compatible client.
import { requestJson, chat as httpChat, embed as httpEmbed } from './http.mjs';

export const kind = 'ollama';
export const capabilities = Object.freeze({
  sizes: true,
  loadedState: true,
  load: true,
  unload: true,
  embed: true,
});

const EMBED_FAMILIES = new Set(['nomic-bert', 'bert']);

// Ollama does not report a model type the way LM Studio does, so embedding
// models are detected by family, with a name hint as a fallback.
function detectType(name, family) {
  if (EMBED_FAMILIES.has(String(family ?? '').toLowerCase())) return 'embeddings';
  if (/embed/i.test(name)) return 'embeddings';
  return 'llm';
}

function toSizeGb(bytes) {
  return typeof bytes === 'number' && Number.isFinite(bytes) ? bytes / 1e9 : null;
}

export async function listModels(endpoint, options = {}) {
  const payload = await requestJson(endpoint, '/api/tags', { method: 'GET' }, options);
  if (!Array.isArray(payload?.models)) {
    throw new Error(`Ollama endpoint "${endpoint.id}" returned an invalid model list`);
  }
  return payload.models.map((model) => ({
    id: model.name,
    type: detectType(model.name, model.details?.family),
    arch: model.details?.family ?? null,
    quantization: model.details?.quantization_level ?? null,
    state: null,
    maxContext: null,
    capabilities: [],
    sizeGb: toSizeGb(model.size),
    parameterSize: model.details?.parameter_size ?? null,
  }));
}

export async function ps(endpoint, options = {}) {
  const payload = await requestJson(endpoint, '/api/ps', { method: 'GET' }, options);
  if (!Array.isArray(payload?.models)) {
    throw new Error(`Ollama endpoint "${endpoint.id}" returned an invalid loaded-model list`);
  }
  // An empty list is the normal "nothing resident" case, not an error.
  return payload.models.map((model) => ({
    identifier: model.model ?? model.name,
    model: model.name,
    status: 'loaded',
    sizeGb: toSizeGb(model.size),
    context: model.context_length ?? null,
    parallel: null,
  }));
}

// keep_alive is the ONLY residency control Ollama has. A chat request with a
// minimal prompt pulls the model into memory; keep_alive: 0 evicts it.
async function keepAliveRequest(endpoint, modelId, keepAlive, options) {
  await requestJson(endpoint, '/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
      keep_alive: keepAlive,
    }),
  }, options);
}

export async function load(endpoint, modelId, { identifier = modelId, keepAlive = '5m' } = {}, options = {}) {
  await keepAliveRequest(endpoint, modelId, keepAlive, options);
  return { model: modelId, identifier };
}

export async function unload(endpoint, identifier, options = {}) {
  await keepAliveRequest(endpoint, identifier, 0, options);
  return { identifier };
}

export async function chat(endpoint, req, options = {}) {
  return httpChat(endpoint, req, options);
}

export async function embed(endpoint, req, options = {}) {
  return httpEmbed(endpoint, req, options);
}
