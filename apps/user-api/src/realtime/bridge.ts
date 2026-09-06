import { createRedis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { getIo } from './socket.js';

export const REALTIME_CHANNEL = 'lifeplanner:realtime';

interface BridgeMessage {
  room: string;
  event: string;
  payload: unknown;
}

/** Re-broadcasts events published by admin-api into the right Socket.IO room. */
export function startRealtimeBridge() {
  const sub = createRedis('realtime-bridge');
  void sub.subscribe(REALTIME_CHANNEL, (err) => {
    if (err) logger.error({ err }, 'Failed to subscribe to the realtime channel');
    else logger.debug('Subscribed to the realtime bridge channel');
  });

  sub.on('message', (channel, raw) => {
    if (channel !== REALTIME_CHANNEL) return;
    try {
      const { room, event, payload } = JSON.parse(raw) as BridgeMessage;
      getIo()?.to(room).emit(event, payload);
    } catch (err) {
      logger.warn({ err }, 'Dropped malformed realtime bridge message');
    }
  });

  return sub;
}
