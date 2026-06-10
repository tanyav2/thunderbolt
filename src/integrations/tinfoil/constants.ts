/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Where a connected user manages or cancels their Tinfoil subscription. A plain
 * outbound link: the Stripe portal URL is only reachable behind Tinfoil's own
 * dashboard session, which this client does not hold.
 */
export const tinfoilManageSubscriptionUrl = 'https://dash.tinfoil.sh/?tab=billing'
