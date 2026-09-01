import fs from 'fs'
import path from 'path'
import type { NextFunction, Request, Response } from 'express'
import multer from 'multer'
import { env } from '../../config'
import { HTTP_STATUS } from '../../constants/http'
import { UPLOAD_LIMITS } from '../../constants/projects'
import { transcribeVideoCaptions } from '../../integrations/caption-transcribe.service'
import { asyncHandler } from '../../utils/asyncHandler'
import { AppError } from '../../utils/AppError'
import { sendSuccess } from '../../utils/response'

const ACCEPT_MIME = [
  ...UPLOAD_LIMITS.acceptMime,
  'audio/wav',
  'audio/x-wav',
  'audio/mpeg',
  'audio/mp3',
  'audio/mp4',
  'audio/webm',
  'audio/aac',
] as const

function captionTmpDir() {
  const dir = path.resolve(process.cwd(), env.UPLOAD_DIR, '.caption-tmp')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

const transcribeUpload = multer({
  dest: captionTmpDir(),
  limits: { fileSize: UPLOAD_LIMITS.maxBytes },
  fileFilter: (_req, file, cb) => {
    const allowedMime = ACCEPT_MIME.includes(
      file.mimetype as (typeof ACCEPT_MIME)[number],
    )
    const allowedName = /\.(mp4|mov|webm|wav|mp3|m4a|aac)$/i.test(
      file.originalname,
    )
    if (!allowedMime && !allowedName) {
      cb(
        new AppError(
          'Unsupported file. Use MP4, MOV, WebM, or an audio file.',
          HTTP_STATUS.BAD_REQUEST,
        ),
      )
      return
    }
    cb(null, true)
  },
}).single('file')

function unlinkQuiet(filePath?: string) {
  if (!filePath) return
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
  } catch {
    // ignore
  }
}

export const captionController = {
  transcribe: [
    (req: Request, res: Response, next: NextFunction) => {
      captionTmpDir()
      transcribeUpload(req, res, (err: unknown) => {
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

      try {
        const result = await transcribeVideoCaptions(req.file.path)
        sendSuccess(res, result)
      } finally {
        unlinkQuiet(req.file.path)
      }
    }),
  ],
}
