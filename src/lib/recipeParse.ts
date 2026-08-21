import { Recipe } from '@/types/recipe';

/**
 * Pulls every complete `{...}` object out of `text`, ignoring braces inside
 * strings. Objects are collected at any nesting depth and then reduced to the
 * outermost non-overlapping ones, so an unterminated wrapper (`{"recipes": [`
 * cut off by a token limit) still yields the recipe objects that did finish.
 */
export function salvageObjects(text: string): unknown[] {
  const stack: number[] = [];
  const ranges: Array<[number, number]> = [];
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') inString = true;
    else if (ch === '{') stack.push(i);
    else if (ch === '}') {
      const start = stack.pop();
      if (start !== undefined) ranges.push([start, i + 1]);
    }
  }

  // Prefer outer objects, then walk left to right keeping only those that do
  // not sit inside an object already taken.
  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);

  const objects: unknown[] = [];
  let consumedTo = -1;
  for (const [start, end] of ranges) {
    if (start < consumedTo) continue;
    try {
      objects.push(JSON.parse(text.slice(start, end)));
      consumedTo = end;
    } catch {
      // Not well-formed on its own; leave the span open for inner objects.
    }
  }

  return objects;
}

/**
 * Replaces any salvaged wrapper (an object with no `title` but an array member,
 * e.g. `{"recipes": [...]}`) with the items it holds.
 */
function expandContainers(items: unknown[]): unknown[] {
  return items.flatMap((item) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const record = item as Record<string, unknown>;
      if (typeof record.title !== 'string') {
        const list = Object.values(record).find(Array.isArray);
        if (list) return list as unknown[];
      }
    }
    return [item];
  });
}

/** Finds the recipe list in whatever shape the model returned it. */
export function findRecipeList(raw: string): unknown[] {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();

  const fromContainer = (value: unknown): unknown[] | null => {
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object') {
      const list = Object.values(value as Record<string, unknown>).find(Array.isArray);
      if (list) return list as unknown[];
    }
    return null;
  };

  try {
    const list = fromContainer(JSON.parse(cleaned));
    if (list) return list;
  } catch {
    // Fall through to the salvage path below.
  }

  const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    try {
      return JSON.parse(arrayMatch[0]);
    } catch {
      // Malformed array; salvage whole objects from it instead.
    }
  }

  // Last resort: the response was cut off mid-array, so recover the objects
  // that did complete.
  return expandContainers(salvageObjects(cleaned));
}

/** Accepts the string-instead-of-array shapes the model sometimes emits. */
export function toStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((v) => (typeof v === 'string' ? v.trim() : String(v ?? '').trim()))
      .filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split(/\r?\n|(?:^|\s)\d+[.)]\s+|;\s*/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

export function normalizeRecipe(value: unknown, sources: string[]): Recipe | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;

  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  if (!title) return null;

  const ingredients = toStringList(raw.ingredients);
  const instructions = toStringList(raw.instructions);
  if (ingredients.length === 0 || instructions.length === 0) return null;

  const source = typeof raw.source === 'string' ? raw.source.trim() : '';
  const cookTime = typeof raw.cookTime === 'string' ? raw.cookTime.trim() : '';

  return {
    title,
    ingredients,
    instructions,
    cookTime: cookTime || 'N/A',
    // Guard against a hallucinated URL so the card always links somewhere real.
    source: sources.includes(source) ? source : (sources[0] ?? ''),
  };
}

/** Turns a raw model completion into the recipes it successfully described. */
export function parseRecipes(content: string, sources: string[]): Recipe[] {
  return findRecipeList(content)
    .map((item) => normalizeRecipe(item, sources))
    .filter((r): r is Recipe => r !== null);
}
