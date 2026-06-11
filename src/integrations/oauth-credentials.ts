/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getIntegrationCredentials, updateIntegrationCredentials } from '@/dal'
import { getDb } from '@/db/database'
import { refreshAccessToken, type OAuthProvider } from '@/lib/auth'
import { HttpError, type HttpClient } from '@/lib/http'
import { withExclusiveLock } from '@/lib/web-locks'

export type OAuthCredentials = {
  access_token: string
  refresh_token?: string
  expires_at?: number
  /** Set when the IdP definitively rejected the refresh grant (revoked or
   *  spent token family, lapsed plan). Cleared by reconnecting, which saves
   *  fresh credentials. While set, token use is skipped instead of replaying
   *  a refresh token the IdP already refused. */
  reauth_required?: boolean
}

/**
 * Whether a refresh failure is a definitive grant rejection (the backend
 * proxies upstream `invalid_grant`-style errors as 400) rather than a
 * transient one (network, 5xx, 503 unconfigured) that may succeed on retry.
 */
const isRefreshRejected = (error: unknown): boolean => error instanceof HttpError && error.response.status === 400

/**
 * Retrieve stored OAuth credentials for the given provider.
 * Throws if the integration has not been connected yet.
 */
export const getOAuthCredentials = async (provider: OAuthProvider): Promise<OAuthCredentials> => {
  const db = getDb()
  const row = await getIntegrationCredentials(db, provider)
  if (!row) {
    throw new Error(`${provider} integration not connected`)
  }
  return row.credentials
}

/**
 * Check whether a token is still valid with a 60-second safety buffer.
 * Returns true when the token can be reused without refreshing.
 */
export const isTokenFresh = (expiresAt: number | undefined, now: number = Date.now()): boolean =>
  expiresAt !== undefined && expiresAt - 60_000 > now

/**
 * Ensure that we have a valid OAuth access token, refreshing it if necessary.
 * If refreshed, the stored credentials are updated automatically.
 *
 * Refreshes are serialized through an exclusive lock (origin-wide where the
 * Web Locks API exists): rotating providers (Tinfoil) revoke the entire token
 * family when a spent refresh token is replayed, so two concurrent refreshes
 * (parallel sends, other tabs sharing the same local DB) must never race.
 * Inside the lock the stored credentials are re-read, so a refresh completed
 * by another holder is reused instead of replaying its consumed refresh token.
 */
export const ensureValidOAuthToken = async (
  httpClient: HttpClient,
  provider: OAuthProvider,
  credentials: OAuthCredentials,
): Promise<string> => {
  if (isTokenFresh(credentials.expires_at)) {
    return credentials.access_token
  }

  return withExclusiveLock(`oauth-refresh-${provider}`, async (): Promise<string> => {
    const db = getDb()
    const stored = await getIntegrationCredentials(db, provider)
    const current = stored?.credentials ?? credentials
    if (isTokenFresh(current.expires_at)) {
      return current.access_token
    }

    if (current.reauth_required) {
      throw new Error(`${provider} authorization expired — reconnect the integration`)
    }

    if (!current.refresh_token) {
      throw new Error('Access token expired and no refresh token available')
    }

    try {
      const newTokens = await refreshAccessToken(httpClient, provider, current.refresh_token)
      const updated: OAuthCredentials = {
        ...current,
        access_token: newTokens.access_token,
        // Rotating providers (Tinfoil) replace the refresh token on every use.
        refresh_token: newTokens.refresh_token ?? current.refresh_token,
        expires_at: Date.now() + newTokens.expires_in * 1000,
      }

      await updateIntegrationCredentials(db, provider, updated)

      return updated.access_token
    } catch (error) {
      if (isRefreshRejected(error)) {
        await updateIntegrationCredentials(db, provider, { ...current, reauth_required: true })
      }
      throw error
    }
  })
}
