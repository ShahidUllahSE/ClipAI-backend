import type { BillingStatus, PlanId } from '../../constants/plans'
import type { UserRole } from '../../constants/roles'

export interface PublicUser {
  id: string
  name: string
  email: string
  role: UserRole
  isActive: boolean
  planId: PlanId
  remainingEdits: number
  billingStatus: BillingStatus
  emailVerified: boolean
  createdAt?: string
  updatedAt?: string
}

export interface AuthPayload {
  user: PublicUser
  token: string
  message?: string
}
