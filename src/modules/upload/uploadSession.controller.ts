import type { NextFunction, Request, Response } from 'express'
import { HTTP_STATUS } from '../../constants/http'
import { asyncHandler } from '../../utils/asyncHandler'
import { AppError } from '../../utils/AppError'
import { sendSuccess } from '../../utils/response'
import { chunkUploadMiddleware, uploadSessionService } from './uploadSession.service'

function requireUserId(req: Request) {
  if (!req.userId) throw new AppError('Not signed in.', HTTP_STATUS.UNAUTHORIZED)
  return req.userId
}

export const uploadSessionController = {
  create: asyncHandler(async (req, res) => {
    const { fingerprint, filename, mimeType, totalSize, durationSeconds } = req.body ?? {}
    if (!fingerprint || !filename || !mimeType) {
      throw new AppError('fingerprint, filename, and mimeType are required.', HTTP_STATUS.BAD_REQUEST)
    }
    const result = await uploadSessionService.createSession(requireUserId(req), {
      fingerprint: String(fingerprint),
      filename: String(filename),
      mimeType: String(mimeType),
      totalSize: Number(totalSize),
      durationSeconds: Number.isFinite(Number(durationSeconds)) ? Number(durationSeconds) : 0,
    })
    sendSuccess(res, result, HTTP_STATUS.CREATED)
  }),

  uploadChunk: [
    asyncHandler(async (req, res, next) => {
      await uploadSessionService.getOwnedSession(req.params.sessionId, requireUserId(req))
      next()
    }),
    (req: Request, res: Response, next: NextFunction) => {
      chunkUploadMiddleware(req, res, (err: unknown) => {
        if (err instanceof AppError) return next(err)
        if (err) {
          return next(
            new AppError(
              err instanceof Error ? err.message : 'Chunk upload failed.',
              HTTP_STATUS.BAD_REQUEST,
            ),
          )
        }
        next()
      })
    },
    asyncHandler(async (req, res) => {
      if (!req.file) {
        throw new AppError('Chunk file is required.', HTTP_STATUS.BAD_REQUEST)
      }
      const index = Number(req.params.index)
      const result = await uploadSessionService.recordChunk(
        req.params.sessionId,
        requireUserId(req),
        index,
        req.file.size,
      )
      sendSuccess(res, result)
    }),
  ],

  complete: asyncHandler(async (req, res) => {
    const result = await uploadSessionService.completeSession(
      req.params.sessionId,
      requireUserId(req),
    )
    sendSuccess(res, result, HTTP_STATUS.CREATED)
  }),
}
