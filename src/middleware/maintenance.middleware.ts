import type { NextFunction, Request, Response } from 'express'
import { HTTP_STATUS } from '../constants/http'
import { getPublicSettings } from '../modules/admin/public-settings'
import { UserModel } from '../modules/user/user.model'
import { verifyAccessToken } from '../utils/jwt'

const ALLOW_PREFIXES = [
  '/api/health',
  '/api/public/',
  '/api/auth/login',
  '/api/auth/forgot-password',
  '/api/auth/reset-password',
]

export async function maintenanceGate(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const path = req.originalUrl.split('?')[0] || ''
    if (!path.startsWith('/api')) return next()
    if (ALLOW_PREFIXES.some((p) => path === p || path.startsWith(p))) {
      return next()
    }

    const settings = await getPublicSettings()
    if (!settings.maintenanceMode) return next()

    const header = req.headers.authorization
    if (header?.startsWith('Bearer ')) {
      try {
        const userId = verifyAccessToken(header.slice(7))
        const user = await UserModel.findById(userId)
          .select('role isActive')
          .lean()
        if (user?.role === 'admin' && user.isActive !== false) {
          return next()
        }
      } catch {
        // fall through to maintenance response
      }
    }

    return res.status(HTTP_STATUS.SERVICE_UNAVAILABLE).json({
      message: 'ClipAI is in maintenance mode. Please try again shortly.',
      maintenanceMode: true,
    })
  } catch (error) {
    return next(error)
  }
}
