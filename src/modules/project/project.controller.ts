import type { Request } from 'express'
import { HTTP_STATUS } from '../../constants/http'
import { asyncHandler } from '../../utils/asyncHandler'
import { AppError } from '../../utils/AppError'
import { sendSuccess } from '../../utils/response'
import { streamStoredZip } from '../../utils/zipStore'
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

  download: asyncHandler(async (req, res) => {
    const { filePath, filename } = await projectService.getDownloadFile(
      String(req.params.id),
      requireUserId(req),
    )
    res.setHeader('Content-Type', 'application/octet-stream')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    await new Promise<void>((resolve, reject) => {
      res.download(filePath, filename, (error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }),

  downloadBulk: asyncHandler(async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : undefined
    const files = await projectService.getBulkDownloadFiles(
      requireUserId(req),
      ids,
    )
    const stamp = new Date().toISOString().slice(0, 10)
    res.setHeader('Content-Type', 'application/zip')
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="clipai-exports-${stamp}.zip"`,
    )
    res.setHeader('X-Content-Type-Options', 'nosniff')
    await streamStoredZip(files, res)
    res.end()
  }),
}
