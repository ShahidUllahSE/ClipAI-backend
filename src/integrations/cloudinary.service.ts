import { v2 as cloudinary } from 'cloudinary'
import { env } from '../config'

let configured = false

function configure() {
  if (configured) return
  if (
    env.CLOUDINARY_CLOUD_NAME &&
    env.CLOUDINARY_API_KEY &&
    env.CLOUDINARY_API_SECRET
  ) {
    cloudinary.config({
      cloud_name: env.CLOUDINARY_CLOUD_NAME,
      api_key: env.CLOUDINARY_API_KEY,
      api_secret: env.CLOUDINARY_API_SECRET,
      secure: true,
    })
  } else if (env.CLOUDINARY_URL) {
    // Prefer explicit URL from env (also set on process.env by dotenv)
    process.env.CLOUDINARY_URL = env.CLOUDINARY_URL
  }
  configured = true
}

export function isCloudinaryEnabled() {
  return Boolean(
    env.CLOUDINARY_URL ||
      (env.CLOUDINARY_CLOUD_NAME &&
        env.CLOUDINARY_API_KEY &&
        env.CLOUDINARY_API_SECRET),
  )
}

/**
 * Upload a local MP4 to Cloudinary (video). Returns HTTPS delivery URL.
 * FFmpeg editing stays on the server; Cloudinary is storage + CDN only.
 */
export async function uploadLocalVideo(input: {
  localPath: string
  publicId: string
  folder?: string
}): Promise<{ url: string; publicId: string }> {
  if (!isCloudinaryEnabled()) {
    throw new Error('Cloudinary is not configured')
  }
  configure()

  const folder = input.folder ?? 'clipai/outputs'
  const result = await cloudinary.uploader.upload(input.localPath, {
    resource_type: 'video',
    folder,
    public_id: input.publicId,
    overwrite: true,
    invalidate: true,
  })

  const url = result.secure_url || result.url
  if (!url) throw new Error('Cloudinary upload returned no URL')
  return { url, publicId: result.public_id }
}
