import { resolve } from './providers/index.mjs';
import { selectModel } from './catalog.mjs';
import { admit, touch } from './ration.mjs';
import { requireRemoteDataOptIn } from './remote-data.mjs';

export async function ask({
  endpoint,
  prompt,
  class: jobClass,
  model,
  uncensored = false,
  system,
  tools,
  temperature,
  maxTokens,
  reasoningEffort,
  signal,
  client = null,
  selectModelFn = selectModel,
  admitFn = admit,
  touchFn = touch,
  admissionOptions = {},
  touchOptions = {},
  allowRemoteData = false,
} = {}) {
  if (!endpoint || typeof endpoint !== 'object') {
    throw new Error('An endpoint object is required');
  }
  if (typeof prompt !== 'string' || prompt.length === 0) {
    throw new Error('A prompt is required');
  }
  requireRemoteDataOptIn(endpoint, allowRemoteData);

  const provider = client ?? resolve(endpoint);

  let modelId = model;
  if (!modelId) {
    const selected = await selectModelFn({
      class: uncensored ? 'security' : (jobClass ?? 'workhorse'),
      endpoint,
      requireTools: Array.isArray(tools) && tools.length > 0,
      client: provider,
      admissionOptions,
    });
    modelId = selected.id;
  }

  const admission = await admitFn(endpoint, modelId, {
    ...admissionOptions,
    client: provider,
  });
  if (!admission.ok) {
    throw new Error(`Cannot admit model "${modelId}": ${admission.reason}`);
  }
  let lruIdentifier = modelId;
  if (typeof provider.ps === 'function' && provider.capabilities?.loadedState !== false) {
    const loaded = await provider.ps(endpoint);
    const match = loaded.find(
      (entry) => entry.model === modelId || entry.identifier === modelId,
    );
    if (match) lruIdentifier = match.identifier;
  }

  const messages = [
    ...(system == null ? [] : [{ role: 'system', content: system }]),
    { role: 'user', content: prompt },
  ];
  const result = await provider.chat(endpoint, {
    model: modelId,
    messages,
    tools,
    temperature,
    maxTokens,
    reasoningEffort,
    signal,
    allowRemoteData,
  });
  await touchFn(endpoint, lruIdentifier, touchOptions);

  return {
    model: modelId,
    response: result.message?.content ?? result.message,
    usage: result.usage ?? null,
    ms: result.ms,
  };
}
