import { Types } from 'mongoose'
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

function withOptionDefaults(raw: ProjectOptionsDto): ProjectOptionsDto {
  return {
    captions: raw.captions ?? true,
    captionPosition: raw.captionPosition ?? 'bottom',
    aspectRatio: raw.aspectRatio ?? '9:16',
    silenceSensitivity: raw.silenceSensitivity ?? 'medium',
    pacing: raw.pacing ?? 'fast',
    speedRamp: raw.speedRamp ?? 'light',
    keyframing: raw.keyframing ?? true,
    keyframePreset: raw.keyframePreset ?? 'speaker-punch-in',
    keepAudio: raw.keepAudio ?? true,
    audioNormalize: raw.audioNormalize ?? true,
    cropPreset: raw.cropPreset ?? 'center',
    colorGrade: raw.colorGrade ?? 'clean',
    fadeInOut: raw.fadeInOut ?? true,
    mirrorHorizontal: raw.mirrorHorizontal ?? false,
    introTitleCard: raw.introTitleCard ?? true,
  }
}

export const projectService = {
  async list(userId: string): Promise<{ projects: PublicProject[] }> {
    const projects = await ProjectModel.find({ userId })
      .sort({ createdAt: -1 })
      .lean()
    return { projects: projects.map((p) => toPublicProject(p)) }
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
      mode: EditingModeId
      options: ProjectOptionsDto
      title?: string
      durationSeconds?: number
    },
  ): Promise<{ project: PublicProject }> {
    const upload = await uploadService.getOwned(input.uploadId, userId)
    const durationSeconds =
      input.durationSeconds && input.durationSeconds > 0
        ? input.durationSeconds
        : upload.durationSeconds

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
      title: generatedTitle,
      originalFilename: upload.originalFilename,
      fileSize: upload.fileSize,
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
    if (input.title) project.title = input.title
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
}
