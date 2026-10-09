// Sign in as your app, list the person's cards, and answer one: the smallest whole app on the person API.
//
//   node index.ts login            sign in through your browser (a desktop app)
//   node index.ts login --device   sign in with a code (a terminal, on a computer set up with `npx pendingyou init`)
//   node index.ts list             the cards waiting on you
//   node index.ts answer [n]       show the nth card (the first by default) and answer it
//   node index.ts me               what this sign-in may do, and for how long
//   node index.ts logout           end the sign-in
//
// The reference: https://www.pendingyou.com/docs/api
import { createInterface } from 'node:readline/promises'
import { createClient, SignedOutError, SignInError } from '@recordplane/pendingyou-sdk'
import { answerCard } from './answer.ts'
import { signInWithBrowser, signInWithCode, signOutHere, store } from './sign-in.ts'

// The client signs every request with the sign-in's key (DPoP), refreshes its tokens, sends ETags back and makes an
// Idempotency-Key for each answer.
const pendingYou = createClient({ store })

async function list(): Promise<void> {
  const { cards, counts } = await pendingYou.cards.list({ status: 'pending', limit: 20 })
  if (!cards.length) console.log('Nothing is waiting on you.')
  for (const [index, card] of cards.entries())
    console.log(`${index + 1}. ${card.title}\n   ${card.asker.assistant.name} · ${card.urgency}`)
  if (counts.elsewhere) console.log(`\n${counts.elsewhere} more wait on other computers.`)
}

async function answer(which: string | undefined): Promise<void> {
  const { cards } = await pendingYou.cards.list({ status: 'pending', limit: 20 })
  const listed = cards[Math.max(0, Number(which ?? 1) - 1)]
  if (!listed) {
    console.log('No card there: `node index.ts list` shows them.')
    return
  }
  // The list's cards may come partial: read the one to answer whole.
  const card = await pendingYou.cards.get(listed.id)
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    await answerCard(pendingYou, card, rl)
  } finally {
    rl.close()
  }
}

async function me(): Promise<void> {
  const { app, grant } = await pendingYou.me()
  console.log(`${app.name}: ${grant.scopes.join(', ')}`)
  console.log(
    grant.reach === 'all'
      ? 'Every card.'
      : `This computer’s cards (${grant.machine?.name ?? 'this computer'}).`,
  )
  console.log(`Until ${new Date(grant.expiresAt).toLocaleString()}.`)
}

const [command, argument] = process.argv.slice(2)
try {
  if (command === 'login') await (argument === '--device' ? signInWithCode() : signInWithBrowser())
  else if (command === 'list') await list()
  else if (command === 'answer') await answer(argument)
  else if (command === 'me') await me()
  else if (command === 'logout') await signOutHere()
  else console.log('node index.ts login [--device] | list | answer [n] | me | logout')
} catch (error) {
  if (error instanceof SignedOutError) console.error('Not signed in: node index.ts login')
  else if (error instanceof SignInError) console.error(`Not signed in: ${error.message}`)
  else throw error
  process.exitCode = 1
}
