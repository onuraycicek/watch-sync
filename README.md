# Watch Sync

Watch videos together with friends on almost any site. When one of you plays,
pauses or seeks, everyone else's video does the same, in a few milliseconds.

- Works with plain HTML5 `<video>` players, including players embedded in
  iframes from another domain.
- Playback stays within about 20 ms between viewers (gentle speed adjustments,
  no constant seeking).
- No accounts, no chat, nothing to sign up for. You run your own tiny relay on
  Cloudflare's free plan; nobody else sees your rooms.
- A friend's current page shows up in the popup as a link: one click and you
  are on the same episode.

Chromium-based browsers, version 116 or newer (tested on Chrome).

## Quick start

**1. Deploy your relay** (once, by one person in the group):

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/onuraycicek/watch-sync/tree/main/server)

You get an address like `watch-sync.<your-name>.workers.dev`. The free plan is
plenty for watching together every day. Send the address to your friends.

**2. Install the extension** (everyone):

1. Download `watch-sync-<version>.zip` from
   [Releases](https://github.com/onuraycicek/watch-sync/releases) and unzip it.
2. Open `chrome://extensions`, turn on **Developer mode**, click
   **Load unpacked** and pick the unzipped folder.

**3. Pair up:**

1. Click the extension icon and enter the relay address (asked only once).
2. Copy your **room code** and send it to your friends. They click **Change**,
   paste it, and you are in the same room.
3. Open the same video and press play.

## How it works

- A content script finds the main video on the page (the largest one longer
  than 90 seconds, so ads are skipped), in every frame.
- The background worker keeps one WebSocket to the relay while the browser is
  open. Play, pause, seek and speed changes go to everyone in the room.
- Whoever acted last leads. Every 2 seconds the leader sends its position, and
  the others close any gap by running 1-8% faster or slower for a moment. Gaps
  above 1.5 s are seeked.
- If the browser blocks autoplay with sound, the video starts muted and the
  popup says so.

The relay (`server/`) is a Cloudflare Worker with one Durable Object per room.
It only forwards messages between the people in a room and stores nothing. It
uses the WebSocket Hibernation API, so idle connections cost nothing.

## What your friends can see

The people in your room see the title and address of the page whose video you
are syncing (or that you shared from the popup), plus playback positions.
Nothing else from your browser is sent. Leaving the page withdraws it.

Room codes are the only key to a room: anyone with your relay address **and**
your room code can join. A room holds at most `MAX_PEERS` people (default 2).

The extension is not in the Chrome Web Store yet; it is loaded unpacked.

## Building it yourself

Needs Node.js and [wrangler](https://developers.cloudflare.com/workers/wrangler/)
(`npm i -g wrangler`, then `wrangler login`).

```sh
make .env        # create your settings from .env.example
make deploy      # deploy the relay to your Cloudflare account
make zip         # dist/watch-sync.zip with the settings from .env
```

Settings (`.env`, all optional):

| Variable | Effect |
| --- | --- |
| `SERVER_URL` | Bake the relay address in; the popup never asks for it. |
| `ROOM_KEY` | Bake a default room in; everyone with this build starts there. Keep such a zip private. |
| `MAX_PEERS` | People per room (default 2). |
| `CUSTOM_DOMAIN` | Serve the relay on your own domain and turn `*.workers.dev` off. |

`make release` builds the generic package from Releases and never reads `.env`.

### Development

```sh
make dev-server  # local relay on ws://127.0.0.1:8787
make browser-a   # two isolated Chrome profiles with the extension loaded
make browser-b
```

`tools/` has the CDP helpers used for testing (`tools/measure.mjs` prints the
playback gap between the two test browsers).

## License

MIT
