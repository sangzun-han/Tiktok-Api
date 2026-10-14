# Unofficial TikTok Web API

An unofficial TikTok web API server. It handles anonymous sessions, request signing and a Chrome-like TLS handshake, so you just call REST endpoints and get TikTok's original JSON back.

[![License](https://img.shields.io/github/license/sangzun-han/Tiktok-Api)](LICENSE) [![Stars](https://img.shields.io/github/stars/sangzun-han/Tiktok-Api?style=flat)](https://github.com/sangzun-han/Tiktok-Api/stargazers) [![Last commit](https://img.shields.io/github/last-commit/sangzun-han/Tiktok-Api)](https://github.com/sangzun-han/Tiktok-Api/commits/main) ![Node](https://img.shields.io/badge/node-22-339933?logo=nodedotjs&logoColor=white) ![Docker](https://img.shields.io/badge/docker-ready-2496ED?logo=docker&logoColor=white)

This API is designed to **retrieve data** from TikTok. It **cannot post, upload, like, follow or comment** on behalf of a user. It has **no support for logged-in routes**: every request is made as a signed-out visitor, so if you can't see something on tiktok.com while logged out, you can't get it here either. For the same reason, nothing is personalized to any account.

- **No browser.** No Puppeteer or Playwright. `X-Gnarly` and `X-Dynosaur` are computed in pure TypeScript in about 2 ms.
- **No account, no API key.** Anonymous sessions are bootstrapped automatically.
- **Any language.** It's a plain HTTP server, so anything that can send a request can use it.
- **One command.** `pnpm run dev` starts everything in Docker.

![demo](assets/demo.gif)

> **Disclaimer:** For educational and research purposes only. See [Disclaimer](#disclaimer).

## Table of Contents

- [Getting Started](#getting-started)
  - [Installing](#installing)
  - [Without Docker](#without-docker)
  - [Common Issues](#common-issues)
- [Quick Start Guide](#quick-start-guide)
- [Endpoints](#endpoints)
- [Paging](#paging)
- [Errors](#errors)
- [Configuration](#configuration)
- [Disclaimer](#disclaimer)
- [License](#license)

## Getting Started

### Installing

Requires Docker and pnpm. Works the same on macOS, Windows and Linux.

```bash
git clone https://github.com/sangzun-han/Tiktok-Api.git
cd Tiktok-Api
pnpm run dev
```

The first build takes a few minutes. The server listens on `http://localhost:3000`. To use another port, run `PORT=3100 pnpm run dev`.

| Command | |
| --- | --- |
| `pnpm run dev` | Build and start |
| `pnpm run logs` | Follow logs |
| `pnpm run stop` | Stop |

Check it's working:

```bash
curl localhost:3000/internal/health
```

You should see `"status": "ok"`.

### Without Docker

Requires Node 22, pnpm and Python 3. Python runs `curl_cffi`, which gives requests a Chrome TLS handshake.

```bash
pnpm install
pnpm run setup
pnpm run build
pnpm run start:prod
```

### Common Issues

- **`Cannot connect to the Docker daemon`.** Docker isn't running. Start Docker Desktop (or `colima start`) and try again.
- **`UPSTREAM_BLOCKED` or `UPSTREAM_THROTTLED`.** TikTok is pushing back. Wait a bit, call `POST /internal/session/reset`, or raise `TIKTOK_MIN_REQUEST_INTERVAL_MS`. If it keeps happening, set a [proxy](#configuration).
- **Comments are slow after many calls.** TikTok throttles a session after a few dozen comment or reply calls in a row. The server then switches to a fresh session and retries, which adds a few seconds. Paging replies hits this sooner, since each page holds only a few.
- **A 200 response with no list.** The data is private (likes, following) or doesn't exist. Check `statusCode`, see [Errors](#errors).
- **`"chromeHandshake": false` in `/internal/health`.** No Chrome-like TLS backend started, so some endpoints come back empty. Without Docker, run `pnpm run setup` to install `curl_cffi`.

## Quick Start Guide

Here's how to get trending videos. It's plain HTTP, so there's no SDK to install and no `ms_token` to copy from your browser.

```py
import requests

API = "http://localhost:3000/tiktok"

videos = requests.get(f"{API}/trending", params={"count": 10}).json()["itemList"]
for video in videos:
    print(video["id"], video["author"]["uniqueId"], video["stats"]["playCount"], video["desc"][:50])
```

> **Note:** This is **not your For You feed.** The server never logs in, so TikTok treats every call as a brand-new signed-out visitor with no follows, likes or watch history. You get the generic feed TikTok shows to anyone who isn't logged in, and it can differ by the server's location. Use the hashtag, sound, search and user routes when you need specific content.

Then a user's profile, their videos, and the comments on one of them.

```bash
curl 'localhost:3000/tiktok/user/detail?uniqueId=tiktok'
```

```jsonc
{
  "userInfo": {
    "user": { "uniqueId": "tiktok", "secUid": "MS4wLjABAAAAv7iSuuXDJGDvJkmH_vz1qkDZYo1apxgzaxdBSeIuPiM", ... },
    "stats": { "followerCount": ..., "videoCount": ..., ... }
  },
  "statusCode": 0
}
```

```bash
curl 'localhost:3000/tiktok/user/posts?secUid=MS4wLjABAAAAv7iSuuXDJGDvJkmH_vz1qkDZYo1apxgzaxdBSeIuPiM&count=5'
```

```jsonc
{
  "itemList": [
    { "id": "7694797676306615583", "desc": "...", "author": { ... }, "music": { ... }, "stats": { ... }, "video": { ... } }
  ],
  "cursor": "1790805450247",
  "hasMore": true
}
```

```bash
curl 'localhost:3000/tiktok/video/7694797676306615583/comments?count=20'
```

```jsonc
{
  "comments": [ { "cid": "...", "text": "...", "create_time": ..., "digg_count": ..., ... } ],
  "cursor": 20,
  "has_more": 1,
  "total": 1557
}
```

From code:

```js
const res = await fetch('http://localhost:3000/tiktok/search/general?keyword=cat&count=10');
const { data } = await res.json();
for (const { item } of data) {
  if (item) console.log(item.id, item.desc);
}
```

## Endpoints

Responses are TikTok's original JSON.

`count` is optional (1–50). TikTok may return more or fewer items than you ask for.

### Users

| Route | Params | Returns |
| --- | --- | --- |
| `GET /tiktok/user/detail` | `uniqueId` (handle without `@`) or `secUid` | `userInfo.user`, `userInfo.stats` |
| `GET /tiktok/user/posts` | `secUid`, `count`, `cursor` | `itemList`, `cursor`, `hasMore` |
| `GET /tiktok/user/followers` | `secUid`, `count`, `cursor` | `userList`, `total`, `minCursor`, `hasMore` |
| `GET /tiktok/user/following` | `secUid`, `count`, `cursor` | `userList`, `total`, `minCursor`, `hasMore` |
| `GET /tiktok/user/liked` | `secUid`, `count`, `cursor` | `itemList`, `cursor`, `hasMore` |
| `GET /tiktok/user/playlists` | `secUid`, `count`, `cursor` | `playList[].mixId`, `cursor`, `hasMore` |

Most user routes need `secUid`. Get it from `user/detail`.

`user/following` only works if the user's following list is public (`userInfo.user.followingVisibility` is `1`). Otherwise TikTok returns 200 with `statusCode: 10222` and no list.

`user/liked` works the same way: if `userInfo.user.openFavorite` is `false`, TikTok returns 200 with `statusCode: 0` and no `itemList`.

### Videos

| Route | Params | Returns |
| --- | --- | --- |
| `GET /tiktok/video/:itemId` | | `itemInfo.itemStruct` |
| `GET /tiktok/video/:itemId/related` | | `itemList` |
| `GET /tiktok/video/:itemId/comments` | `count`, `cursor` | `comments`, `cursor`, `has_more`, `total` |
| `GET /tiktok/video/:itemId/comments/:commentId/replies` | `cursor` | `comments`, `cursor`, `has_more`, `total` |
| `GET /tiktok/trending` | `count` | `itemList` |

Replies come a few at a time, and `has_more` stays `0` even when more remain. Keep sending `cursor` until it reaches `total`. The comment id is each comment's `cid`.

`trending` is the For You feed of a signed-out visitor, not of any account. It isn't personalized, and you can't steer it toward a topic or region you want. It has no cursor, and back-to-back calls repeat most items (5 calls gave 30 unique videos out of 40), so dedupe by `id`.

### Playlists

| Route | Params | Returns |
| --- | --- | --- |
| `GET /tiktok/playlist/:mixId` | | `mixInfo` |
| `GET /tiktok/playlist/:mixId/videos` | `count`, `cursor` | `itemList`, `cursor`, `hasMore` |

### Sounds

| Route | Params | Returns |
| --- | --- | --- |
| `GET /tiktok/music/:musicId` | | `musicInfo.music`, `musicInfo.author`, `musicInfo.stats` |
| `GET /tiktok/music/:musicId/videos` | `count`, `cursor` | `itemList`, `cursor`, `hasMore` |

The music id is in every video's `music.id`.

### Hashtags

| Route | Params | Returns |
| --- | --- | --- |
| `GET /tiktok/challenge/:tag` | | `challengeInfo.challenge`, `challengeInfo.stats` |
| `GET /tiktok/challenge/:tag/videos` | `count`, `cursor` | `itemList`, `cursor`, `hasMore` |

`:tag` can be a name (`cat`, any language) or a numeric id.

```bash
curl 'localhost:3000/tiktok/challenge/cat/videos?count=10'
```

### Search

| Route | Params | Returns |
| --- | --- | --- |
| `GET /tiktok/search/general` | `keyword`, `count`, `offset`, `searchId` | `data[].item`, `cursor`, `has_more` |
| `GET /tiktok/search/users` | `keyword`, `count`, `offset`, `searchId` | `user_list[].user_info`, `cursor`, `has_more` |

```bash
curl 'localhost:3000/tiktok/search/users?keyword=cat'
```

For the next page, send `offset` (the `cursor` you got) and `searchId` (`log_pb.impr_id` from the first page). Without `searchId`, TikTok returns an empty or repeated page.

`search/general` sometimes comes back with `status_code: 203` instead of `0`. The results in it are normal, so treat it as success.

### Anything else

`POST /tiktok/raw` calls any `www.tiktok.com` path and signs it for you.

```bash
curl -X POST localhost:3000/tiktok/raw \
  -H 'content-type: application/json' \
  -d '{"path":"/api/search/general/preview/","query":{"keyword":"cat"}}'
```

| Field | |
| --- | --- |
| `path` | Required. Starts with `/` |
| `query` | Query params as an object |
| `method` | `GET` (default) or `POST` |
| `body` | Request body for POST |

## Paging

Read the cursor from the response and send it with the next request. Stop when `hasMore` / `has_more` is false or `0`.

| Route | Read | Send as |
| --- | --- | --- |
| `user/posts`, `music/:id/videos`, `challenge/:tag/videos` | `cursor` | `cursor` |
| `user/followers`, `user/following` | `minCursor` | `cursor` |
| `video/:id/comments` | `cursor` | `cursor` |
| `video/:id/comments/:cid/replies` | `cursor`, until it reaches `total` | `cursor` |
| `user/liked`, `user/playlists`, `playlist/:id/videos` | `cursor` | `cursor` |
| `search/general`, `search/users` | `cursor`, and `log_pb.impr_id` from page 1 | `offset`, `searchId` |

```js
const secUid = 'MS4wLjABAAAAv7iSuuXDJGDvJkmH_vz1qkDZYo1apxgzaxdBSeIuPiM';
let cursor = '0';
let hasMore = true;
while (hasMore) {
  const url = `http://localhost:3000/tiktok/user/posts?secUid=${secUid}&count=30&cursor=${cursor}`;
  const page = await (await fetch(url)).json();
  for (const item of page.itemList ?? []) console.log(item.id);
  cursor = page.cursor;
  hasMore = page.hasMore;
}
```

## Errors

A 200 response can still be empty. TikTok reports some failures inside the body, so check `statusCode` / `status_code` (`0` means success):

```json
{ "statusCode": 10221, "userInfo": {} }
```

| Code | Meaning |
| --- | --- |
| `10221` | User not found |
| `10204` | Video not found |
| `10222` | Following list is private |
| `10205` | Hashtag not found |

When the request itself fails, you get:

```json
{
  "error": {
    "kind": "BAD_REQUEST",
    "message": "keyword should not be empty",
    "statusCode": 400
  }
}
```

| `kind` | HTTP | What to do |
| --- | --- | --- |
| `BAD_REQUEST` | 400 | Fix the params |
| `UPSTREAM_THROTTLED`, `UPSTREAM_RATE_LIMITED` | 429 | Too many requests. Wait and retry |
| `UPSTREAM_BLOCKED` | 502 | TikTok returned an empty body. Wait, or call `POST /internal/session/reset` |
| `UPSTREAM_*` (other) | 502 / 504 | TikTok error or network issue. Retry later |
| `INTERNAL` | 500 | Bug. Check `pnpm run logs` |

## Configuration

Copy `.env.example` to `.env`, edit it, then run `pnpm run dev` again.

```bash
cp .env.example .env
```

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `3000` | Server port |
| `TIKTOK_MIN_REQUEST_INTERVAL_MS` | `2000` | Minimum gap between requests to TikTok. Raise it if you get throttled |
| `TIKTOK_MAX_CONCURRENT_REQUESTS` | `2` | |
| `TIKTOK_PROXY_URL` | | Optional proxy, e.g. `http://user:pass@host:8080` |
| `LOG_LEVEL` | | Set to `debug` for verbose logs |

## Disclaimer

This project is not affiliated with, endorsed by, or connected to TikTok or ByteDance. "TikTok" is a trademark of its respective owner.

It is provided for educational and research purposes only. Using it may violate TikTok's Terms of Service. You are solely responsible for how you use it, including compliance with TikTok's terms and any applicable laws. The author accepts no liability for any misuse, account restrictions, or damages arising from its use.

Keep request rates low. Do not use it for spam, harassment, or large-scale collection of personal data.

## License

[MIT](LICENSE)
