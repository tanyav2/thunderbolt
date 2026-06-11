/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { getClock } from '@/testing-library'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { createMockModel } from '@/test-utils/chat-store-mocks'
import { createQueryTestWrapper } from '@/test-utils/react-query'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from 'bun:test'
import { useLayoutEffect } from 'react'
import type { Model } from '@/types'
import type { SecureClient, VerificationDocument } from 'tinfoil'
import { type VerificationStatus, useTinfoilVerification } from './use-tinfoil-verification'

// Real providers (HttpClient + DB + react-query) so useHttpClient /
// useIntegrationStatus resolve normally — no module mocks that would leak into
// other test files in the same bun process. The enclave attestation is the only
// thing stubbed, via the injectable getActiveTinfoilClient.
beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

afterEach(() => {
  cleanup()
})

const tinfoilModel = (overrides?: Partial<Model>) =>
  createMockModel({ provider: 'tinfoil', isSystem: 1, isConfidential: 1, ...overrides })

const fakeClient = (securityVerified: boolean) =>
  ({
    getVerificationDocument: () => ({ securityVerified }) as unknown as VerificationDocument,
  }) as unknown as SecureClient

const renderVerification = (model: Model | null, getClient: (m: Model) => Promise<SecureClient>) =>
  renderHook(() => useTinfoilVerification(model, getClient), { wrapper: createQueryTestWrapper() })

const flush = () =>
  act(async () => {
    await getClock().tickAsync(1)
  })

