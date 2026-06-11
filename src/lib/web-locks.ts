/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** In-process queues used when the Web Locks API is unavailable. Entries are
 *  removed once their queue drains so abandoned lock names don't accumulate. */
const fallbackQueues = new Map<string, Promise<unknown>>()

const requestFallbackLock = <T>(name: string, task: () => Promise<T>): Promise<T> => {
  const previous = fallbackQueues.get(name) ?? Promise.resolve()
  const run = previous.then(task)
  const settled: Promise<void> = run
    .catch(() => undefined)
    .then(() => {
      if (fallbackQueues.get(name) === settled) {
        fallbackQueues.delete(name)
      }
    })
  fallbackQueues.set(name, settled)
  return run
}

/**
 * Run `task` while holding an exclusive lock on `name`.
 *
 * Uses the Web Locks API when available, which serializes holders origin-wide
 * (across tabs and workers). Environments without `navigator.locks` — older
 * WebKit, happy-dom under test, Bun scripts — fall back to an in-process
 * queue with the same exclusivity within a single JS context.
 */
export const withExclusiveLock = async <T>(name: string, task: () => Promise<T>): Promise<T> => {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks.request(name, task) as Promise<T>
  }
  return requestFallbackLock(name, task)
}
