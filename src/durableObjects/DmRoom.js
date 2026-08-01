export class DmRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = [];
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/broadcast') {
      const message = await request.text();
      for (const session of this.sessions) {
        try {
          session.send(message);
        } catch (err) {
          // Connection dead, cleaned up on its own 'close' event
        }
      }
      return new Response('ok', { status: 200 });
    }

    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader !== 'websocket') {
      return new Response('Expected websocket', { status: 400 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    server.accept();
    this.sessions.push(server);

    server.addEventListener('message', async (msg) => {
      for (const session of this.sessions) {
        if (session !== server) {
          try {
            session.send(msg.data);
          } catch (err) {
            // Connection dead, will get cleaned up below
          }
        }
      }
    });

    server.addEventListener('close', () => {
      this.sessions = this.sessions.filter(s => s !== server);
    });

    return new Response(null, { status: 101, webSocket: client });
  }
}
