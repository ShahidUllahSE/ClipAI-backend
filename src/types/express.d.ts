import type { Request } from 'express'
import type { UserRole } from '../constants/roles'

declare global {
  namespace Express {
    interface Request {
      userId?: string
      userRole?: UserRole
    }
  }
}

export type AuthedRequest = Request & {
  userId: string
  userRole: UserRole
}

export {}
