export const LEGAL_TEMPLATES = {
  terms: [
    'Terms',
    [
      [
        'Scope',
        'Replace this draft with the name, address, contact, jurisdiction and effective date of your server operator before use. This template does not offer a hosted service or create an agreement by itself.',
      ],
      [
        'Your content',
        'Capture and upload only sites and content you own or are authorized to use. Use test accounts and synthetic data. You retain your rights to captures and comments; you authorize the operator to store, process and display them only to provide the service and follow your sharing choices.',
      ],
      [
        'Access and responsibility',
        'Keep passkeys, recovery codes, project tokens and share links private. Workspace owners control membership and sharing. The operator may suspend access while investigating abuse and should provide a way to export content when lawful.',
      ],
      [
        'Service terms to complete',
        'Before inviting users, specify availability, support, termination, export periods, liability limits, dispute resolution, minimum age, and any fees and cancellation terms. Have qualified counsel review these terms for your jurisdiction.',
      ],
    ],
  ],
  privacy: [
    'Privacy',
    [
      [
        'Who handles data',
        'Replace this draft with the operator identity, privacy contact, effective date, hosting region, and applicable rights. The operator controls account and security data and processes captured content on instructions from workspace owners. Local Shapewall has no telemetry; pushing to a hosted server transfers the selected captures and comments to that operator.',
      ],
      [
        'What is stored',
        'Account handles, display names, passkey public keys, recovery-code hashes, sessions, workspace membership, captures, comments, project-token hashes and security audit events are stored. Passkey private keys stay with the authenticator. Captures can include sensitive content; use synthetic data and never upload data you lack authority to share.',
      ],
      [
        'Sharing and retention',
        'Workspace members and anyone holding an enabled share link can access the content that link permits. Removing a project, workspace or account deletes the relevant active data according to the documented deletion flow. Backups should age out within 30 days under an operator-enabled retention policy; restoration must honor outstanding deletion requests. Specify actual security-log and abuse-report retention periods before use.',
      ],
      [
        'Regions and requests',
        'Do not claim US hosting unless this deployment is hosted there. List actual regions, transfers, legal bases, subprocessors and access/deletion request procedures. The operator must document any email, analytics or anti-abuse providers it enables. This draft is not a completed privacy notice.',
      ],
    ],
  ],
  subprocessors: [
    'Subprocessors',
    [
      [
        'Replace before use',
        'List only providers actually used by this deployment, their purpose, processing location, data categories and current contractual information. No provider is required by the self-hosted application.',
      ],
      [
        'Optional providers to review',
        'DigitalOcean: server hosting if used. Cloudflare: DNS, TLS proxy, object storage or Turnstile if enabled. Resend: invite delivery if configured. GitHub: source hosting or repository integration if configured. Tailscale: private networking and public Funnel transport if enabled. Include other infrastructure and backup providers used by your operator.',
      ],
      [
        'Changes',
        'Name the operator contact and explain how users learn about provider changes. Review provider agreements and international transfer requirements before adopting this list.',
      ],
    ],
  ],
  'acceptable-use': [
    'Acceptable use',
    [
      [
        'Authorized use',
        'Capture only content you are permitted to access and share. Respect copyright, privacy and site access restrictions. Do not use the service for phishing, malware, illegal material, harassment or attempts to bypass another workspace’s access controls.',
      ],
      [
        'Secrets and personal data',
        'Use test accounts and synthetic data. Do not upload credentials, authentication sessions, personal health information or other regulated data unless the operator has expressly agreed to support it and put the required protections in place.',
      ],
      [
        'Reporting and action',
        'Replace this draft with the operator abuse email and notice procedure. A report form is available at /report on hosted deployments. Reports are private to the operator. The operator may suspend a workspace during review, document the reason and provide an appeal/export process where appropriate.',
      ],
    ],
  ],
}
