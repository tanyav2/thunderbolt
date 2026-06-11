/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useDatabase } from '@/contexts'
import { getIntegrationStatus } from '@/dal'
import { useQuery } from '@tanstack/react-query'

export type IntegrationStatus = {
  googleConnected: boolean
  googleEnabled: boolean
  googleEmail: string | null
  microsoftConnected: boolean
  microsoftEnabled: boolean
  microsoftEmail: string | null
  tinfoilConnected: boolean
  tinfoilEnabled: boolean
  tinfoilRequiresReauth: boolean
}

export const useIntegrationStatus = (): {
  data: IntegrationStatus | null
  isLoading: boolean
  error: Error | null
} => {
  const db = useDatabase()

  const query = useQuery({
    queryKey: ['integrationStatus'],
    queryFn: (): Promise<IntegrationStatus> => getIntegrationStatus(db),
  })

  return {
    data: query.data ?? null,
    isLoading: query.isLoading,
    error: query.error as Error | null,
  }
}
