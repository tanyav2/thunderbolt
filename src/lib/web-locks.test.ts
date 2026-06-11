/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { withExclusiveLock } from './web-locks'

// happy-dom ships `navigator.locks` as null, so these tests exercise the
// in-process fallback queue — the same path older WebKit and Bun scripts take.
describe('withExclusiveLock', () => {
  it('serializes concurrent holders of the same lock', async () => {
    const order: string[] = []
    const task = (name: string) =>
      withExclusiveLock('same-lock', async () => {
        order.push(`${name}:start`)
        await Promise.resolve()
        order.push(`${name}:end`)
        return name
      })

    const results = await Promise.all([task('a'), task('b'), task('c')])

    expect(results).toEqual(['a', 'b', 'c'])
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end'])
  })

  it('does not serialize holders of different locks', async () => {
    const order: string[] = []
    const task = (lock: string) =>
      withExclusiveLock(lock, async () => {
        order.push(`${lock}:start`)
        await Promise.resolve()
        order.push(`${lock}:end`)
      })

    await Promise.all([task('lock-a'), task('lock-b')])

    expect(order.slice(0, 2)).toEqual(['lock-a:start', 'lock-b:start'])
  })

  it('propagates rejections to the caller without blocking later holders', async () => {
    const failing = withExclusiveLock('rejecting-lock', async () => {
      throw new Error('task failed')
    })
    const following = withExclusiveLock('rejecting-lock', async () => 'recovered')

    await expect(failing).rejects.toThrow('task failed')
    expect(await following).toBe('recovered')
  })
})
