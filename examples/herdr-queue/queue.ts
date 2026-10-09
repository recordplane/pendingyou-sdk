// A terminal queue of the person's cards, answered with a key: the person API as Pending You for Herdr uses it, every
// call of its popup, without Herdr. https://www.pendingyou.com/docs/api/herdr is the plugin itself.
//
//   GET  /v1/me                  as it opens: whose computer the sign-in sees (`grant.machine`)
//   GET  /v1/cards               the cards waiting, again whenever the feed says something changed, and every 30 s
//   GET  /v1/changes             followed while it's open (the SDK's `changes()`)
//   GET  /v1/assistants          where each card's agent is running: its terminal pane, when it says
//   POST /v1/cards/{id}/answer   a number or y/n; /undo with `u` while Pending You holds the answer (5 s)
//   POST /v1/cards/{id}/later    `l`: tomorrow morning, in the person's time zone; /back with `u`
//   POST /v1/presence            "here" every 30 s while keys come, "gone" as it closes (presence.ts)
//
// Keys: j/k (or the arrows) choose a card; 1–9 answers a choice; y/n approves or declines; u takes the last back; l puts
// it in Later; t says where its agent is; o shows its link; q quits. High-stakes cards are answered in Pending You.
// It never logs, and never writes a card's words anywhere but the screen.
import { homedir } from 'node:os'
import { join } from 'node:path'
import { emitKeypressEvents } from 'node:readline'
import {
  type AnswerRequest,
  ApiError,
  type Assistant,
  type Card,
  createClient,
  SignedOutError,
} from '@recordplane/pendingyou-sdk'
import { fileStore } from '@recordplane/pendingyou-sdk/node'
import { away, deskStep } from './presence.ts'

/** The sign-in the answer-cards example made: `node index.ts login --device` there, as Herdr signs in. */
const pendingYou = createClient({
  store: fileStore(join(homedir(), '.config', 'pendingyou-example', 'sign-in.json')),
})

/** How often it reads the cards again even when the feed says nothing. */
const RELIST_MS = 30_000

let cards: Card[] = []
let selected = 0
let note = ''
let machine: string | null = null
let assistants: Assistant[] = []
let scopes = new Set<string>()
/** The last thing sent that `u` can take back, until when. */
let sent: { cardId: string; what: 'answer' | 'later'; until: number } | null = null
let stale = true
let listedAt = Number.NEGATIVE_INFINITY
let activeAt: number | null = Date.now()
let desk = away()
const closing = new AbortController()

/** What a refusal means to the person. A sign-in that ended closes the queue. */
function failed(error: unknown): void {
  if (error instanceof SignedOutError) {
    note = 'Signed out: sign in again with the answer-cards example (node index.ts login --device).'
    closing.abort()
  } else if (error instanceof ApiError) {
    note =
      error.code === 'high_stakes'
        ? 'High stakes: answer it in Pending You (o shows its link).'
        : error.code === 'version_conflict' || error.code === 'not_waiting'
          ? 'It changed meanwhile: look again.'
          : error.code === 'rate_limited'
            ? `Too fast: try again in ${error.retryAfterSeconds ?? 60} s.`
            : `Pending You refused it (${error.code}).`
  } else note = 'Pending You couldn’t be reached.'
}

/** The cards again, the chosen one kept chosen. */
async function list(): Promise<void> {
  stale = false
  listedAt = Date.now()
  const keep = cards[selected]?.id
  try {
    // Partial cards are enough for a list (`whole: 0`): read one whole when it's opened.
    cards = (await pendingYou.cards.list({ status: 'pending', limit: 50, whole: 0 })).cards
    const at = cards.findIndex((card) => card.id === keep)
    selected = at >= 0 ? at : Math.max(0, Math.min(selected, cards.length - 1))
  } catch (error) {
    failed(error)
  }
}

/** Where a card's agent is running now: the terminal pane its live session names. */
function paneOf(card: Card): string | null {
  const agentId = card.asker.agent?.id
  for (const assistant of assistants)
    for (const agent of assistant.agents)
      if (agent.id === agentId)
        for (const session of agent.liveSessions)
          if (session.terminal) return session.terminal.paneId
  return null
}

/** Answers the chosen card with what the person pressed. */
async function answer(
  card: Card,
  chosen: Omit<AnswerRequest, 'version'>,
  words: string,
): Promise<void> {
  if (card.highStakes || !card.actions.includes('answer')) {
    note = `Answer it in Pending You: ${card.url}`
    return
  }
  try {
    const done = await pendingYou.cards.answer(card.id, { version: card.version, ...chosen })
    sent = { cardId: card.id, what: 'answer', until: Date.parse(done.undoUntil) }
    note = `Sent: ${words}. u takes it back.`
  } catch (error) {
    failed(error)
  }
  stale = true
}

