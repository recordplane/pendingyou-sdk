# @recordplane/pendingyou-sdk

Build an app that works as the person who signs it in to [Pending You](https://www.pendingyou.com), the one queue for
everything their AI assistants are waiting on them for. Your app can show their cards, answer one when they press
something in it, write to its assistant, put it in Later, hand it to another assistant, see which assistants are
running, and keep their phone quiet while they're at your app.

This is the person API (`/v1`) in TypeScript: sign-in by code or through the browser with PKCE, DPoP and its nonces,
token refresh, ETags, Idempotency-Keys and the change feed, done for you. Zero dependencies. ESM. WebCrypto only, so it
runs on Node 20 or later, in browsers and in Workers. The reference is <https://www.pendingyou.com/docs/api>, and the
OpenAPI document is at <https://www.pendingyou.com/v1/openapi.json>.

```sh
npm install @recordplane/pendingyou-sdk
```

Register your app first, in Pending You's **Settings › Developers**: it works for you and up to 10 testers at once, and
for everyone once it's reviewed. Then use its client ID where these examples say `YOUR-CLIENT-ID`.

## Examples

Whole apps you can run, in [examples/](https://github.com/recordplane/pendingyou-sdk/tree/main/examples):

- [answer-cards](https://github.com/recordplane/pendingyou-sdk/tree/main/examples/answer-cards): sign in, list the
  person's cards, and answer one.
- [change-feed](https://github.com/recordplane/pendingyou-sdk/tree/main/examples/change-feed): every change as it
  happens, passed on to your own server.
- [herdr-queue](https://github.com/recordplane/pendingyou-sdk/tree/main/examples/herdr-queue): a terminal queue making
  the calls Pending You for Herdr makes.
- [show-in-tmux](https://github.com/recordplane/pendingyou-sdk/tree/main/examples/show-in-tmux): when the person
  presses Show on a card, bring the agent that asked to the front in tmux.

## Sign in (device code)

```ts
import { createClient, deviceSignIn } from '@recordplane/pendingyou-sdk'
import { cliAttester, fileStore } from '@recordplane/pendingyou-sdk/node'

const store = fileStore(`${process.env.HOME}/.config/example-app/pendingyou.json`)
const signIn = await deviceSignIn({
  origin: 'https://www.pendingyou.com',
  clientId: 'YOUR-CLIENT-ID',
  scopes: ['cards:read', 'cards:answer'],
  machine: 'build-01',
  attest: cliAttester(), // pendingyou machine attest: this computer's key vouches for the sign-in
  store,
})
console.log(`Allow it at ${signIn.verificationUriComplete} (code ${signIn.userCode})`)
await signIn.signedIn
```

The sign-in makes a new key for its tokens and keeps it in the store with them: the tokens are useless without it
(DPoP). The computer must be set up with the person's account (`npx pendingyou init`).

## Sign in (web or desktop app)

A desktop app signs in through the person's browser and listens for it to come back on this computer:

```ts
import { loopbackSignIn, fileStore } from '@recordplane/pendingyou-sdk/node'

const signIn = await loopbackSignIn({
  origin: 'https://www.pendingyou.com',
  clientId: 'YOUR-CLIENT-ID', // registered with the redirect address http://127.0.0.1/callback
  scopes: ['cards:read', 'cards:read:all', 'cards:answer'],
  store: fileStore(`${process.env.HOME}/.config/example-app/pendingyou.json`),
  open: (url) => openInBrowser(url),
})
await signIn.signedIn
```

A single-page app is sent away and comes back to its registered address:

```ts
import { finishRedirectSignIn, redirectToSignIn } from '@recordplane/pendingyou-sdk'

// On "Sign in with Pending You":
await redirectToSignIn({ origin, clientId, redirectUri: `${location.origin}/pendingyou/callback`, scopes })
// On /pendingyou/callback:
const credentials = await finishRedirectSignIn({ store })
```

`codeSignIn` is what both are made of: `url` to send the person to, and `finish(callbackUrl)`. Each sign-in makes a new
key, a PKCE verifier and a `state`, and names the key's thumbprint as `dpop_jkt`, so the code and every token after it
are useless without the key. An app signed in this way has no computer, so it asks for `cards:read` and
`cards:read:all`: it sees every card it's allowed to. Signing in again with the same key replaces the sign-in; another
copy of the app, with its own key, keeps its own.

## Use it

```ts
const pendingYou = createClient({ store })
const { cards } = await pendingYou.cards.list()
const card = cards[0]
if (card && card.actions.includes('answer'))
  await pendingYou.cards.answer(card.id, { version: card.version, choiceIds: ['b'] })

for await (const batch of pendingYou.changes({ signal })) {
  if (batch.resync) await reloadEverything()
  for (const change of batch.changes) await reload(change.cardId)
}
```

The client signs every request (DPoP, with the nonce Pending You asks for), refreshes tokens once however many calls
need it (across processes sharing a `fileStore` too), sends ETags back, and makes an `Idempotency-Key` for every
answer, kept if it has to send the answer again. High-stakes cards come back from `answer` as an `ApiError` with code
`high_stakes`: send the person to `card.url`. `answer` with `handled: 'self'` says the person will do it themselves
(I'll handle it), and `handled: 'leave'` that they won't do a to-do (Skip).

A card its assistant asked to send on carries `sendTo`. On one asking another of the person's assistants again ("Ask
Maple again?", `kind: 'assistant'`), a hand-over to `sendTo.to` says yes this time, while it's there (the assistant is
in your sign-in's reach), and `notSent` says no:

```ts
const { sendTo } = card
if (sendTo?.kind === 'assistant' && yes && sendTo.to)
  await pendingYou.cards.delegate(card.id, {
    to: sendTo.to,
    mode: sendTo.mode === 'freely' ? 'freely' : 'loop',
  })
if (sendTo?.kind === 'assistant' && no)
  await pendingYou.cards.answer(card.id, { version: card.version, notSent: true })
```

"From now on" is the person's, in Pending You. A teammate's (`kind: 'teammate'`, "Send this to Doug?") is answered in
Pending You too: send the person to `card.url`.

`pendingYou.snapshot()` reads the whole queue at once: each list's first cards (`pending`, `later`, `delegated`,
`done`), their `counts`, and the `areas` and `groups` the cards are filed in. Read it on start and when the change feed
says something changed; while nothing has, its ETag makes the read a 304.

An app that brings windows to the front on its computer (a terminal's panes: `herdr` or `tmux`) can follow the person's
presses of Show on a card, with `assistants:show`, signed in on that computer:

```ts
await pendingYou.followShows({
  places: ['herdr'],
  mine: (place) => place.server === myServer,
  find: (show) => myPanes().find((pane) => pane.id === show.places[0]?.paneId && isAgentsPane(pane, show)),
  focus: (pane) => focusPane(pane),
  signal,
})
```

`find` looks for the agent's window in your own list and returns your own record of it; `focus` gets only that, so a
show only ever brings forward a window you already know. It answers `shown`, or `not_found` when nothing was found,
and leaves a show with no place of yours to the app whose it is. Never type into a window, run anything or open a link
for a show. `pendingYou.shows({ places })` gives the show requests alone, each once, and `answerShow(id, result)`
answers one. The [show-in-tmux](https://github.com/recordplane/pendingyou-sdk/tree/main/examples/show-in-tmux) example
does all of it for tmux.

`fileStore(path)` keeps the sign-in at `path`, readable only by you (0600), written whole, and locked while it's
written or refreshed. `memoryStore()` keeps it in memory.

## Sign out

```ts
import { signOut } from '@recordplane/pendingyou-sdk'

await signOut({ store }) // 'signed-out', 'none' or 'unreachable'
```

It revokes the sign-in's refresh token at Pending You (RFC 7009), which ends the whole sign-in at once. Remove it from
the store afterwards, whatever it answers: one Pending You couldn't reach ends by itself 30 days after it started.

## Types

Every request and answer is typed, from the person API's OpenAPI document (`src/openapi.generated.ts`): `Card`,
`CardList`, `AnswerRequest`, `Change`, `Assistant`, `Me` and the rest, exported from `@recordplane/pendingyou-sdk`.
/v1 only adds, so the enums in what it sends are open: `Card['kind']` is `'choice' | 'multi' | … | (string & {})`. Give
a value you don't know a way through (a `default:` in a `switch`) rather than assume the list is complete. A doc's
`Block` and `Run` are open the same way: each ends in `{ t: string }`, a kind of block or run your version doesn't
know, so read past it (the doc's `plain` has all its words).
`Presentation`, `PresentationAction`, `Line` and `Toast` type how Pending You draws a card and what an action's toast
says; for now /v1 sends them to Pending You's own apps only, so read them as optional.
`ClientConfig` types GET /v1/client's answer, which Pending You's own apps read (with the `Pending-You-Client` header)
to learn whether their version must update; your app doesn't need it.

## This repository

[recordplane/pendingyou-sdk](https://github.com/recordplane/pendingyou-sdk) is published from Pending You's own
repository with every release of Pending You, so a change made here directly is replaced by the next. Apache-2.0.
