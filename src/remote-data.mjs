export function isBurstEndpoint(endpoint) {
  return endpoint?.kind === 'aiod'
    || endpoint?.control === 'aiod'
    || endpoint?.id === 'burst';
}

export function requireRemoteDataOptIn(endpoint, allowed) {
  if (isBurstEndpoint(endpoint) && allowed !== true) {
    throw new Error(
      'Refusing to send data to the public burst endpoint without --allow-remote-data on this run',
    );
  }
}
