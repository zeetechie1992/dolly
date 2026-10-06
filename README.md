# Dolly

Record your screen and camera, polish the video like Screen Studio, and get captions and an AI summary. It works like Loom.

**Record → Edit (orientation, background, zooms) → Captions → Summary → Export or Share**

## Run it

You only need the Python 3 that ships with macOS. There is no npm install and no build step.

```bash
python3 server.py
```

Open **http://localhost:8000** in **Chrome** (or Edge or Arc). Recording relies on Chrome's screen capture, live speech recognition and Picture-in-Picture APIs.

### AI summaries (optional)

Without an API key, Dolly writes a basic summary on your machine. To get Claude-written summaries (title, TL;DR, key points, action items and chapters):

```bash
python3 -m pip install --user anthropic
```

```bash
ANTHROPIC_API_KEY=sk-ant-... python3 server.py
```

The model defaults to `claude-opus-5-5`. To use a different one, set `DOLLY_MODEL`.

### Settings

All settings are optional environment variables:

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `8000` | The port to listen on. |
| `DOLLY_HOST` | `127.0.0.1` | The address to listen on. `0.0.0.0` makes Dolly reachable from your network (and inside Docker). |
| `DOLLY_DATA_DIR` | `data/` next to `server.py` | Where share links are stored: videos, posters, comments and the key that signs password access. |
| `DOLLY_PUBLIC_URL` | — | The address used in share links, for example `https://dolly.example.com`. Without it, links use the address you opened Dolly with. |
| `DOLLY_SHARE_KEY` | — | A secret (at least 16 characters, for example from `openssl rand -hex 24`) that lets other devices create share links. Once it is set, every browser must enter it to create links, including the one on the computer running Dolly. Without it, only the computer running Dolly can create them. |
| `DOLLY_TRUST_PROXY` | on inside a container, off otherwise | Whether to believe the `X-Forwarded-For` header from a proxy on a private network address (used to tell visitors apart for rate limits). Set it to `1` when Dolly runs directly on a machine behind a reverse proxy on another host of your network. Set it to `0` when a Docker container is reachable straight from your network (for example Docker Desktop on a laptop) with no proxy in front. A proxy on the same machine (`127.0.0.1`) is always believed. |
| `DOLLY_MAX_UPLOAD_MB` | `4096` | The largest video a share link can hold. |
| `ANTHROPIC_API_KEY` | — | Turns on AI summaries. |
| `DOLLY_MODEL` | `claude-opus-5-5` | The model used for AI summaries. |

When the server starts, it prints the address where share links will work, or tells you they're local-only.

## Features

- **Recording:** screen and camera, screen only, or camera only. Includes a mic level meter, optional system audio, a 3-2-1 countdown, pause/resume/restart, and floating Picture-in-Picture controls. A live transcript is captured while you talk, and it drives the captions and the summary.
- **Editor:**
  - Orientations: 16:9, 9:16, 1:1 and 4:5.
  - Fit or fill layout.
  - Mesh-gradient, solid or blurred backgrounds.
  - Padding, rounded corners, shadow, and a macOS window frame.
  - Camera bubble that you can drag, with shape, size and mirror options.
  - Trim.
  - Zooms: add them by hand (press `Z`) or with **Auto zoom**, which uses motion analysis. Pick the zoom focus on a mini-map.
  - Undo and redo.
  - Keyboard shortcuts (press `?` to see them).
- **Captions:** six styles (Minimal, Clean, Bold, Karaoke, Subtitle, Glass). You can edit the transcript and download an .srt file.
- **Summary:** AI or basic. Chapters are clickable, and you can copy the summary as Markdown.
- **Export:** MP4 or WebM at 720p, 1080p or 4K, with optional burned-in captions.
- **Share links:** one click creates a link people can watch in the browser, with the summary, a searchable transcript, styled captions, comments and reactions. Update the video without changing the link, add a password, allow downloads, or embed the player. See "Sharing publicly" below.
- **Storage:** your recordings stay in your browser (IndexedDB). A share link stores only the rendered video and what you chose to share on the Dolly server.

## Sharing publicly

Click **Share** in the editor and Dolly creates a link right away, then renders and uploads the edited video in the background. Viewers watch at `/s/<id>`, and `/embed/<id>` is a player you can put in an iframe. You can update the video without changing the link, turn downloads, the summary, the transcript and comments on or off, add a password, or delete the link.

The links are served by the same `server.py` and stored in `DOLLY_DATA_DIR`. Your original recordings stay in your browser; the server keeps only the rendered video, its poster, the text you chose to share, comments and view counts. Who can open a link depends on where that server is reachable:

| How you run Dolly | Who can open your links |
|---|---|
| `python3 server.py` (the default) | Only you, on this computer. Dolly tells you that links are local-only. |
| `DOLLY_HOST=0.0.0.0 python3 server.py` | Anyone on the same Wi-Fi or office network. Links use your computer's network address, such as `http://192.168.1.20:8000/s/…`. |
| On a server with HTTPS (see Docker below) | Anyone with the link, anywhere. |

