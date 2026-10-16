import { SystemSettingsModel } from './models/system-settings.model'

export type PublicAppSettings = {
  appName: string
  supportEmail: string
  announcementBanner: string
  maintenanceMode: boolean
  allowSignups: boolean
  maxUploadMb: number
  maxDurationSeconds: number
  defaultPlanSlug: string
  featureFlags: {
    captions: boolean
    aiCombine: boolean
    retakeRemoval: boolean
    randomZoom: boolean
  }
}

const DEFAULTS: PublicAppSettings = {
  appName: 'ClipAI',
  supportEmail: 'support@clipai.dev',
  announcementBanner: '',
  maintenanceMode: false,
  allowSignups: true,
  maxUploadMb: 500,
  maxDurationSeconds: 1800,
  defaultPlanSlug: 'basic',
  featureFlags: {
    captions: true,
    aiCombine: true,
    retakeRemoval: true,
    randomZoom: true,
  },
}

export async function getPublicSettings(): Promise<PublicAppSettings> {
  const doc = await SystemSettingsModel.findOne({ key: 'global' }).lean()
  if (!doc) return { ...DEFAULTS, featureFlags: { ...DEFAULTS.featureFlags } }

  return {
    appName: doc.appName || DEFAULTS.appName,
    supportEmail: doc.supportEmail || DEFAULTS.supportEmail,
    announcementBanner: doc.announcementBanner || '',
    maintenanceMode: Boolean(doc.maintenanceMode),
    allowSignups: doc.allowSignups !== false,
    maxUploadMb: doc.maxUploadMb ?? DEFAULTS.maxUploadMb,
    maxDurationSeconds: doc.maxDurationSeconds ?? DEFAULTS.maxDurationSeconds,
    defaultPlanSlug: doc.defaultPlanSlug || DEFAULTS.defaultPlanSlug,
    featureFlags: {
      captions: doc.featureFlags?.captions !== false,
      aiCombine: doc.featureFlags?.aiCombine !== false,
      retakeRemoval: doc.featureFlags?.retakeRemoval !== false,
      randomZoom: doc.featureFlags?.randomZoom !== false,
    },
  }
}
