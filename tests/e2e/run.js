'use strict';
/**
 * Browser end-to-end test: drives the real UI with Chromium.
 *   organizer (desktop)  : sign up, build a 3-stage hunt (photo, QR, photo-or-QR), start it, watch live, review
 *   team Red (2 phones)  : form a team, solve riddles, use a hint, fail then pass a photo, scan a code, win
 *   team Blue (1 phone)  : sees the hunt end when Red finds the treasure
 * AI is a fake Ollama server speaking the real HTTP API, so the production adapter is what runs.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { createApp } = require('../../server/app');
const { createFakeOllama } = require('./../fake-ollama');
const { makeImage, LOC, sharp } = require('../helpers');
const images = require('../../server/services/images');

/** what a player's own phone would capture: other angle, crop, tilt - never the clue image itself */
async function realPhoto(buf) {
  const out = await sharp(buf).extract({ left: 60, top: 40, width: 300, height: 230 }).rotate(9, { background: '#777' }).resize(480).jpeg({ quality: 75 }).toBuffer();
  const d = images.hamming((await images.features(buf)).dhash, (await images.features(out)).dhash);
  if (d <= 6) throw new Error('test photo too close to the target (distance ' + d + ')');
  return out;
}

let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('playwright-core')); }

const SHOTS = process.env.SHOT_DIR || path.join(os.tmpdir(), 'th-shots');
fs.mkdirSync(SHOTS, { recursive: true });
const CHROME = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => fs.existsSync(p));
const log = (m) => console.log('  ✓ ' + m);