describe('useTinfoilVerification', () => {
  it('stays idle for a non-Tinfoil model and never attests', () => {
    const getClient = mock(async () => fakeClient(true))

    const { result } = renderVerification(createMockModel({ provider: 'openai' }), getClient)

    expect(result.current.status).toBe('idle')
    expect(result.current.doc).toBeNull()
    expect(getClient).not.toHaveBeenCalled()
  })

  it('stays idle for a confidential thunderbolt-provider model (e.g. GPT OSS)', () => {
    const getClient = mock(async () => fakeClient(true))

    const { result } = renderVerification(createMockModel({ provider: 'thunderbolt', isConfidential: 1 }), getClient)

    expect(result.current.status).toBe('idle')
    expect(getClient).not.toHaveBeenCalled()
  })

  it('resolves to verified and exposes the document', async () => {
    const getClient = mock(async () => fakeClient(true))

    const { result } = renderVerification(tinfoilModel(), getClient)
    await flush()

    expect(getClient).toHaveBeenCalled()
    expect(result.current.status).toBe('verified')
    expect(result.current.doc?.securityVerified).toBe(true)
    expect(result.current.error).toBeNull()
  })

  it('marks failed when the enclave is not securityVerified', async () => {
    const getClient = mock(async () => fakeClient(false))

    const { result } = renderVerification(tinfoilModel(), getClient)
    await flush()

    expect(result.current.status).toBe('failed')
    expect(result.current.error).toBe('Enclave verification failed')
  })

  it('retries with backoff then fails when attestation keeps throwing', async () => {
    const getClient = mock(async () => {
      throw new Error('attestation unreachable')
    })

    const { result } = renderVerification(tinfoilModel(), getClient)

    await act(async () => {
      // Exceeds the summed exponential backoff (~26s) for all attempts.
      await getClock().tickAsync(60_000)
    })

    // 6 attempts (0..maxRetries) per effect run; React may double-invoke the
    // effect under StrictMode, so assert the floor rather than an exact count.
    expect(getClient.mock.calls.length).toBeGreaterThanOrEqual(6)
    expect(result.current.status).toBe('failed')
    expect(result.current.error).toBe('attestation unreachable')
  })

  it('re-attests when retry() is called', async () => {
    let verified = false
    const getClient = mock(async () => fakeClient(verified))

    const { result } = renderVerification(tinfoilModel(), getClient)
    await flush()
    expect(result.current.status).toBe('failed')

    const callsBeforeRetry = getClient.mock.calls.length
    verified = true
    act(() => result.current.retry())
    await flush()

    expect(result.current.status).toBe('verified')
    expect(getClient.mock.calls.length).toBeGreaterThan(callsBeforeRetry)
  })

  it('resets to verifying immediately when switching to another Tinfoil model (fail-closed)', async () => {
    const getClient = mock(async () => fakeClient(true))
    const wrapper = createQueryTestWrapper()

    const { result, rerender } = renderHook(({ m }) => useTinfoilVerification(m, getClient), {
      wrapper,
      initialProps: { m: tinfoilModel({ id: 'model-a' }) },
    })
    await flush()
    expect(result.current.status).toBe('verified')

    rerender({ m: tinfoilModel({ id: 'model-b' }) })
    // Synchronous reset on model change — before the effect re-attests — so a
    // send can't slip through on the previous model's verified status.
    expect(result.current.status).toBe('verifying')

    await flush()
    expect(result.current.status).toBe('verified')
  })

  it('clears the previous document while a retry re-attestation is in flight', async () => {
    // retry() starts a new cycle without changing enclaveKey, so the render-phase
    // reset doesn't fire — the effect itself must drop the stale doc. Otherwise the
    // Verification Center keeps showing the previous enclave's attestation mid-refresh.
    const firstDoc = { securityVerified: true, enclaveHost: 'enclave-1' } as unknown as VerificationDocument
    const secondDoc = { securityVerified: true, enclaveHost: 'enclave-2' } as unknown as VerificationDocument
    let releaseSecond: (() => void) | null = null
    let call = 0
    const getClient = mock(async () => {
      call += 1
      if (call === 1) {
        return { getVerificationDocument: () => firstDoc } as unknown as SecureClient
      }
      // Block the re-attestation so the verifying window stays observable.
      await new Promise<void>((resolve) => {
        releaseSecond = resolve
      })
      return { getVerificationDocument: () => secondDoc } as unknown as SecureClient
    })

    const { result } = renderVerification(tinfoilModel(), getClient)
    await flush()
    expect(result.current.status).toBe('verified')
    expect(result.current.doc).toBe(firstDoc)

    act(() => result.current.retry())
    // Re-attestation in flight: the stale document must be gone, not lingering.
    expect(result.current.status).toBe('verifying')
    expect(result.current.doc).toBeNull()

    act(() => releaseSecond?.())
    await flush()
    expect(result.current.status).toBe('verified')
    expect(result.current.doc).toBe(secondDoc)
  })

  it('fails closed (no stale verified frame) when a non-model enclave signal changes', async () => {
    // Connecting/disconnecting Tinfoil OAuth or changing cloudUrl swaps the
    // answering enclave without changing modelId. The synchronous reset must
    // still fire so no committed frame keeps the previous enclave's `verified`
    // status — otherwise the send gate (status === 'verified') briefly opens.
    const originalCloudUrl = useLocalSettingsStore.getState().cloudUrl
    let releaseSecond: (() => void) | null = null
    let call = 0
    const getClient = mock(async () => {
      call += 1
      if (call === 1) {
        return fakeClient(true)
      }
      // Block the re-attestation so any post-switch `verified` can only be the
      // stale previous result, not a fresh one.
      await new Promise<void>((resolve) => {
        releaseSecond = resolve
      })
      return fakeClient(true)
    })

    // Capture every *committed* status (layout effect runs on commit only, so
    // a render discarded by the render-phase reset never lands here).
    const committed: VerificationStatus[] = []
    const model = tinfoilModel()
    try {
      const { result } = renderHook(
        () => {
          const v = useTinfoilVerification(model, getClient)
          useLayoutEffect(() => {
            committed.push(v.status)
          })
          return v
        },
        { wrapper: createQueryTestWrapper() },
      )
      await flush()
      expect(result.current.status).toBe('verified')

      const before = committed.length
      act(() => {
        useLocalSettingsStore.setState({ cloudUrl: `${originalCloudUrl}#switched` })
      })

      // Re-attestation is still pending, so the only way `verified` could appear
      // here is the previous enclave's stale status leaking through.
      expect(committed.slice(before)).not.toContain('verified')
      expect(result.current.status).toBe('verifying')

      act(() => releaseSecond?.())
      await flush()
      expect(result.current.status).toBe('verified')
    } finally {
      useLocalSettingsStore.setState({ cloudUrl: originalCloudUrl })
    }
  })

  it('does not re-attest a BYOK (non-system) model when cloudUrl changes', async () => {
    // BYOK models always use the direct enclave client — cloudUrl and Tinfoil
    // OAuth state never swap their enclave, so changing them must not reset a
    // verified status (which gates sending) or trigger another attestation.
    const originalCloudUrl = useLocalSettingsStore.getState().cloudUrl
    const getClient = mock(async () => fakeClient(true))
    try {
      const { result } = renderVerification(tinfoilModel({ isSystem: 0 }), getClient)
      await flush()
      expect(result.current.status).toBe('verified')

      const callsBefore = getClient.mock.calls.length
      act(() => {
        useLocalSettingsStore.setState({ cloudUrl: `${originalCloudUrl}#switched` })
      })

      expect(result.current.status).toBe('verified')
      await flush()
      expect(result.current.status).toBe('verified')
      expect(getClient.mock.calls.length).toBe(callsBefore)
    } finally {
      useLocalSettingsStore.setState({ cloudUrl: originalCloudUrl })
    }
  })

  it('fails (not stuck verifying) after exhausting retries while offline', async () => {
    const onLine = Object.getOwnPropertyDescriptor(navigator, 'onLine')
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    try {
      const getClient = mock(async () => fakeClient(true))

      const { result } = renderVerification(tinfoilModel(), getClient)
      await act(async () => {
        await getClock().tickAsync(60_000)
      })

      expect(getClient).not.toHaveBeenCalled()
      expect(result.current.status).toBe('failed')
      expect(result.current.error).toBe('No network connection')
    } finally {
      if (onLine) {
        Object.defineProperty(navigator, 'onLine', onLine)
      }
    }
  })
})
