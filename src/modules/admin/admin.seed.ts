import { PLAN_EDIT_QUOTA, PLAN_IDS } from '../../constants/plans'
import { EmailTemplateModel } from './models/email-template.model'
import { PlanModel } from './models/plan.model'
import { SystemSettingsModel } from './models/system-settings.model'

const PLAN_META: Record<
  (typeof PLAN_IDS)[number],
  { name: string; price: number; description: string; features: string[] }
> = {
  basic: {
    name: 'Basic',
    price: 20,
    description: 'For creators posting a few times a week.',
    features: [
      '80 render tokens each cycle',
      'Talking-head, rapid-cut & ASMR',
      'Captions, ratios & export options',
    ],
  },
  standard: {
    name: 'Standard',
    price: 40,
    description: 'Steady output for growing channels.',
    features: [
      '200 render tokens each cycle',
      'All editing modes & options',
      'Preview before download',
    ],
  },
  pro: {
    name: 'Pro',
    price: 49,
    description: 'High-volume short-form publishing.',
    features: [
      '400 render tokens each cycle',
      'All modes, options & aspect ratios',
      'Retry eligible failed jobs free',
    ],
  },
  unlimited: {
    name: 'Unlimited',
    price: 99,
    description: 'For teams and daily publishers.',
    features: [
      'Unlimited tokens under fair use',
      'Team-friendly monthly ceiling',
      'All product features included',
    ],
  },
}

const DEFAULT_TEMPLATES = [
  {
    slug: 'welcome',
    name: 'Welcome email',
    subject: 'Welcome to ClipAI',
    body: 'Hi {{name}},\n\nWelcome to ClipAI. Start your first edit from the dashboard.\n\n— ClipAI',
  },
  {
    slug: 'verify-email',
    name: 'Verify email',
    subject: 'Verify your ClipAI email',
    body: 'Hi {{name}},\n\nVerify your email: {{link}}\n\n— ClipAI',
  },
  {
    slug: 'password-reset',
    name: 'Password reset',
    subject: 'Reset your ClipAI password',
    body: 'Hi {{name}},\n\nReset your password: {{link}}\n\n— ClipAI',
  },
  {
    slug: 'support-reply',
    name: 'Support reply',
    subject: 'Re: {{subject}}',
    body: 'Hi {{name}},\n\n{{reply}}\n\n— ClipAI Support',
  },
]

export async function seedAdminDefaults(): Promise<void> {
  for (let i = 0; i < PLAN_IDS.length; i += 1) {
    const slug = PLAN_IDS[i]
    const meta = PLAN_META[slug]
    await PlanModel.updateOne(
      { slug },
      {
        $setOnInsert: {
          slug,
          name: meta.name,
          price: meta.price,
          editQuota: PLAN_EDIT_QUOTA[slug],
          description: meta.description,
          features: meta.features,
          isActive: true,
          sortOrder: i,
        },
      },
      { upsert: true },
    )
  }

  for (const template of DEFAULT_TEMPLATES) {
    await EmailTemplateModel.updateOne(
      { slug: template.slug },
      { $setOnInsert: { ...template, isActive: true } },
      { upsert: true },
    )
  }

  await SystemSettingsModel.updateOne(
    { key: 'global' },
    {
      $setOnInsert: {
        key: 'global',
        appName: 'ClipAI',
        supportEmail: 'support@clipai.dev',
        announcementBanner: '',
        maintenanceMode: false,
        allowSignups: true,
        maxUploadMb: 500,
        maxDurationSeconds: 1800,
        defaultPlanSlug: 'basic',
        featureFlags: {
          captions: true,
          aiCombine: true,
          retakeRemoval: true,
          randomZoom: true,
        },
      },
    },
    { upsert: true },
  )
}
