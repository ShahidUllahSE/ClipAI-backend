import { Types } from 'mongoose'
import { env } from '../../config'
import { HTTP_STATUS } from '../../constants/http'
import {
  PLAN_EDIT_QUOTA,
  TOKEN_TTL_MS,
  TOKEN_TYPES,
  type PlanId,
  type TokenType,
} from '../../constants/plans'
import { mailService } from '../../integrations/mail.service'
import { AppError } from '../../utils/AppError'
import { createRawToken, hashToken } from '../../utils/crypto'
import { signAccessToken } from '../../utils/jwt'
import { comparePassword, hashPassword } from '../../utils/password'
import { toPublicUser } from './user.mapper'
import { UserModel, type UserDocument } from './user.model'
import type { AuthPayload, PublicUser } from './user.types'

function clientOrigin(originHeader?: string): string {
  if (env.isDev && originHeader) return originHeader
  return env.CLIENT_URL
}

function verifyLink(origin: string, token: string): string {
  return `${origin}/verify-email?token=${encodeURIComponent(token)}`
}

function resetLink(origin: string, token: string): string {
  return `${origin}/reset-password?token=${encodeURIComponent(token)}`
}

function withAuth(user: PublicUser, extra?: Record<string, unknown>): AuthPayload {
  return {
    user,
    token: signAccessToken(user.id),
    ...extra,
  }
}

async function findUserOrFail(userId: string): Promise<UserDocument> {
  const user = await UserModel.findById(userId)
  if (!user) throw new AppError('User not found.', HTTP_STATUS.NOT_FOUND)
  return user
}

async function issueToken(
  user: UserDocument,
  type: TokenType,
  ttlMs: number,
): Promise<string> {
  const raw = createRawToken()
  const kept = (user.tokens ?? [])
    .filter((t) => t.type !== type)
    .map((t) => ({
      type: t.type,
      tokenHash: t.tokenHash,
      expiresAt: t.expiresAt,
      usedAt: t.usedAt ?? null,
      createdAt: t.createdAt,
    }))

  kept.push({
    type,
    tokenHash: hashToken(raw),
    expiresAt: new Date(Date.now() + ttlMs),
    usedAt: null,
    createdAt: new Date(),
  })

  user.set('tokens', kept)
  user.markModified('tokens')
  await user.save()
  return raw
}

async function consumeToken(
  raw: string,
  type: TokenType,
): Promise<UserDocument | null> {
  const tokenHash = hashToken(raw)
  const user = await UserModel.findOne({
    'tokens.tokenHash': tokenHash,
    'tokens.type': type,
    'tokens.usedAt': null,
  }).select('+tokens')

  if (!user) return null

  const entry = user.tokens.find(
    (t) => t.tokenHash === tokenHash && t.type === type && !t.usedAt,
  )
  if (!entry || entry.expiresAt.getTime() < Date.now()) return null

  entry.usedAt = new Date()
  await user.save()
  return user
}

async function sendVerifyOrThrow(email: string, url: string) {
  try {
    await mailService.sendVerifyEmail(email, url)
  } catch (error) {
    console.error('[mail] verify failed:', error)
    throw new AppError(
      'Could not send verification email. Check SMTP settings.',
      HTTP_STATUS.BAD_GATEWAY,
    )
  }
}

async function sendResetOrThrow(email: string, url: string) {
  try {
    await mailService.sendPasswordReset(email, url)
  } catch (error) {
    console.error('[mail] reset failed:', error)
    throw new AppError(
      'Could not send password reset email. Check SMTP settings.',
      HTTP_STATUS.BAD_GATEWAY,
    )
  }
}

