
import { createHash } from 'node:crypto';

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const serialized = JSON.stringify(value);

    if (serialized === undefined) {
      throw new Error('Invalid canonical JSON value');
    }

    return serialized;
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }

  const object = value as Record<string, unknown>;

  const fields = Object.keys(object)
    .sort()
    .filter((key) => object[key] !== undefined)
    .map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(object[key])}`,
    );

  return `{${fields.join(',')}}`;
}

export function calculatePayloadHash(
  payload: Record<string, unknown>,
): string {
  return createHash('sha256')
    .update(canonicalJson(payload))
    .digest('hex');
}