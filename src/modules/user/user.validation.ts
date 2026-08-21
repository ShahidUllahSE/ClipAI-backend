import { z } from 'zod'
import { PLAN_IDS } from '../../constants/plans'

export const registerSchema = z.object({
  name: z.string().trim().min(1, 'Name is required.').max(80),
  email: z.string().trim().email('Enter a valid email.').toLowerCase(),
  password: z
    .string()
    .min(6, 'Password must be at least 6 characters.')
    .max(72),
  planId: z.enum(PLAN_IDS).optional(),
})

export const loginSchema = z.object({
  email: z.string().trim().email('Enter a valid email.').toLowerCase(),
  password: z.string().min(1, 'Password is required.'),
})

export const updateProfileSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    email: z.string().trim().email().toLowerCase().optional(),
  })
  .refine((data) => data.name !== undefined || data.email !== undefined, {
    message: 'Nothing to update.',
  })

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required.'),
  newPassword: z
    .string()
    .min(6, 'New password must be at least 6 characters.')
    .max(72),
})

export const forgotPasswordSchema = z.object({
  email: z.string().trim().email().toLowerCase(),
})

export const resetPasswordSchema = z.object({
  token: z.string().min(1, 'Reset token is required.'),
  password: z
    .string()
    .min(6, 'Password must be at least 6 characters.')
    .max(72),
})

export const verifyEmailSchema = z.object({
  token: z.string().min(1, 'Token is required.'),
})

export const setPlanSchema = z.object({
  planId: z.enum(PLAN_IDS),
})
