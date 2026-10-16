import { HTTP_STATUS } from '../../constants/http'
import { AppError } from '../../utils/AppError'
import { logAdminActivity } from './admin.activity'
import { SystemSettingsModel } from './models/system-settings.model'

function toPublicSettings(doc: {
  appName?: string
  supportEmail?: string
  announcementBanner?: string
  maintenanceMode?: boolean
  allowSignups?: boolean
  maxUploadMb?: number
  maxDurationSeconds?: number
  defaultPlanSlug?: string
  featureFlags?: {
    captions?: boolean
    aiCombine?: boolean
    retakeRemoval?: boolean
    randomZoom?: boolean
  }
  updatedAt?: Date
}) {
  return {
    appName: doc.appName || 'ClipAI',
    supportEmail: doc.supportEmail || 'support@clipai.dev',
    announcementBanner: doc.announcementBanner || '',
    maintenanceMode: Boolean(doc.maintenanceMode),
    allowSignups: doc.allowSignups !== false,
    maxUploadMb: doc.maxUploadMb ?? 500,
    maxDurationSeconds: doc.maxDurationSeconds ?? 1800,
    defaultPlanSlug: doc.defaultPlanSlug || 'basic',
    featureFlags: {
      captions: doc.featureFlags?.captions !== false,
      aiCombine: doc.featureFlags?.aiCombine !== false,
      retakeRemoval: doc.featureFlags?.retakeRemoval !== false,
      randomZoom: doc.featureFlags?.randomZoom !== false,
    },
    updatedAt: doc.updatedAt?.toISOString?.() ?? new Date().toISOString(),
  }
}

export const adminSettingsService = {
  async get() {
    let doc = await SystemSettingsModel.findOne({ key: 'global' })
    if (!doc) {
      doc = await SystemSettingsModel.create({ key: 'global' })
    }
    return { settings: toPublicSettings(doc) }
  },

  async update(
    actorId: string,
    input: Partial<{
      appName: string
      supportEmail: string
      announcementBanner: string
      maintenanceMode: boolean
      allowSignups: boolean
      maxUploadMb: number
      maxDurationSeconds: number
      defaultPlanSlug: string
      featureFlags: {
        captions?: boolean
        aiCombine?: boolean
        retakeRemoval?: boolean
        randomZoom?: boolean
      }
    }>,
  ) {
    let doc = await SystemSettingsModel.findOne({ key: 'global' })
    if (!doc) {
      doc = await SystemSettingsModel.create({ key: 'global' })
    }

    if (input.appName !== undefined) doc.appName = input.appName.trim()
    if (input.supportEmail !== undefined) {
      doc.supportEmail = input.supportEmail.trim().toLowerCase()
    }
    if (input.announcementBanner !== undefined) {
      doc.announcementBanner = input.announcementBanner
    }
    if (input.maintenanceMode !== undefined) {
      doc.maintenanceMode = input.maintenanceMode
    }
    if (input.allowSignups !== undefined) doc.allowSignups = input.allowSignups
    if (input.maxUploadMb !== undefined) {
      if (input.maxUploadMb < 1) {
        throw new AppError('maxUploadMb must be >= 1.', HTTP_STATUS.BAD_REQUEST)
      }
      doc.maxUploadMb = input.maxUploadMb
    }
    if (input.maxDurationSeconds !== undefined) {
      if (input.maxDurationSeconds < 30) {
        throw new AppError(
          'maxDurationSeconds must be >= 30.',
          HTTP_STATUS.BAD_REQUEST,
        )
      }
      doc.maxDurationSeconds = input.maxDurationSeconds
    }
    if (input.defaultPlanSlug !== undefined) {
      doc.defaultPlanSlug = input.defaultPlanSlug.trim().toLowerCase()
    }
    if (input.featureFlags) {
      doc.featureFlags = {
        captions: input.featureFlags.captions ?? doc.featureFlags?.captions ?? true,
        aiCombine:
          input.featureFlags.aiCombine ?? doc.featureFlags?.aiCombine ?? true,
        retakeRemoval:
          input.featureFlags.retakeRemoval ??
          doc.featureFlags?.retakeRemoval ??
          true,
        randomZoom:
          input.featureFlags.randomZoom ?? doc.featureFlags?.randomZoom ?? true,
      }
      doc.markModified('featureFlags')
    }

    await doc.save()
    await logAdminActivity({
      actorId,
      action: 'settings.update',
      targetType: 'settings',
      targetId: 'global',
      summary: 'Updated system settings',
      meta: input,
    })
    return { settings: toPublicSettings(doc) }
  },
}
