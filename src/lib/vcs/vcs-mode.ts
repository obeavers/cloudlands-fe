/** Capability input is the acknowledged server.capabilities snapshot, never task evidence. */
export type VcsMode =
  | { mode: 'legacy-git'; kind: 'git' }
  | { mode: 'native'; kind: 'git' | 'atomic' }
  | {
      mode: 'unavailable';
      reason: 'unknown-engine' | 'unsupported-version' | 'atomic-unavailable';
    };

export function supportsNeutralCapability(
  capabilities: Record<string, unknown> | null,
  key: 'vcs' | 'workEvidence' | 'knowledge' | 'atomic',
): boolean {
  return capabilities?.[key] === 1;
}

export function resolveVcsMode(
  kind: unknown,
  capabilities: Record<string, unknown> | null,
): VcsMode {
  if (kind !== undefined && kind !== 'git' && kind !== 'atomic')
    return { mode: 'unavailable', reason: 'unknown-engine' };
  const selected = kind ?? 'git';
  for (const key of ['vcs', ...(selected === 'atomic' ? ['atomic'] : [])]) {
    const value = capabilities?.[key];
    if (value !== undefined && value !== 1)
      return { mode: 'unavailable', reason: 'unsupported-version' };
  }
  if (selected === 'atomic')
    return supportsNeutralCapability(capabilities, 'vcs') &&
      supportsNeutralCapability(capabilities, 'atomic')
      ? { mode: 'native', kind: 'atomic' }
      : { mode: 'unavailable', reason: 'atomic-unavailable' };
  return supportsNeutralCapability(capabilities, 'vcs')
    ? { mode: 'native', kind: 'git' }
    : { mode: 'legacy-git', kind: 'git' };
}
