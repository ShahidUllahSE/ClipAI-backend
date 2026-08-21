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

  app.use(
    helmet({
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

  app.use(
    '/uploads',
    express.static(path.resolve(process.cwd(), env.UPLOAD_DIR)),
  )

  app.use('/api', apiRouter)

  app.use(notFoundHandler)
  app.use(errorHandler)

  return app
}
