# A terminal queue, the way Pending You for Herdr works

[Pending You for Herdr](https://www.pendingyou.com/docs/api/herdr) is the first app on the person API: a popup in the
Herdr terminal that shows the cards your coding agents are waiting on, answers one with a key, and takes you to the
pane its agent is running in. This example makes the same calls, in a plain terminal, so you can see how a real app
puts the API together.

## Before you start

Sign in with the [answer-cards](../answer-cards/) example first, with a code, as Herdr does:
`PENDINGYOU_CLIENT_ID=YOUR-CLIENT-ID node index.ts login --device` there, on a computer set up with
`npx pendingyou init`. This example uses the same sign-in, so its scopes are the ones that example asks for. Node 22.18
or later.

```sh
npm install
node queue.ts
```

## Keys

| Key | What it does |
| --- | --- |
| `j` `k` or the arrows | Choose a card |
| `1`–`9` | Answer a choice |
| `y` `n` | Approve or decline |
| `u` | Take the last answer back (while Pending You holds it, 5 seconds), or bring a card back from Later |
| `l` | Put it in Later, until tomorrow morning |
| `t` | Say which terminal pane its agent is in |
| `o` | Show its link in Pending You |
| `q` | Quit |

## The calls, and why

| When | Call | Why |
| --- | --- | --- |
| It opens | `GET /v1/me` | A sign-in by code sees one computer's cards: show which. |
| It opens, and when anything changes | `GET /v1/cards?status=pending&whole=0` | The list needs only partial cards. |
| While it's open | `GET /v1/changes` (`changes()`) | Read the cards again when the feed says something changed, and every 30 seconds anyway. |
| It opens, and on each resync | `GET /v1/assistants` | Each agent's live sessions name their terminal pane: that's where `t` goes in Herdr. |
| A key | `POST /v1/cards/{id}/answer` | With the version shown, and an Idempotency-Key the SDK makes. |
| `u` | `POST /v1/cards/{id}/undo` or `/back` | Only your own answer, while Pending You holds it. |
| `l` | `POST /v1/cards/{id}/later` | `tomorrow`, in the person's time zone. |
| Every 30 seconds while keys come | `POST /v1/presence` | Pending You keeps the phone quiet for the cards you're looking at ([`presence.ts`](presence.ts)). |

What it leaves to Pending You: high-stakes cards (it says to answer them there, and `o` shows the link), cards of
several questions, and anything the sign-in's scopes don't allow. It never logs, and never writes a card's words
anywhere but the screen.

In Herdr itself, the plugin runs the `pendingyou` command line, which signs in as Pending You's own app by name. Your
app signs in by its own client ID, as here.

The reference: <https://www.pendingyou.com/docs/api>.
