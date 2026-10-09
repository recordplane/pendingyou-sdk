# The change feed

Hear about every change to the person's cards as it happens, and pass each one on to your own server, as a webhook
would.

The person API has no webhooks of its own: it has a change feed. `GET /v1/changes` waits up to 25 seconds for something
to change, then says what did (ids and types only) and where it got to. The SDK's `changes()` follows it for you.

## Before you start

Sign in with the [answer-cards](../answer-cards/) example first (`node index.ts login` there, with your app's client
ID: `PENDINGYOU_CLIENT_ID=YOUR-CLIENT-ID`). This example uses the same sign-in. Node 22.18 or later.

```sh
npm install
node watch.ts
```

To hear each change on your own server too:

```sh
FORWARD_TO=<your address> node watch.ts
```

It POSTs each change there as JSON, `{ "type": "card.answered", "cardId": "req_…", "at": "…" }`, and says so when your
server doesn't answer 2xx.

## What it does

- [`watch.ts`](watch.ts) follows `pendingYou.changes()`. Each batch is the changes since the last, in the order they
  happened, and the cursor it reached, which it keeps in a file so a restart picks up where it stopped.
- On start and every 10 minutes a batch says `resync`: read the cards again then. A card that comes into the sign-in's
  reach (an assistant's computer joins it) makes no change of its own.
- For each change it reads the card again for its title. A card that left the sign-in's reach answers 404.
- When Pending You can't be reached it waits and tries again, longer each time, and as long as a 429 says.

| Type | When |
| --- | --- |
| `card.created` | An assistant asked something new. |
| `card.answered` | Someone answered it: the person, here or elsewhere, or a helper. |
| `card.changed` | Anything else: words, Later, handed over, back, updated. |
| `card.closed` | Its assistant picked the answer up, withdrew it, or it ran out. |

The reference: <https://www.pendingyou.com/docs/api#changes>.
