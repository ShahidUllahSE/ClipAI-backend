import type { NextFunction, Request, Response } from 'express'
import { HTTP_STATUS } from '../../constants/http'
import { asyncHandler } from '../../utils/asyncHandler'
import { AppError } from '../../utils/AppError'
import { sendSuccess } from '../../utils/response'
import { uploadMiddleware, uploadService } from './upload.service'

function requireUserId(req: Request) {
  if (!req.userId) throw new AppError('Not signed in.', HTTP_STATUS.UNAUTHORIZED)
  return req.userId
}

export const uploadController = {
  upload: [
    (req: Request, res: Response, next: NextFunction) => {
      uploadMiddleware(req, res, (err: unknown) => {
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
}
