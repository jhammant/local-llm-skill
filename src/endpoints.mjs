import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { KINDS } from './providers/index.mjs';
import { burstEndpoint } from './aiod.mjs';

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

export const BURST_ENDPOINT = Object.freeze({
  id: 'burst',
  kind: 'aiod',
  label: 'aiod (vast.ai)',
  baseUrl: null,
  apiKey: null,
  control: 'aiod',
  capacityGb: null,
  profile: 'qwen3-coder-30b',
  model: null,
  quant: 'fp8',
  maxPricePerHour: 3,
  idleMinutes: null,
  ttlHours: null,
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
  const kind = endpoint.kind ?? 'lmstudio';
  const control = endpoint.control ?? (kind === 'openai' ? 'none' : 'cli');
  if (
    (typeof endpoint.baseUrl !== 'string' || endpoint.baseUrl.length === 0)
    && !(kind === 'aiod' && control === 'aiod')
  ) {
    throw new Error(`Invalid endpoint "${endpoint.id}" in ${source}: "baseUrl" is required`);
  }
  // Back-compat: entries written before multi-backend support have no `kind`
  // and are LM Studio endpoints.
  if (!KINDS.includes(kind)) {
    throw new Error(
      `Invalid endpoint "${endpoint.id}" in ${source}: kind must be one of ${KINDS.join(', ')}`,
    );
  }
  if (!['cli', 'jit', 'none', 'aiod'].includes(control)) {
    throw new Error(
      `Invalid endpoint "${endpoint.id}" in ${source}: control must be "cli", "jit", "none", or "aiod"`,
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
    baseUrl: typeof endpoint.baseUrl === 'string'
      ? endpoint.baseUrl.replace(/\/+$/, '')
      : null,
    apiKey,
    control,
    capacityGb: endpoint.capacityGb ?? null,
    ...(kind === 'aiod'
      ? {
        profile: endpoint.profile ?? 'qwen3-coder-30b',
        model: endpoint.model ?? null,
        quant: endpoint.quant ?? 'fp8',
        maxPricePerHour: endpoint.maxPricePerHour ?? 3,
        // Deliberately do not accept idle/TTL values from config. The flags
        // must be present on every invocation that could spend money.
        idleMinutes: null,
        ttlHours: null,
      }
      : {}),
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

async function appendBurstIfAvailable(endpoints, options) {
  const burst = await burstEndpoint(options);
  const index = endpoints.findIndex((endpoint) => endpoint.id === 'burst');
  if (!burst.available) {
    if (index >= 0) endpoints.splice(index, 1);
    return endpoints;
  }
  if (index < 0) {
    endpoints.push({ ...BURST_ENDPOINT, ...burst });
  } else {
    endpoints[index] = {
      ...BURST_ENDPOINT,
      ...endpoints[index],
      ...burst,
      // These remain per-invocation-only, even if present in the file.
      idleMinutes: null,
      ttlHours: null,
    };
  }
  return endpoints;
}

async function readRegistry(options = {}) {
  const path = endpointsPath(options);
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      const detected = await detectEndpoints(options);
      const defaultId = detected[0]?.id ?? null;
      await appendBurstIfAvailable(detected, options);
      return { endpoints: detected, defaultId };
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
  await appendBurstIfAvailable(endpoints, options);
  const ids = new Set();
  for (const endpoint of endpoints) {
    if (ids.has(endpoint.id)) {
      throw new Error(`Endpoint registry ${path} contains duplicate id "${endpoint.id}"`);
    }
    ids.add(endpoint.id);
  }

  if (endpoints.length === 0) return { endpoints, defaultId: null };

  let defaultId = Array.isArray(parsed)
    ? (ids.has('local') ? 'local' : endpoints[0].id)
    : (parsed.default ?? parsed.defaultId ?? (ids.has('local') ? 'local' : endpoints[0].id));
  // An optional configured burst disappearing because aiod is absent is not
  // a malformed registry. Fall back to a free endpoint without error.
  if (!ids.has(defaultId) && defaultId === 'burst') {
    defaultId = ids.has('local') ? 'local' : endpoints[0]?.id ?? null;
  }
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
