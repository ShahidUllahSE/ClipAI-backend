import type { NextFunction, Request, Response } from 'express'
import { HTTP_STATUS } from '../constants/http'
import type { UserRole } from '../constants/roles'
import { UserModel } from '../modules/user/user.model'
import { AppError } from '../utils/AppError'
import { verifyAccessToken } from '../utils/jwt'

export async function requireAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const header = req.headers.authorization
    const token = header?.startsWith('Bearer ') ? header.slice(7) : ''

    if (!token) {
      throw new AppError('Not signed in.', HTTP_STATUS.UNAUTHORIZED)
    }

    const userId = verifyAccessToken(token)
    const user = await UserModel.findById(userId)
      .select('_id role isActive')
      .lean()

    if (!user) {
      throw new AppError('Not signed in.', HTTP_STATUS.UNAUTHORIZED)
    }

    if (user.isActive === false) {
      throw new AppError('Account is disabled.', HTTP_STATUS.FORBIDDEN)
    }

    req.userId = userId
    req.userRole = (user.role as UserRole) || 'user'
    next()
  } catch (error) {
    next(error)
  }
}

export function requireAdmin(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  if (req.userRole !== 'admin') {
    next(new AppError('Admin access required.', HTTP_STATUS.FORBIDDEN))
    return
  }
  next()
}
