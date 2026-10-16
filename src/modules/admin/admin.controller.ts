import type { Request, Response } from 'express'
import { asyncHandler } from '../../utils/asyncHandler'
import { sendSuccess } from '../../utils/response'
import { adminPlansService } from './admin.plans'
import { adminReportsService } from './admin.reports'
import { adminService } from './admin.service'
import { adminSettingsService } from './admin.settings'
import { adminSupportService } from './admin.support'

function requireUserId(req: Request): string {
  if (!req.userId) throw new Error('Missing authenticated user.')
  return req.userId
}

function sendCsv(res: Response, filename: string, csv: string) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${filename}"`,
  )
  res.status(200).send(csv)
}

export const adminController = {
  stats: asyncHandler(async (_req, res) => {
    sendSuccess(res, await adminService.getStats())
  }),

  listUsers: asyncHandler(async (req, res) => {
    sendSuccess(res, await adminService.listUsers(req.query as never))
  }),

  createUser: asyncHandler(async (req, res) => {
    sendSuccess(
      res,
      await adminService.createUser(requireUserId(req), req.body),
      201,
    )
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

  adjustTokens: asyncHandler(async (req, res) => {
    sendSuccess(
      res,
      await adminService.adjustTokens(
        requireUserId(req),
        String(req.params.id),
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
    sendSuccess(
      res,
      await adminService.verifyUserEmail(
        String(req.params.id),
        requireUserId(req),
      ),
    )
  }),

  listProjects: asyncHandler(async (req, res) => {
    sendSuccess(res, await adminService.listProjects(req.query as never))
  }),

  getProject: asyncHandler(async (req, res) => {
    sendSuccess(res, await adminService.getProject(String(req.params.id)))
  }),

  deleteProject: asyncHandler(async (req, res) => {
    sendSuccess(res, await adminService.deleteProject(String(req.params.id)))
  }),

  retryProject: asyncHandler(async (req, res) => {
    sendSuccess(res, await adminService.retryProject(String(req.params.id)))
  }),

  listJobs: asyncHandler(async (req, res) => {
    sendSuccess(res, await adminService.listJobs(req.query as never))
  }),

  listPlans: asyncHandler(async (_req, res) => {
    sendSuccess(res, await adminPlansService.list())
  }),

  createPlan: asyncHandler(async (req, res) => {
    sendSuccess(
      res,
      await adminPlansService.create(requireUserId(req), req.body),
      201,
    )
  }),

  updatePlan: asyncHandler(async (req, res) => {
    sendSuccess(
      res,
      await adminPlansService.update(
        requireUserId(req),
        String(req.params.id),
        req.body,
      ),
    )
  }),

  deletePlan: asyncHandler(async (req, res) => {
    sendSuccess(
      res,
      await adminPlansService.remove(requireUserId(req), String(req.params.id)),
    )
  }),

  listSubscriptions: asyncHandler(async (req, res) => {
    sendSuccess(
      res,
      await adminReportsService.listSubscriptions(req.query as never),
    )
  }),

  listUsage: asyncHandler(async (req, res) => {
    sendSuccess(res, await adminReportsService.listUsage(req.query as never))
  }),

  listTickets: asyncHandler(async (req, res) => {
    sendSuccess(res, await adminSupportService.listTickets(req.query as never))
  }),

  getTicket: asyncHandler(async (req, res) => {
    sendSuccess(res, await adminSupportService.getTicket(String(req.params.id)))
  }),

  createTicket: asyncHandler(async (req, res) => {
    sendSuccess(
      res,
      await adminSupportService.createTicket(requireUserId(req), req.body),
      201,
    )
  }),

  replyTicket: asyncHandler(async (req, res) => {
    sendSuccess(
      res,
      await adminSupportService.replyTicket(
        requireUserId(req),
        String(req.params.id),
        req.body,
      ),
    )
  }),

  updateTicket: asyncHandler(async (req, res) => {
    sendSuccess(
      res,
      await adminSupportService.updateTicket(
        requireUserId(req),
        String(req.params.id),
        req.body,
      ),
    )
  }),

  listTemplates: asyncHandler(async (_req, res) => {
    sendSuccess(res, await adminSupportService.listTemplates())
  }),

  createTemplate: asyncHandler(async (req, res) => {
    sendSuccess(
      res,
      await adminSupportService.createTemplate(requireUserId(req), req.body),
      201,
    )
  }),

  updateTemplate: asyncHandler(async (req, res) => {
    sendSuccess(
      res,
      await adminSupportService.updateTemplate(
        requireUserId(req),
        String(req.params.id),
        req.body,
      ),
    )
  }),

  deleteTemplate: asyncHandler(async (req, res) => {
    sendSuccess(
      res,
      await adminSupportService.deleteTemplate(
        requireUserId(req),
        String(req.params.id),
      ),
    )
  }),

  listActivity: asyncHandler(async (req, res) => {
    sendSuccess(res, await adminReportsService.listActivity(req.query as never))
  }),

  exportUsers: asyncHandler(async (_req, res) => {
    sendCsv(res, 'clipai-users.csv', await adminReportsService.exportUsersCsv())
  }),

  exportUsage: asyncHandler(async (_req, res) => {
    sendCsv(res, 'clipai-usage.csv', await adminReportsService.exportUsageCsv())
  }),

  exportRevenue: asyncHandler(async (_req, res) => {
    sendCsv(
      res,
      'clipai-revenue.csv',
      await adminReportsService.exportRevenueCsv(),
    )
  }),

  exportActivity: asyncHandler(async (_req, res) => {
    sendCsv(
      res,
      'clipai-activity.csv',
      await adminReportsService.exportActivityCsv(),
    )
  }),

  getSettings: asyncHandler(async (_req, res) => {
    sendSuccess(res, await adminSettingsService.get())
  }),

  updateSettings: asyncHandler(async (req, res) => {
    sendSuccess(
      res,
      await adminSettingsService.update(requireUserId(req), req.body),
    )
  }),
}
