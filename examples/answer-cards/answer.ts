// Answering one card, from the person's own key presses: https://www.pendingyou.com/docs/api#endpoints
// (POST /v1/cards/{id}/answer, then /undo). An app answers only when the person presses something in it: never on a
// timer, from a model's decision, or for a card they haven't seen. High-stakes cards are answered in Pending You.
import type { Interface } from 'node:readline/promises'
import { type AnswerRequest, ApiError, type Card, type Client } from '@recordplane/pendingyou-sdk'

/** What the person chose, as /v1 takes it (without the version), and in words. */
type Chosen = { answer: Omit<AnswerRequest, 'version'>; words: string }

/** The card, as the terminal shows it. */
export function describe(card: Card): string {
  const lines = [card.title]
  if (card.summary) lines.push(card.summary)
  lines.push(`From ${card.asker.assistant.name} · ${card.area.name} · ${card.urgency}`)
  return lines.join('\n')
}

const numbered = (labels: readonly string[], recommended: readonly boolean[] = []) =>
  labels.map(
    (label, index) => `  ${index + 1}. ${label}${recommended[index] ? ' (recommended)' : ''}`,
  )

/** Asks the person in the terminal; null when they skip it, or when it's for Pending You. */
async function ask(card: Card, rl: Interface): Promise<Chosen | null> {
  switch (card.kind) {
    case 'choice':
    case 'multi': {
      const options = card.options ?? []
      const labels = options.map((option) => option.label)
      const recommended = options.map((option) => card.recommendedIds?.includes(option.id) ?? false)
      console.log(numbered(labels, recommended).join('\n'))
      const said = await rl.question(
        card.kind === 'choice'
          ? `Choose 1–${options.length} (Enter skips): `
          : 'Choose, e.g. 1,3 (Enter skips): ',
      )
      const picked = said
        .split(',')
        .map((each) => options[Number(each.trim()) - 1])
        .filter((option) => option !== undefined)
      if (!picked.length || (card.kind === 'choice' && picked.length !== 1)) return null
      return {
        answer: { choiceIds: picked.map((option) => option.id) },
        words: picked.map((option) => option.label).join(', '),
      }
    }
    case 'approve':
    case 'review': {
      if (card.approve?.command) console.log(`  ${card.approve.command}`)
      const said = (await rl.question('y or n (Enter skips): ')).trim().toLowerCase()
      if (said !== 'y' && said !== 'n') return null
      const yes = said === 'y'
      const words =
        card.kind === 'review'
          ? yes
            ? 'Looks good'
            : 'Needs changes'
          : yes
            ? 'Approved'
            : 'Declined'
      return { answer: { approved: yes }, words }
    }
    case 'text': {
      const suggestions = card.text?.suggestions ?? []
      if (suggestions.length) console.log(numbered(suggestions).join('\n'))
      const said = (await rl.question('Your answer (or a number; Enter skips): ')).trim()
      const text = suggestions[Number(said) - 1] ?? said
      return text ? { answer: { text }, words: text } : null
    }
    case 'action': {
      for (const [index, step] of (card.action?.steps ?? []).entries())
        console.log(
          `  ${index + 1}. ${typeof step === 'string' ? step : `${step.text}${step.command ? `: ${step.command}` : ''}`}`,
        )
      const said = (await rl.question('Done? y (Enter skips): ')).trim().toLowerCase()
      return said === 'y' ? { answer: {}, words: 'Done' } : null
    }
    case 'fyi': {
      const said = (await rl.question('Got it? y (Enter skips): ')).trim().toLowerCase()
      return said === 'y' ? { answer: {}, words: 'Got it' } : null
    }
    default:
      // A card of several questions (`group`), or a kind this example doesn't know yet: Pending You answers it.
      return null
  }
}

/** Shows the card, asks the person, sends their answer, and offers to take it back while Pending You holds it. */
export async function answerCard(client: Client, card: Card, rl: Interface): Promise<void> {
  console.log(`\n${describe(card)}\n`)
  if (card.highStakes || !card.actions.includes('answer') || card.kind === 'group') {
    console.log(`Answer this one in Pending You: ${card.url}`)
    return
  }
  const chosen = await ask(card, rl)
  if (!chosen) {
    console.log('Skipped: it’s still waiting on you.')
    return
  }
  try {
    // The version shown, so an answer to a card that changed meanwhile is refused (409) rather than misread.
    const sent = await client.cards.answer(card.id, { version: card.version, ...chosen.answer })
    console.log(`Sent: ${chosen.words}.`)
    await offerUndo(client, card, rl, Date.parse(sent.undoUntil))
  } catch (error) {
    if (!(error instanceof ApiError)) throw error
    if (error.code === 'high_stakes') console.log(`Answer this one in Pending You: ${card.url}`)
    else if (error.code === 'version_conflict')
      console.log('It changed while you looked: run it again to see it as it is.')
    else if (error.code === 'not_waiting')
      console.log('It isn’t waiting on you any more: answered elsewhere, or closed.')
    else console.log(`Pending You refused it: ${error.message}`)
  }
}

/** Pending You holds an answer for 5 seconds before its assistant hears it: `u` takes it back meanwhile. */
async function offerUndo(client: Client, card: Card, rl: Interface, until: number): Promise<void> {
  const left = until - Date.now()
  if (!(left > 0)) return
  try {
    const said = await rl.question('u and Enter takes it back: ', {
      signal: AbortSignal.timeout(left),
    })
    if (said.trim().toLowerCase() !== 'u') return
    await client.cards.undo(card.id)
    console.log('Taken back: it’s waiting on you again.')
  } catch (error) {
    if (error instanceof ApiError) console.log(`Too late to take it back (${error.code}).`)
    else if (!(error instanceof Error && error.name === 'AbortError')) throw error
    else console.log('')
  }
}