export const userService = {
  async register(
    input: {
      name: string
      email: string
      password: string
      planId?: PlanId
    },
    originHeader?: string,
  ): Promise<AuthPayload> {
    const existing = await UserModel.findOne({ email: input.email }).lean()
    if (existing) {
      throw new AppError(
        'An account with this email already exists.',
        HTTP_STATUS.CONFLICT,
      )
    }

    const planId: PlanId = input.planId ?? 'basic'
    const user = await UserModel.create({
      name: input.name,
      email: input.email,
      passwordHash: await hashPassword(input.password),
      planId,
      remainingEdits: PLAN_EDIT_QUOTA[planId],
      billingStatus: 'active',
    })

    const raw = await issueToken(
      user,
      TOKEN_TYPES.EMAIL_VERIFY,
      TOKEN_TTL_MS.EMAIL_VERIFY,
    )
    const origin = clientOrigin(originHeader)
    const url = verifyLink(origin, raw)
    await sendVerifyOrThrow(user.email, url)

    return withAuth(toPublicUser(user), {
      message: 'Account created. Check your email to verify.',
    })
  },

  async login(input: {
    email: string
    password: string
  }): Promise<AuthPayload> {
    const user = await UserModel.findOne({ email: input.email }).select(
      '+passwordHash',
    )
    if (!user || !(await comparePassword(input.password, user.passwordHash))) {
      throw new AppError('Invalid email or password.', HTTP_STATUS.UNAUTHORIZED)
    }
    if (user.isActive === false) {
      throw new AppError('Account is disabled.', HTTP_STATUS.FORBIDDEN)
    }
    return withAuth(toPublicUser(user))
  },

  async getMe(userId: string): Promise<{ user: PublicUser }> {
    return { user: toPublicUser(await findUserOrFail(userId)) }
  },

  async updateProfile(
    userId: string,
    input: { name?: string; email?: string },
    originHeader?: string,
  ): Promise<{ user: PublicUser; message?: string }> {
    const user = await findUserOrFail(userId)
    let emailChanged = false

    if (input.email && input.email !== user.email) {
      const taken = await UserModel.findOne({
        email: input.email,
        _id: { $ne: new Types.ObjectId(userId) },
      }).lean()
      if (taken) {
        throw new AppError('Email already in use.', HTTP_STATUS.CONFLICT)
      }
      user.email = input.email
      user.emailVerified = false
      emailChanged = true
    }

    if (input.name) user.name = input.name
    await user.save()

    if (emailChanged) {
      const raw = await issueToken(
        user,
        TOKEN_TYPES.EMAIL_VERIFY,
        TOKEN_TTL_MS.EMAIL_VERIFY,
      )
      const url = verifyLink(clientOrigin(originHeader), raw)
      await sendVerifyOrThrow(user.email, url)
      return {
        user: toPublicUser(user),
        message: 'Profile updated. Check your email to verify the new address.',
      }
    }

    return { user: toPublicUser(user) }
  },

  async changePassword(
    userId: string,
    input: { currentPassword: string; newPassword: string },
  ): Promise<{ message: string }> {
    const user = await UserModel.findById(userId).select('+passwordHash')
    if (!user) throw new AppError('User not found.', HTTP_STATUS.NOT_FOUND)

    if (!(await comparePassword(input.currentPassword, user.passwordHash))) {
      throw new AppError('Current password is incorrect.', HTTP_STATUS.BAD_REQUEST)
    }

    user.passwordHash = await hashPassword(input.newPassword)
    await user.save()
    return { message: 'Password changed.' }
  },

  async requestPasswordReset(
    email: string,
    originHeader?: string,
  ): Promise<{ message: string }> {
    const generic = {
      message:
        'If an account exists for that email, a reset link has been sent.',
    }

    const user = await UserModel.findOne({ email }).select('+tokens')
    if (!user) return generic

    const raw = await issueToken(
      user,
      TOKEN_TYPES.PASSWORD_RESET,
      TOKEN_TTL_MS.PASSWORD_RESET,
    )
    const url = resetLink(clientOrigin(originHeader), raw)
    await sendResetOrThrow(user.email, url)

    return generic
  },

  async resetPassword(input: {
    token: string
    password: string
  }): Promise<{ message: string }> {
    const user = await consumeToken(input.token, TOKEN_TYPES.PASSWORD_RESET)
    if (!user) {
      throw new AppError(
        'Reset link is invalid or expired.',
        HTTP_STATUS.BAD_REQUEST,
      )
    }

    user.passwordHash = await hashPassword(input.password)
    await user.save()
    return { message: 'Password updated. You can sign in now.' }
  },

  async verifyEmail(
    token: string,
  ): Promise<{ user: PublicUser; message: string }> {
    const user = await consumeToken(token, TOKEN_TYPES.EMAIL_VERIFY)
    if (!user) {
      throw new AppError(
        'Verification link is invalid or expired.',
        HTTP_STATUS.BAD_REQUEST,
      )
    }

    user.emailVerified = true
    await user.save()
    return { user: toPublicUser(user), message: 'Email verified.' }
  },

  async resendVerification(
    userId: string,
    originHeader?: string,
  ): Promise<{ message: string }> {
    const user = await UserModel.findById(userId).select('+tokens')
    if (!user) throw new AppError('User not found.', HTTP_STATUS.NOT_FOUND)
    if (user.emailVerified) return { message: 'Email is already verified.' }

    const raw = await issueToken(
      user,
      TOKEN_TYPES.EMAIL_VERIFY,
      TOKEN_TTL_MS.EMAIL_VERIFY,
    )
    const url = verifyLink(clientOrigin(originHeader), raw)
    await sendVerifyOrThrow(user.email, url)

    return { message: 'Verification email sent. Check your inbox.' }
  },

  async setPlan(
    userId: string,
    planId: PlanId,
  ): Promise<{ user: PublicUser }> {
    const user = await findUserOrFail(userId)
    user.planId = planId
    user.remainingEdits = PLAN_EDIT_QUOTA[planId]
    user.billingStatus = 'active'
    await user.save()
    return { user: toPublicUser(user) }
  },

  async cancelSubscription(userId: string): Promise<{ user: PublicUser }> {
    const user = await findUserOrFail(userId)
    user.billingStatus = 'canceled'
    await user.save()
    return { user: toPublicUser(user) }
  },

  async useEditCredit(userId: string): Promise<{ user: PublicUser }> {
    const user = await findUserOrFail(userId)

    if (user.billingStatus === 'canceled') {
      throw new AppError(
        'Subscription canceled. Reactivate a plan to process.',
        HTTP_STATUS.PAYMENT_REQUIRED,
      )
    }

    if (user.planId !== 'unlimited' && user.remainingEdits <= 0) {
      throw new AppError(
        'No edit credits remaining. Upgrade your plan.',
        HTTP_STATUS.PAYMENT_REQUIRED,
      )
    }

    if (user.planId !== 'unlimited') {
      user.remainingEdits -= 1
      await user.save()
    }

    return { user: toPublicUser(user) }
  },
}
