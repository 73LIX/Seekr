# Treasure Hunt

Live, map-based treasure hunts. Organizers pin checkpoints and write riddles; teams solve a riddle to unlock the next spot on their map, walk there, and prove it with a **photo** (checked by AI) or a **QR code**. First team to the treasure wins. Everything syncs live to the organizer's dashboard.

- **Organizer**: build stages (riddle, accepted answers, map pin, GPS radius, photo or QR proof), print QR codes, start the hunt, watch teams move on a live map, approve borderline photos.
- **Participant**: join with an event code, form a team (max 4, share a team code), solve riddles, use up to 3 hints per team for the whole hunt (AI-written), check in at the spot.
- **No framework, no build step**: Node 22+ (built-in SQLite, HTTP, crypto), plain JS frontend, a small built-in map and QR encoder. The only npm dependency is `sharp` (image resizing / fingerprints).

## Run it

```bash
npm install            # installs sharp
cp .env.example .env   # optional for local use
node server/index.js   # http://localhost:3000
```

Local use needs Ollama running with the model: `ollama pull gemma4:e2b`. Without it set `AI_PROVIDER=off` (photos go to the organizer for approval; hints use organizer-written text).
Phones only allow camera and GPS on **HTTPS** (or localhost) - see Deployment.

## How a hunt flows

1. Organizer signs up (role: organizer), creates a hunt, adds stages. The last stage is the treasure.
2. Participants sign up, enter the **event code**, create a team or join one with its **team code**.
3. Organizer presses **Start**. Each team sees riddle 1.
4. Correct answer -> the checkpoint pulses on the team's map. At the spot they upload a photo (AI compares it with your target photo; 85+ passes by default) or scan the QR code. GPS radius is enforced if you set one.
5. Borderline scores (60-84 by default) or AI outages put the photo in the organizer's **review queue** instead of failing the team.
6. First team to clear the last stage wins and the hunt ends for everyone.

## About the AI (gemma4:e2b)

Ollama lists `gemma4:e2b` with image input, so it can be asked "do these two photos show the same thing?" and to write hints. Honest expectations:

- **Hints**: fine for a 2B-effective model. Every hint is checked server-side so it can't contain the answer; leaks are retried, then replaced by your written fallback hints.
- **Photo matching**: workable for distinctive objects (a plaque, a statue, a door); weaker for generic ones (a tree, a bench) and a self-reported "85%" is not a calibrated probability. This is why the app adds: GPS radius, copy/duplicate detection (clue image or another team's exact photo), a review band instead of hard rejection, and instant fallback to the organizer when the model is slow or down.
- **Before an event**: run a few real photos (right and wrong) at each checkpoint and tune the pass mark per stage (Stage -> "Match score to pass"). Prefer QR for generic locations.
- **Speed**: CPU-only inference can take 20-60 s per photo. Teams see "checking your photo..." meanwhile. One photo is processed at a time (`AI_CONCURRENCY=1`); a GPU box or a bigger `AI_CONCURRENCY` helps with many teams.

## Tests

```bash
npm test               # 97 backend tests: auth, teams, gameplay, cheating, AI adapter, live sync, security, load
npm run test:e2e       # real Chromium plays a full hunt (needs playwright-core + a Chromium; set SHOT_DIR for screenshots)
```

The AI tests run the real Ollama adapter against a stand-in HTTP server (`tests/fake-ollama.js`) that speaks Ollama's API. They prove the plumbing and failure handling, **not** how well gemma4:e2b judges photos - check that on your own hardware.

## Deployment (recommended: one VPS, Docker Compose, Caddy HTTPS)

Why this: the app is a single stateful process (SQLite + live streams) so one machine is simplest and plenty for hundreds of players; Caddy gives automatic HTTPS (required for phone camera/GPS); Ollama runs beside it.

1. Rent a Linux VPS (Ubuntu 24.04; **4 vCPU / 8 GB RAM** minimum for gemma4:e2b on CPU; add a GPU box later if photo checks feel slow) and point a DNS `A` record for your domain at it.
2. Install Docker, then:
   ```bash
   git clone <your repo> treasure-hunt && cd treasure-hunt
   cp .env.example .env     # set DOMAIN, PUBLIC_URL, ORGANIZER_SIGNUP_CODE, TILE_URL
   docker compose up -d --build
   ```
   First start downloads the model (~5-7 GB) via the `ollama-pull` service: `docker compose logs -f ollama-pull`.
3. Open `https://your-domain`. The organizer dashboard shows "AI ready" when the model is reachable.
4. Back up the `hunt_data` volume (database + photos). Update with `git pull && docker compose up -d --build`.

Already have a stronger machine running Ollama (your own PC/GPU)? Set `OLLAMA_URL` in `.env` to it (e.g. over Tailscale) and delete the `ollama` and `ollama-pull` services.

Use a real tile provider key (`TILE_URL`) for events: OpenStreetMap's public tiles are not meant for crowds.

## Known limits

- One server instance (SQLite). Scale up the machine, not out.
- In-app QR scanning uses the browser's `BarcodeDetector` (Chrome/Android). On iPhone or other browsers, players scan with the phone's camera app: the QR is a link that opens the game and checks them in. A typed-code box is always available.
- The organizer UI locks stages while a hunt is live (the API allows wording fixes); use "Reset to setup" to edit.
- No password reset or email; usernames + passwords only.
- Docker files were written but not built in the authoring sandbox (no Docker daemon, restricted network); everything else was run and tested.

## Look and feel (16-bit quest theme)

- Pixel font `public/fonts/pixelquest.ttf` (generated by `python3 scripts/make-font.py`, needs `fonttools`) and the title-screen landscape `public/img/title-scene.svg` (`python3 scripts/make-scene.py`). Both are committed, so you only re-run them if you want to change them.
- Sprites (hero, chest, hearts, camera, QR, trophy...) are drawn from text grids in `public/js/sprites.js`; add your own by adding a grid.
- Sound effects are tiny WebAudio beeps, no audio files. The `SND ON/OFF` button in the top bar mutes them (remembered per browser).
- Players see: a level bar for stages, hearts for the hints left, a compass arrow to the target, and a typewriter riddle. The final stage shows a chest on the map. Reduced-motion settings turn the animations off.

## Scanning QR codes and sending photos from a phone

- The camera needs an **https** address (ngrok gives you one). The scanner uses the browser's own QR detector when it has one (Chrome on Android) and otherwise a built-in decoder (`public/js/qrdecode.js`), so it works on iPhone Safari and Firefox too.
- If the camera is blocked or unavailable, players can **Upload QR picture** (any photo of the code) or type the code. For photo checkpoints there are **Take photo** (opens the camera) and **Upload photo** (opens the gallery).
- Phone camera apps also work: they open the printed link, which signs the team in and checks them in.
