export type MemoryTargetType = 'play_song' | 'play_playlist';

export interface MemoryRecord {
  id: string;
  normalizedQuery: string;
  type: MemoryTargetType;
  songId?: number;
  songName?: string;
  artist?: string;
  playlistId?: number;
  playlistName?: string;
  songIndex?: number;
  hitCount: number;
  successCount: number;
  failureCount: number;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string;
}

export interface MemoryRecordInput {
  query: string;
  type: MemoryTargetType;
  songId?: number;
  songName?: string;
  artist?: string;
  playlistId?: number;
  playlistName?: string;
  songIndex?: number;
}

export interface MemoryStoreSnapshot {
  version: 1;
  records: MemoryRecord[];
  updatedAt: string;
}

export type MemoryFindResult = MemoryRecord | null;

export interface MemoryStorageAdapter {
  load(): Promise<MemoryStoreSnapshot>;
  save(snapshot: MemoryStoreSnapshot): Promise<boolean>;
}
