/**
 * Alias/forwarding loop detection.
 *
 * `routes` maps an alias source address to the addresses it delivers to.
 * Mailbox addresses (terminal) simply do not appear as keys.
 * Returns the cycle path if adding `source -> destinations` would create a loop.
 */
export function detectAliasLoop(
  routes: ReadonlyMap<string, readonly string[]>,
  source: string,
  destinations: readonly string[],
  maxDepth = 10,
): string[] | null {
  const graph = new Map(routes);
  graph.set(source, destinations);

  const visit = (node: string, path: string[]): string[] | null => {
    if (path.length > maxDepth) return [...path, node];
    if (path.includes(node)) return [...path, node];
    const next = graph.get(node);
    if (!next) return null;
    for (const n of next) {
      const found = visit(n, [...path, node]);
      if (found) return found;
    }
    return null;
  };
  return visit(source, []);
}
