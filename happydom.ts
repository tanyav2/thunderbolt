/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()

// Add comprehensive Node.js polyfills for better compatibility
import { ReadableStream, TransformStream, WritableStream } from 'stream/web'

// Polyfill Web Streams API
globalThis.ReadableStream = ReadableStream
globalThis.WritableStream = WritableStream
globalThis.TransformStream = TransformStream

// Add other Node.js globals that might be needed
if (typeof globalThis.process === 'undefined') {
  globalThis.process = process
}

// Add Node.js Buffer if needed
if (typeof globalThis.Buffer === 'undefined') {
  globalThis.Buffer = Buffer
}

// happy-dom ships `navigator.locks` as null — provide a minimal exclusive
// Web Locks implementation so code that serializes work through
// `navigator.locks.request` (e.g. OAuth token refresh) runs under test.
const lockQueues = new Map<string, Promise<unknown>>()
const webLocksPolyfill = {
  request: (name: string, callback: (lock: { name: string; mode: 'exclusive' }) => unknown): Promise<unknown> => {
    const previous = lockQueues.get(name) ?? Promise.resolve()
    const run = previous.then(() => callback({ name, mode: 'exclusive' }))
    lockQueues.set(
      name,
      run.catch(() => undefined),
    )
    return run
  },
}
Object.defineProperty(navigator, 'locks', { value: webLocksPolyfill, configurable: true })

// Fake timers are now managed in testing-library.ts
// This file just sets up the DOM environment
