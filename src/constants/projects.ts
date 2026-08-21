export const EDITING_MODES = ['talking-head', 'rapid-cut', 'asmr'] as const
export type EditingModeId = (typeof EDITING_MODES)[number]

export const PROJECT_STATUSES = [
  'Uploading',
  'Uploaded',
  'Queued',
  'Analyzing',
  'Preparing edit',
  'Rendering',
  'Completed',
  'Failed',
] as const
export type ProjectStatus = (typeof PROJECT_STATUSES)[number]

export const ACTIVE_PROCESS_STATUSES: ProjectStatus[] = [
  'Queued',
  'Analyzing',
  'Preparing edit',
  'Rendering',
]

export const PROCESS_FLOW: ProjectStatus[] = [
  'Queued',
  'Analyzing',
  'Preparing edit',
  'Rendering',
  'Completed',
]

export const ASPECT_RATIOS = ['9:16', '1:1', '16:9'] as const
export const SILENCE_LEVELS = ['light', 'medium', 'aggressive'] as const
export const PACING_LEVELS = ['normal', 'fast', 'very-fast'] as const
export const SPEED_RAMPS = ['off', 'light', 'medium', 'aggressive'] as const
export const CAPTION_POSITIONS = ['bottom', 'top'] as const
export const KEYFRAME_PRESETS = [
  'slow-zoom-in',
  'slow-zoom-out',
  'speaker-punch-in',
  'product-reveal-zoom',
] as const
export const CROP_PRESETS = [
  'none',
  'center',
  'top',
  'bottom',
  'tight',
] as const
export const COLOR_GRADES = [
  'none',
  'clean',
  'warm',
  'cool',
  'vivid',
] as const

export const UPLOAD_LIMITS = {
  maxBytes: 2 * 1024 * 1024 * 1024,
  maxDurationSeconds: 20 * 60,
  acceptMime: ['video/mp4', 'video/quicktime', 'video/webm'],
} as const
