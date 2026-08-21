export const PLAN_IDS = ['basic', 'standard', 'pro', 'unlimited'] as const
export type PlanId = (typeof PLAN_IDS)[number]

export const PLAN_EDIT_QUOTA: Record<PlanId, number> = {
  basic: 50,
  standard: 100,
  pro: 200,
  unlimited: 9999,
}

export const BILLING_STATUSES = [
  'active',
  'past_due',
  'canceled',
  'none',
] as const
export type BillingStatus = (typeof BILLING_STATUSES)[number]

export const TOKEN_TYPES = {
  EMAIL_VERIFY: 'email_verify',
  PASSWORD_RESET: 'password_reset',
} as const

export type TokenType = (typeof TOKEN_TYPES)[keyof typeof TOKEN_TYPES]

export const TOKEN_TTL_MS = {
  EMAIL_VERIFY: 24 * 60 * 60 * 1000,
  PASSWORD_RESET: 60 * 60 * 1000,
} as const
