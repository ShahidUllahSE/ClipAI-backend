import fs from 'fs'
import path from 'path'
import multer from 'multer'
import { env } from '../../config'
import { HTTP_STATUS } from '../../constants/http'
import { UPLOAD_LIMITS } from '../../constants/projects'
import { AppError } from '../../utils/AppError'
import { UploadModel } from './upload.model'

function ensureUploadDir() {
  const dir = path.resolve(process.cwd(), env.UPLOAD_DIR)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, ensureUploadDir())
  },
  filename: (_req, file, cb) => {
    const safe = file.originalname.replace(/[^\w.\-]+/g, '_')
    cb(null, `${Date.now()}-${safe}`)
  },
})

export const uploadMiddleware = multer({
  storage,
  limits: { fileSize: UPLOAD_LIMITS.maxBytes },
  fileFilter: (_req, file, cb) => {
    if (!UPLOAD_LIMITS.acceptMime.includes(file.mimetype as never)) {
      cb(
        new AppError(
          'Unsupported video format. Use MP4, MOV, or WebM.',
          HTTP_STATUS.BAD_REQUEST,
        ),
      )
      return
    }
    cb(null, true)
  },
}).single('file')

export const uploadService = {
  async createFromFile(
    userId: string,
    file: Express.Multer.File,
    durationSeconds = 0,
  ) {
    if (durationSeconds > UPLOAD_LIMITS.maxDurationSeconds) {
      fs.unlinkSync(file.path)
      throw new AppError(
        'Video exceeds the 20-minute duration limit.',
        HTTP_STATUS.BAD_REQUEST,
      )
    }

    const publicUrl = `${env.PUBLIC_API_URL}/uploads/${file.filename}`
    const upload = await UploadModel.create({
      userId,
      originalFilename: file.originalname,
      storedFilename: file.filename,
      mimeType: file.mimetype,
      fileSize: file.size,
      durationSeconds,
      storagePath: file.path,
      publicUrl,
    })

    return {
      upload: {
        id: upload._id.toString(),
        originalFilename: upload.originalFilename,
        mimeType: upload.mimeType,
        fileSize: upload.fileSize,
        durationSeconds: upload.durationSeconds,
        publicUrl: upload.publicUrl,
        createdAt: upload.createdAt.toISOString(),
      },
    }
  },

  async getOwned(uploadId: string, userId: string) {
    const upload = await UploadModel.findOne({ _id: uploadId, userId })
    if (!upload) throw new AppError('Upload not found.', HTTP_STATUS.NOT_FOUND)
    return upload
  },
}