async function tileServer() {
  const png = await sharp({ create: { width: 256, height: 256, channels: 3, background: '#e9efe2' } })
    .composite([{ input: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><path d="M0 128H256M128 0V256" stroke="#c9d6c0" stroke-width="3"/><rect x="150" y="150" width="70" height="50" fill="#cfe5ee"/><path d="M0 40 Q128 90 256 30" stroke="#f4d98c" stroke-width="8" fill="none"/></svg>') }]).png().toBuffer();
  const srv = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=60' }); res.end(png); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }) };
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hunt-e2e-'));
  const fake = await createFakeOllama().listen();
  const tiles = await tileServer();
  const app = createApp({
    dataDir: dir, dbPath: path.join(dir, 'hunt.db'), rate: { disabled: true },
    tileUrl: `${tiles.url}/{z}/{x}/{y}.png`,
    ai: { provider: 'ollama', ollamaUrl: fake.url, model: 'gemma4:e2b', timeoutMs: 20000 },
  });
  const addr = await app.listen(0, '127.0.0.1');
  const BASE = `http://127.0.0.1:${addr.port}`;
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const errors = [];
  const watch = (page, who) => {
    page.on('pageerror', (e) => errors.push(`${who} pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' && !/favicon|status of 4\d\d/.test(m.text())) errors.push(`${who} console: ${m.text()}`); });
  };
  const newCtx = async (opts = {}) => {
    const ctx = await browser.newContext({ baseURL: BASE, ...opts });
    return ctx;
  };

  // test images
  const target1 = await makeImage(501); const target3 = await makeImage(503);
  const files = {};
  for (const [k, buf] of Object.entries({ target1, target3, photo1: await realPhoto(target1), wrong: await makeImage(999), photo3: await realPhoto(target3) })) {
    files[k] = path.join(dir, k + '.jpg'); fs.writeFileSync(files[k], buf);
  }

  try {
    // ============================================================ organizer builds the hunt
    const octx = await newCtx({ viewport: { width: 1280, height: 900 } });
    const org = await octx.newPage(); watch(org, 'organizer');
    await org.goto('/');
    assert.match(await org.title(), /Treasure Hunt/);
    await org.click('#switch');
    await org.click('button[data-role="organizer"]');
    await org.fill('#username', 'maya.org'); await org.fill('#password', 'secret-pass-1');
    await org.click('#submit');
    await org.waitForURL('**/organizer.html');
    log('organizer signs up and lands on the dashboard');

    await org.fill('#newName', 'Campus Hunt');
    await org.click('text=Create hunt');
    await org.waitForSelector('[data-testid=add-stage]');
    const code = (await org.textContent('[data-testid=event-code]')).trim();
    assert.match(code, /^[A-Z0-9]{6}$/);
    assert.ok(await org.isDisabled('[data-testid=start-btn]'), 'start is blocked on an empty hunt');
    assert.match(await org.textContent('[data-testid=problems]'), /Add at least one stage/);
    log(`hunt created (code ${code}); start is blocked until it is complete`);

    const geo = (i) => ({ lat: (LOC.lat + i * 0.001).toFixed(6), lng: (LOC.lng + i * 0.001).toFixed(6) });
    async function buildStage(i, { title, riddle, answers, place, verify, object, geofence, target, hints }) {
      await org.click('[data-testid=add-stage]');
      await org.waitForFunction((n) => document.querySelectorAll('[data-testid=stage-item]').length === n, i + 1);
      await org.fill('#f-title', title);
      await org.fill('#f-riddle', riddle);
      await org.fill('#f-answers', answers);
      if (hints) await org.fill('#f-hints', hints);
      await org.fill('#f-place', place);
      if (i === 0) {
        // use the map picker once: click the middle of the map and make sure it fills the coordinates
        await org.click('[data-testid=pick-map]', { position: { x: 200, y: 150 } });
        await org.waitForFunction(() => document.querySelector('#f-lat').value !== '');
        log('clicking the map fills latitude and longitude');
      }
      await org.fill('#f-lat', geo(i).lat); await org.fill('#f-lng', geo(i).lng);
      await org.fill('#f-geofence', String(geofence));
      await org.selectOption('#f-verify', verify);
      if (object) await org.fill('#f-object', object);
      if (target) {
        await org.setInputFiles('[data-testid=upload-target]', target);
        await org.waitForFunction(() => document.querySelector('[data-testid=upload-target]') && document.querySelectorAll('img[alt="Target photo preview"]').length > 0 && getComputedStyle(document.querySelector('img[alt="Target photo preview"]')).display !== 'none');
      }
      await org.click('[data-testid=save-stage]');
      await org.waitForSelector('.toast.good:has-text("Stage saved")');
    }
    await buildStage(0, { title: 'Fountain', riddle: 'I run all day but never move. Where am I?', answers: 'fountain\nthe fountain', place: 'Library fountain', verify: 'photo', object: 'the brass plaque on the fountain', geofence: 80, target: files.target1, hints: 'Think water.' });
    await buildStage(1, { title: 'Clock', riddle: 'I have hands but cannot clap.', answers: 'clock', place: 'Clock tower', verify: 'qr', geofence: 120 });
    await buildStage(2, { title: 'Treasure', riddle: 'Where pages sleep in rows, the treasure glows.', answers: 'library', place: 'Old library', verify: 'either', object: 'the red door', geofence: 100, target: files.target3 });
    assert.equal(await org.locator('[data-testid=stage-item]').count(), 3);
    assert.ok(await org.isVisible('[data-testid=qr-preview] svg'), 'QR preview rendered for the QR stage... (stage 3 is selected: either)');
    log('three stages saved (photo, QR, photo-or-QR) with target photos');
    await org.screenshot({ path: path.join(SHOTS, '01-organizer-stage-editor.png'), fullPage: true });
    assert.match(await org.textContent('[data-testid=problems]'), /No teams have joined yet/);

    // ============================================================ players form teams
    const phone = { viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true, permissions: ['geolocation'], geolocation: { latitude: LOC.lat, longitude: LOC.lng, accuracy: 15 } };
    async function signUp(page, username, display) {
      await page.goto('/');
      await page.click('#switch');
      await page.fill('#username', username); await page.fill('#display', display); await page.fill('#password', 'secret-pass-1');
      await page.click('#submit');
      await page.waitForURL('**/play.html');
    }
    const ctxA = await newCtx(phone); const pA = await ctxA.newPage(); watch(pA, 'ana');
    const ctxB = await newCtx(phone); const pB = await ctxB.newPage(); watch(pB, 'ben');
    const ctxC = await newCtx(phone); const pC = await ctxC.newPage(); watch(pC, 'cara');
    await signUp(pA, 'ana', 'Ana'); await signUp(pB, 'ben', 'Ben'); await signUp(pC, 'cara', 'Cara');
    for (const p of [pA, pB, pC]) { await p.fill('#joinCode', code.toLowerCase()); await p.click('text=Join hunt'); await p.waitForSelector('#teamName'); }
    await pA.fill('#teamName', 'Red Foxes'); await pA.click('text=Create team');
    await pA.waitForSelector('[data-testid=team-code]');
    const redCode = (await pA.textContent('[data-testid=team-code]')).trim();
    await pB.fill('#teamCode', redCode); await pB.click('text=Join team');
    await pB.waitForSelector('[data-testid=team-code]');
    await pA.waitForFunction(() => document.body.innerText.includes('Members (2/4)'));
    await pC.fill('#teamName', 'Blue Herons'); await pC.click('text=Create team'); await pC.waitForSelector('[data-testid=team-code]');
    log('Red Foxes (Ana+Ben) and Blue Herons (Cara) formed; Ana sees Ben appear live');
    await pA.screenshot({ path: path.join(SHOTS, '02-team-lobby.png') });

    // team full / bad code UX
    const ctxD = await newCtx(phone); const pD = await ctxD.newPage(); watch(pD, 'dan');
    await signUp(pD, 'dan', 'Dan'); await pD.fill('#joinCode', code); await pD.click('text=Join hunt'); await pD.waitForSelector('#teamCode');
    await pD.fill('#teamCode', 'ZZZZZZ'); await pD.click('text=Join team');
    await pD.waitForSelector('.toast.bad');
    const toastText = await pD.textContent('.toast.bad');
    assert.ok(!/object Object/.test(toastText) && /team|code/i.test(toastText), 'readable error message, got: ' + toastText);
    log('a wrong team code shows an error toast');
    await ctxD.close();

    // ============================================================ organizer starts the hunt
    await org.click('[data-testid=tab-live]');
    await org.waitForSelector('[data-testid=team-row]');
    assert.equal(await org.locator('[data-testid=team-row]').count(), 2);
    await org.waitForFunction(() => !document.querySelector('[data-testid=start-btn]').disabled, null, { timeout: 8000 }).catch(async (e) => {
      throw new Error('Start stayed disabled; problems shown: ' + JSON.stringify(await org.locator('[data-testid=problems]').allTextContents()));
    });
    await org.click('[data-testid=start-btn]');
    await org.waitForSelector('[data-testid=status]:has-text("Live")');
    for (const p of [pA, pB, pC]) await p.waitForSelector('[data-testid=riddle]');
    assert.match(await pA.textContent('[data-testid=riddle]'), /never move/);
    log('hunt starts: every phone shows riddle 1 with no refresh');
    await pA.screenshot({ path: path.join(SHOTS, '03-riddle.png') });

    // ============================================================ stage 1 (Red): wrong answer, hint, right answer, photos
    await pA.fill('#answer', 'a river'); await pA.click('text=Check answer');
    await pA.waitForSelector('[data-testid=flash].bad');
    assert.ok(!(await pA.isVisible('[data-testid=place]')), 'location stays hidden after a wrong answer');
    await pA.click('[data-testid=hint-btn]');            // arm
    await pA.click('[data-testid=hint-btn]');            // confirm
    await pA.waitForSelector('[data-testid=hint]');
    assert.match(await pA.textContent('[data-testid=hint]'), /AI/);
    await pB.waitForSelector('[data-testid=hint]');      // teammate sees the same hint live
    assert.match(await pB.textContent('body'), /2 of 3 hints left/);
    log('wrong answer keeps the map locked; a hint costs 1 of 3 and shows on both phones');
    await pA.fill('#answer', 'The Fountain!'); await pA.click('text=Check answer');
    await pA.waitForSelector('[data-testid=place]');
    assert.equal((await pA.textContent('[data-testid=place]')).trim(), 'Library fountain');
    await pB.waitForSelector('[data-testid=place]');
    await pA.waitForSelector('.tmap .ctl.pulse i');
    assert.match(await pA.textContent('[data-testid=distance]'), /\d+ m away|away/);
    log('right answer (case/punctuation ignored) unlocks the blinking checkpoint on both phones');
    await pA.screenshot({ path: path.join(SHOTS, '04-unlocked-map.png') });

    fake.state.scores.push(38);
    await pA.setInputFiles('[data-testid=photo-input]', files.wrong);
    await pA.waitForSelector('[data-testid=flash].bad');
    assert.match(await pA.textContent('[data-testid=flash]'), /38%|match/i);
    log('a wrong photo scoring 38% is refused with the score shown');
    await pA.waitForTimeout(3300); // per-team photo cooldown
    fake.state.scores.push(93);
    await pA.setInputFiles('[data-testid=photo-input]', files.photo1);
    await pA.waitForSelector('[data-testid=riddle]:has-text("hands but cannot clap")', { timeout: 20000 }).catch(async () => {
      throw new Error('photo 2 not accepted; flash = ' + JSON.stringify(await pA.locator('[data-testid=flash]').allTextContents()));
    });
    log('a matching photo (93%) clears stage 1 and reveals riddle 2');
    const chat = fake.state.calls.filter((c) => (c.messages[0].images || []).length === 2);
    assert.equal(chat.length, 2); assert.equal(chat[0].think, false); assert.equal(chat[0].model, 'gemma4:e2b');
    await pB.waitForSelector('[data-testid=riddle]:has-text("hands but cannot clap")');

    // ============================================================ organizer sees it live
    await org.waitForFunction(() => /Red Foxes[\s\S]*Heading|Solving riddle 2/.test(document.querySelector('[data-testid=teams]').innerText));
    assert.match(await org.textContent('[data-testid=activity]'), /Red Foxes/);
    await org.screenshot({ path: path.join(SHOTS, '05-organizer-live.png'), fullPage: true });
    log('organizer dashboard reflects progress and activity in real time');

    // ============================================================ stage 2 (Red): QR scanner
    await pA.fill('#answer', 'clock'); await pA.click('text=Check answer');
    await pA.waitForSelector('[data-testid=scan-btn]');
    await pA.evaluate(() => { window.__lat = null; });
    await ctxA.setGeolocation({ latitude: LOC.lat + 0.001, longitude: LOC.lng + 0.001, accuracy: 10 });
    const orgToken = await org.evaluate(() => localStorage.getItem('th.token'));
    const stages = (await (await fetch(`${BASE}/api/events/1/dashboard`, { headers: { Authorization: `Bearer ${orgToken}` } })).json()).stages;
    await pA.click('[data-testid=scan-btn]');
    await pA.fill('[data-testid=scan-input]', 'WRONGCODE123'); await pA.click('[data-testid=scan-send]');
    await pA.waitForFunction(() => /belong|wrong|not/i.test(document.querySelector('.scanner .bar').innerText));
    log('a wrong QR code is rejected inside the scanner');
    // a "photo" of the printed QR code, turned and on a grey table, uploaded from the gallery (no camera needed)
    const qrSvg = require('../../server/services/qr.js').toSvg(`${BASE}/play.html#scan=${stages[1].qr_token}`);
    const qrPng = await sharp(Buffer.from(qrSvg)).resize(300, 300).flatten({ background: '#fff' })
      .extend({ top: 60, bottom: 60, left: 60, right: 60, background: '#8a8a8a' }).rotate(17, { background: '#6d6d6d' }).jpeg({ quality: 70 }).toBuffer();
    fs.writeFileSync(path.join(SHOTS, 'qr-photo.jpg'), qrPng);
    await pA.setInputFiles('[data-testid=scan-file]', path.join(SHOTS, 'qr-photo.jpg'));
    await pA.waitForSelector('[data-testid=riddle]:has-text("pages sleep")');
    log('uploading a tilted picture of the QR code clears stage 2 (no camera needed)');

    // ============================================================ stage 3 (Red): QR deep link = phone camera app flow
    await pA.fill('#answer', 'Library'); await pA.click('text=Check answer');
    await pA.waitForSelector('[data-testid=scan-btn]');
    await pA.goto('/play.html#scan=' + stages[2].qr_token);   // still standing at stage 2: too far away
    await pA.waitForSelector('[data-testid=flash]', { timeout: 15000 }).catch(async () => { throw new Error('no flash; page text: ' + (await pA.innerText('body')).slice(0, 400)); });
    log('scanning the right code from 150 m away is refused (GPS check-in radius)');
    await ctxA.setGeolocation({ latitude: LOC.lat + 0.002, longitude: LOC.lng + 0.002, accuracy: 10 });
    await pA.waitForTimeout(800);
    await pA.goto('/play.html#scan=' + stages[2].qr_token);
    await pA.waitForFunction(() => document.body.innerText.includes('Your team found the treasure'), null, { timeout: 15000 });
    log('opening the printed QR link in the browser checks the team in and wins the hunt');
    await pA.screenshot({ path: path.join(SHOTS, '06-winner.png') });

    // ============================================================ everyone else is told
    await pC.waitForFunction(() => document.body.innerText.includes('found the treasure first'), null, { timeout: 15000 });
    assert.match(await pC.textContent('body'), /Red Foxes found the treasure first/);
    await pB.waitForFunction(() => document.body.innerText.includes('Your team found the treasure'), null, { timeout: 15000 });
    await org.waitForSelector('[data-testid=status]:has-text("Ended")');
    await org.waitForFunction(() => document.querySelector('.pill') && document.body.innerText.includes('Red Foxes'));
    log('Blue Herons and the organizer see the hunt end the instant Red wins');
    await pC.screenshot({ path: path.join(SHOTS, '07-loser-view.png') });

    assert.deepEqual(errors, [], 'no JavaScript errors in any browser:\n' + errors.join('\n'));
    log('no JavaScript or console errors on any page');
    console.log(`\nE2E PASSED - screenshots in ${SHOTS}`);
  } finally {
    await browser.close();
    await app.close(); await fake.close(); await tiles.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error('\nE2E FAILED\n', e); process.exit(1); });
