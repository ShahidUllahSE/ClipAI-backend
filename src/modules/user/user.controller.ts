import type { Request } from 'express'
import { HTTP_STATUS } from '../../constants/http'
import type { PlanId } from '../../constants/plans'
import { asyncHandler } from '../../utils/asyncHandler'
import { sendSuccess } from '../../utils/response'
import { userService } from './user.service'

function originOf(req: Request): string | undefined {
  return typeof req.headers.origin === 'string' ? req.headers.origin : undefined
}

function requireUserId(req: Request): string {
  if (!req.userId) throw new Error('Missing authenticated user.')
  return req.userId
}

export const userController = {
  register: asyncHandler(async (req, res) => {
    const result = await userService.register(req.body, originOf(req))
    sendSuccess(res, result, HTTP_STATUS.CREATED)
  }),

  login: asyncHandler(async (req, res) => {
    sendSuccess(res, await userService.login(req.body))
  }),

  logout: asyncHandler(async (_req, res) => {
    sendSuccess(res, { message: 'Signed out.' })
  }),

  me: asyncHandler(async (req, res) => {
    sendSuccess(res, await userService.getMe(requireUserId(req)))
  }),

  updateProfile: asyncHandler(async (req, res) => {
    sendSuccess(
      res,
      await userService.updateProfile(
        requireUserId(req),
        req.body,
        originOf(req),
      ),
    )
  }),

  changePassword: asyncHandler(async (req, res) => {
    sendSuccess(
      res,
      await userService.changePassword(requireUserId(req), req.body),
    )
  }),

  forgotPassword: asyncHandler(async (req, res) => {
    sendSuccess(
      res,
      await userService.requestPasswordReset(req.body.email, originOf(req)),
    )
  }),

  resetPassword: asyncHandler(async (req, res) => {
    sendSuccess(res, await userService.resetPassword(req.body))
  }),

  verifyEmail: asyncHandler(async (req, res) => {
    sendSuccess(res, await userService.verifyEmail(req.body.token))
  }),

  resendVerification: asyncHandler(async (req, res) => {
    sendSuccess(
      res,
      await userService.resendVerification(requireUserId(req), originOf(req)),
    )
  }),

  setPlan: asyncHandler(async (req, res) => {
    sendSuccess(
      res,
      await userService.setPlan(requireUserId(req), req.body.planId as PlanId),
    )
  }),

  cancelSubscription: asyncHandler(async (req, res) => {
    sendSuccess(res, await userService.cancelSubscription(requireUserId(req)))
  }),

  useCredit: asyncHandler(async (req, res) => {
    sendSuccess(res, await userService.useEditCredit(requireUserId(req)))
  }),
}
