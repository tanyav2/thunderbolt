/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Auth } from '@/auth/elysia-plugin'
import { createAuthMacro } from '@/auth/elysia-plugin'
import { getSettings, isOAuthRedirectUriAllowed } from '@/config/settings'
import { safeErrorHandler } from '@/middleware/error-handling'
import { Elysia, t } from 'elysia'
import { mapUpstreamTokenStatus, oauthTokenResponseSchema, type OAuthTokenResponse } from './types'

const tinfoilTokenUrl = 'https://api.tinfoil.sh/oauth/token'
const tinfoilRevokeUrl = 'https://api.tinfoil.sh/oauth/revoke'

const unconfiguredError = { error: 'Tinfoil OAuth not configured. Set TINFOIL_CLIENT_ID.' }

type StatusSetter = { status?: number | string }

/**
 * POST a grant to Tinfoil's token endpoint and normalize the result to the
 * shared OAuthTokenResponse shape. Definitive upstream rejections become 400s
 * carrying the upstream message; transient upstream failures become 502s (see
 * mapUpstreamTokenStatus); network failures and malformed 200s throw to
 * safeErrorHandler. `fallbackRefreshToken` covers a refresh response that omits
 * rotation (exchange passes none — a missing refresh_token stays null).
 */
const proxyTokenGrant = async (
  fetchFn: typeof fetch,
  set: StatusSetter,
  grant: 'exchange' | 'refresh',
  params: Record<string, string>,
  fallbackRefreshToken?: string,
): Promise<OAuthTokenResponse | { error: string }> => {
  const response = await fetchFn(tinfoilTokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  })

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}))
    const errorMsg = errorData.error_description || errorData.error || `HTTP ${response.status}`
    console.error(`Tinfoil token ${grant} failed:`, errorMsg)
    set.status = mapUpstreamTokenStatus(response.status)
    return { error: `Token ${grant} failed: ${errorMsg}` }
  }

  // Validate before this feeds client credential storage: a malformed 200 must
  // become a thrown 500, not a persisted `access_token: undefined`.
  const tokenData = oauthTokenResponseSchema.parse(await response.json())
  console.info(`Tinfoil token ${grant} succeeded`)

  return {
    ...tokenData,
    refresh_token: tokenData.refresh_token ?? fallbackRefreshToken ?? null,
    scope: tokenData.scope ?? null,
  }
}

/**
 * Tinfoil OAuth proxy. Unlike Google/Microsoft, Tinfoil is a public OAuth 2.1
 * client (PKCE S256, no client secret), and its client_id is not a secret —
 * the proxy's job is enforcing the redirect_uri allowlist and keeping the
 * token-endpoint call server-side. The returned access token is an opaque
 * bearer the Tinfoil enclave verifies itself — never parsed here.
 */
export const createTinfoilAuthRoutes = (auth: Auth, fetchFn: typeof fetch = globalThis.fetch) => {
  return new Elysia({ prefix: '/auth/tinfoil' })
    .onError(safeErrorHandler)
    .use(createAuthMacro(auth))
    .get(
      '/config',
      async () => {
        const settings = getSettings()

        return {
          client_id: settings.tinfoilClientId,
          // Public client — no secret to check.
          configured: Boolean(settings.tinfoilClientId),
        }
      },
      { auth: true },
    )

    .post(
      '/exchange',
      async ({ body, set }) => {
        const settings = getSettings()
        if (!settings.tinfoilClientId) {
          set.status = 503
          return unconfiguredError
        }
        if (!isOAuthRedirectUriAllowed(body.redirect_uri, settings)) {
          set.status = 400
          return { error: 'Invalid redirect_uri' }
        }

        return proxyTokenGrant(fetchFn, set, 'exchange', {
          grant_type: 'authorization_code',
          code: body.code,
          client_id: settings.tinfoilClientId,
          redirect_uri: body.redirect_uri,
          code_verifier: body.code_verifier,
        })
      },
      {
        auth: true,
        body: t.Object({
          code: t.String(),
          code_verifier: t.String(),
          redirect_uri: t.String(),
        }),
      },
    )

    .post(
      '/refresh',
      async ({ body, set }) => {
        const settings = getSettings()
        if (!settings.tinfoilClientId) {
          set.status = 503
          return unconfiguredError
        }

        // Tinfoil rotates the refresh token on every use and revokes the whole
        // family if a spent one is replayed, so the rotated token MUST replace
        // the old.
        return proxyTokenGrant(
          fetchFn,
          set,
          'refresh',
          {
            grant_type: 'refresh_token',
            refresh_token: body.refresh_token,
            client_id: settings.tinfoilClientId,
          },
          body.refresh_token,
        )
      },
      {
        auth: true,
        body: t.Object({
          refresh_token: t.String(),
        }),
      },
    )

    .post(
      '/revoke',
      async ({ body, set }) => {
        const settings = getSettings()
        if (!settings.tinfoilClientId) {
          set.status = 503
          return unconfiguredError
        }

        // RFC 7009: revokes this refresh-token family member and its linked
        // opaque key; already-minted JWT access tokens stay valid in-enclave
        // until exp (≤15 min). Failures still answer 200 `{ revoked: false }`
        // so local disconnect can proceed while surfacing the real outcome.
        const data = new URLSearchParams({
          client_id: settings.tinfoilClientId,
          token: body.refresh_token,
        })

        try {
          const response = await fetchFn(tinfoilRevokeUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: data,
          })
          if (!response.ok) {
            console.warn(`Tinfoil token revoke returned non-2xx: HTTP ${response.status}`)
          }
          return { revoked: response.ok }
        } catch (error) {
          console.error('Unexpected error during Tinfoil token revoke:', error)
          return { revoked: false }
        }
      },
      {
        auth: true,
        body: t.Object({
          refresh_token: t.String(),
        }),
      },
    )
}
