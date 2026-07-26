import * as lmstudio from './lmstudio.mjs';
import { selectModel } from './catalog.mjs';
import { admit, touch } from './ration.mjs';

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
  client = lmstudio,
  selectModelFn = selectModel,
  admitFn = admit,
  touchFn = touch,
  admissionOptions = {},
  touchOptions = {},
} = {}) {
  if (!endpoint || typeof endpoint !== 'object') {
    throw new Error('An endpoint object is required');
  }
  if (typeof prompt !== 'string' || prompt.length === 0) {
    throw new Error('A prompt is required');
  }

  let modelId = model;
  if (!modelId) {
    const selected = await selectModelFn({
      class: uncensored ? 'security' : (jobClass ?? 'workhorse'),
      endpoint,
      requireTools: Array.isArray(tools) && tools.length > 0,
      client,
      admissionOptions,
    });
    modelId = selected.id;
  }

  const admission = await admitFn(endpoint, modelId, {
    ...admissionOptions,
    client,
  });
  if (!admission.ok) {
    throw new Error(`Cannot admit model "${modelId}": ${admission.reason}`);
  }
  let lruIdentifier = modelId;
  if (typeof client.ps === 'function') {
    const loaded = await client.ps(endpoint);
    const match = loaded.find(
      (entry) => entry.model === modelId || entry.identifier === modelId,
    );
    if (match) lruIdentifier = match.identifier;
  }

  const messages = [
    ...(system == null ? [] : [{ role: 'system', content: system }]),
    { role: 'user', content: prompt },
  ];
  const result = await client.chat(endpoint, {
    model: modelId,
    messages,
    tools,
    temperature,
    maxTokens,
    reasoningEffort,
    signal,
  });
  await touchFn(endpoint, lruIdentifier, touchOptions);

  return {
    model: modelId,
    response: result.message?.content ?? result.message,
    usage: result.usage ?? null,
    ms: result.ms,
  };
}
