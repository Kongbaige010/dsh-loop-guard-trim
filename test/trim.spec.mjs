/**
 * Tail trimming and the configurable notice templates.
 *
 * The plugin's break path closes each open block with a `block-end` payload that
 * wins over the accumulated deltas, so it is the last point where the text that
 * actually reaches the context can still be changed. These tests pin that the
 * repeated tail is really gone from the committed block, that the guard never
 * empties a block, and that a configured template is used verbatim.
 *
 * `test/…` runs against the built `lib/index.js`, so these also pin the shipped
 * artifact rather than the sources.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import * as plugin from '../lib/index.js'

/** A period long enough that the cycle rule recognises it as a repetition. */
const PERIOD = 'The agent keeps restating the same plan instead of acting on it. '

/** Baseline config: the shape a call needs to trip the mid-stream breaker. */
const BASE = {
  maxThinkingSteps: 3,
  minReasoningChars: 2048,
  similarityThreshold: 0.8,
  escalate: 'steer',
  maxFires: 4,
  cancelCause: 'thinking-loop',
  maxRepeatedText: 4,
  maxRepeatedCycleChars: 512,
  minRepeatedCycleChars: 256,
  maxRepeatedReasoningCycleChars: 512,
  minRepeatedReasoningCycleChars: 512,
  maxRepeatedReasoningLineChars: 2048,
  minRepeatedReasoningLineCoverage: 0.6,
  maxRepeatedReasoningLineConcentration: 4,
  breakCode: 'REPETITIVE_OUTPUT',
  breakCorrection: true,
  resumeAfterBreak: false,
}

/** Minimal stand-in for the live agent, capturing what the guard steers. */
function fakeAgent() {
  const steered = []
  const injected = []
  let cancelled = 0
  return {
    steered,
    injected,
    get cancelled() {
      return cancelled
    },
    steer: m => steered.push(m),
    inject: m => injected.push(m),
    cancel: () => {
      cancelled++
    },
  }
}

/** Wraps a fake agent in the context surface `apply()` reads. */
function fakeContext(agent) {
  const listeners = []
  const warnings = []
  return {
    warnings,
    on(name, listener) {
      if (name === 'llm/stream') listeners.push(listener)
    },
    logger: { warn: m => warnings.push(m), debug() {}, info() {}, error() {} },
    agents: { get: () => agent },
    settings: { get: () => 'zh' },
    /**
     * Invoke the installed `llm/stream` waterfall.
     *
     * The middleware signature is `(options, next)`, where `next` is a function
     * returning the async iterable to wrap — not the iterable itself.
     *
     * @param options - the marked request the wrapper keys on.
     * @param next - factory returning the stream to wrap.
     * @returns every chunk the wrapper emitted.
     */
    fire(options, next) {
      assert.equal(listeners.length, 1, 'apply() must register exactly one llm/stream listener')
      return listeners[0](options, next)
    },
  }
}

/**
 * Run one repetitive stream through `apply()`.
 *
 * @param config - plugin config, merged over {@link BASE}.
 * @param blocks - the blocks to stream, as `[blockType, text]` pairs.
 * @returns the emitted chunks, the agent, and the committed block texts.
 */
