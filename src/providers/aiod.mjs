// aiod provider: an OpenAI-compatible endpoint whose lifecycle is controlled
// by the separate `aiod` CLI. Provisioning stays in src/aiod.mjs; the provider
// surface keeps ask/batch/bench backend-agnostic.
import { requestJson } from './http.mjs';
import {
  chat as aiodChat,
  embed as aiodEmbed,
  status as aiodStatus,
} from '../aiod.mjs';

export const kind = 'aiod';
export const capabilities = Object.freeze({
  sizes: false,
  loadedState: false,
  load: false,
  unload: false,
  embed: true,
  toolInfo: false,
});

function requireRemoteDataOptIn(endpoint, request) {
  if (request?.allowRemoteData !== true) {
    throw new Error(
      `Endpoint "${endpoint.id}" is a public burst endpoint. Refusing to send data without --allow-remote-data on this run`,
    );
  }
}

function requireBearerToken(endpoint) {
  if (typeof endpoint?.apiKey !== 'string' || endpoint.apiKey === '') {
    throw new Error(
      `Burst endpoint "${endpoint?.id ?? 'burst'}" has no bearer token; refusing to send data to a public unauthenticated endpoint`,
    );
  }
}

export async function listModels(endpoint, options = {}) {
  requireBearerToken(endpoint);
  const payload = await requestJson(endpoint, '/v1/models', { method: 'GET' }, options);
  if (!Array.isArray(payload?.data)) {
    throw new Error(`Burst endpoint "${endpoint.id}" returned an invalid model list`);
  }
  return payload.data.map((model) => ({
    id: model.id,
    type: 'llm',
    arch: null,
    quantization: endpoint.quant ?? null,
    state: 'loaded',
    maxContext: null,
    capabilities: [],
    sizeGb: null,
  }));
}

export async function ps(endpoint, options = {}) {
  const current = await aiodStatus({
    ...options,
    ...(endpoint.binary == null ? {} : { binary: endpoint.binary }),
  });
  if (!current.running || !current.model) return [];
  return [{
    identifier: current.model,
    model: current.model,
    status: current.state ?? 'running',
    sizeGb: null,
    context: null,
    parallel: null,
  }];
}

function unmanaged(endpoint, operation) {
  throw new Error(
    `Endpoint "${endpoint.id}" is managed by "local-llm burst" and cannot ${operation} through model residency controls`,
  );
}

export async function load(endpoint) {
  unmanaged(endpoint, 'load models');
}

export async function unload(endpoint) {
  unmanaged(endpoint, 'unload models');
}

export async function chat(endpoint, request, options = {}) {
  requireRemoteDataOptIn(endpoint, request);
  requireBearerToken(endpoint);
  return aiodChat(endpoint, request, options);
}

export async function embed(endpoint, request, options = {}) {
  requireRemoteDataOptIn(endpoint, request);
  requireBearerToken(endpoint);
  return aiodEmbed(endpoint, request, options);
}
