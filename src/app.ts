import path from 'path'
import cors from 'cors'
import express from 'express'
import helmet from 'helmet'
import morgan from 'morgan'
import { env } from './config'
import {
  errorHandler,
  notFoundHandler,
} from './middleware/error.middleware'
import { apiRouter } from './routes'

export function createApp() {
  const app = express()
  const uploadsDir = path.resolve(process.cwd(), env.UPLOAD_DIR)

  // Serve videos before Helmet. HSTS + upgrade-insecure-requests on HTTP
  // makes the browser try HTTPS, so the player appears but never plays.
  app.use(
    '/uploads',
    (req, res, next) => {
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
      if ('download' in req.query) {
        const raw =
          typeof req.query.filename === 'string' && req.query.filename.trim()
            ? req.query.filename.trim()
            : path.basename(req.path) || 'video.mp4'
        const ascii = raw
          .replace(/[^\x20-\x7E]/g, '_')
          .replace(/"/g, '_')
          .slice(0, 160)
        const encoded = encodeURIComponent(raw.slice(0, 160))
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`,
        )
      }
      next()
    },
    express.static(uploadsDir, { acceptRanges: true }),
  )

  app.use(
    helmet({
      hsts: false,
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  )
  app.use(
    cors({
      origin: env.isDev ? true : [env.CLIENT_URL],
      credentials: true,
    }),
  )
  app.use(express.json({ limit: '2mb' }))
  app.use(morgan(env.isDev ? 'dev' : 'combined'))

  app.use('/api', apiRouter)

  app.use(notFoundHandler)
  app.use(errorHandler)

  return app
}
