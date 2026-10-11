'use strict';
/**
 * A stand-in for Ollama's HTTP API (/api/tags, /api/show, /api/chat) with switchable behaviours,
 * so the real AIService adapter can be exercised end to end without a GPU or a 5 GB model download.
 * It speaks the same JSON shapes Ollama does; it does NOT prove how good gemma4:e2b is at judging photos.
 */
const http = require('node:http');

function createFakeOllama({ model = 'gemma4:e2b', vision = true } = {}) {
  const state = {
    model,
    vision,
    calls: [],            // every /api/chat body, parsed
    scores: [],           // queue of scores for the next photo comparisons
    defaultScore: 92,
    mode: 'ok',           // ok | http500 | garbage | fenced | slow | leak | leak-always | hang | no-score | string-score | fraction
    delayMs: 0,
    inflight: 0,
    maxInflight: 0,
    tagsStatus: 200,
  };

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    const send = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
    };
    if (req.url === '/api/tags') {
      if (state.tagsStatus !== 200) return send(state.tagsStatus, { error: 'nope' });
      return send(200, { models: [{ name: state.model, model: state.model }] });
    }
    if (req.url === '/api/show') return send(200, { capabilities: state.vision ? ['completion', 'vision'] : ['completion'] });
    if (req.url !== '/api/chat') return send(404, { error: 'not found' });

    let body;
    try { body = JSON.parse(raw); } catch { return send(400, { error: 'bad json' }); }
    state.calls.push(body);
    state.inflight++;
    state.maxInflight = Math.max(state.maxInflight, state.inflight);
    try {
      if (state.mode === 'hang') return; // never answer; the client must time out
      if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
      if (state.mode === 'http500') return send(500, { error: 'model crashed' });
      const msg = body.messages && body.messages[0];
      const prompt = (msg && msg.content) || '';
      const imgs = (msg && msg.images) || [];
      let content;
      if (imgs.length >= 2) {
        let score = state.scores.length ? state.scores.shift() : state.defaultScore;
        const same = score >= 50;
        if (state.mode === 'garbage') content = 'I think they look quite similar, maybe.';
        else if (state.mode === 'no-score') content = JSON.stringify({ same_object: true, reason: 'no number given' });
        else if (state.mode === 'string-score') content = JSON.stringify({ same_object: same, match_score: `${score}%`, reason: 'string score' });
        else if (state.mode === 'fraction') content = JSON.stringify({ same_object: same, match_score: score / 100, reason: 'fraction score' });
        else if (state.mode === 'fenced') content = '```json\n' + JSON.stringify({ same_object: same, match_score: score, reason: 'fenced' }) + '\n```';
        else content = JSON.stringify({ same_object: same, match_score: score, reason: 'fake judge' });
      } else {
        const lvl = Number((/Hint strength: (\d)/.exec(prompt) || [])[1] || 1);
        const secret = ((/Secret answer \(NEVER reveal\): (.*)/.exec(prompt) || [])[1] || '').split(' / ')[0];
        const retry = /previous attempt leaked/i.test(prompt);
        if (state.mode === 'garbage') content = 'Sorry, I cannot help with that.';
        else if (state.mode === 'leak-always' || (state.mode === 'leak' && !retry)) content = JSON.stringify({ hint: `It is definitely the ${secret}, level ${lvl}.` });
        else content = JSON.stringify({ hint: `Level ${lvl} nudge: reread the riddle and think about everyday objects.` });
      }
      return send(200, { model: body.model, message: { role: 'assistant', content }, done: true });
    } finally {
      state.inflight--;
    }
  });

  return {
    state,
    server,
    async listen() {
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      this.url = `http://127.0.0.1:${server.address().port}`;
      return this;
    },
    async close() {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    },
  };
}

module.exports = { createFakeOllama };
