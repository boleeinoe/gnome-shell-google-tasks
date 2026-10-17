// Parsing and pruning of the small local caches (task colors, task creation
// times). No GNOME imports, so it runs under `bun test`; file I/O lives in
// extension.ts.

import { formatColorSpec, parseColorSpec } from './colorSpec.js';

function parseObject(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('expected a JSON object');
  return parsed as Record<string, unknown>;
}

// task id -> color spec (see colorSpec.ts: a palette id or '#rrggbb', with
// an optional '@opacity'). Entries with an unknown color, a bad opacity or a
// non-string value are dropped rather than trusted: the file is ours, but it
// can be edited or truncated, and a bad value would otherwise reach the
// renderer. Valid entries come back normalized.
export function parseTaskColors(text: string, validColorIds: ReadonlySet<string>): Map<string, string> {
  const result = new Map<string, string>();
  for (const [id, value] of Object.entries(parseObject(text))) {
    const spec = id && typeof value === 'string' ? parseColorSpec(value, validColorIds) : null;
    if (spec)
      result.set(id, formatColorSpec(spec));
  }
  return result;
}

// task id -> creation time (epoch ms). Only finite, positive numbers survive.
export function parseCreationTimes(text: string): Map<string, number> {
  const result = new Map<string, number>();
  for (const [id, value] of Object.entries(parseObject(text))) {
    if (id && typeof value === 'number' && Number.isFinite(value) && value > 0)
      result.set(id, value);
  }
  return result;
}

export function serializeMap(map: ReadonlyMap<string, unknown>): string {
  return JSON.stringify(Object.fromEntries(map));
}

// Drops the entries of tasks that no longer exist. Returns whether anything
// was removed. Callers must only prune when every list loaded: a list that
// failed to fetch would otherwise look like all its tasks were deleted.
export function pruneToLiveIds<V>(map: Map<string, V>, liveIds: ReadonlySet<string>): boolean {
  let changed = false;
  for (const id of [...map.keys()]) {
    if (!liveIds.has(id)) {
      map.delete(id);
      changed = true;
    }
  }
  return changed;
}
