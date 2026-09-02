import fs from 'fs'
import type { NextFunction, Request, Response } from 'express'
import { HTTP_STATUS } from '../../constants/http'
import { asyncHandler } from '../../utils/asyncHandler'
import { AppError } from '../../utils/AppError'
import { sendSuccess } from '../../utils/response'
import {
  chunkUploadMiddleware,
  uploadMiddleware,
  uploadService,
} from './upload.service'

function requireUserId(req: Request) {
  if (!req.userId) throw new AppError('Not signed in.', HTTP_STATUS.UNAUTHORIZED)
  return req.userId
}

function runUploadMiddleware(
  middleware: typeof uploadMiddleware,
  req: Request,
  res: Response,
  next: NextFunction,
) {
  middleware(req, res, (err: unknown) => {
    if (err instanceof AppError) return next(err)
    if (err) {
      return next(
        new AppError(
          err instanceof Error ? err.message : 'Upload failed.',
          HTTP_STATUS.BAD_REQUEST,
        ),
      )
    }
    next()
  })
}

export const uploadController = {
  upload: [
    (req: Request, res: Response, next: NextFunction) => {
      runUploadMiddleware(uploadMiddleware, req, res, next)
    },
    asyncHandler(async (req, res) => {
      if (!req.file) {
        throw new AppError('Video file is required.', HTTP_STATUS.BAD_REQUEST)
      }
      const durationSeconds = Number(req.body.durationSeconds ?? 0)
      const result = await uploadService.createFromFile(
        requireUserId(req),
        req.file,
        Number.isFinite(durationSeconds) ? durationSeconds : 0,
      )
      sendSuccess(res, result, HTTP_STATUS.CREATED)
    }),
  ],

  initializeSession: asyncHandler(async (req, res) => {
    const result = await uploadService.initializeSession(requireUserId(req), {
      fingerprint: String(req.body.fingerprint ?? ''),
      filename: String(req.body.filename ?? ''),
      mimeType: String(req.body.mimeType ?? ''),
      totalSize: Number(req.body.totalSize),
      durationSeconds: Number(req.body.durationSeconds ?? 0),
    })
    sendSuccess(res, result, HTTP_STATUS.CREATED)
  }),

  getSession: asyncHandler(async (req, res) => {
    const result = await uploadService.getSession(
      requireUserId(req),
      req.params.sessionId,
    )
    sendSuccess(res, result)
  }),

  uploadChunk: [
    (req: Request, res: Response, next: NextFunction) => {
      runUploadMiddleware(chunkUploadMiddleware, req, res, next)
    },
    asyncHandler(async (req, res) => {
      if (!req.file) {
        throw new AppError('Chunk file is required.', HTTP_STATUS.BAD_REQUEST)
      }
      try {
        const result = await uploadService.storeChunk(
          requireUserId(req),
          req.params.sessionId,
          Number(req.params.index),
          req.file,
        )
        sendSuccess(res, result)
      } catch (error) {
        try {
          if (req.file?.path) fs.rmSync(req.file.path, { force: true })
        } catch {
          // Best-effort cleanup.
        }
        throw error
      }
    }),
  ],

  completeSession: asyncHandler(async (req, res) => {
    const result = await uploadService.completeSession(
      requireUserId(req),
      req.params.sessionId,
    )
    sendSuccess(res, result, HTTP_STATUS.CREATED)
  }),

  cancelSession: asyncHandler(async (req, res) => {
    await uploadService.cancelSession(
      requireUserId(req),
      req.params.sessionId,
    )
    res.status(204).send()
  }),
}
