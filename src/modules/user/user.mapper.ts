import type { BillingStatus, PlanId } from '../../constants/plans'
import type { UserRole } from '../../constants/roles'
import type { PublicUser } from './user.types'

interface UserLike {
  _id: { toString(): string }
  name: string
  email: string
  role?: string
  isActive?: boolean
  planId: string
  remainingEdits: number
  billingStatus: string
  emailVerified: boolean
  createdAt?: Date
  updatedAt?: Date
}

export function toPublicUser(user: UserLike): PublicUser {
  return {
    id: user._id.toString(),
    name: user.name,
    email: user.email,
    role: (user.role as UserRole) || 'user',
    isActive: user.isActive !== false,
    planId: user.planId as PlanId,
    remainingEdits: user.remainingEdits,
    billingStatus: user.billingStatus as BillingStatus,
    emailVerified: user.emailVerified,
    createdAt: user.createdAt?.toISOString(),
    updatedAt: user.updatedAt?.toISOString(),
  }
}
