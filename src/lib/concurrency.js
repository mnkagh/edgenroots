'use strict';

/**
 * Promise pool. Runs `worker` over `items` with at most `limit` in flight so a
 * large preview cannot flood the machine with child processes. Results keep the
 * input order.
 */
async function mapLimit(items, limit, worker) {
  const list = [...items];
  const results = new Array(list.length);
  const size = Math.max(1, Math.min(limit || 1, list.length || 1));
  let next = 0;

  async function runner() {
    while (true) {
      const index = next;
      next += 1;
      if (index >= list.length) return;
      results[index] = await worker(list[index], index);
    }
  }

  await Promise.all(Array.from({ length: size }, runner));
  return results;
}

module.exports = { mapLimit };
