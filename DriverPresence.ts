import type { Env } from '../types';

// One instance per driver. Tracks online/offline state and holds the
// driver's live WebSocket connection so the dispatch logic can push new
// delivery requests directly and get accept/decline back in real time.

export class DriverPresence {
  state: DurableObjectState;
  env: Env;
  socket: WebSocket | null = null;
  online = false;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.endsWith('/ws')) {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected WebSocket', { status: 426 });
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();
      this.socket = server;
      this.online = true;

      server.addEventListener('message', (event) => this.handleMessage(event));
      server.addEventListener('close', () => {
        this.online = false;
        this.socket = null;
      });

      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname.endsWith('/offer') && request.method === 'POST') {
      if (!this.online || !this.socket) {
        return Response.json({ delivered: false, reason: 'driver_offline' }, { status: 409 });
      }
      const offer = await request.json();
      this.socket.send(JSON.stringify({ type: 'delivery_offer', offer }));
      return Response.json({ delivered: true });
    }

    return new Response('Not found', { status: 404 });
  }

  private handleMessage(event: MessageEvent) {
    // Driver app sends accept/decline responses here; wire this up to your
    // dispatch/queue logic (e.g. forward to the relevant order's Worker route).
    try {
      const msg = JSON.parse(event.data as string);
      if (msg.type === 'toggle_availability') {
        this.online = Boolean(msg.online);
      }
      // TODO: handle { type: 'offer_response', orderId, accepted }
    } catch {
      // ignore malformed messages
    }
  }
}
