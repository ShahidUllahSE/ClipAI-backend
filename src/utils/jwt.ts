import jwt from 'jsonwebtoken'
import { env } from '../config'
import { HTTP_STATUS } from '../constants/http'
import { AppError } from './AppError'

interface AccessTokenPayload {
  sub: string
}

export function signAccessToken(userId: string): string {
  return jwt.sign({ sub: userId }, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'],
  })
}

export function verifyAccessToken(token: string): string {
  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as AccessTokenPayload
    if (!payload.sub) {
      throw new AppError('Invalid token.', HTTP_STATUS.UNAUTHORIZED)
    }
    return payload.sub
  } catch {
    throw new AppError('Invalid or expired session.', HTTP_STATUS.UNAUTHORIZED)
  }
}
