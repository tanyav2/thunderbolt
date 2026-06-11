/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from 'zod'

/**
 * Standard OAuth token response schema
 */
export const oauthTokenResponseSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().nullable().optional(),
  expires_in: z.number(),
  token_type: z.string(),
  scope: z.string().nullable().optional(),
})

export type OAuthTokenResponse = z.infer<typeof oauthTokenResponseSchema>

/**
 * Map an IdP token-endpoint failure to the proxy's response status. Upstream
 * 400 is a definitive grant rejection (RFC 6749 §5.2 `invalid_grant` et al.)
 * and stays 400 — clients treat it as "reconnect required". Anything else
 * (5xx outage, 429, 401 client-config) is upstream trouble a client may
 * retry, surfaced as 502 so it is never mistaken for a revoked grant.
 */
export const mapUpstreamTokenStatus = (upstreamStatus: number): 400 | 502 => (upstreamStatus === 400 ? 400 : 502)

/**
 * Request body schema for exchanging authorization codes
 */
export const codeRequestSchema = z.object({
  code: z.string(),
  code_verifier: z.string(),
  redirect_uri: z.string(),
})

export type CodeRequest = z.infer<typeof codeRequestSchema>

/**
 * Request body schema for refreshing tokens
 */
export const refreshRequestSchema = z.object({
  refresh_token: z.string(),
})

export type RefreshRequest = z.infer<typeof refreshRequestSchema>