### On your network

```bash
DOLLY_HOST=0.0.0.0 python3 server.py
```

Keep recording and editing at http://localhost:8000 on this computer. Other devices can watch your links, but they can't create links unless you also set `DOLLY_SHARE_KEY` (and once it is set, this computer asks for the key too). Recording from another device's browser needs HTTPS (see below).

### Deploy on Railway (easiest)

Railway builds the included `Dockerfile` straight from your GitHub repository and serves it over HTTPS. The `railway.json` file sets up the build and the health check for you.

1. Push this folder to a GitHub repository.
2. Sign in at [railway.com](https://railway.com) with GitHub. Click **New Project → Deploy from GitHub repo**, then pick the repository.
3. Add storage: right-click the service (or use the command palette, ⌘K) and choose **Add Volume**. Set the mount path to **`/data`**. Videos and comments live there and survive redeploys.
4. Get a URL: open the service's **Settings → Networking** and click **Generate Domain**. You'll get something like `https://dolly-production.up.railway.app`.
5. Open the **Variables** tab and add:

   | Variable | Value |
   |---|---|
   | `DOLLY_PUBLIC_URL` | the domain from step 4, including `https://` |
   | `DOLLY_SHARE_KEY` | a long random secret; run `openssl rand -hex 24` in Terminal and paste the result |
   | `DOLLY_TRUST_PROXY` | `1` (Railway's proxy passes on each visitor's address, which rate limits need) |

   Saving the variables redeploys the service.
6. Open your domain. Anyone can record, edit and export, all in their own browser. Creating share links asks for your `DOLLY_SHARE_KEY` once per browser, so only you, and the people you give the key to, can publish videos on your server. Anyone with a link can watch it.

Railway charges about $5 a month for a small service with a volume. Leave `ANTHROPIC_API_KEY` unset unless you're fine with visitors running summaries on your key (see "Good to know" below).

### Deploy with Docker

Any host that runs a container with a persistent volume and HTTPS works, such as Render, Fly.io, Railway, or your own VPS.

```bash
docker build -t dolly .
docker run -d --name dolly --restart unless-stopped \
  -p 127.0.0.1:8000:8000 -v dolly-data:/data \
  -e DOLLY_PUBLIC_URL=https://dolly.example.com \
  -e DOLLY_SHARE_KEY=paste-a-long-random-secret-here \
  dolly
```

Generate the share key once (for example with `openssl rand -hex 24`) and keep it somewhere safe; you'll type it into Dolly.

- **Mount a volume at `/data`.** Videos, comments and the signing key live there. Without a volume, every link breaks when the container is replaced.
- **Set `DOLLY_PUBLIC_URL`** to the `https://` address people will use, so generated links point there.
- **Set `DOLLY_SHARE_KEY`.** The first time you share from a browser, Dolly asks for this key (every browser, even one on the server itself). Without it, nobody can create links on a public server (watching still works). Keep it secret, like a password. Dolly ignores keys shorter than 16 characters and the placeholder above, and slows down wrong guesses.
- **Serve it over HTTPS.** Browsers only allow screen and camera recording on `https://` pages or `localhost`, and links should be encrypted anyway.
  - **Render, Fly.io, Railway:** they handle HTTPS for you. Attach a disk or volume at `/data` and point the service at port `8000`.
  - **Your own VPS:** run the container as above (bound to `127.0.0.1`) and put [Caddy](https://caddyserver.com) in front. Caddy gets the certificate automatically. A complete `Caddyfile`:

    ```
    dolly.example.com {
        reverse_proxy 127.0.0.1:8000
    }
    ```
- **Proxy limits:** Dolly uploads in 8 MB pieces, so any proxy in front must accept request bodies of at least 16 MB. The total size per video is capped by `DOLLY_MAX_UPLOAD_MB`.
- **Proxy headers:** a reverse proxy on the same machine must pass on the visitor's address and the original host name, or every visitor looks like the computer running Dolly. Caddy does this by default. For nginx, add `proxy_set_header Host $host;` and `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` next to `proxy_pass`. Set `DOLLY_SHARE_KEY` on any server other people can reach.

For a quick share without a server, you can expose your local Dolly through a tunnel (Cloudflare Tunnel, ngrok or Tailscale Funnel). Set `DOLLY_PUBLIC_URL` to the tunnel's `https://` address and keep using http://localhost:8000 yourself. If the tunnel forwards raw connections without an `X-Forwarded-For` header (for example `ssh -R`), also set `DOLLY_SHARE_KEY`, because visitors would otherwise look like this computer.

Good to know:

- Link ids are random and can't be guessed, but anyone who has a link can watch it. Add a password in the Share dialog for anything sensitive.
- If you set `ANTHROPIC_API_KEY` on a public server, anyone who can reach that server can request summaries billed to your key. Leave it unset there, or keep the server private.
- Server tests: `python3 tools/test_sharing.py`

## Develop

```bash
python3 tools/check.py
```

This syntax-checks every module with macOS JavaScriptCore and verifies imports. See `ARCHITECTURE.md` for the module contracts.
