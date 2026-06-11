/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { cn } from '@/lib/utils'
import type { Model } from '@/types'

type VendorIcon = {
  /** Icon used in light mode, and in dark mode when no `darkSrc` is provided. */
  src: string
  /** Dark-mode variant for glyphs that are illegible on dark backgrounds. */
  darkSrc?: string
}

/**
 * Vendor logo assets in `public/model-icons/`. To support a new vendor, drop
 * its PNG there and add an entry keyed by the `vendor` column on the model.
 */
const vendorIcons: Record<string, VendorIcon> = {
  deepseek: { src: '/model-icons/deepseek.png' },
  moonshot: { src: '/model-icons/moonshot-light.png', darkSrc: '/model-icons/moonshot-dark.png' },
  openai: { src: '/model-icons/openai-light.png', darkSrc: '/model-icons/openai-dark.png' },
  zhipu: { src: '/model-icons/zai.png' },
}

/**
 * Avatar for a model: the vendor's logo when we have one, otherwise the
 * model's initial on the primary-color tile.
 */
export const ModelIcon = ({ model, className }: { model: Model; className?: string }) => {
  const icon = model.vendor ? vendorIcons[model.vendor] : undefined

  if (!icon) {
    return (
      <div
        className={cn(
          'flex items-center justify-center bg-primary text-primary-foreground size-8 rounded-md font-medium flex-shrink-0',
          className,
        )}
      >
        {model.name[0].toUpperCase()}
      </div>
    )
  }

  return (
    <div className={cn('flex items-center justify-center size-8 rounded-md flex-shrink-0', className)}>
      <img
        src={icon.src}
        alt={`${model.vendor} logo`}
        className={cn('size-full object-contain', icon.darkSrc && 'dark:hidden')}
      />
      {icon.darkSrc && (
        <img src={icon.darkSrc} alt={`${model.vendor} logo`} className="hidden size-full object-contain dark:block" />
      )}
    </div>
  )
}
