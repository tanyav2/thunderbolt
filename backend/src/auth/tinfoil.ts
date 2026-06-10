/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Auth } from '@/auth/elysia-plugin'
import { createAuthMacro } from '@/auth/elysia-plugin'
import { getSettings, isOAuthRedirectUriAllowed } from '@/config/settings'
import { safeErrorHandler } from '@/middleware/error-handling'
import { Elysia, t } from 'elysia'
import { codeRequestSchema, refreshRequestSchema, type OAuthTokenResponse } from './types'

const tinfoilTokenUrl = 'https://api.tinfoil.sh/oauth/token'
const tinfoilRevokeUrl = 'https://api.tinfoil.sh/oauth/revoke'

/**
 * Tinfoil OAuth proxy. Unlike Google/Microsoft, Tinfoil is a public OAuth 2.1
 * client (PKCE S256, no client secret); the proxy exists so the `client_id`
 * stays server-side and the redirect_uri is validated against the trusted-origin
 * allowlist. The returned access token is an opaque bearer the Tinfoil enclave
 * verifies itself — never parsed here.
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
          return { error: 'Tinfoil OAuth not configured. Set TINFOIL_CLIENT_ID.' }
        }

        const validatedBody = codeRequestSchema.parse(body)

        if (!isOAuthRedirectUriAllowed(validatedBody.redirect_uri, settings)) {
          set.status = 400
          return { error: 'Invalid redirect_uri' }
        }

        const data = new URLSearchParams({
          grant_type: 'authorization_code',
          code: validatedBody.code,
          client_id: settings.tinfoilClientId,
          redirect_uri: validatedBody.redirect_uri,
          code_verifier: validatedBody.code_verifier,
        })

        try {
          const response = await fetchFn(tinfoilTokenUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: data,
          })

          if (!response.ok) {
            const errorData = await response.json().catch(() => ({}))
            const errorMsg = errorData.error_description || errorData.error || `HTTP ${response.status}`
            console.error('Tinfoil token exchange failed:', errorMsg)

            set.status = 400
            return { error: `Token exchange failed: ${errorMsg}` }
          }

          const tokenData = await response.json()
          console.info('Successfully exchanged Tinfoil OAuth code for tokens')

          const result: OAuthTokenResponse = {
            access_token: tokenData.access_token,
            refresh_token: tokenData.refresh_token || null,
            expires_in: tokenData.expires_in,
            token_type: tokenData.token_type,
            scope: tokenData.scope || null,
          }

          return result
        } catch (error) {
          console.error('Unexpected error during Tinfoil token exchange:', error)
          set.status = 500
          return { error: 'Internal server error during token exchange' }
        }
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
          return { error: 'Tinfoil OAuth not configured. Set TINFOIL_CLIENT_ID.' }
        }

        const validatedBody = refreshRequestSchema.parse(body)

        const data = new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: validatedBody.refresh_token,
          client_id: settings.tinfoilClientId,
        })

        try {
          const response = await fetchFn(tinfoilTokenUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: data,
          })

          if (!response.ok) {
            const errorData = await response.json().catch(() => ({}))
            const errorMsg = errorData.error_description || errorData.error || `HTTP ${response.status}`
            console.error('Tinfoil token refresh failed:', errorMsg)

            set.status = 400
            return { error: `Token refresh failed: ${errorMsg}` }
          }

          const tokenData = await response.json()
          console.info('Successfully refreshed Tinfoil OAuth token')

          // Tinfoil rotates the refresh token on every use and revokes the whole
          // family if a spent one is replayed, so the rotated token MUST replace
          // the old.
          const result: OAuthTokenResponse = {
            access_token: tokenData.access_token,
            refresh_token: tokenData.refresh_token || validatedBody.refresh_token,
            expires_in: tokenData.expires_in,
            token_type: tokenData.token_type,
            scope: tokenData.scope || null,
          }

          return result
        } catch (error) {
          console.error('Unexpected error during Tinfoil token refresh:', error)
          set.status = 500
          return { error: 'Internal server error during token refresh' }
        }
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
          return { error: 'Tinfoil OAuth not configured. Set TINFOIL_CLIENT_ID.' }
        }

        const validatedBody = refreshRequestSchema.parse(body)

        // RFC 7009: revoking the refresh token also disables the access tokens
        // it minted. Always returns 200 so local disconnect can proceed.
        const data = new URLSearchParams({
          client_id: settings.tinfoilClientId,
          token: validatedBody.refresh_token,
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
