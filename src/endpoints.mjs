import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { KINDS } from './providers/index.mjs';

export const LOCAL_ENDPOINT = Object.freeze({
  id: 'local',
  kind: 'lmstudio',
  label: 'LM Studio (this Mac)',
  baseUrl: 'http://127.0.0.1:1234',
  apiKey: null,
  control: 'cli',
  capacityGb: null,
});

export const OLLAMA_ENDPOINT = Object.freeze({
  id: 'ollama',
  kind: 'ollama',
  label: 'Ollama (this Mac)',
  baseUrl: 'http://127.0.0.1:11434',
  apiKey: null,
  control: 'cli',
  capacityGb: null,
});

function endpointsPath(options = {}) {
  return options.configPath
    ?? process.env.LOCAL_LLM_ENDPOINTS_FILE
    ?? join(homedir(), '.config', 'local-llm', 'endpoints.json');
}

function validateEndpoint(endpoint, source) {
  if (!endpoint || typeof endpoint !== 'object') {
    throw new Error(`Invalid endpoint in ${source}: expected an object`);
  }
  if (typeof endpoint.id !== 'string' || endpoint.id.length === 0) {
    throw new Error(`Invalid endpoint in ${source}: "id" is required`);
  }
  if (typeof endpoint.baseUrl !== 'string' || endpoint.baseUrl.length === 0) {
    throw new Error(`Invalid endpoint "${endpoint.id}" in ${source}: "baseUrl" is required`);
  }
  // Back-compat: entries written before multi-backend support have no `kind`
  // and are LM Studio endpoints.
  const kind = endpoint.kind ?? 'lmstudio';
  if (!KINDS.includes(kind)) {
    throw new Error(
      `Invalid endpoint "${endpoint.id}" in ${source}: kind must be one of ${KINDS.join(', ')}`,
    );
  }
  const control = endpoint.control ?? (kind === 'openai' ? 'none' : 'cli');
  if (!['cli', 'jit', 'none'].includes(control)) {
    throw new Error(
      `Invalid endpoint "${endpoint.id}" in ${source}: control must be "cli", "jit", or "none"`,
    );
  }
  // An API key is read from the named environment variable, never stored
  // inline in the registry file.
  const apiKey = endpoint.apiKey
    ?? (endpoint.apiKeyEnv ? process.env[endpoint.apiKeyEnv] : null)
    ?? null;

  return {
    id: endpoint.id,
    kind,
    label: endpoint.label ?? endpoint.id,
    baseUrl: endpoint.baseUrl.replace(/\/+$/, ''),
    apiKey,
    control,
    capacityGb: endpoint.capacityGb ?? null,
  };
}

// Auto-detection, used only when no registry file exists: probe the two
// default ports in parallel and register whichever backend answers. Both may
// be registered simultaneously; neither answering is an empty list, not an
// error.
const PROBES = Object.freeze([
  { endpoint: LOCAL_ENDPOINT, pathname: '/api/v0/models' },
  { endpoint: OLLAMA_ENDPOINT, pathname: '/api/tags' },
]);

async function probeReachable(probe, options) {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  if (typeof fetchFn !== 'function') return false;
  try {
    const response = await fetchFn(`${probe.endpoint.baseUrl}${probe.pathname}`, {
      signal: AbortSignal.timeout(options.probeTimeoutMs ?? 750),
    });
    return Boolean(response?.ok);
  } catch {
    return false;
  }
}

export async function detectEndpoints(options = {}) {
  const results = await Promise.all(
    PROBES.map(async (probe) => (await probeReachable(probe, options) ? { ...probe.endpoint } : null)),
  );
  return results.filter(Boolean);
}

async function readRegistry(options = {}) {
  const path = endpointsPath(options);
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      const detected = await detectEndpoints(options);
      return { endpoints: detected, defaultId: detected[0]?.id ?? null };
    }
    if (error instanceof SyntaxError) {
      throw new Error(`Could not parse endpoint registry ${path}: ${error.message}`, {
        cause: error,
      });
    }
    throw new Error(`Could not read endpoint registry ${path}: ${error.message}`, {
      cause: error,
    });
  }

  const rawEndpoints = Array.isArray(parsed) ? parsed : parsed?.endpoints;
  if (!Array.isArray(rawEndpoints) || rawEndpoints.length === 0) {
    throw new Error(`Endpoint registry ${path} must contain a non-empty endpoint list`);
  }

  const endpoints = rawEndpoints.map((endpoint) => validateEndpoint(endpoint, path));
  const ids = new Set();
  for (const endpoint of endpoints) {
    if (ids.has(endpoint.id)) {
      throw new Error(`Endpoint registry ${path} contains duplicate id "${endpoint.id}"`);
    }
    ids.add(endpoint.id);
  }

  const defaultId = Array.isArray(parsed)
    ? (ids.has('local') ? 'local' : endpoints[0].id)
    : (parsed.default ?? parsed.defaultId ?? (ids.has('local') ? 'local' : endpoints[0].id));
  if (!ids.has(defaultId)) {
    throw new Error(`Endpoint registry ${path} names unknown default endpoint "${defaultId}"`);
  }

  return { endpoints, defaultId };
}

export async function listEndpoints(options = {}) {
  const { endpoints } = await readRegistry(options);
  return endpoints;
}

export async function getEndpoint(id, options = {}) {
  const { endpoints } = await readRegistry(options);
  const endpoint = endpoints.find((candidate) => candidate.id === id);
  if (!endpoint) {
    throw new Error(
      `Unknown endpoint "${id}". Available endpoints: ${endpoints.map((item) => item.id).join(', ')}`,
    );
  }
  return endpoint;
}

export async function defaultEndpoint(options = {}) {
  const { endpoints, defaultId } = await readRegistry(options);
  const endpoint = endpoints.find((candidate) => candidate.id === defaultId);
  if (!endpoint) {
    throw new Error(
      'No endpoints configured and no local backend detected (probed LM Studio on 127.0.0.1:1234 and Ollama on 127.0.0.1:11434)',
    );
  }
  return endpoint;
}
