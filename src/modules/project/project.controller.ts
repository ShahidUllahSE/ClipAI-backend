import type { Request } from 'express'
import { HTTP_STATUS } from '../../constants/http'
import { asyncHandler } from '../../utils/asyncHandler'
import { AppError } from '../../utils/AppError'
import { sendSuccess } from '../../utils/response'
import { jobService } from '../job/job.service'
import { projectService } from './project.service'

function requireUserId(req: Request) {
  if (!req.userId) throw new AppError('Not signed in.', HTTP_STATUS.UNAUTHORIZED)
  return req.userId
}

export const projectController = {
  list: asyncHandler(async (req, res) => {
    sendSuccess(res, await projectService.list(requireUserId(req)))
  }),

  get: asyncHandler(async (req, res) => {
    sendSuccess(
      res,
      await projectService.get(String(req.params.id), requireUserId(req)),
    )
  }),

  create: asyncHandler(async (req, res) => {
    sendSuccess(
      res,
      await projectService.create(requireUserId(req), req.body),
      HTTP_STATUS.CREATED,
    )
  }),

  update: asyncHandler(async (req, res) => {
    sendSuccess(
      res,
      await projectService.update(
        String(req.params.id),
        requireUserId(req),
        req.body,
      ),
    )
  }),

  remove: asyncHandler(async (req, res) => {
    sendSuccess(
      res,
      await projectService.remove(String(req.params.id), requireUserId(req)),
    )
  }),

  process: asyncHandler(async (req, res) => {
    sendSuccess(
      res,
      await jobService.start(String(req.params.id), requireUserId(req)),
    )
  }),

  retry: asyncHandler(async (req, res) => {
    sendSuccess(
      res,
      await jobService.retry(String(req.params.id), requireUserId(req)),
    )
  }),

  job: asyncHandler(async (req, res) => {
    sendSuccess(
      res,
      await jobService.getLatest(String(req.params.id), requireUserId(req)),
    )
  }),
}
