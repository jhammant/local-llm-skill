// Shared OpenAI-compatible HTTP surface. Every backend here speaks
// /v1/chat/completions (and usually /v1/embeddings), so the wire code lives
// exactly once and the providers only differ in discovery and control.
import { performance } from 'node:perf_hooks';

export function requireEndpoint(endpoint) {
  if (!endpoint || typeof endpoint.baseUrl !== 'string') {
    throw new Error('An endpoint object with baseUrl is required');
  }
}

function headersFor(endpoint, extra = {}) {
  return {
    accept: 'application/json',
    ...(endpoint.apiKey ? { authorization: `Bearer ${endpoint.apiKey}` } : {}),
    ...extra,
  };
}

export async function requestJson(endpoint, pathname, init = {}, options = {}) {
  requireEndpoint(endpoint);
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    throw new Error('No fetch implementation is available');
  }
  const url = `${endpoint.baseUrl.replace(/\/+$/, '')}${pathname}`;
  let response;
  try {
    response = await fetchFn(url, {
      ...init,
      headers: headersFor(endpoint, init.headers),
    });
  } catch (error) {
    throw new Error(`Request to endpoint "${endpoint.id}" failed: ${error.message}`, {
      cause: error,
    });
  }
  const body = await response.text();
  if (!response.ok) {
    throw new Error(
      `Endpoint "${endpoint.id}" returned HTTP ${response.status}: ${body}`,
    );
  }
  try {
    return body ? JSON.parse(body) : {};
  } catch (error) {
    throw new Error(
      `Endpoint "${endpoint.id}" returned invalid JSON: ${error.message}`,
      { cause: error },
    );
  }
}

export const REASONING_EFFORTS = ['none', 'low', 'medium', 'high'];

// Opt-in only: the field is omitted entirely when unset, because servers
// fronting non-thinking models may reject an unknown reasoning_effort value.
export function validateReasoningEffort(value) {
  if (!REASONING_EFFORTS.includes(value)) {
    throw new Error(
      `Invalid reasoning effort "${value}". Valid options: ${REASONING_EFFORTS.join(', ')}`,
    );
  }
  return value;
}

export async function chat(
  endpoint,
  { model, messages, tools, temperature, maxTokens, reasoningEffort, signal },
  options = {},
) {
  const started = performance.now();
  const payload = {
    model,
    messages,
    stream: false,
    ...(tools == null ? {} : { tools }),
    ...(temperature == null ? {} : { temperature }),
    ...(maxTokens == null ? {} : { max_tokens: maxTokens }),
    ...(reasoningEffort == null ? {} : { reasoning_effort: validateReasoningEffort(reasoningEffort) }),
  };
  const response = await requestJson(endpoint, '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  }, options);
  const message = response?.choices?.[0]?.message;
  if (!message) {
    throw new Error(`Endpoint "${endpoint.id}" returned no chat message`);
  }
  return {
    message,
    usage: response.usage ?? null,
    ms: Math.round(performance.now() - started),
  };
}

export async function embed(endpoint, { model, input, signal }, options = {}) {
  return requestJson(endpoint, '/v1/embeddings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, input }),
    signal,
  }, options);
}
