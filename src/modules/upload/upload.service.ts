import fs from 'fs'
import path from 'path'
import { pipeline } from 'stream/promises'
import multer from 'multer'
import { Types } from 'mongoose'
import { env } from '../../config'
import { HTTP_STATUS } from '../../constants/http'
import { UPLOAD_LIMITS } from '../../constants/projects'
import { AppError } from '../../utils/AppError'
import { UploadModel } from './upload.model'
import { UploadSessionModel } from './upload-session.model'

const CHUNK_SIZE = 20 * 1024 * 1024
const SESSION_TTL_MS = 24 * 60 * 60 * 1000

function ensureUploadDir() {
  const dir = path.resolve(process.cwd(), env.UPLOAD_DIR)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

function ensureChunkRoot() {
  const dir = path.join(ensureUploadDir(), '.chunks')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function safeFilename(filename: string) {
  return filename.replace(/[^\w.\-]+/g, '_')
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, ensureUploadDir())
  },
  filename: (_req, file, cb) => {
    cb(null, `${Date.now()}-${safeFilename(file.originalname)}`)
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

const chunkStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, ensureChunkRoot()),
  filename: (_req, _file, cb) => {
    cb(null, `.incoming-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  },
})

export const chunkUploadMiddleware = multer({
  storage: chunkStorage,
  limits: { fileSize: CHUNK_SIZE },
}).single('chunk')

function expiresAt() {
  return new Date(Date.now() + SESSION_TTL_MS)
}

function sessionDir(sessionId: string) {
  return path.join(ensureChunkRoot(), sessionId)
}

function chunkPath(sessionId: string, index: number) {
  return path.join(sessionDir(sessionId), `${index}.part`)
}

function removeQuiet(target: string) {
  try {
    fs.rmSync(target, { recursive: true, force: true })
  } catch {
    // Best-effort cleanup must not break uploads.
  }
}

function cleanupStaleChunkFiles() {
  const root = ensureChunkRoot()
  const cutoff = Date.now() - SESSION_TTL_MS
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const target = path.join(root, entry.name)
      if (fs.statSync(target).mtimeMs < cutoff) removeQuiet(target)
    }
  } catch {
    // A concurrent cleanup or upload may change the directory.
  }
}

function validateVideo(mimeType: string, filename: string) {
  const allowedMime = UPLOAD_LIMITS.acceptMime.includes(mimeType as never)
  const allowedExtension = /\.(mp4|mov|webm)$/i.test(filename)
  if (!allowedMime || !allowedExtension) {
    throw new AppError(
      'Unsupported video format. Use MP4, MOV, or WebM.',
      HTTP_STATUS.BAD_REQUEST,
    )
  }
}

async function createUploadRecord(input: {
  userId: string
  originalFilename: string
  storedFilename: string
  mimeType: string
  fileSize: number
  durationSeconds: number
  storagePath: string
}) {
  const publicUrl = `${env.PUBLIC_API_URL}/uploads/${input.storedFilename}`
  const upload = await UploadModel.create({ ...input, publicUrl })
  return { upload: publicUpload(upload) }
}

function publicUpload(upload: {
  _id: { toString(): string }
  originalFilename: string
  mimeType: string
  fileSize: number
  durationSeconds: number
  publicUrl: string
  createdAt: Date
}) {
  return {
    id: upload._id.toString(),
    originalFilename: upload.originalFilename,
    mimeType: upload.mimeType,
    fileSize: upload.fileSize,
    durationSeconds: upload.durationSeconds,
    publicUrl: upload.publicUrl,
    createdAt: upload.createdAt.toISOString(),
  }
}

function publicSession(session: {
  _id: { toString(): string }
  chunkSize: number
  totalChunks: number
  uploadedChunks: number[]
  totalSize: number
  status: string
}) {
  return {
    id: session._id.toString(),
    chunkSize: session.chunkSize,
    totalChunks: session.totalChunks,
    uploadedChunks: [...session.uploadedChunks].sort((a, b) => a - b),
    totalSize: session.totalSize,
    status: session.status,
  }
}

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

    return createUploadRecord({
      userId,
      originalFilename: file.originalname,
      storedFilename: file.filename,
      mimeType: file.mimetype,
      fileSize: file.size,
      durationSeconds,
      storagePath: file.path,
    })
  },

  async initializeSession(
    userId: string,
    input: {
      fingerprint: string
      filename: string
      mimeType: string
      totalSize: number
      durationSeconds: number
    },
  ) {
    cleanupStaleChunkFiles()
    validateVideo(input.mimeType, input.filename)
    if (!input.fingerprint.trim() || input.fingerprint.length > 500) {
      throw new AppError('Invalid upload fingerprint.', HTTP_STATUS.BAD_REQUEST)
    }
    if (
      !Number.isSafeInteger(input.totalSize) ||
      input.totalSize <= 0 ||
      input.totalSize > UPLOAD_LIMITS.maxBytes
    ) {
      throw new AppError('Invalid or oversized video.', HTTP_STATUS.BAD_REQUEST)
    }
    if (
      !Number.isFinite(input.durationSeconds) ||
      input.durationSeconds < 0 ||
      input.durationSeconds > UPLOAD_LIMITS.maxDurationSeconds
    ) {
      throw new AppError(
        'Video exceeds the 20-minute duration limit.',
        HTTP_STATUS.BAD_REQUEST,
      )
    }

    const completed = await UploadSessionModel.findOne({
      userId,
      fingerprint: input.fingerprint,
      status: 'completed',
      expiresAt: { $gt: new Date() },
      uploadId: { $ne: null },
    }).sort({ updatedAt: -1 })
    if (completed?.uploadId) {
      const upload = await UploadModel.findOne({
        _id: completed.uploadId,
        userId,
      })
      if (upload) {
        return {
          session: publicSession(completed),
          upload: publicUpload(upload),
        }
      }
    }

    const existing = await UploadSessionModel.findOne({
      userId,
      fingerprint: input.fingerprint,
      status: 'active',
      expiresAt: { $gt: new Date() },
    })
    if (existing) {
      const metadataMatches =
        existing.originalFilename === input.filename &&
        existing.mimeType === input.mimeType &&
        existing.totalSize === input.totalSize
      if (metadataMatches) {
        existing.expiresAt = expiresAt()
        await existing.save()
        return { session: publicSession(existing) }
      }
      removeQuiet(sessionDir(existing._id.toString()))
      await existing.deleteOne()
    }

    const session = await UploadSessionModel.create({
      userId,
      fingerprint: input.fingerprint,
      originalFilename: input.filename,
      mimeType: input.mimeType,
      totalSize: input.totalSize,
      durationSeconds: input.durationSeconds,
      chunkSize: CHUNK_SIZE,
      totalChunks: Math.ceil(input.totalSize / CHUNK_SIZE),
      uploadedChunks: [],
      status: 'active',
      expiresAt: expiresAt(),
    })
    return { session: publicSession(session) }
  },

  async getSession(userId: string, sessionId: string) {
    const session = await UploadSessionModel.findOne({
      _id: sessionId,
      userId,
      status: { $in: ['active', 'completing'] },
    })
    if (!session) {
      throw new AppError('Upload session not found.', HTTP_STATUS.NOT_FOUND)
    }
    return { session: publicSession(session) }
  },

  async storeChunk(
    userId: string,
    sessionId: string,
    index: number,
    file: Express.Multer.File,
  ) {
    const session = await UploadSessionModel.findOne({
      _id: sessionId,
      userId,
      status: 'active',
      expiresAt: { $gt: new Date() },
    })
    if (!session) {
      throw new AppError('Upload session not found.', HTTP_STATUS.NOT_FOUND)
    }
    if (!Number.isInteger(index) || index < 0 || index >= session.totalChunks) {
      throw new AppError('Invalid chunk index.', HTTP_STATUS.BAD_REQUEST)
    }

    const expectedSize =
      index === session.totalChunks - 1
        ? session.totalSize - index * session.chunkSize
        : session.chunkSize
    if (file.size !== expectedSize) {
      throw new AppError(
        `Invalid chunk size. Expected ${expectedSize} bytes.`,
        HTTP_STATUS.BAD_REQUEST,
      )
    }

    const dir = sessionDir(sessionId)
    fs.mkdirSync(dir, { recursive: true })
    const destination = chunkPath(sessionId, index)
    removeQuiet(destination)
    fs.renameSync(file.path, destination)

    session.uploadedChunks = Array.from(
      new Set([...session.uploadedChunks, index]),
    )
    session.expiresAt = expiresAt()
    await session.save()
    return { session: publicSession(session) }
  },

  async completeSession(userId: string, sessionId: string) {
    const session = await UploadSessionModel.findOneAndUpdate(
      { _id: sessionId, userId, status: 'active' },
      { $set: { status: 'completing', expiresAt: expiresAt() } },
      { new: true },
    )
    if (!session) {
      throw new AppError('Upload session not found.', HTTP_STATUS.NOT_FOUND)
    }

    const expected = Array.from({ length: session.totalChunks }, (_, i) => i)
    const missing = expected.filter(
      (index) =>
        !session.uploadedChunks.includes(index) ||
        !fs.existsSync(chunkPath(sessionId, index)),
    )
    if (missing.length) {
      session.status = 'active'
      await session.save()
      throw new AppError(
        `Upload is incomplete. Missing ${missing.length} chunk(s).`,
        HTTP_STATUS.BAD_REQUEST,
      )
    }

    const storedFilename = `${Date.now()}-${safeFilename(session.originalFilename)}`
    const finalPath = path.join(ensureUploadDir(), storedFilename)
    const assemblingPath = `${finalPath}.assembling`

    try {
      removeQuiet(assemblingPath)
      for (const index of expected) {
        await pipeline(
          fs.createReadStream(chunkPath(sessionId, index)),
          fs.createWriteStream(assemblingPath, {
            flags: index === 0 ? 'w' : 'a',
          }),
        )
      }
      const assembledSize = fs.statSync(assemblingPath).size
      if (assembledSize !== session.totalSize) {
        throw new AppError(
          'Assembled upload size does not match the source file.',
          HTTP_STATUS.BAD_REQUEST,
        )
      }
      fs.renameSync(assemblingPath, finalPath)
      const result = await createUploadRecord({
        userId,
        originalFilename: session.originalFilename,
        storedFilename,
        mimeType: session.mimeType,
        fileSize: assembledSize,
        durationSeconds: session.durationSeconds,
        storagePath: finalPath,
      })
      session.status = 'completed'
      session.uploadId = new Types.ObjectId(result.upload.id)
      await session.save()
      removeQuiet(sessionDir(sessionId))
      return result
    } catch (error) {
      removeQuiet(assemblingPath)
      removeQuiet(finalPath)
      session.status = 'active'
      await session.save()
      throw error
    }
  },

  async cancelSession(userId: string, sessionId: string) {
    const session = await UploadSessionModel.findOne({ _id: sessionId, userId })
    if (!session) return
    removeQuiet(sessionDir(sessionId))
    await session.deleteOne()
  },

  async getOwned(uploadId: string, userId: string) {
    const upload = await UploadModel.findOne({ _id: uploadId, userId })
    if (!upload) throw new AppError('Upload not found.', HTTP_STATUS.NOT_FOUND)
    return upload
  },
}
