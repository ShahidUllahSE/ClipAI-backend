import { HTTP_STATUS } from '../constants/http'

export class AppError extends Error {
  readonly statusCode: number
  readonly isOperational: boolean

  constructor(message: string, statusCode: number = HTTP_STATUS.BAD_REQUEST) {
    super(message)
    this.name = 'AppError'
    this.statusCode = statusCode
    this.isOperational = true
    Error.captureStackTrace?.(this, this.constructor)
  }
}
