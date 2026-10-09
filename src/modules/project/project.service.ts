import fs from 'fs'
import path from 'path'
import { Types } from 'mongoose'
import { env } from '../../config'
import { HTTP_STATUS } from '../../constants/http'
import {
  ACTIVE_PROCESS_STATUSES,
  type EditingModeId,
  type ProjectStatus,
} from '../../constants/projects'
import { AppError } from '../../utils/AppError'
import { uploadService } from '../upload/upload.service'
import {
  suggestFilename,
  suggestTitle,
  toPublicProject,
} from './project.mapper'
import { ProjectModel } from './project.model'
import type { ProjectOptionsDto, PublicProject } from './project.types'

const BULK_DOWNLOAD_MAX = 10

function withOptionDefaults(raw: ProjectOptionsDto): ProjectOptionsDto {
  return {
    captions: raw.captions ?? true,
    captionPosition: raw.captionPosition ?? 'bottom',
    captionFontFamily: raw.captionFontFamily ?? 'arial',
    captionFontSize: raw.captionFontSize ?? 22,
    captionColor: raw.captionColor ?? 'white',
    aspectRatio: raw.aspectRatio ?? '9:16',
    silenceSensitivity: raw.silenceSensitivity ?? 'medium',
    pacing: raw.pacing ?? 'fast',
    speedRamp: raw.speedRamp ?? 'light',
    keyframing: raw.keyframing ?? true,
    keyframePreset: raw.keyframePreset ?? 'speaker-punch-in',
    zoomEffect: raw.zoomEffect ?? 'none',
    keepAudio: raw.keepAudio ?? true,
    audioNormalize: raw.audioNormalize ?? true,
    cropPreset: raw.cropPreset ?? 'center',
    colorGrade: raw.colorGrade ?? 'clean',
    fadeInOut: raw.fadeInOut ?? true,
    mirrorHorizontal: raw.mirrorHorizontal ?? false,
    introTitleCard: raw.introTitleCard ?? true,
    timelineJson: raw.timelineJson ?? null,
  }
}

