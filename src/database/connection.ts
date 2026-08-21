import mongoose from 'mongoose'
import { env } from '../config'

export async function connectDatabase(): Promise<void> {
  mongoose.set('strictQuery', true)

  await mongoose.connect(env.MONGODB_URI)

  console.log(`MongoDB connected: ${mongoose.connection.name}`)
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.disconnect()
}
