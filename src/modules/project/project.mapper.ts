import type { EditingModeId, ProjectStatus } from '../../constants/projects'
import type { ProjectOptionsDto, PublicProject } from './project.types'

interface ProjectLike {
  _id: { toString(): string }
  userId: { toString(): string }
  title: string
  originalFilename: string
  fileSize: number
  durationSeconds: number
  mimeType: string
  mode: string
  options: ProjectOptionsDto
  status: string
  generatedTitle: string
  outputFilename: string
  createdAt: Date
  updatedAt: Date
  errorMessage?: string
  sourceUrl?: string
  outputUrl?: string
  analysis?: Record<string, unknown> | null
  editPlan?: Record<string, unknown> | null
  secondaryUploadId?: { toString(): string } | null
}

function slugify(text: string) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
}

export function suggestTitle(filename: string, mode: string) {
  const base = filename.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ')
  const modeLabel =
    mode === 'talking-head'
      ? 'Talking Head'
      : mode === 'rapid-cut'
        ? 'Rapid Cut'
        : mode === 'ai-combine'
          ? 'AI Combine'
          : 'ASMR Unboxing'
  return `${base || 'Untitled'} — ${modeLabel}`.slice(0, 80)
}

export function suggestFilename(title: string) {
  return `${slugify(title) || 'export'}.mp4`
}

export function toPublicProject(project: ProjectLike): PublicProject {
  const isDone = project.status === 'Completed' && project.outputUrl
  const previewUrl = isDone ? project.outputUrl : project.sourceUrl || project.outputUrl
  return {
    id: project._id.toString(),
    userId: project.userId.toString(),
    title: project.title,
    originalFilename: project.originalFilename,
    fileSize: project.fileSize,
    durationSeconds: project.durationSeconds,
    mimeType: project.mimeType,
    mode: project.mode as EditingModeId,
    options: project.options,
    status: project.status as ProjectStatus,
    generatedTitle: project.generatedTitle,
    outputFilename: project.outputFilename,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
    errorMessage: project.errorMessage || undefined,
    previewUrl,
    outputUrl: project.outputUrl || undefined,
    analysis: project.analysis ?? undefined,
    editPlan: project.editPlan ?? undefined,
    secondaryUploadId: project.secondaryUploadId
      ? project.secondaryUploadId.toString()
      : null,
  }
}
