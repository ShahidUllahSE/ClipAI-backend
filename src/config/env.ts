import dotenv from 'dotenv'
import { z } from 'zod'

dotenv.config()

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(4000),
  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_EXPIRES_IN: z.string().default('7d'),
  CLIENT_URL: z.string().url().default('http://localhost:5173'),
  PUBLIC_API_URL: z.string().url().default('http://localhost:4000'),
  ADMIN_EMAIL: z.string().email().default('admin@clipai.dev'),
  ADMIN_PASSWORD: z.string().min(6).default('Admin123!'),
  ADMIN_NAME: z.string().min(1).default('ClipAI Admin'),
  UPLOAD_DIR: z.string().default('uploads'),
  DEEPGRAM_API_KEY: z.string().optional().default(''),
  GROQ_API_KEY: z.string().optional().default(''),
  GEMINI_API_KEY: z.string().optional().default(''),
  SHOTSTACK_API_KEY: z.string().optional().default(''),
  SHOTSTACK_ENV: z.enum(['stage', 'v1']).default('stage'),
  USE_MOCK_AI: z
    .string()
    .optional()
    .default('true')
    .transform((v) => v !== 'false'),
  /** Faster VPS exports: mock naming, skip polish, ultrafast encode */
  FAST_EXPORT: z
    .string()
    .optional()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
  SKIP_EXPORT_POLISH: z
    .string()
    .optional()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
  CLOUDINARY_URL: z.string().optional().default(''),
  CLOUDINARY_CLOUD_NAME: z.string().optional().default(''),
  CLOUDINARY_NAME: z.string().optional().default(''),
  CLOUDINARY_API_KEY: z.string().optional().default(''),
  CLOUDINARY_API_SECRET: z.string().optional().default(''),
  DEFAULT_SMTP_EMAIL: z
    .string()
    .optional()
    .default('')
    .transform((v) => v.trim()),
  DEFAULT_SMTP_PASSWORD: z.string().optional().default(''),
  SMTP_HOST: z.string().optional().default('smtp.gmail.com'),
  SMTP_PORT: z.coerce.number().optional().default(587),
})

const parsed = envSchema.safeParse(process.env)

if (!parsed.success) {
  console.error('Invalid environment variables:')
  console.error(parsed.error.flatten().fieldErrors)
  process.exit(1)
}

const data = parsed.data

export const env = {
  ...data,
  isDev: data.NODE_ENV !== 'production',
  isProd: data.NODE_ENV === 'production',
  mockAi: data.USE_MOCK_AI,
  fastExport: data.FAST_EXPORT,
  skipExportPolish: data.SKIP_EXPORT_POLISH || data.FAST_EXPORT,
  CLOUDINARY_CLOUD_NAME:
    data.CLOUDINARY_CLOUD_NAME || data.CLOUDINARY_NAME || '',
} as const
