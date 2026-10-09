# Examples

Each one runs against Pending You itself (`https://www.pendingyou.com`), as your app: register it first in
**Settings › Developers**, and put its client ID where an example says `YOUR-CLIENT-ID`. Node 22.18 or later runs them
as they are.

- [Sign in, list the cards, answer one](answer-cards/): both ways to sign in (a code for terminals, the browser with
  PKCE for desktop apps), the person's cards, and an answer from their own key press, with undo. Start here: the others
  use its sign-in.
- [The change feed](change-feed/): every change to the person's cards as it happens, passed on to your own server as a
  webhook would.
- [A terminal queue, the way Pending You for Herdr works](herdr-queue/): the first real app on the API, its calls in a
  plain terminal: the queue, answers by key, Later, where each agent is running, and keeping the phone quiet.

The reference for everything here: <https://www.pendingyou.com/docs/api>.