/** What a key does. */
async function press(key: string): Promise<void> {
  activeAt = Date.now()
  note = ''
  const card = cards[selected]
  if (key === 'j' || key === 'down')
    selected = Math.min(selected + 1, Math.max(0, cards.length - 1))
  else if (key === 'k' || key === 'up') selected = Math.max(0, selected - 1)
  else if (key === 'u') {
    if (!sent || Date.now() > sent.until) note = 'Nothing to take back.'
    else {
      try {
        if (sent.what === 'answer') await pendingYou.cards.undo(sent.cardId)
        else await pendingYou.cards.back(sent.cardId)
        note = 'Taken back: it’s waiting on you again.'
      } catch (error) {
        failed(error)
      }
      sent = null
      stale = true
    }
  } else if (!card) return
  else if (/^[1-9]$/.test(key) && card.kind === 'choice') {
    const option = card.options?.[Number(key) - 1]
    if (option) await answer(card, { choiceIds: [option.id] }, option.label)
  } else if ((key === 'y' || key === 'n') && (card.kind === 'approve' || card.kind === 'review'))
    await answer(card, { approved: key === 'y' }, key === 'y' ? 'Yes' : 'No')
  else if (key === 'l' && scopes.has('cards:later') && card.actions.includes('later')) {
    try {
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
      await pendingYou.cards.later(card.id, { until: 'tomorrow', timeZone })
      sent = { cardId: card.id, what: 'later', until: Date.now() + 5000 }
      note = 'In Later until tomorrow morning. u brings it back.'
    } catch (error) {
      failed(error)
    }
    stale = true
  } else if (key === 't')
    note = paneOf(card)
      ? `Its agent is in pane ${paneOf(card)}.`
      : 'Its agent isn’t in a terminal pane now.'
  else if (key === 'o') note = card.url
}

/** Tells Pending You the person is here, or has left, as presence.ts says. Never in the way. */
async function tellPresence(): Promise<void> {
  if (!scopes.has('presence:desk')) return
  const step = deskStep(desk, activeAt, Date.now())
  if (step.send === null) return
  desk = step.desk
  await pendingYou.presence(step.send).catch(failed)
}

function draw(): void {
  const lines = [`Waiting on you${machine ? ` on ${machine}` : ''}: ${cards.length}`, '']
  for (const [index, card] of cards.entries())
    lines.push(`${index === selected ? '›' : ' '} ${card.title}  · ${card.asker.assistant.name}`)
  const card = cards[selected]
  if (card) {
    lines.push('', card.summary)
    for (const [index, option] of (card.options ?? []).entries())
      lines.push(`  ${index + 1}. ${option.label}`)
    if (card.kind === 'approve' || card.kind === 'review') lines.push('  y yes · n no')
    if (card.highStakes) lines.push('  High stakes: answer it in Pending You.')
  }
  lines.push(
    '',
    note || 'j/k choose · 1–9 or y/n answer · u undo · l later · t its pane · o link · q quit',
  )
  process.stdout.write(`\x1b[2J\x1b[H${lines.join('\n')}\n`)
}

// As it opens: who it's signed in as, the cards, where their agents are, and that the person is here.
try {
  const me = await pendingYou.me()
  scopes = new Set(me.grant.scopes)
  machine = me.grant.reach === 'machine' ? (me.grant.machine?.name ?? null) : null
} catch (error) {
  failed(error)
  console.error(note)
  process.exit(1)
}
await list()
if (scopes.has('assistants:read'))
  assistants = (await pendingYou.assistants.list().catch(() => null))?.assistants ?? []
await tellPresence()
draw()

// The change feed while it's open: anything that changes a card in reach reads the cards again; a resync reads where
// the agents are too.
const feed = (async () => {
  try {
    for await (const batch of pendingYou.changes({ signal: closing.signal })) {
      if (batch.changes.length || batch.resync) stale = true
      if (batch.resync && scopes.has('assistants:read'))
        assistants =
          (await pendingYou.assistants.list().catch(() => null))?.assistants ?? assistants
    }
  } catch (error) {
    failed(error)
  }
})()

// Keys, one at a time; the screen again after each, and every second.
emitKeypressEvents(process.stdin)
if (process.stdin.isTTY) process.stdin.setRawMode(true)
let busy = Promise.resolve()
process.stdin.on('keypress', (text: string | undefined, key: { name?: string; ctrl?: boolean }) => {
  if (key.name === 'q' || key.name === 'escape' || (key.ctrl && key.name === 'c')) closing.abort()
  else
    busy = busy.then(async () => {
      await press(key.name === 'up' || key.name === 'down' ? key.name : (text ?? ''))
      if (stale) await list()
      draw()
    })
})
const ticker = setInterval(() => {
  busy = busy.then(async () => {
    if (sent && Date.now() > sent.until) sent = null
    if (stale || Date.now() - listedAt >= RELIST_MS) await list()
    await tellPresence()
    draw()
  })
}, 1000)

await new Promise<void>((done) => closing.signal.addEventListener('abort', () => done()))
clearInterval(ticker)
await busy
await feed
// Gone: the phone may ring again.
if (desk.here && scopes.has('presence:desk')) await pendingYou.presence(false).catch(() => {})
if (process.stdin.isTTY) process.stdin.setRawMode(false)
process.stdin.pause()
process.stdout.write(note ? `${note}\n` : '')
