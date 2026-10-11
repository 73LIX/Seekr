'use strict';

/** Server-sent-events hub. Clients are tagged with user, role and event; payloads are small "something changed" notices. */
class Hub {
  constructor() {
    this.clients = new Set();
    this.timer = setInterval(() => {
      for (const c of this.clients) this._write(c, ': ping\n\n');
    }, 15_000);
    this.timer.unref();
  }

  add(res, meta) {
    const client = { res, ...meta };
    this.clients.add(client);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n: connected\n\n');
    const remove = () => this.clients.delete(client);
    res.on('close', remove);
    res.on('error', remove);
    return client;
  }

  _write(client, chunk) {
    try {
      client.res.write(chunk);
    } catch {
      this.clients.delete(client);
    }
  }

  _send(filter, data) {
    const chunk = `data: ${JSON.stringify(data)}\n\n`;
    let n = 0;
    for (const c of this.clients) {
      if (filter(c)) {
        this._write(c, chunk);
        n++;
      }
    }
    return n;
  }

  toOrganizers(eventId, data) {
    return this._send((c) => c.role === 'organizer' && c.eventId === eventId, data);
  }
  toUsers(eventId, userIds, data) {
    const ids = new Set(userIds);
    return this._send((c) => c.role === 'participant' && c.eventId === eventId && ids.has(c.userId), data);
  }
  toEventParticipants(eventId, data) {
    return this._send((c) => c.role === 'participant' && c.eventId === eventId, data);
  }
  count() {
    return this.clients.size;
  }
  closeAll() {
    clearInterval(this.timer);
    for (const c of this.clients) {
      try {
        c.res.end();
      } catch { /* ignore */ }
    }
    this.clients.clear();
  }
}

module.exports = { Hub };
