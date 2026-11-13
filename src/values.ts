/** Encode a JSON value or a BiDi shared node as a WebDriver BiDi local value. */
export function toLocalValue(value: unknown): unknown {
  if (value === null) return { type: 'null' };
  if (value === undefined) return { type: 'undefined' };
  if (typeof value === 'string') return { type: 'string', value };
  if (typeof value === 'boolean') return { type: 'boolean', value };
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Firefox script arguments must be finite numbers');
    return { type: 'number', value };
  }
  if (Array.isArray(value)) return { type: 'array', value: value.map(item => toLocalValue(item)) };
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.sharedId === 'string') return { sharedId: record.sharedId };
    return {
      type: 'object',
      value: Object.entries(record).map(([key, entry]) => [key, toLocalValue(entry)]),
    };
  }
  throw new Error('Unsupported Firefox script argument');
}

export function fromRemoteValue(value: unknown, depth = 0): unknown {
  if (depth > 20 || !value || typeof value !== 'object') return value;
  const remote = value as { type?: string; value?: unknown };
  switch (remote.type) {
    case 'null':
      return null;
    case 'undefined':
      return undefined;
    case 'string':
    case 'boolean':
    case 'bigint':
      return remote.value;
    case 'number':
      if (remote.value === 'NaN') return Number.NaN;
      if (remote.value === 'Infinity') return Number.POSITIVE_INFINITY;
      if (remote.value === '-Infinity') return Number.NEGATIVE_INFINITY;
      if (remote.value === '-0') return -0;
      return remote.value;
    case 'array':
      return Array.isArray(remote.value) ? remote.value.map(item => fromRemoteValue(item, depth + 1)) : [];
    case 'object':
    case 'map': {
      const result: Record<string, unknown> = {};
      if (Array.isArray(remote.value)) {
        for (const entry of remote.value) {
          if (!Array.isArray(entry)) continue;
          result[String(fromRemoteValue(entry[0], depth + 1))] = fromRemoteValue(entry[1], depth + 1);
        }
      }
      return result;
    }
    default:
      return null;
  }
}

export function bytesValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  const record = value as { type?: string; value?: unknown };
  if (typeof record.value !== 'string') return '';
  return record.type === 'base64' ? Buffer.from(record.value, 'base64').toString('utf8') : record.value;
}
