import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const LOCAL_ENDPOINT = Object.freeze({
  id: 'local',
  label: 'LM Studio (this Mac)',
  baseUrl: 'http://127.0.0.1:1234',
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
  if (!['cli', 'jit', 'none'].includes(endpoint.control)) {
    throw new Error(
      `Invalid endpoint "${endpoint.id}" in ${source}: control must be "cli", "jit", or "none"`,
    );
  }

  return {
    id: endpoint.id,
    label: endpoint.label ?? endpoint.id,
    baseUrl: endpoint.baseUrl.replace(/\/+$/, ''),
    apiKey: endpoint.apiKey ?? null,
    control: endpoint.control,
    capacityGb: endpoint.capacityGb ?? null,
  };
}

async function readRegistry(options = {}) {
  const path = endpointsPath(options);
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { endpoints: [{ ...LOCAL_ENDPOINT }], defaultId: 'local' };
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
  return endpoints.find((endpoint) => endpoint.id === defaultId);
}
