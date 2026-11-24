// Getting in: sign up, sign in (and its error and SSO paths), two-step
// codes, password reset, invites, and the five onboarding steps.
import { auth, centered, onboarding } from '../shells.js'
import { avatar, badge, btn, esc, field, icon } from '../ui.js'

const A = 'Sign up & sign in'
const O = 'Onboarding'

const google = () =>
  `<button class="btn block lg" type="button"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="none" stroke="#2563eb" stroke-width="3"/></svg>Continue with a work account</button>`

function signup(ctx) {
  const rules =
    ctx.round >= 2
      ? '<p class="help" data-testid="password-rules">At least 12 characters. A passphrase works well.</p>'
      : '<p class="help err" data-testid="password-rules">Password must be at least 12 characters!</p>'
  return auth({
    title: 'Start your free trial',
    body: `<div><h1>Start your free trial</h1><p class="muted mt-s">14 days of Growth, free. No card needed.</p></div>${google()}<div class="divider">or</div>
    <form class="stack" action="/signup/check-email/" method="post">${field('Your name', 'Robin Ash')}${field('Work email', 'robin@northgate.example', { state: 'focus' })}${field('Company', 'Northgate Mechanical')}
    <div class="field"><label>Password</label><div class="input"></div>${rules}</div>
    <button class="btn primary lg" type="submit" data-testid="signup-submit">Create account</button></form><p class="muted small">Already have an account? <a href="/signin/">Sign in</a></p>`,
  })
}

const signin = (error = false) =>
  auth({
    title: error ? 'Sign in: wrong password' : 'Sign in',
    body: `<div><h1>Welcome back</h1><p class="muted mt-s">Sign in to Northgate Mechanical and other workspaces.</p></div>${
      error
        ? `<div class="alert err" data-testid="signin-error">${icon('circle-x')}<div><strong>That email and password do not match.</strong><br />Try again, or reset your password. After 5 tries we pause sign in for 10 minutes.</div></div>`
        : ''
    }${google()}<div class="divider">or</div><form class="stack" action="/app/" method="post">${field('Work email', 'robin@northgate.example')}<div class="field"><div class="row between"><label>Password</label><a class="small" href="/forgot-password/">Forgot password?</a></div><div class="input ${error ? 'err' : ''}"></div></div>
    <button class="btn primary lg" type="submit" data-testid="signin-submit">Sign in</button></form><a class="btn ghost" href="/signin/sso/">${icon('key-round')}Sign in with SSO</a><p class="muted small">New to Brackwell? <a href="/signup/">Start a free trial</a></p>`,
  })

const sso = () =>
  auth({
    title: 'Single sign-on',
    body: `<div><h1>Sign in with SSO</h1><p class="muted mt-s">Your company signs you in. Enter your work email or your workspace's address.</p></div><form class="stack" action="/two-factor/" method="post">${field('Work email', 'robin@northgate.example')}<button class="btn primary lg" type="submit">Continue</button></form>
    <div class="alert info">${icon('shield-check')}<div>Northgate Mechanical uses SSO through its identity provider. You will come back here after signing in there.</div></div><a class="small" href="/signin/">${'Back to sign in'}</a>`,
  })

const twoFactor = () =>
  auth({
    title: 'Two-step code',
    body: `<div><h1>Enter your code</h1><p class="muted mt-s">We sent a 6-digit code to the authenticator app on your phone.</p></div><div class="otp" data-testid="otp">${[
      '4',
      '8',
      '1',
      '',
      '',
      '',
    ]
      .map((d, i) => `<span class="${i === 3 ? 'on' : ''}">${d}</span>`)
      .join(
        '',
      )}</div><form class="stack" action="/app/" method="post"><button class="btn primary lg" type="submit">Verify</button></form><label class="row small"><span class="cb on"></span>Trust this device for 30 days</label><a class="small" href="/signin/">Use a recovery code instead</a>`,
  })

const forgot = () =>
  auth({
    title: 'Reset password',
    body: `<div><h1>Reset your password</h1><p class="muted mt-s">We will email you a link. It works for one hour.</p></div><form class="stack" action="/forgot-password/sent/" method="post">${field('Work email', 'robin@northgate.example')}<button class="btn primary lg" type="submit" data-testid="reset-submit">Send reset link</button></form><a class="small" href="/signin/">Back to sign in</a>`,
  })

const resetSent = () =>
  centered({
    title: 'Check your email',
    body: `<div class="big-ic blue">${icon('mail')}</div><h1>Check your email</h1><p class="muted">If robin@northgate.example has an account, a reset link is on its way. It works for one hour.</p><a class="btn" href="/signin/">Back to sign in</a><p class="small muted">No email after 5 minutes? Check spam, or <a href="/forgot-password/">send it again</a>.</p>`,
  })

