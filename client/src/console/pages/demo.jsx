// Pages only the public demo shows: one-click sign-in and sign-up (the demo
// has no passkeys and asks for nothing), and what a share link guest sees
// when they open the console (they have no account).

import { useState } from 'react'
import { ArrowRight, LayoutDashboard, LogIn, UserPlus } from 'lucide-react'
import { Button, Spinner } from '../../components/ui'
import { DemoBanner } from '../../components/demo-banner'
import { useDemo } from '../../lib/demo'
import { Card } from '../components'
import { leaveTo } from '../lib/router'
import { AuthLayout } from '../shell'

export function DemoSignIn({ signup = false }) {
  const demo = useDemo()
  const [busy, setBusy] = useState(null)
  // Whoever is the owner of the demo's main workspace right now, if anyone.
  const ownerName = demo.viewAs.options.find((option) => option.id === 'owner')?.hint
  const hasOwner = Boolean(ownerName) && ownerName !== 'nobody'
  const go = async (kind) => {
    setBusy(kind)
    if (kind === 'signup') await demo.signUp()
    else await demo.signIn('owner')
    leaveTo('/')
  }
  return (
    <>
      {/* View as and Reset stay in reach while signed out. */}
      <DemoBanner />
      <AuthLayout>
        <Card className="p-6 sm:p-8" data-sw-demo-signin>
          <h1 className="text-xl font-semibold text-fg">{signup ? 'Create your account' : 'Sign in to the demo'}</h1>
          <p className="mt-2 text-sm text-muted">
            A real server signs you in with a passkey. The demo skips that: one click, nothing to fill in, and everything stays in this
            browser.
          </p>
          <div className="mt-6 grid gap-2">
            <Button
              size="touch"
              variant={signup ? 'secondary' : 'default'}
              onClick={() => go('signin')}
              disabled={Boolean(busy) || !hasOwner}
              data-sw-demo-signin-button
            >
              {busy === 'signin' ? <Spinner /> : <LogIn size={16} aria-hidden="true" />}{' '}
              {hasOwner ? `Sign in as ${ownerName} (the owner)` : 'Sign in as the owner'}
            </Button>
            {hasOwner ? null : (
              <p className="text-xs text-muted" data-sw-demo-no-owner>
                The demo workspace has no owner any more. Create an account, or reset the demo to start over.
              </p>
            )}
            <Button
              size="touch"
              variant={signup ? 'default' : 'secondary'}
              onClick={() => go('signup')}
              disabled={Boolean(busy)}
              data-sw-demo-signup-button
            >
              {busy === 'signup' ? <Spinner /> : <UserPlus size={16} aria-hidden="true" />} Create a new account
            </Button>
          </div>
        </Card>
      </AuthLayout>
    </>
  )
}

export function DemoGuestConsole() {
  const demo = useDemo()
  return (
    <>
      <DemoBanner />
      <AuthLayout>
        <Card className="p-6 sm:p-8" data-sw-demo-guest>
          <h1 className="text-xl font-semibold text-fg">Guests have no console</h1>
          <p className="mt-2 text-sm text-muted">
            You are viewing as a guest of a share link. Guests see one project&apos;s board and nothing about the workspace: no members, no
            other projects, no settings.
          </p>
          <div className="mt-6 grid gap-2">
            <Button asChild size="touch" variant="default">
              <a href="index.html">
                <LayoutDashboard size={16} aria-hidden="true" /> Open the shared board
              </a>
            </Button>
            <Button size="touch" variant="secondary" onClick={() => demo.viewAs.onChange('owner')}>
              View as the owner instead <ArrowRight size={16} aria-hidden="true" />
            </Button>
          </div>
        </Card>
      </AuthLayout>
    </>
  )
}
