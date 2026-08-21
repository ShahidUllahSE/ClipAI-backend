import type { Request } from 'express'
import { asyncHandler } from '../../utils/asyncHandler'
import { sendSuccess } from '../../utils/response'
import { adminService } from './admin.service'

function requireUserId(req: Request): string {
  if (!req.userId) throw new Error('Missing authenticated user.')
  return req.userId
}

export const adminController = {
  stats: asyncHandler(async (_req, res) => {
    sendSuccess(res, await adminService.getStats())
  }),

  listUsers: asyncHandler(async (req, res) => {
    sendSuccess(res, await adminService.listUsers(req.query as never))
  }),

  getUser: asyncHandler(async (req, res) => {
    sendSuccess(res, await adminService.getUser(String(req.params.id)))
  }),

  updateUser: asyncHandler(async (req, res) => {
    sendSuccess(
      res,
      await adminService.updateUser(
        String(req.params.id),
        requireUserId(req),
        req.body,
      ),
    )
  }),

  deleteUser: asyncHandler(async (req, res) => {
    sendSuccess(
      res,
      await adminService.deleteUser(String(req.params.id), requireUserId(req)),
    )
  }),

  verifyUserEmail: asyncHandler(async (req, res) => {
    sendSuccess(res, await adminService.verifyUserEmail(String(req.params.id)))
  }),
}