const checkEmail = () =>
  centered({
    title: 'Confirm your email',
    body: `<div class="big-ic">${icon('mail')}</div><h1>Confirm your email</h1><p class="muted">We sent a link to <strong>robin@northgate.example</strong>. Open it on this device to finish setting up Northgate Mechanical.</p><a class="btn primary" href="/welcome/">I confirmed it</a><p class="small muted">Wrong address? <a href="/signup/">Change it</a></p>`,
  })

const invite = () =>
  centered({
    title: 'Join Northgate Mechanical',
    body: `<div class="avs">${avatar('Robin Ash', 'lg')}${avatar('Northgate Mechanical', 'lg')}</div><h1>Robin Ash invited you to Northgate Mechanical</h1><p class="muted">You will join as a <strong>Dispatcher</strong>: you can schedule and assign jobs, and see customers and parts.</p>
    <form class="stack" style="width:100%;text-align:left" action="/app/" method="post">${field('Your name', 'Alex Kim')}<div class="field"><label>Choose a password</label><div class="input"></div></div><button class="btn primary lg" type="submit" data-testid="accept-invite">Accept and join</button></form><p class="small muted">This invite expires in 7 days.</p>`,
  })

const signedOut = () =>
  centered({
    title: 'Session ended',
    body: `<div class="big-ic">${icon('lock')}</div><h1>You were signed out</h1><p class="muted">For security, Brackwell signs you out after 12 hours without activity. Your drafts are saved.</p><a class="btn primary" href="/signin/">Sign in again</a>`,
  })

const obFoot = (back, next, label = 'Continue') =>
  `<div class="row between"><a class="btn ghost" href="${back}">${icon('arrow-left')}Back</a><a class="btn primary" href="${next}" data-testid="ob-next">${label}${icon('arrow-right')}</a></div>`

const obCompany = () =>
  onboarding({
    title: 'Welcome: your company',
    step: 1,
    body: `<div><h1>Welcome to Brackwell, Robin</h1><p class="muted mt-s">A few questions so your workspace starts out looking like your business.</p></div>${field('Company name', 'Northgate Mechanical')}<div class="grid g2">${field('Industry', 'HVAC and mechanical', { kind: 'select' })}${field('Time zone', 'Central Time', { kind: 'select' })}</div>
    <div class="field"><label>How many technicians do you have?</label><div class="row wrap">${['1-5', '6-20', '21-50', '51-200', '200+'].map((n) => `<span class="chip ${n === '21-50' ? 'on' : ''}">${n}</span>`).join('')}</div></div>${obFoot('/signup/check-email/', '/welcome/trades/')}`,
  })

const obTrades = () =>
  onboarding({
    title: 'Welcome: trades',
    step: 2,
    body: `<div><h1>What kind of work do you do?</h1><p class="muted mt-s">We will add job templates and checklists for each trade you pick.</p></div><div class="grid g2">${[
      ['fan', 'HVAC', true],
      ['zap', 'Electrical', true],
      ['droplets', 'Plumbing', true],
      ['thermometer', 'Refrigeration', false],
      ['flame', 'Fire safety', false],
      ['cpu', 'Controls', false],
    ]
      .map(
        ([ic, t, on]) =>
          `<div class="radio-card ${on ? 'on' : ''}"><span class="big-ic" style="width:36px;height:36px;border-radius:10px">${icon(ic)}</span><div class="grow"><strong>${t}</strong><div class="muted small">${on ? '12 templates' : 'Add templates'}</div></div><span class="cb ${on ? 'on' : ''}"></span></div>`,
      )
      .join('')}</div>${obFoot('/welcome/', '/welcome/team/')}`,
  })

const obTeam = () =>
  onboarding({
    title: 'Welcome: invite your team',
    step: 3,
    body: `<div><h1>Invite your team</h1><p class="muted mt-s">Office seats are free. Technicians get a text with a link to the app.</p></div>${[
      ['jo@northgate.example', 'Admin'],
      ['mei@northgate.example', 'Dispatcher'],
      ['(555) 014-2290', 'Technician'],
      ['', 'Technician'],
    ]
      .map(
        ([who, role]) =>
          `<div class="row"><div class="input grow">${who ? esc(who) : '<span class="faint">Email or mobile number</span>'}</div><div class="select" style="width:150px">${role}${icon('chevron-down')}</div></div>`,
      )
      .join(
        '',
      )}<a class="small row" href="/welcome/team/">${icon('plus')}Add another</a>${obFoot('/welcome/trades/', '/welcome/import/', 'Send 3 invites')}`,
  })

