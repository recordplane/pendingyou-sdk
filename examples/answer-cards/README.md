# Sign in, list the cards, answer one

The smallest whole app on the Pending You person API: it signs in as your app, lists the cards waiting on the person,
and answers one from their own key presses, with 5 seconds to take it back.

## Before you start

1. Register your app in Pending You: **Settings › Developers › Register an app**. It works for you and your testers at
   once. Give it the redirect address `http://127.0.0.1/callback` for the browser sign-in, and the scopes in
   [`sign-in.ts`](sign-in.ts).
2. Node 22.18 or later, which runs TypeScript as it is.
3. For the sign-in with a code: set this computer up with your account first, with `npx pendingyou init`.

```sh
npm install
export PENDINGYOU_CLIENT_ID=YOUR-CLIENT-ID
```

## Run it

```sh
node index.ts login            # through your browser, as a desktop app does
node index.ts login --device   # or with a code, as a terminal does
node index.ts list
node index.ts answer 1
node index.ts logout
```

`login` keeps the sign-in in `~/.config/pendingyou-example/sign-in.json`, readable only by you. The other examples use
it too.

## What's in it

- [`sign-in.ts`](sign-in.ts): both ways to sign in. With a code (`deviceSignIn`), this computer vouches for the sign-in
  with its own key (`pendingyou machine attest`), and the sign-in sees this computer's cards. Through the browser
  (`loopbackSignIn`), it's authorization code with PKCE, back to `http://127.0.0.1` at a port of its own, and it sees
  every card. Either way the tokens are bound to a key the SDK makes for the sign-in (DPoP).
- [`answer.ts`](answer.ts): a card shown in the terminal and answered as the person chose: options, yes or no, words,
  a step done. High-stakes cards, and cards of several questions, are answered in Pending You: it prints the card's
  link. It sends the version it showed, so a card that changed meanwhile is refused rather than misread, and offers
  `u` while Pending You holds the answer.
- [`index.ts`](index.ts): the commands.

## The rules it keeps

An app answers only when the person presses something in it: never on a timer, from a model's decision, or for a card
they haven't seen. Every answer reads "Answered in" your app's name, wherever the person looks.

The reference: <https://www.pendingyou.com/docs/api>.
