/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getActiveTinfoilClient as defaultGetActiveTinfoilClient } from '@/ai/fetch'
import { useIntegrationStatus } from '@/hooks/use-integration-status'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import type { Model } from '@/types'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { VerificationDocument } from 'tinfoil'

export type VerificationStatus = 'idle' | 'verifying' | 'verified' | 'failed'

export type TinfoilVerification = {
  /** `idle` for any non-Tinfoil model (the chip renders nothing). */
  status: VerificationStatus
  doc: VerificationDocument | null
  error: string | null
  /** Force a fresh attestation read (used by the Error chip and the Verification Center). */
  retry: () => void
}

type VerificationState = Pick<TinfoilVerification, 'status' | 'doc' | 'error'>

const resetState = (isTinfoil: boolean): VerificationState => ({
  status: isTinfoil ? 'verifying' : 'idle',
  doc: null,
  error: null,
})

// Mirrors tinfoil-webapp's backoff (constants.ts): up to 5 retries, 2s base,
// exponential 1.5^n. Attestation runs once per page load per enclave and the
// SecureClient is cached, so this normally resolves on the first attempt.
const maxRetries = 5
const baseRetryDelayMs = 2000

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const isOnline = () => (typeof navigator !== 'undefined' ? navigator.onLine : true)

/**
 * Read the enclave verification document for the active Tinfoil model.
 *
 * Gated on `provider === 'tinfoil'` — NOT `isConfidential`: confidential
 * thunderbolt-provider models (e.g. GPT OSS) have no client-side SecureClient,
 * so they stay `idle`. Resolves the same attested SecureClient inference uses
 * and re-reads when the model, cloudUrl, or Tinfoil OAuth connection changes
 * (each can swap the enclave that answers) — never per message.
 *
 * `getActiveTinfoilClient` is injectable for tests.
 */
export const useTinfoilVerification = (
  model: Model | null,
  getActiveTinfoilClient: typeof defaultGetActiveTinfoilClient = defaultGetActiveTinfoilClient,
): TinfoilVerification => {
  const cloudUrl = useLocalSettingsStore((s) => s.cloudUrl)
  const { data: integrationStatus } = useIntegrationStatus()
  const tinfoilConnected = integrationStatus?.tinfoilConnected ?? false
  const tinfoilEnabled = integrationStatus?.tinfoilEnabled ?? false

  const isTinfoil = model?.provider === 'tinfoil'
  const modelId = model?.id ?? null

  const [state, setState] = useState<VerificationState>(() => resetState(isTinfoil))
  const [retryNonce, setRetryNonce] = useState(0)

  // Fail closed the moment any enclave-switch signal changes (model, cloudUrl,
  // Tinfoil OAuth connection): the re-attesting effect runs only after commit,
  // which would leave one committed frame on the previous enclave's `verified`
  // status through which a send could slip. retryNonce (a same-enclave refresh)
  // is deliberately excluded so it doesn't flash the chip back to "verifying".
  // React's documented "adjust state during render" pattern.
  const enclaveKey = JSON.stringify([modelId, cloudUrl, tinfoilConnected, tinfoilEnabled])
  const [prevEnclaveKey, setPrevEnclaveKey] = useState(enclaveKey)
  if (enclaveKey !== prevEnclaveKey) {
    setPrevEnclaveKey(enclaveKey)
    setState(resetState(isTinfoil))
  }

  const retry = useCallback(() => setRetryNonce((n) => n + 1), [])

  // Read the live model object from a ref so the effect re-runs only on inputs
  // that change which enclave answers, not on unrelated field edits.
  const modelRef = useRef(model)
  modelRef.current = model

  // The injected resolver can change identity between renders in tests; keep
  // the latest in a ref so it isn't an attestation-triggering dependency.
  const getClientRef = useRef(getActiveTinfoilClient)
  getClientRef.current = getActiveTinfoilClient

  // Async attestation read with cancellation cleanup; re-runs when the active
  // enclave could change.
  useEffect(() => {
    if (!isTinfoil) {
      setState(resetState(false))
      return
    }

    let cancelled = false
    // Also covers retry(), which doesn't change enclaveKey and so skips the
    // render-phase reset — the previous enclave's document must not stay on
    // screen while re-attestation is in flight.
    setState(resetState(true))

    const run = async () => {
      const activeModel = modelRef.current
      if (!activeModel) {
        return
      }

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (cancelled) {
          return
        }
        if (!isOnline()) {
          await delay(baseRetryDelayMs)
          continue
        }
        try {
          // Awaits ready() under the hood, so a thrown error means attestation
          // could not complete (transient → retry).
          const client = await getClientRef.current(activeModel)
          if (cancelled) {
            return
          }
          const nextDoc = client.getVerificationDocument()
          setState(
            nextDoc.securityVerified
              ? { status: 'verified', doc: nextDoc, error: null }
              : { status: 'failed', doc: nextDoc, error: 'Enclave verification failed' },
          )
          return
        } catch (err) {
          if (cancelled) {
            return
          }
          if (attempt === maxRetries) {
            setState({ status: 'failed', doc: null, error: err instanceof Error ? err.message : 'Verification failed' })
            return
          }
          await delay(baseRetryDelayMs * Math.pow(1.5, attempt))
        }
      }

      // Reached only when every attempt found the device offline — surface a
      // terminal failure instead of leaving the chip stuck on "Verifying…".
      if (!cancelled) {
        setState({ status: 'failed', doc: null, error: 'No network connection' })
      }
    }

    void run()

    return () => {
      cancelled = true
    }
    // `tinfoilConnected` / `tinfoilEnabled` aren't read in the body but switch
    // getActiveTinfoilClient between the direct and managed enclaves (different
    // verification documents), so they must re-trigger attestation.
  }, [isTinfoil, modelId, cloudUrl, tinfoilConnected, tinfoilEnabled, retryNonce])

  return { ...state, retry }
}
