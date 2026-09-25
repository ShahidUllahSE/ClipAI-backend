import fs from 'fs'
import path from 'path'
import * as ort from 'onnxruntime-node'

/**
 * Silero VAD (v5, ONNX): a small neural model that scores each 32 ms of
 * 16 kHz audio for human speech. Unlike a pitch check it rejects voiced
 * non-speech — hums, "mmm", laughs — and it ignores breaths and room noise.
 */

export const SILERO_SAMPLE_RATE = 16000
export const SILERO_WINDOW = 512
const CONTEXT = 64
const MODEL_PATH = path.resolve(__dirname, '../../models/silero_vad.onnx')

let sessionPromise: Promise<ort.InferenceSession> | null = null

function getSession() {
  if (!sessionPromise) {
    if (!fs.existsSync(MODEL_PATH)) {
      return Promise.reject(new Error(`Silero model missing at ${MODEL_PATH}`))
    }
    sessionPromise = ort.InferenceSession.create(MODEL_PATH, {
      intraOpNumThreads: 1,
      interOpNumThreads: 1,
    }).catch((error) => {
      sessionPromise = null
      throw error
    })
  }
  return sessionPromise
}

/** Speech probability (0..1) per 512-sample window of 16 kHz mono audio. */
export async function sileroSpeechProbs(pcm: Int16Array): Promise<Float32Array> {
  const session = await getSession()
  const windows = Math.floor(pcm.length / SILERO_WINDOW)
  const probs = new Float32Array(windows)
  const sr = new ort.Tensor('int64', BigInt64Array.from([BigInt(SILERO_SAMPLE_RATE)]), [])
  let state: ort.Tensor = new ort.Tensor('float32', new Float32Array(2 * 128), [2, 1, 128])
  const buffer = new Float32Array(CONTEXT + SILERO_WINDOW)

  for (let w = 0; w < windows; w++) {
    buffer.copyWithin(0, SILERO_WINDOW, SILERO_WINDOW + CONTEXT)
    const offset = w * SILERO_WINDOW
    for (let i = 0; i < SILERO_WINDOW; i++) {
      buffer[CONTEXT + i] = pcm[offset + i] / 32768
    }
    const result = await session.run({
      input: new ort.Tensor('float32', buffer.slice(), [1, CONTEXT + SILERO_WINDOW]),
      state,
      sr,
    })
    probs[w] = (result.output.data as Float32Array)[0]
    state = result.stateN
  }
  return probs
}

/** Speech on/off per window with hysteresis (enter ≥0.5, leave <0.35). */
export function sileroSpeechMask(probs: Float32Array): Uint8Array {
  const mask = new Uint8Array(probs.length)
  let on = false
  for (let w = 0; w < probs.length; w++) {
    on = on ? probs[w] >= 0.35 : probs[w] >= 0.5
    mask[w] = on ? 1 : 0
  }
  // One window of slack each side: Silero reacts a beat late at onsets.
  const padded = new Uint8Array(mask)
  for (let w = 0; w < mask.length; w++) {
    if (!mask[w]) continue
    if (w > 0) padded[w - 1] = 1
    if (w + 1 < mask.length) padded[w + 1] = 1
  }
  return padded
}
