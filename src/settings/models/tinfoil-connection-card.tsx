/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ConnectProviderButton } from '@/components/connect-provider-button'
import { TinfoilIcon } from '@/components/provider-icons'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { useDatabase, useHttpClient } from '@/contexts'
import { deleteIntegrationCredentials, setIntegrationEnabled } from '@/dal'
import { useIntegrationStatus } from '@/hooks/use-integration-status'
import { useOAuthLocationCallback } from '@/hooks/use-oauth-location-callback'
import { getOAuthCredentials } from '@/integrations/oauth-credentials'
import { revokeTokens as revokeTinfoilTokens } from '@/integrations/tinfoil/auth'
import { tinfoilManageSubscriptionUrl } from '@/integrations/tinfoil/constants'
import { openExternalUrl } from '@/lib/open-external-url'
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

/** Scroll target for the "Connect/Enable Tinfoil" affordances on model cards. */
export const tinfoilConnectionCardId = 'tinfoil-connection'

/**
 * Mirrors the plan gate in `src/ai/fetch.ts`: the plan-billed path requires the
 * integration connected AND enabled.
 */
const tinfoilCardDescription = (connected: boolean, enabled: boolean): string => {
  if (!connected) {
    return 'Power Tinfoil’s confidential models with your own plan. Connecting walks you through subscribing.'
  }
  if (enabled) {
    return 'Connected — Tinfoil models run on your plan.'
  }
  return 'Connected, but disabled — Tinfoil models use the managed service until you re-enable.'
}

/**
 * Connect/manage card for the Tinfoil subscription, shown on the Models page
 * since it changes how the built-in Tinfoil models are billed and routed.
 */
export const TinfoilConnectionCard = () => {
  const db = useDatabase()
  const httpClient = useHttpClient()
  const queryClient = useQueryClient()

  const [error, setError] = useState<string | null>(null)
  const { isProcessingCallback } = useOAuthLocationCallback({
    returnContext: '/settings/models',
    onError: (err) => setError(err.message),
  })

  const { data: integrationStatusData } = useIntegrationStatus()
  const isConnected = integrationStatusData?.tinfoilConnected ?? false
  const isEnabled = integrationStatusData?.tinfoilEnabled ?? false
  const userEmail = integrationStatusData?.tinfoilEmail || undefined

  const handleDisconnect = async () => {
    try {
      // Best-effort server-side revoke before clearing locally, so the paid
      // credential stops working even if the local copy later leaks.
      try {
        const creds = await getOAuthCredentials('tinfoil')
        if (creds.refresh_token) {
          await revokeTinfoilTokens(httpClient, creds.refresh_token)
        }
      } catch (revokeErr) {
        console.warn('Tinfoil token revoke failed; continuing with local disconnect', revokeErr)
      }
      await deleteIntegrationCredentials(db, 'tinfoil')
      await queryClient.invalidateQueries({ queryKey: ['integrationStatus'] })
    } catch (err) {
      console.error('Failed to disconnect Tinfoil', err)
      setError(err instanceof Error ? err.message : 'Failed to disconnect Tinfoil')
    }
  }

  const handleToggleEnabled = async (enabled: boolean) => {
    try {
      await setIntegrationEnabled(db, 'tinfoil', enabled)
      await queryClient.invalidateQueries({ queryKey: ['integrationStatus'] })
    } catch (err) {
      console.error('Failed to update Tinfoil integration', err)
    }
  }

  if (!integrationStatusData) {
    return null
  }

  return (
    <div id={tinfoilConnectionCardId} className="flex flex-col gap-4">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Card className="border border-border">
        <CardHeader className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-0 py-2">
          <div className="flex flex-col gap-1 min-w-0">
            <div className="flex items-center gap-2">
              <TinfoilIcon />
              <CardTitle className="text-base">{isConnected && userEmail ? userEmail : 'Tinfoil'}</CardTitle>
            </div>
            <p className="text-sm text-muted-foreground">{tinfoilCardDescription(isConnected, isEnabled)}</p>
          </div>

          <CardAction className="flex items-center gap-2">
            <Switch
              checked={isEnabled}
              onCheckedChange={(checked) => handleToggleEnabled(checked)}
              disabled={!isConnected}
            />
          </CardAction>
        </CardHeader>

        {!isConnected && (
          <CardContent>
            <ConnectProviderButton
              provider="tinfoil"
              isConnected={false}
              isProcessing={isProcessingCallback}
              onError={(err) => {
                setError(err.message)
              }}
              returnContext="/settings/models"
              className="w-full"
              connectLabel="Connect Tinfoil"
            />
          </CardContent>
        )}

        {isConnected && (
          <>
            <CardContent className="border-t p-0" />
            <CardFooter className="gap-2">
              <Button variant="outline" size="sm" onClick={() => void openExternalUrl(tinfoilManageSubscriptionUrl)}>
                Manage subscription
              </Button>
              <Button variant="outline" size="sm" onClick={handleDisconnect} className="ml-auto">
                Disconnect
              </Button>
            </CardFooter>
          </>
        )}
      </Card>
    </div>
  )
}
