import { pubClient } from './redis.js';

export const REALTIME_CHANNEL = 'lifeplanner:realtime';

/**
 * admin-api does not run its own Socket.IO server. It publishes onto a Redis
 * channel that user-api subscribes to and re-broadcasts, so an admin reply
 * reaches the user's browser in real time. As on the user side, the message is
 * already persisted by the REST handler — this is broadcast only.
 */
export const publishRealtime = async (room: string, event: string, payload: unknown) => {
  await pubClient.publish(REALTIME_CHANNEL, JSON.stringify({ room, event, payload }));
};

export const conversationRoom = (id: string) => `conversation:${id}`;
export const userRoom = (id: string) => `user:${id}`;