const obImport = () =>
  onboarding({
    title: 'Welcome: import customers',
    step: 4,
    body: `<div><h1>Bring your customers</h1><p class="muted mt-s">Upload a spreadsheet, or connect your accounting tool. You can skip this and add them later.</p></div>
    <div class="radio-card on" style="flex-direction:column;align-items:center;text-align:center;padding:28px;border-style:dashed" data-testid="dropzone"><span class="big-ic">${icon('upload')}</span><strong>Drop a CSV or spreadsheet here</strong><span class="muted small">Columns we look for: name, address, phone, email</span>${btn('Choose a file', { size: 'sm' })}</div>
    <div class="grid g2">${['Ledgerly', 'Booksmith'].map((n) => `<div class="radio-card">${icon('plug')}<div class="grow"><strong>${n}</strong><div class="muted small">Import customers and items</div></div>${btn('Connect', { size: 'sm' })}</div>`).join('')}</div>${obFoot('/welcome/team/', '/welcome/first-job/')}`,
  })

const obFirstJob = () =>
  onboarding({
    title: 'Welcome: first job',
    step: 5,
    body: `<div><h1>Create your first job</h1><p class="muted mt-s">We filled this in from your answers. Change anything, then add it to tomorrow's schedule.</p></div>${field('Job', 'Quarterly PM: rooftop units')}<div class="grid g2">${field('Customer', 'Crestline Dental Group', { kind: 'select' })}${field('Template', 'HVAC preventive maintenance', { kind: 'select' })}</div><div class="grid g2">${field('When', 'Tomorrow, 9:00 to 11:00', { kind: 'select' })}${field('Technician', 'Dana Whitlock', { kind: 'select' })}</div>${obFoot('/welcome/import/', '/welcome/done/', 'Create job')}`,
  })

const obDone = () =>
  onboarding({
    title: 'Welcome: all set',
    step: 5,
    body: `<div class="stack" style="align-items:center;text-align:center"><div class="big-ic green">${icon('circle-check')}</div><h1>Northgate Mechanical is ready</h1><p class="muted">Your first job is on tomorrow's schedule and 3 invites are on their way.</p></div>
    <div class="stack tight">${[
      ['Create your first job', true],
      ['Invite your team', true],
      ['Import customers', false],
      ['Connect accounting', false],
      ['Download the technician app', false],
    ]
      .map(
        ([t, done]) =>
          `<div class="check-row ${done ? 'done' : ''}"><span class="box">${done ? icon('check') : ''}</span><span class="txt grow">${t}</span>${done ? '' : badge('2 min', 'plain')}</div>`,
      )
      .join('')}</div><a class="btn primary lg" href="/app/" data-testid="ob-finish">Go to my dashboard</a>`,
  })

export const pages = [
  { id: 'signup', path: '/signup/', title: 'Sign up', group: A, render: signup },
  { id: 'check-email', path: '/signup/check-email/', title: 'Confirm your email', group: A, render: checkEmail },
  { id: 'signin', path: '/signin/', title: 'Sign in', group: A, render: () => signin(false) },
  {
    id: 'signin-error',
    path: '/signin/error/',
    title: 'Sign in: wrong password',
    group: A,
    note: 'Error state',
    render: () => signin(true),
  },
  { id: 'signin-sso', path: '/signin/sso/', title: 'Sign in with SSO', group: A, render: sso },
  { id: 'two-factor', path: '/two-factor/', title: 'Two-step code', group: A, render: twoFactor },
  { id: 'forgot', path: '/forgot-password/', title: 'Forgot password', group: A, render: forgot },
  { id: 'reset-sent', path: '/forgot-password/sent/', title: 'Reset link sent', group: A, render: resetSent },
  { id: 'invite-accept', path: '/invite/', title: 'Accept invite', group: A, render: invite },
  { id: 'signed-out', path: '/signed-out/', title: 'Session ended', group: A, render: signedOut },
  { id: 'ob-company', path: '/welcome/', title: 'Onboarding 1: company', group: O, render: obCompany },
  { id: 'ob-trades', path: '/welcome/trades/', title: 'Onboarding 2: trades', group: O, render: obTrades },
  { id: 'ob-team', path: '/welcome/team/', title: 'Onboarding 3: team', group: O, render: obTeam },
  { id: 'ob-import', path: '/welcome/import/', title: 'Onboarding 4: customers', group: O, render: obImport },
  { id: 'ob-first-job', path: '/welcome/first-job/', title: 'Onboarding 5: first job', group: O, render: obFirstJob },
  { id: 'ob-done', path: '/welcome/done/', title: 'Onboarding: all set', group: O, render: obDone },
]
