import type { EditingModeId, ProjectStatus } from '../../constants/projects'

export interface ProjectOptionsDto {
  captions: boolean
  captionPosition: 'bottom' | 'top'
  captionFontFamily:
    | 'arial'
    | 'impact'
    | 'georgia'
    | 'verdana'
    | 'comic-sans'
    | 'courier'
    | 'segoe'
  captionFontSize: 18 | 22 | 28 | 36 | 48
  captionColor: 'white' | 'yellow' | 'black' | 'cyan'
  aspectRatio: '9:16' | '1:1' | '16:9'
  silenceSensitivity: 'light' | 'medium' | 'aggressive'
  pacing: 'normal' | 'fast' | 'very-fast'
  speedRamp: 'off' | 'light' | 'medium' | 'aggressive'
  keyframing: boolean
  keyframePreset:
    | 'slow-zoom-in'
    | 'slow-zoom-out'
    | 'speaker-punch-in'
    | 'product-reveal-zoom'
  keepAudio: boolean
  audioNormalize: boolean
  /** ClipAI local tools (no API keys) */
  cropPreset: 'none' | 'center' | 'top' | 'bottom' | 'tight'
  colorGrade: 'none' | 'clean' | 'warm' | 'cool' | 'vivid'
  fadeInOut: boolean
  mirrorHorizontal: boolean
  introTitleCard: boolean
  timelineJson?: unknown | null
}

export interface PublicProject {
  id: string
  userId: string
  title: string
  originalFilename: string
  fileSize: number
  durationSeconds: number
  mimeType: string
  mode: EditingModeId
  options: ProjectOptionsDto
  status: ProjectStatus
  generatedTitle: string
  outputFilename: string
  createdAt: string
  updatedAt: string
  errorMessage?: string
  previewUrl?: string
  outputUrl?: string
  analysis?: Record<string, unknown> | null
  editPlan?: Record<string, unknown> | null
  secondaryUploadId?: string | null
}
