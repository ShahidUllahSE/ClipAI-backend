import { z } from 'zod'
import { BILLING_STATUSES } from '../../constants/plans'
import { EDITING_MODES, PROJECT_STATUSES } from '../../constants/projects'
import { USER_ROLES } from '../../constants/roles'
import {
  TICKET_PRIORITIES,
  TICKET_STATUSES,
} from './models/support-ticket.model'
import { TOKEN_LEDGER_REASONS } from './models/token-ledger.model'

export const listUsersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().trim().optional(),
  planId: z.string().trim().optional(),
  billingStatus: z.enum(BILLING_STATUSES).optional(),
  role: z.enum(USER_ROLES).optional(),
  isActive: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
})

export const listProjectsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().trim().optional(),
  status: z.enum(PROJECT_STATUSES).optional(),
  mode: z.enum(EDITING_MODES).optional(),
  userId: z.string().trim().optional(),
})

export const listJobsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(PROJECT_STATUSES).optional(),
  activeOnly: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
})

export const createUserSchema = z.object({
  name: z.string().trim().min(1).max(80),
  email: z.string().trim().email().toLowerCase(),
  password: z.string().min(6).max(120),
  planId: z.string().trim().optional(),
  remainingEdits: z.number().int().min(0).optional(),
  billingStatus: z.enum(BILLING_STATUSES).optional(),
  role: z.enum(USER_ROLES).optional(),
  isActive: z.boolean().optional(),
  emailVerified: z.boolean().optional(),
})

export const updateUserSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    email: z.string().trim().email().toLowerCase().optional(),
    planId: z.string().trim().optional(),
    remainingEdits: z.number().int().min(0).optional(),
    billingStatus: z.enum(BILLING_STATUSES).optional(),
    role: z.enum(USER_ROLES).optional(),
    isActive: z.boolean().optional(),
    emailVerified: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Nothing to update.',
  })

export const adjustTokensSchema = z.object({
  mode: z.enum(['add', 'deduct', 'set', 'reset']),
  amount: z.number().int().min(0).optional(),
  note: z.string().trim().max(240).optional(),
})

export const createPlanSchema = z.object({
  slug: z
    .string()
    .trim()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9-]+$/, 'Slug must be lowercase letters, numbers, dashes.'),
  name: z.string().trim().min(1).max(80),
  price: z.number().min(0),
  editQuota: z.number().int().min(0),
  description: z.string().trim().max(240).optional(),
  features: z.array(z.string().trim().max(120)).optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
})

export const updatePlanSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    price: z.number().min(0).optional(),
    editQuota: z.number().int().min(0).optional(),
    description: z.string().trim().max(240).optional(),
    features: z.array(z.string().trim().max(120)).optional(),
    isActive: z.boolean().optional(),
    sortOrder: z.number().int().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Nothing to update.',
  })

export const listTicketsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(TICKET_STATUSES).optional(),
  priority: z.enum(TICKET_PRIORITIES).optional(),
  q: z.string().trim().optional(),
})

export const createTicketSchema = z.object({
  userId: z.string().trim().min(1),
  subject: z.string().trim().min(1).max(160),
  body: z.string().trim().min(1).max(5000),
  priority: z.enum(TICKET_PRIORITIES).optional(),
})

export const replyTicketSchema = z.object({
  body: z.string().trim().min(1).max(5000),
  status: z.enum(TICKET_STATUSES).optional(),
})

export const updateTicketSchema = z
  .object({
    status: z.enum(TICKET_STATUSES).optional(),
    priority: z.enum(TICKET_PRIORITIES).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Nothing to update.',
  })

export const createTemplateSchema = z.object({
  slug: z
    .string()
    .trim()
    .min(2)
    .max(60)
    .regex(/^[a-z0-9-]+$/),
  name: z.string().trim().min(1).max(100),
  subject: z.string().trim().min(1).max(200),
  body: z.string().min(1).max(20000),
  isActive: z.boolean().optional(),
})

export const updateTemplateSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    subject: z.string().trim().min(1).max(200).optional(),
    body: z.string().min(1).max(20000).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Nothing to update.',
  })

export const listActivityQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  q: z.string().trim().optional(),
})

export const listUsageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  userId: z.string().trim().optional(),
  reason: z.enum(TOKEN_LEDGER_REASONS).optional(),
})

export const listSubscriptionsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  billingStatus: z.enum(BILLING_STATUSES).optional(),
  planId: z.string().trim().optional(),
  q: z.string().trim().optional(),
})

export const updateSettingsSchema = z
  .object({
    appName: z.string().trim().min(1).max(80).optional(),
    supportEmail: z.string().trim().email().optional(),
    announcementBanner: z.string().max(500).optional(),
    maintenanceMode: z.boolean().optional(),
    allowSignups: z.boolean().optional(),
    maxUploadMb: z.number().int().min(1).max(5000).optional(),
    maxDurationSeconds: z.number().int().min(30).max(7200).optional(),
    defaultPlanSlug: z.string().trim().optional(),
    featureFlags: z
      .object({
        captions: z.boolean().optional(),
        aiCombine: z.boolean().optional(),
        retakeRemoval: z.boolean().optional(),
        randomZoom: z.boolean().optional(),
      })
      .optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Nothing to update.',
  })
