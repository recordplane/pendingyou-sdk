# Show in tmux

When the person presses **Show** on a card in Pending You, the agent that asked comes to the front where it runs. This
example is what brings it forward in tmux: an app you sign in on your computer that follows those presses and moves tmux
to the agent's pane. It's the whole of the app's side, in about 80 lines; Pending You for Herdr does the same for Herdr's
panes.

## Before you start

1. Register your app in Pending You: **Settings › Developers › Register an app**, as a terminal that signs in with a
   code, with the scope `assistants:show`. It works for your own account, and up to 10 testers, at once and with no
   review: this example is yours to run on your own computer. Anyone else needs it reviewed first.
2. Set this computer up with Pending You (`npx pendingyou init`, version 0.39.0 or later). Its key vouches for your
   app's sign-in, and from 0.39.0 your coding agents' presence says which tmux pane each one runs in.
3. Node 22.18 or later, and tmux.

```sh
npm install
export PENDINGYOU_CLIENT_ID=YOUR-CLIENT-ID
node show.ts login
node show.ts
```

`login` asks for `assistants:show` alone, and the person sees it in these words: "Bring the assistant that asked to the
front on this computer when you press Show. It learns which card and assistant." Then, while `node show.ts` runs, a card
asked by an agent in a tmux pane on this computer has **Show in tmux**.

## What it does

- [`show.ts`](show.ts) waits for a press with `GET /v1/shows?places=tmux&wait=25`, through the SDK's `followShows`.
  While it waits, and for a minute after, Pending You shows the button on those cards. A sign-in without this
  computer is refused (`no_machine`): a show goes to the computer the agent runs on.
- Each show names the card, the agent that asked and its places, newest first, each `{ app: "tmux", paneId: "%12",
  server, sessionId }`. `server` is the first 16 hex characters of a SHA-256 of the computer's name and tmux's socket
  path: it keeps only the places on its own tmux server (`#{socket_path}`) and leaves the rest to their own server's app.
- It checks the pane is there, as tmux names it: `tmux display-message -p -t %12 '#{pane_id} #{session_id}'` gives the
  pane's own id back, and its session. When none of the places is there, it answers `not_found`, and nothing moves.
- It brings the pane forward: `switch-client` when the pane is in another session than the one you're on, then
  `select-window` and `select-pane`. The SDK answers `shown`.

A pane's id names one pane for as long as its tmux server runs; a server started again numbers its panes from the
start. An app that can tell which agent a pane runs (Herdr's watcher reads its own badges) also checks the pane is still
the agent's before it moves.

## The rules it keeps

An app that brings windows forward when the person presses Show:

- **MUST bring a window to the front, and do nothing else.** The press means "show me", never anything more.
- **MUST check the place before moving anything.** It must be on its own server and there now; when it can't confirm
  that, it answers `not_found` and moves nothing.
- **MUST never type, run or open anything for a show.** Not into the pane, not a command, not a link. A pane's id reaches
  tmux only once it reads as tmux's own (`%` and digits), as one argument, never through a shell.

The reference: <https://www.pendingyou.com/docs/api#show-me>.
