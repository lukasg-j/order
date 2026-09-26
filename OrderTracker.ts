import type { Env } from '../types';

// One instance per active order. Holds the live WebSocket connections for
// whoever is watching this order (member app, shop dashboard, driver app)
// and broadcasts status changes / GPS pings to all of them. This state is
// intentionally NOT in D1 — it's ephemeral and high-frequency.

interface OrderState {
  status: string;
  driverLocation?: { lat: number; lng: number; heading?: number; updatedAt: number };
}

export class OrderTracker {
  state: DurableObjectState;
  env: Env;
  sockets: Set<WebSocket> = new Set();
  orderState: OrderState = { status: 'placed' };

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.endsWith('/ws')) {
      return this.handleWebSocketUpgrade(request);
    }

    if (url.pathname.endsWith('/status') && request.method === 'POST') {
      const body = await request.json<{ status: string }>();
      this.orderState.status = body.status;
      await this.state.storage.put('orderState', this.orderState);
      this.broadcast({ type: 'status_update', status: body.status });
      return Response.json({ ok: true });
    }

    if (url.pathname.endsWith('/location') && request.method === 'POST') {
      const body = await request.json<{ lat: number; lng: number; heading?: number }>();
      this.orderState.driverLocation = { ...body, updatedAt: Date.now() };
      // Deliberately not persisted to storage on every ping — GPS pings are
      // frequent and low-value historically; only the latest matters.
      this.broadcast({ type: 'driver_location', ...this.orderState.driverLocation });
      return Response.json({ ok: true });
    }

    return new Response('Not found', { status: 404 });
  }

  private handleWebSocketUpgrade(request: Request): Response {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    server.accept();
    this.sockets.add(server);

    // Send current state immediately on connect
    server.send(JSON.stringify({ type: 'snapshot', ...this.orderState }));

    server.addEventListener('close', () => this.sockets.delete(server));
    server.addEventListener('error', () => this.sockets.delete(server));

    return new Response(null, { status: 101, webSocket: client });
  }

  private broadcast(message: unknown) {
    const payload = JSON.stringify(message);
    for (const socket of this.sockets) {
      try {
        socket.send(payload);
      } catch {
        this.sockets.delete(socket);
      }
    }
  }
}