async function run(config, blocks) {
  const agent = fakeAgent()
  const ctx = fakeContext(agent)
  plugin.apply(ctx, { ...BASE, ...config })
  const options = markAgentLoopRequest({ sessionId: 's1', provider: 'p', model: 'm', messages: [] })
  function next() {
    return (async function* stream() {
      for (const [blockType, text] of blocks) {
        yield { type: 'block-start', index: 0, blockType }
        for (let i = 0; i < text.length; i += 16) {
          yield { type: 'text-delta', index: 0, text: text.slice(i, i + 16) }
        }
      }
    })()
  }
  const out = []
  for await (const chunk of ctx.fire(options, next)) out.push(chunk)
  // A `block-end` payload replaces the accumulated deltas, so this is the text
  // the committed message actually carries.
  const committed = out.filter(c => c.type === 'block-end').map(c => c.block.text)
  // The repetition the detector reported, read back from its own log line.
  const breakLog = ctx.warnings.find(w => w.includes('breaking a repetitive stream')) ?? ''
  const repeated = Number(/\((\d+) repeated chars/.exec(breakLog)?.[1] ?? Number.NaN)
  return { out, agent, committed, repeated, warnings: ctx.warnings }
}

/**
 * A long unique lead-in followed by a repeating tail.
 *
 * The breaker fires on the tail, but the text accumulated by then also carries
 * the lead-in — so `text.length - repeated` stays above `MIN_TRIM_KEEP` and a
 * real trim happens. A pure repetition (no lead-in) stops the stream at roughly
 * the repetition size, which makes `keep` land under the floor and the guard
 * correctly commit the block whole.
 */
const LEAD_IN = 'Unique lead-in. ' + Array.from({ length: 40 }, (_, i) => `step-${i}`).join(' ') + '. '

/**
 * A repetitive stream whose accumulated text exceeds the measured repetition.
 *
 * @param reps - how many periods to append.
 * @returns the full text to stream.
 */
function bleedWithLeadIn(reps = 20) {
  return LEAD_IN + PERIOD.repeat(reps)
}

test('the repeated tail is removed from the committed block', async () => {
  const total = bleedWithLeadIn()
  const { committed } = await run({}, [['text', total]])
  assert.equal(committed.length, 1, 'the open block must be closed')
  assert.ok(committed[0].length < total.length, 'the tail must be gone, not committed')
})

test('a trimmed commit keeps enough text for the renderer', async () => {
  const total = bleedWithLeadIn()
  const { committed } = await run({}, [['text', total]])
  // A block with no non-whitespace text is invisible, and an all-empty content
  // array is the shape that historically withdrew a materialized target.
  assert.ok(committed[0].trim().length > 0, 'the block must not be emptied')
  assert.ok(committed[0].length >= 256, 'MIN_TRIM_KEEP must be respected')
})

test('trimRepeatedTail: false leaves the committed block longer', async () => {
  const total = bleedWithLeadIn()
  const trimmedRun = await run({}, [['text', total]])
  const wholeRun = await run({ trimRepeatedTail: false }, [['text', total]])
  assert.ok(
    wholeRun.committed[0].length > trimmedRun.committed[0].length,
    'disabling the trim must leave strictly more text in the committed block',
  )
  assert.equal(
    wholeRun.committed[0].length - trimmedRun.committed[0].length,
    trimmedRun.repeated,
    'the difference must be exactly the repetition the detector measured',
  )
})

test('a repetition smaller than the keep-floor commits the block whole', async () => {
  // A pure repetition (no lead-in) stops the stream at about the repetition
  // size, leaving `keep` under MIN_TRIM_KEEP. Trimming there would empty the
  // block, which the renderer cannot show, so the guard must leave it alone.
  const total = PERIOD.repeat(60)
  const { committed, warnings } = await run({}, [['text', total]])
  assert.ok(committed[0].length > 0, 'the block must still carry text')
  assert.ok(
    warnings.some(w => w.includes('trimming would leave')),
    `the keep-floor must have blocked the trim, warnings: ${warnings.join(' | ')}`,
  )
})

test('an omitted trimRepeatedTail still trims (hand-built config)', async () => {
  // The test suite passes configs without the newer fields; an absent field must
  // mean "use the default", never "silently skip the trim".
  const partial = { ...BASE }
  delete partial.trimRepeatedTail
  const total = bleedWithLeadIn()
  const { committed } = await run(partial, [['text', total]])
  assert.ok(committed[0].length < total.length, 'a missing field must not disable trimming')
})

test('an omitted template falls back to the built-in wording', async () => {
  const partial = { ...BASE }
  delete partial.correctionTemplate
  delete partial.trimNoticeTemplate
  const total = bleedWithLeadIn()
  const { agent } = await run(partial, [['text', total]])
  assert.equal(agent.steered.length, 1)
  assert.ok(agent.steered[0].content[0].text.length > 0, 'the correction must still be sent')
})

test('a configured correctionTemplate replaces the built-in text', async () => {
  const total = bleedWithLeadIn()
  const { agent } = await run({ correctionTemplate: 'STOP: repeated {chars} chars.' }, [['text', total]])
  const text = agent.steered[0].content[0].text
  assert.ok(text.startsWith('STOP: repeated '), `custom template must be used, got: ${text}`)
  assert.match(text, /STOP: repeated \d+ chars\./, 'the {chars} placeholder must be filled with a number')
})

test('every placeholder is substituted', async () => {
  const total = bleedWithLeadIn()
  const { agent } = await run(
    { correctionTemplate: 'w={what} c={chars} t={trimmed}' },
    [['text', total]],
  )
  const text = agent.steered[0].content[0].text
  assert.doesNotMatch(text, /\{what\}|\{chars\}|\{trimmed\}/, `no placeholder may survive: ${text}`)
  // Not anchored: when a trim happened the built-in notice is appended after the
  // custom correction, so the template occupies only the start of the message.
  assert.match(text, /^w=.+ c=\d+ t=\d+/, `placeholders must be filled: ${text}`)
  assert.ok(text.startsWith('w=可见输出 '), `{what} must follow the session language: ${text}`)
})

test('an unknown placeholder is left verbatim rather than throwing', async () => {
  const total = bleedWithLeadIn()
  const { agent } = await run({ correctionTemplate: 'x {nope} y' }, [['text', total]])
  const text = agent.steered[0].content[0].text
  assert.ok(text.includes('{nope}'), `an unknown placeholder must survive untouched: ${text}`)
})

test('a configured trimNoticeTemplate replaces the appended sentence', async () => {
  // The notice is only appended when a trim actually happened, and a trim only
  // happens when the measured repetition exceeds MIN_TRIM_KEEP. A longer bleed
  // is therefore required here than for the correction-only assertions.
  const total = bleedWithLeadIn(60)
  const { agent, committed } = await run({ trimNoticeTemplate: ' TAIL-GONE-{trimmed}' }, [['text', total]])
  const text = agent.steered[0].content[0].text
  assert.match(text, /TAIL-GONE-\d+/, `the custom notice must be appended: ${text}`)
  assert.ok(committed[0].length < total.length, 'a trim must really have happened')
})

test('the trim notice is omitted when nothing was trimmed', async () => {
  const total = bleedWithLeadIn()
  const { agent } = await run({ trimRepeatedTail: false, trimNoticeTemplate: 'SHOULD-NOT-APPEAR' }, [['text', total]])
  const text = agent.steered[0].content[0].text
  assert.ok(!text.includes('SHOULD-NOT-APPEAR'), `no trim happened, so no notice: ${text}`)
})

test('the custom correction still steers exactly once', async () => {
  const total = bleedWithLeadIn()
  const { agent } = await run({ correctionTemplate: 'custom' }, [['text', total]])
  assert.equal(agent.steered.length, 1, 'one break, one steer')
})

test('a rule whose block type is not open warns instead of trimming silently', async () => {
  // The visible-output breaker fires here, but only a reasoning block is open.
  // Through the shipped paths the two always agree; if they ever diverge the
  // trim would quietly do nothing, so the guard must say so.
  const total = bleedWithLeadIn()
  const { warnings, committed } = await run({}, [['reasoning', total]])
  assert.ok(
    warnings.some(w => w.includes('committing without trimming')),
    `a mismatched target must be logged, warnings: ${warnings.join(' | ')}`,
  )
  assert.ok(committed[0].length > 0, 'the block must still be committed')
})
