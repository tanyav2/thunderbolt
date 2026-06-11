/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useOAuthConnect } from '@/hooks/use-oauth-connect'
import type { ReturnContext } from '@/lib/oauth-state'
import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'

type OAuthLocationState = { oauth?: { code?: string; state?: string; error?: string } } | null

/**
 * Completes an OAuth flow when the callback page navigates back with
 * `location.state.oauth` (see `OAuthCallback`): exchanges the code, saves
 * credentials, then clears the navigation state.
 */
export const useOAuthLocationCallback = ({
  returnContext,
  onError,
}: {
  returnContext: ReturnContext
  onError: (err: Error) => void
}) => {
  const location = useLocation()
  const navigate = useNavigate()
  // Initialized from location so the connect button shows as busy on first render
  const [isProcessingCallback, setIsProcessingCallback] = useState(
    () => !!(location.state as OAuthLocationState)?.oauth,
  )
  const { processCallback } = useOAuthConnect({ onError, returnContext })

  useEffect(() => {
    const oauth = (location.state as OAuthLocationState)?.oauth
    if (!oauth) {
      return
    }

    const handleCallback = async () => {
      setIsProcessingCallback(true)
      try {
        await processCallback(oauth)
      } catch (err) {
        console.error('Failed to complete OAuth:', err)
      } finally {
        setIsProcessingCallback(false)
        navigate('.', { replace: true, state: null })
      }
    }

    handleCallback()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state])

  return { isProcessingCallback }
}
