import fs from 'fs'
import path from 'path'
import multer from 'multer'
import { env } from '../../config'
import { HTTP_STATUS } from '../../constants/http'
import { UPLOAD_LIMITS } from '../../constants/projects'
import { AppError } from '../../utils/AppError'
import { UploadModel } from './upload.model'
import { UploadSessionModel, type UploadSessionDocument } from './uploadSession.model'

function uploadDir() {
  const dir = path.resolve(process.cwd(), env.UPLOAD_DIR)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

function sessionDir(sessionId: string) {
  const dir = path.join(uploadDir(), 'tmp-sessions', sessionId)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

function chunkBytes(totalSize: number, chunkSize: number, index: number) {
  return Math.max(0, Math.min(chunkSize, totalSize - index * chunkSize))
}

function serializeSession(session: UploadSessionDocument) {
  return {
    id: session._id.toString(),
    chunkSize: session.chunkSize,
    totalChunks: session.totalChunks,
    uploadedChunks: session.uploadedChunks,
    totalSize: session.totalSize,
  }
}

async function findOwnedSession(sessionId: string, userId: string) {
  const session = await UploadSessionModel.findOne({ _id: sessionId, userId })
  if (!session) throw new AppError('Upload session not found.', HTTP_STATUS.NOT_FOUND)
  return session
}

export const uploadSessionService = {
  async createSession(
    userId: string,
    input: {
      fingerprint: string
      filename: string
      mimeType: string
      totalSize: number
      durationSeconds: number
    },
  ) {
    if (!UPLOAD_LIMITS.acceptMime.includes(input.mimeType as never)) {
      throw new AppError(
        'Unsupported video format. Use MP4, MOV, or WebM.',
        HTTP_STATUS.BAD_REQUEST,
      )
    }
    if (input.durationSeconds > UPLOAD_LIMITS.maxDurationSeconds) {
      throw new AppError(
        'Video exceeds the 20-minute duration limit.',
        HTTP_STATUS.BAD_REQUEST,
      )
    }
    if (!(input.totalSize > 0) || input.totalSize > UPLOAD_LIMITS.maxBytes) {
      throw new AppError('Invalid or oversized file.', HTTP_STATUS.BAD_REQUEST)
    }

    const existing = await UploadSessionModel.findOne({
      userId,
      fingerprint: input.fingerprint,
    })

    if (existing) {
      if (existing.status === 'completed' && existing.completedUploadId) {
        const upload = await UploadModel.findById(existing.completedUploadId)
        if (upload) {
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
        }
      }
      return { session: serializeSession(existing) }
    }

    const chunkSize = UPLOAD_LIMITS.chunkSizeBytes
    const totalChunks = Math.max(1, Math.ceil(input.totalSize / chunkSize))

    const session = await UploadSessionModel.create({
      userId,
      fingerprint: input.fingerprint,
      filename: input.filename,
      mimeType: input.mimeType,
      totalSize: input.totalSize,
      durationSeconds: input.durationSeconds,
      chunkSize,
      totalChunks,
      uploadedChunks: [],
      status: 'pending',
    })

    return { session: serializeSession(session) }
  },

  async getOwnedSession(sessionId: string, userId: string) {
    return findOwnedSession(sessionId, userId)
  },

  async recordChunk(sessionId: string, userId: string, index: number, receivedSize: number) {
    const session = await findOwnedSession(sessionId, userId)
    if (session.status === 'completed') {
      throw new AppError('Upload session already completed.', HTTP_STATUS.CONFLICT)
    }
    if (!Number.isInteger(index) || index < 0 || index >= session.totalChunks) {
      throw new AppError('Invalid chunk index.', HTTP_STATUS.BAD_REQUEST)
    }
    const expectedSize = chunkBytes(session.totalSize, session.chunkSize, index)
    if (receivedSize !== expectedSize) {
      const chunkPath = path.join(sessionDir(sessionId), String(index))
      fs.rmSync(chunkPath, { force: true })
      throw new AppError('Chunk size mismatch.', HTTP_STATUS.BAD_REQUEST)
    }

    await UploadSessionModel.updateOne(
      { _id: sessionId },
      { $addToSet: { uploadedChunks: index } },
    )

    return { received: index }
  },

  async completeSession(sessionId: string, userId: string) {
    const session = await findOwnedSession(sessionId, userId)

    if (session.status === 'completed' && session.completedUploadId) {
      const upload = await UploadModel.findById(session.completedUploadId)
      if (upload) {
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
      }
    }

    if (session.uploadedChunks.length !== session.totalChunks) {
      throw new AppError(
        `Upload incomplete: ${session.uploadedChunks.length}/${session.totalChunks} chunks received.`,
        HTTP_STATUS.BAD_REQUEST,
      )
    }

    const dir = sessionDir(sessionId)
    const safeName = session.filename.replace(/[^\w.\-]+/g, '_')
    const storedFilename = `${Date.now()}-${safeName}`
    const destPath = path.join(uploadDir(), storedFilename)

    await new Promise<void>((resolve, reject) => {
      const out = fs.createWriteStream(destPath)
      out.on('error', reject)
      out.on('finish', resolve)

      const writeNext = (index: number) => {
        if (index >= session.totalChunks) {
          out.end()
          return
        }
        const chunkPath = path.join(dir, String(index))
        const readStream = fs.createReadStream(chunkPath)
        readStream.on('error', reject)
        readStream.on('end', () => writeNext(index + 1))
        readStream.pipe(out, { end: false })
      }
      writeNext(0)
    })

    fs.rmSync(dir, { recursive: true, force: true })

    const publicUrl = `${env.PUBLIC_API_URL}/uploads/${storedFilename}`
    const upload = await UploadModel.create({
      userId,
      originalFilename: session.filename,
      storedFilename,
      mimeType: session.mimeType,
      fileSize: session.totalSize,
      durationSeconds: session.durationSeconds,
      storagePath: destPath,
      publicUrl,
    })

    session.status = 'completed'
    session.completedUploadId = upload._id
    await session.save()

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
}

export const chunkUploadMiddleware = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      cb(null, sessionDir(req.params.sessionId))
    },
    filename: (req, _file, cb) => {
      cb(null, req.params.index)
    },
  }),
  // Headroom above the exact chunk size: multer/busboy's fileSize check can
  // reject a chunk that lands exactly on the limit. recordChunk() below is
  // the real gate — it enforces the exact expected chunk size afterward.
  limits: { fileSize: UPLOAD_LIMITS.chunkSizeBytes + 1024 * 1024 },
}).single('chunk')
