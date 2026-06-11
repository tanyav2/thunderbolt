/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { TinfoilVerification } from '@/hooks/use-tinfoil-verification'
import { cn } from '@/lib/utils'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { useCallback, useEffect, useRef, useState } from 'react'

// The hosted Verification Center widget — visually identical to what Tinfoil
// ships and what tinfoil-webapp embeds. We feed it the verification document
// over postMessage rather than rebuilding the (detailed) attestation UI.
// This origin is allowlisted in src-tauri/tauri.conf.json `frame-src` — the
// packaged Tauri CSP blocks all other cross-origin frames, so changing the
// URL here requires updating that allowlist too.
const verificationCenterBaseUrl = 'https://verification-center.tinfoil.sh'
const verificationCenterOrigin = new URL(verificationCenterBaseUrl).origin

// Mirrors tinfoil-webapp's send schedule: post immediately, then a few backoff
// retries to survive the iframe's own init races.
const sendRetryDelaysMs = [100, 300, 800, 2000]

const resolveIsDarkMode = (theme: 'light' | 'dark' | 'system'): boolean => {
  if (theme === 'dark') {
    return true
  }
  if (theme === 'light') {
    return false
  }
  return typeof window !== 'undefined' && (window.matchMedia?.('(prefers-color-scheme: dark)')?.matches ?? false)
}

type VerificationCenterFrameProps = {
  verification: TinfoilVerification
  onClose: () => void
  isDarkMode: boolean
}

/**
 * The iframe + postMessage bridge. Radix unmounts it on close and remounts on
 * open, so `isReady` resets and the handshake re-runs per open.
 */
const VerificationCenterFrame = ({ verification, onClose, isDarkMode }: VerificationCenterFrameProps) => {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [isReady, setIsReady] = useState(false)
  const { doc } = verification

  // Keep callbacks/values the message listener needs in refs so the listener
  // effect mounts once (stable deps) and never reads a stale closure.
  const verificationRef = useRef(verification)
  verificationRef.current = verification
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== verificationCenterOrigin) {
        return
      }
      const type = (event.data as { type?: string } | null)?.type
      if (type === 'TINFOIL_VERIFICATION_CENTER_READY') {
        setIsReady(true)
      } else if (type === 'TINFOIL_VERIFICATION_CENTER_CLOSED') {
        onCloseRef.current()
      } else if (type === 'TINFOIL_REQUEST_VERIFICATION_DOCUMENT') {
        // Re-send the document we already have — a request from the widget is
        // usually an iframe-side init race, not a reason to re-attest the
        // enclave. While verification is still in flight (no doc yet) the
        // doc-push effect below delivers it as soon as it lands. But after a
        // terminal failure with no document there is nothing to push and no
        // other retry path, so re-attest.
        const { doc: currentDoc, status, retry } = verificationRef.current
        if (currentDoc) {
          iframeRef.current?.contentWindow?.postMessage(
            { type: 'TINFOIL_VERIFICATION_DOCUMENT', document: currentDoc },
            verificationCenterOrigin,
          )
        } else if (status === 'failed') {
          retry()
        }
      }
    }
    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [])

  // Signal "open" once ready; the iframe only exists while the modal is open.
  useEffect(() => {
    if (!isReady || !iframeRef.current) {
      return
    }
    iframeRef.current.contentWindow?.postMessage({ type: 'TINFOIL_VERIFICATION_CENTER_OPEN' }, verificationCenterOrigin)
  }, [isReady])

  // Push the document once ready, re-pushing when it updates (verifying → verified).
  useEffect(() => {
    if (!isReady || !doc || !iframeRef.current) {
      return
    }
    const send = () => {
      iframeRef.current?.contentWindow?.postMessage(
        { type: 'TINFOIL_VERIFICATION_DOCUMENT', document: doc },
        verificationCenterOrigin,
      )
    }
    send()
    const timers = sendRetryDelaysMs.map((ms) => setTimeout(send, ms))
    return () => timers.forEach(clearTimeout)
  }, [isReady, doc])

  const iframeUrl = `${verificationCenterBaseUrl}?darkMode=${isDarkMode}&showVerificationFlow=true&compact=false&open=true`

  return (
    <iframe
      ref={iframeRef}
      src={iframeUrl}
      title="Tinfoil Verification Center"
      // Hidden until ready so Tinfoil's white initial paint doesn't flash over
      // the modal's dark background on a dark-mode open.
      className={cn('min-h-0 w-full flex-1 border-0 transition-opacity', isReady ? 'opacity-100' : 'opacity-0')}
      style={{ colorScheme: isDarkMode ? 'dark' : 'light' }}
      onLoad={() => setIsReady(true)}
      // Thunderbolt's COEP (credentialless, for PowerSync's SharedArrayBuffer)
      // blocks cross-origin iframes lacking CORP/COEP; the widget sends neither,
      // so it needs credentialless to load. Not yet in React's iframe types.
      {...({ credentialless: '' } as Record<string, string>)}
    />
  )
}

type VerificationCenterModalProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  verification: TinfoilVerification
}

/**
 * Centered modal hosting the Verification Center. DialogContent is portaled +
 * fixed so it overlays the whole app; the iframe fills the modal body.
 */
export const VerificationCenterModal = ({ open, onOpenChange, verification }: VerificationCenterModalProps) => {
  const handleClose = useCallback(() => onOpenChange(false), [onOpenChange])
  const theme = useLocalSettingsStore((s) => s.theme)
  const isDarkMode = resolveIsDarkMode(theme)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex h-[80vh] w-[90vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-[480px]"
        aria-describedby={undefined}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>Verification Center</DialogTitle>
        </DialogHeader>
        {/* Remount the frame when the theme flips so the iframe reloads with the
            matching darkMode — the widget reads it only from the URL. */}
        <VerificationCenterFrame
          key={isDarkMode ? 'dark' : 'light'}
          verification={verification}
          onClose={handleClose}
          isDarkMode={isDarkMode}
        />
      </DialogContent>
    </Dialog>
  )
}
