import type { Track, UnresolvedTrack } from "./Track";

export type Awaitable<T> = T | Promise<T>;

export interface StoredQueue {
  current: Track | null;
  previous: Track[];
  tracks: (Track | UnresolvedTrack)[];
}

export interface QueueStoreManager {
  get: (guildId: string) => Awaitable<StoredQueue | string | undefined | null>;
  set: (guildId: string, value: StoredQueue | string) => Awaitable<void | boolean>;
  delete: (guildId: string) => Awaitable<void | boolean>;
  stringify: (value: StoredQueue | string) => Awaitable<StoredQueue | string>;
  parse: (value: StoredQueue | string | undefined | null) => Awaitable<Partial<StoredQueue>>;
}

export interface QueueChangesWatcher {
  tracksAdd: (
    guildId: string,
    tracks: (Track | UnresolvedTrack)[],
    position: number,
    oldStoredQueue: StoredQueue,
    newStoredQueue: StoredQueue
  ) => void;
  tracksRemoved: (
    guildId: string,
    tracks: (Track | UnresolvedTrack)[],
    position: number | number[] | undefined,
    oldStoredQueue: StoredQueue,
    newStoredQueue: StoredQueue
  ) => void;
  shuffled: (
    guildId: string,
    oldStoredQueue: StoredQueue,
    newStoredQueue: StoredQueue
  ) => void;
}

export interface ManagerQueueOptions {
  maxPreviousTracks?: number;
  queueStore?: QueueStoreManager;
  queueChangesWatcher?: QueueChangesWatcher;
}
