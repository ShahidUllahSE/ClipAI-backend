let chain: Promise<void> = Promise.resolve()

/**
 * Run FFmpeg-heavy jobs one at a time so two long uploads
 * don't fight for CPU and both stall.
 */
export function enqueueJob(run: () => Promise<void>) {
  chain = chain.then(run, run)
}
