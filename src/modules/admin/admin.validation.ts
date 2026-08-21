import { z } from 'zod'
import { BILLING_STATUSES, PLAN_IDS } from '../../constants/plans'
import { USER_ROLES } from '../../constants/roles'

export const listUsersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().trim().optional(),
  planId: z.enum(PLAN_IDS).optional(),
  billingStatus: z.enum(BILLING_STATUSES).optional(),
  role: z.enum(USER_ROLES).optional(),
  isActive: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
})

export const updateUserSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    email: z.string().trim().email().toLowerCase().optional(),
    planId: z.enum(PLAN_IDS).optional(),
    remainingEdits: z.number().int().min(0).optional(),
    billingStatus: z.enum(BILLING_STATUSES).optional(),
    role: z.enum(USER_ROLES).optional(),
    isActive: z.boolean().optional(),
    emailVerified: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Nothing to update.',
  })
