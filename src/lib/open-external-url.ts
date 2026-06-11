/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { isTauri } from '@/lib/platform'
import { isSafeUrl } from '@/lib/url-utils'

/**
 * Open a trusted external URL in the system browser (Tauri) or a new tab (web).
 * For first-party destinations only; untrusted in-content links should go
 * through {@link useExternalLinkDialog}. Validated with {@link isSafeUrl} so a
 * caller mistake can't smuggle a `javascript:` scheme into `window.open`.
 */
export const openExternalUrl = async (url: string): Promise<void> => {
  if (!isSafeUrl(url)) {
    console.error('Refusing to open unsafe URL:', url)
    return
  }
  if (isTauri()) {
    const { openUrl } = await import('@tauri-apps/plugin-opener')
    await openUrl(url)
    return
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}
