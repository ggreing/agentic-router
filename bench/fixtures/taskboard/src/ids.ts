/** Returns a function producing sequential ids: `task-1`, `task-2`, ... */
export function createIdGenerator(prefix: string): () => string {
  let counter = 0;
  return () => `${prefix}-${++counter}`;
}
