import type { NetDataEvent } from '@songloft/plugin-sdk';
import { SSDP_GROUP } from './protocol';

// All virtual renderers share one multicast listener (the host allows eight UDP sockets).
export class SSDPDiscovery {
  private socket = '';
  private nextId = 0;
  private listeners = new Map<string, (event: NetDataEvent) => void>();

  async open(listener: (event: NetDataEvent) => void): Promise<string> {
    if (!this.socket) {
      const socket = await songloft.net.udpBind({ address: '0.0.0.0:1900', reuseAddress: true });
      try {
        await songloft.net.udpJoinMulticast(socket.socketId, SSDP_GROUP);
        songloft.net.onData(socket.socketId, event => {
          for (const receive of this.listeners.values()) {
            try { receive(event); } catch { /* Ignore malformed discovery packets. */ }
          }
        });
        this.socket = socket.socketId;
      } catch (error) {
        await songloft.net.udpClose(socket.socketId);
        throw error;
      }
    }
    const id = String(++this.nextId);
    this.listeners.set(id, listener);
    return id;
  }

  async send(id: string, data: string, address: string): Promise<void> {
    if (!this.listeners.has(id)) return;
    await songloft.net.udpSend(this.socket, data, address);
  }

  async close(id: string): Promise<void> {
    this.listeners.delete(id);
    if (this.listeners.size || !this.socket) return;
    const socket = this.socket;
    this.socket = '';
    await songloft.net.udpClose(socket);
  }
}
