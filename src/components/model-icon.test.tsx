/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Model } from '@/types'
import '@testing-library/jest-dom'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'bun:test'
import { ModelIcon } from './model-icon'

const makeModel = (overrides: Partial<Model>): Model =>
  ({
    id: 'model-1',
    provider: 'tinfoil',
    name: 'DeepSeek V4 Pro',
    model: 'deepseek-v4-pro',
    enabled: 1,
    toolUsage: 1,
    isConfidential: 1,
    startWithReasoning: 0,
    supportsParallelToolCalls: 0,
    apiKey: null,
    vendor: null,
    ...overrides,
  }) as Model

describe('ModelIcon', () => {
  afterEach(() => {
    cleanup()
  })

  it('renders the vendor logo for a known vendor', () => {
    render(<ModelIcon model={makeModel({ vendor: 'deepseek' })} />)

    const logo = screen.getByRole('img', { name: 'deepseek logo' })
    expect(logo).toHaveAttribute('src', '/model-icons/deepseek.png')
  })

  it('renders light and dark variants when the vendor has both', () => {
    render(<ModelIcon model={makeModel({ name: 'Kimi K2.6', vendor: 'moonshot' })} />)

    const logos = screen.getAllByRole('img', { name: 'moonshot logo' })
    expect(logos.map((img) => img.getAttribute('src'))).toEqual([
      '/model-icons/moonshot-light.png',
      '/model-icons/moonshot-dark.png',
    ])
  })

  it('maps the zhipu vendor to the Z.ai logo', () => {
    render(<ModelIcon model={makeModel({ name: 'GLM 5.1', vendor: 'zhipu' })} />)

    expect(screen.getByRole('img', { name: 'zhipu logo' })).toHaveAttribute('src', '/model-icons/zai.png')
  })

  it('falls back to the model initial when the vendor is unknown or missing', () => {
    render(<ModelIcon model={makeModel({ name: 'my custom model', vendor: null })} />)

    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    expect(screen.getByText('M')).toBeInTheDocument()
  })
})
