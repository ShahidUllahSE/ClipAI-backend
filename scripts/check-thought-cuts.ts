import {
  compactWordTimings,
  cutsFromPhrases,
  mergeIncompleteThoughtCuts,
  mergeSpokenPhrases,
  snapCutsToCompleteWords,
  wordsToSentenceCues,
} from '../src/integrations/timed-edit'

function wordsFromScript(
  items: Array<{ word: string; start: number; dur?: number; gapAfter?: number }>,
) {
  let t = 0.4
  return items.map((item) => {
    const start = t
    const end = start + (item.dur ?? Math.max(0.16, item.word.length * 0.07))
    t = end + (item.gapAfter ?? 0.06)
    return { word: item.word, start, end }
  })
}

const words = wordsFromScript([
  { word: 'This', start: 0 },
  { word: 'one' },
  { word: 'is' },
  { word: 'six' },
  { word: 'feet' },
  { word: 'tall.', gapAfter: 0.7 },
  { word: 'So' },
  { word: 'now' },
  { word: 'you' },
  { word: 'can' },
  { word: 'expose' },
  { word: 'everyone' },
  { word: 'for' },
  { word: 'lying' },
  { word: 'about' },
  { word: 'their', gapAfter: 0.28 },
  { word: 'height,', gapAfter: 0.22 },
  { word: 'all' },
  { word: 'while' },
  { word: 'having' },
  { word: 'an' },
  { word: 'awesome' },
  { word: 'Halloween' },
  { word: 'inflatable' },
  { word: 'decoration.', gapAfter: 1.8 },
  { word: 'This' },
  { word: 'one' },
  { word: 'is' },
  { word: 'the' },
  { word: 'six' },
  { word: 'foot' },
  { word: 'half', gapAfter: 0.3 },
  { word: 'skull.', gapAfter: 0.65 },
  { word: 'Just' },
  { word: 'plug' },
  { word: 'them' },
  { word: 'in,', gapAfter: 0.26 },
  { word: 'stake' },
  { word: 'them' },
  { word: 'down,' },
  { word: 'and' },
  { word: "you're" },
  { word: 'good' },
  { word: 'to' },
  { word: 'go.', gapAfter: 1.4 },
  { word: 'Now,' },
  { word: 'there' },
  { word: 'is' },
  { word: 'a' },
  { word: 'big' },
  { word: 'problem' },
  { word: 'with' },
  { word: 'this' },
  { word: 'one,', gapAfter: 0.32 },
  { word: 'and' },
  { word: 'that' },
  { word: 'is' },
  { word: 'that' },
  { word: 'there' },
  { word: 'was' },
  { word: 'a' },
  { word: 'very' },
  { word: 'similar' },
  { word: 'one' },
  { word: 'last' },
  { word: 'year' },
  { word: 'that' },
  { word: 'sold' },
  { word: 'out' },
  { word: 'super', gapAfter: 0.27 },
  { word: 'quick.', gapAfter: 1.1 },
  { word: 'So' },
  { word: 'if' },
  { word: 'you' },
  { word: 'still' },
  { word: 'see' },
  { word: 'this' },
  { word: 'inflatable' },
  { word: 'half' },
  { word: 'skeleton' },
  { word: 'tagged' },
  { word: 'down' },
  { word: 'there,' },
  { word: 'I' },
  { word: 'would' },
  { word: 'probably' },
  { word: 'grab' },
  { word: 'them' },
  { word: 'before' },
  { word: "it's" },
  { word: 'gone.' },
])

const compact = compactWordTimings(words)
const phrases = mergeSpokenPhrases(wordsToSentenceCues(compact))
const cuts = mergeIncompleteThoughtCuts(
  snapCutsToCompleteWords(cutsFromPhrases(phrases, 90), compact, 90),
  compact,
)

const kept = compact
  .filter((word) => cuts.some((cut) => word.end > cut.start && word.start < cut.end))
  .map((word) => word.word)
  .join(' ')

const required = [
  'height',
  'decoration',
  'skull',
  'go',
  'quick',
  'tagged',
  'grab',
  'gone',
]

console.log('phrases')
for (const phrase of phrases) {
  console.log(`  ${phrase.start.toFixed(2)}-${phrase.end.toFixed(2)}  ${phrase.text}`)
}
console.log(
  'cuts',
  cuts.map((cut) => `${cut.start.toFixed(2)}-${cut.end.toFixed(2)}`),
)
console.log('kept', kept)

const missing = required.filter(
  (word) => !new RegExp(`\\b${word}\\b`, 'i').test(kept.replace(/[.,]/g, '')),
)
if (missing.length) {
  console.error('MISSING', missing)
  process.exit(1)
}

const dangling = ['their height', 'half skull', 'super quick', 'good to go', "before it's gone"]
const lost = dangling.filter((part) => !kept.replace(/[.,]/g, '').includes(part.replace(/[.,]/g, '')))
if (lost.length) {
  console.error('BROKEN PHRASES', lost)
  process.exit(1)
}

console.log('ok: complete punchlines kept')