export const projectService = {
  async list(userId: string): Promise<{ projects: PublicProject[] }> {
    const projects = await ProjectModel.find({ userId })
      .select('-analysis -editPlan')
      .sort({ createdAt: -1 })
      .lean()
    return { projects: projects.map((p) => toPublicProject(p, { slim: true })) }
  },

  async get(id: string, userId: string): Promise<{ project: PublicProject }> {
    if (!Types.ObjectId.isValid(id)) {
      throw new AppError('Project not found.', HTTP_STATUS.NOT_FOUND)
    }
    const project = await ProjectModel.findOne({ _id: id, userId }).lean()
    if (!project) throw new AppError('Project not found.', HTTP_STATUS.NOT_FOUND)
    return { project: toPublicProject(project) }
  },

  async create(
    userId: string,
    input: {
      uploadId: string
      secondaryUploadId?: string
      extraUploadIds?: string[]
      mode: EditingModeId
      options: ProjectOptionsDto
      title?: string
      durationSeconds?: number
    },
  ): Promise<{ project: PublicProject }> {
    const upload = await uploadService.getOwned(input.uploadId, userId)
    const secondary =
      input.secondaryUploadId
        ? await uploadService.getOwned(input.secondaryUploadId, userId)
        : null
    const extraUploads = input.extraUploadIds?.length
      ? await Promise.all(
          input.extraUploadIds.map((id) => uploadService.getOwned(id, userId)),
        )
      : []

    if (input.mode === 'ai-combine' && !secondary) {
      throw new AppError(
        'AI Combine requires a second video upload.',
        HTTP_STATUS.BAD_REQUEST,
      )
    }

    const extraDuration = extraUploads.reduce(
      (sum, item) => sum + (item.durationSeconds || 0),
      0,
    )
    const extraSize = extraUploads.reduce(
      (sum, item) => sum + (item.fileSize || 0),
      0,
    )
    const durationSeconds =
      input.durationSeconds && input.durationSeconds > 0
        ? input.durationSeconds
        : upload.durationSeconds +
          (secondary?.durationSeconds ?? 0) +
          extraDuration

    if (input.durationSeconds && input.durationSeconds > 0) {
      upload.durationSeconds = input.durationSeconds
      await upload.save()
    }

    const generatedTitle =
      input.title?.trim() ||
      suggestTitle(upload.originalFilename, input.mode)

    const project = await ProjectModel.create({
      userId,
      uploadId: upload._id,
      secondaryUploadId: secondary?._id ?? null,
      extraUploadIds: extraUploads.map((item) => item._id),
      title: generatedTitle,
      originalFilename: extraUploads.length
        ? [upload, ...extraUploads].map((item) => item.originalFilename).join(' + ')
        : secondary
          ? `${upload.originalFilename} + ${secondary.originalFilename}`
          : upload.originalFilename,
      fileSize: upload.fileSize + (secondary?.fileSize ?? 0) + extraSize,
      durationSeconds,
      mimeType: upload.mimeType,
      mode: input.mode,
      options: withOptionDefaults(input.options),
      status: 'Uploaded',
      generatedTitle,
      outputFilename: suggestFilename(generatedTitle),
      sourceUrl: upload.publicUrl,
      outputUrl: '',
    })

    return { project: toPublicProject(project) }
  },

  async update(
    id: string,
    userId: string,
    input: {
      title?: string
      generatedTitle?: string
      outputFilename?: string
    },
  ): Promise<{ project: PublicProject }> {
    const project = await ProjectModel.findOne({ _id: id, userId })
    if (!project) throw new AppError('Project not found.', HTTP_STATUS.NOT_FOUND)

    if (input.generatedTitle) {
      project.generatedTitle = input.generatedTitle
      project.title = input.generatedTitle
      project.outputFilename = suggestFilename(input.generatedTitle)
    }
    if (input.title) {
      project.title = input.title
      if (!input.outputFilename && !input.generatedTitle) {
        project.outputFilename = suggestFilename(input.title)
      }
    }
    if (input.outputFilename) project.outputFilename = input.outputFilename

    await project.save()
    return { project: toPublicProject(project) }
  },

  async remove(id: string, userId: string): Promise<{ message: string }> {
    const project = await ProjectModel.findOne({ _id: id, userId })
    if (!project) throw new AppError('Project not found.', HTTP_STATUS.NOT_FOUND)
    if (ACTIVE_PROCESS_STATUSES.includes(project.status as ProjectStatus)) {
      throw new AppError(
        'Cannot delete a project while it is processing.',
        HTTP_STATUS.BAD_REQUEST,
      )
    }
    await project.deleteOne()
    return { message: 'Project deleted.' }
  },

  async getDocument(id: string, userId?: string) {
    const query: Record<string, unknown> = { _id: id }
    if (userId) query.userId = userId
    const project = await ProjectModel.findOne(query)
    if (!project) throw new AppError('Project not found.', HTTP_STATUS.NOT_FOUND)
    return project
  },

  async getDownloadFile(id: string, userId: string) {
    const project = await this.getDocument(id, userId)
    if (project.status !== 'Completed') {
      throw new AppError(
        'Edited file is not ready yet.',
        HTTP_STATUS.BAD_REQUEST,
      )
    }
    const filePath = path.resolve(
      process.cwd(),
      env.UPLOAD_DIR,
      'outputs',
      `${project._id.toString()}.mp4`,
    )
    if (!fs.existsSync(filePath)) {
      throw new AppError(
        'Edited file is not available on this server.',
        HTTP_STATUS.NOT_FOUND,
      )
    }
    return {
      filePath,
      filename: project.outputFilename || 'export.mp4',
    }
  },

  async getBulkDownloadFiles(userId: string, ids?: string[]) {
    const query: Record<string, unknown> = {
      userId,
      status: 'Completed',
    }
    if (ids?.length) {
      query._id = { $in: ids.filter((id) => Types.ObjectId.isValid(id)) }
    }

    const projects = await ProjectModel.find(query)
      .sort({ createdAt: -1 })
      .limit(BULK_DOWNLOAD_MAX)
      .lean()

    if (!projects.length) {
      throw new AppError(
        'No finished videos are ready to download.',
        HTTP_STATUS.NOT_FOUND,
      )
    }

    const used = new Set<string>()
    const files: Array<{ name: string; path: string }> = []
    for (const project of projects) {
      const filePath = path.resolve(
        process.cwd(),
        env.UPLOAD_DIR,
        'outputs',
        `${project._id.toString()}.mp4`,
      )
      if (!fs.existsSync(filePath)) continue
      let name = String(project.outputFilename || 'export.mp4')
      if (!name.toLowerCase().endsWith('.mp4')) name = `${name}.mp4`
      const base = name.replace(/\.mp4$/i, '')
      let unique = name
      let n = 2
      while (used.has(unique.toLowerCase())) {
        unique = `${base}-${n}.mp4`
        n += 1
      }
      used.add(unique.toLowerCase())
      files.push({ name: unique, path: filePath })
    }

    if (!files.length) {
      throw new AppError(
        'Finished videos are not on this server yet.',
        HTTP_STATUS.NOT_FOUND,
      )
    }

    return files
  },
}
