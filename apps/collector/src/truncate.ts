/** Copie bornée d'une valeur JSON : limite la taille des chaînes, tableaux et la profondeur. */
export function bounded(value: unknown, maxString = 4000, maxArray = 50, depth = 6): unknown {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.length > maxString ? value.slice(0, maxString) + `… [${value.length - maxString} car. tronqués]` : value;
  if (depth <= 0) return '[profondeur max]';
  if (Array.isArray(value)) {
    const out = value.slice(0, maxArray).map((v) => bounded(v, maxString, maxArray, depth - 1));
    if (value.length > maxArray) out.push(`[${value.length - maxArray} éléments tronqués]`);
    return out;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Le contenu complet d'un fichier écrit n'est pas utile à la supervision.
      out[k] = k === 'content' || k === 'new_string' || k === 'old_string' ? bounded(v, 600, maxArray, depth - 1) : bounded(v, maxString, maxArray, depth - 1);
    }
    return out;
  }
  return String(value);
}
