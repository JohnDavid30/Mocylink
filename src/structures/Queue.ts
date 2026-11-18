import type {
  Awaitable,
  ManagerQueueOptions,
  QueueChangesWatcher,
  QueueStoreManager,
  StoredQueue,
  Track,
  UnresolvedQuery,
  UnresolvedTrack,
} from "../types";
import { MiniMap } from "./Utils";

/**
 * Default in-memory QueueStore implementation, swappable with Redis/Prisma/MongoDB adapters.
 */
export class DefaultQueueStore implements QueueStoreManager {
  private data = new MiniMap<string, StoredQueue | string>();

  public get(guildId: string): Awaitable<StoredQueue | string | undefined> {
    return this.data.get(guildId);
  }

  public set(guildId: string, stringifiedQueueData: StoredQueue | string): Awaitable<boolean> {
    this.data.set(guildId, stringifiedQueueData);
    return true;
  }

  public delete(guildId: string): Awaitable<boolean> {
    return this.data.delete(guildId);
  }

  public stringify(unparsedQueueData: StoredQueue | string): Awaitable<StoredQueue | string> {
    if (typeof unparsedQueueData === "string") return unparsedQueueData;
    return JSON.stringify(unparsedQueueData);
  }

  public parse(parsedQueueData: StoredQueue | string | undefined | null): Awaitable<Partial<StoredQueue>> {
    if (!parsedQueueData) {
      return { current: null, previous: [], tracks: [] };
    }
    if (typeof parsedQueueData === "string") {
      return JSON.parse(parsedQueueData) as Partial<StoredQueue>;
    }
    return parsedQueueData;
  }
}

export { DefaultQueueStore as MemoryQueueStore };

/**
 * Persistence helper bound to each guild's `Queue` (`player.queue.utils`).
 */
export class QueueSaver {
  private readonly _queue: Queue;
  private readonly options: {
    maxPreviousTracks: number;
    queueStore: QueueStoreManager;
    queueChangesWatcher?: QueueChangesWatcher;
  };

  constructor(queue: Queue, queueOptions?: ManagerQueueOptions) {
    this._queue = queue;
    this.options = {
      maxPreviousTracks: queueOptions?.maxPreviousTracks ?? 25,
      queueStore: queueOptions?.queueStore ?? new DefaultQueueStore(),
      queueChangesWatcher: queueOptions?.queueChangesWatcher,
    };
  }

  public get maxPreviousTracks(): number {
    return this.options.maxPreviousTracks;
  }

  private snapshot(): StoredQueue {
    return {
      current: this._queue.current,
      previous: [...this._queue.previous].slice(0, this.options.maxPreviousTracks),
      tracks: [...this._queue.tracks],
    };
  }

  public toJSON(): StoredQueue {
    return this.snapshot();
  }

  public async get(): Promise<Partial<StoredQueue>> {
    const raw = await this.options.queueStore.get(this._queue.guildId);
    return await this.options.queueStore.parse(raw);
  }

  public async save(): Promise<void> {
    if (this._queue.previous.length > this.options.maxPreviousTracks) {
      this._queue.previous.splice(
        this.options.maxPreviousTracks,
        this._queue.previous.length - this.options.maxPreviousTracks
      );
    }
    const serialized = await this.options.queueStore.stringify(this.snapshot());
    await this.options.queueStore.set(this._queue.guildId, serialized);
  }

  /**
   * Synchronizes the in-memory Queue with the backing QueueStore (useful across shards/restarts).
   */
  public async sync(override = true, dontSyncCurrent = false): Promise<void> {
    const data = await this.get();
    if (!data) return;

    if (!dontSyncCurrent && (override || !this._queue.current) && data.current !== undefined) {
      this._queue.current = data.current
        ? this._queue.rehydrateTrack(data.current) as Track
        : null;
    }

    if (Array.isArray(data.tracks)) {
      const hydratedTracks = data.tracks.map((t) => this._queue.rehydrateTrack(t));
      if (override) {
        this._queue.tracks.splice(0, this._queue.tracks.length, ...hydratedTracks);
      } else {
        this._queue.tracks.push(...hydratedTracks);
      }
    }

    if (Array.isArray(data.previous)) {
      const hydratedPrev = data.previous
        .map((t) => this._queue.rehydrateTrack(t))
        .filter((t): t is Track => Boolean(t.encoded));
      if (override) {
        this._queue.previous.splice(0, this._queue.previous.length, ...hydratedPrev);
      } else {
        this._queue.previous.push(...hydratedPrev);
      }
    }
  }

  public async destroy(): Promise<void> {
    await this.options.queueStore.delete(this._queue.guildId);
  }

  /**
   * Total duration in milliseconds of upcoming tracks plus current track.
   */
  public totalDuration(): number {
    const currentDuration = this._queue.current?.info.duration ?? 0;
    return this._queue.tracks.reduce(
      (acc, track) => acc + (track.info.duration ?? 0),
      currentDuration
    );
  }
}

export type RemoveTrackInput =
  | number
  | number[]
  | { start: number; end: number }
  | Track
  | UnresolvedTrack
  | ((track: Track | UnresolvedTrack, index: number) => boolean);

/**
 * Per-guild Queue managing current, upcoming, and previous tracks with pluggable persistence.
 */
export class Queue {
  public readonly guildId: string;
  public readonly tracks: (Track | UnresolvedTrack)[] = [];
  public readonly previous: Track[] = [];
  public current: Track | null = null;
  public readonly utils: QueueSaver;
  private readonly queueChangesWatcher?: QueueChangesWatcher;
  private readonly trackRehydrator?: (
    raw: Track | UnresolvedTrack | Partial<Track>
  ) => Track | UnresolvedTrack;

  constructor(
    guildId: string,
    data: Partial<StoredQueue> = {},
    queueOptions?: ManagerQueueOptions,
    trackRehydrator?: (raw: Track | UnresolvedTrack | Partial<Track>) => Track | UnresolvedTrack
  ) {
    this.guildId = guildId;
    this.queueChangesWatcher = queueOptions?.queueChangesWatcher;
    this.trackRehydrator = trackRehydrator;
    this.utils = new QueueSaver(this, queueOptions);

    this.current = data.current ? (this.rehydrateTrack(data.current) as Track) : null;
    if (Array.isArray(data.tracks)) {
      this.tracks.push(...data.tracks.map((t) => this.rehydrateTrack(t)));
    }
    if (Array.isArray(data.previous)) {
      this.previous.push(
        ...(data.previous
          .map((t) => this.rehydrateTrack(t))
          .filter((t): t is Track => Boolean(t.encoded)))
      );
    }
  }

  /**
   * Re-attaches `.resolve()` to deserialized unresolved tracks loaded from external QueueStores.
   */
  public rehydrateTrack(raw: Track | UnresolvedTrack | Partial<Track>): Track | UnresolvedTrack {
    if (this.trackRehydrator) {
      return this.trackRehydrator(raw);
    }
    return raw as Track | UnresolvedTrack;
  }

  /** Number of upcoming tracks in `queue.tracks`. */
  public get size(): number {
    return this.tracks.length;
  }

  /** Number of upcoming tracks plus 1 if `queue.current` is active. */
  public get totalSize(): number {
    return this.tracks.length + (this.current ? 1 : 0);
  }

  /** Total duration in milliseconds of `current` + `tracks`. */
  public get duration(): number {
    return this.utils.totalDuration();
  }

  private cloneSnapshot(): StoredQueue {
    return {
      current: this.current,
      previous: [...this.previous],
      tracks: [...this.tracks],
    };
  }

  /**
   * Adds one or more tracks to the queue (at the end or at a specific index) and persists to the QueueStore.
   */
  public async add(
    trackOrTracks: Track | UnresolvedTrack | Array<Track | UnresolvedTrack>,
    index?: number
  ): Promise<number> {
    const items = (Array.isArray(trackOrTracks) ? trackOrTracks : [trackOrTracks]).filter(Boolean);
    if (!items.length) return this.tracks.length;

    const oldStored = this.cloneSnapshot();
    const insertPos =
      typeof index === "number" && index >= 0 && index <= this.tracks.length
        ? index
        : this.tracks.length;

    this.tracks.splice(insertPos, 0, ...items);

    await this.utils.save();

    this.queueChangesWatcher?.tracksAdd(
      this.guildId,
      items,
      insertPos,
      oldStored,
      this.cloneSnapshot()
    );

    return this.tracks.length;
  }

  /**
   * Splices upcoming tracks in `queue.tracks` and persists changes.
   */
  public async splice(
    index: number,
    amount: number,
    tracks?: Track | UnresolvedTrack | Array<Track | UnresolvedTrack>
  ): Promise<(Track | UnresolvedTrack)[]> {
    const oldStored = this.cloneSnapshot();
    const toInsert = tracks ? (Array.isArray(tracks) ? tracks : [tracks]) : [];

    const removed = this.tracks.splice(index, amount, ...toInsert);

    await this.utils.save();

    if (removed.length > 0) {
      this.queueChangesWatcher?.tracksRemoved(
        this.guildId,
        removed,
        index,
        oldStored,
        this.cloneSnapshot()
      );
    }
    if (toInsert.length > 0) {
      this.queueChangesWatcher?.tracksAdd(
        this.guildId,
        toInsert,
        index,
        oldStored,
        this.cloneSnapshot()
      );
    }

    return removed;
  }

  /**
   * Removes track(s) by index, index array, `{ start, end }` range, Track reference, or predicate.
   */
  public async remove(
    input: RemoveTrackInput
  ): Promise<{ removed: (Track | UnresolvedTrack)[] }> {
    if (!this.tracks.length) return { removed: [] };

    const oldStored = this.cloneSnapshot();
    const removed: (Track | UnresolvedTrack)[] = [];
    let positionInfo: number | number[] | undefined;

    if (typeof input === "number") {
      const idx = input < 0 ? this.tracks.length + input : input;
      if (idx >= 0 && idx < this.tracks.length) {
        removed.push(...this.tracks.splice(idx, 1));
        positionInfo = idx;
      }
    } else if (Array.isArray(input)) {
      const uniqueSortedDesc = [...new Set(input)]
        .filter((i) => i >= 0 && i < this.tracks.length)
        .sort((a, b) => b - a);
      for (const idx of uniqueSortedDesc) {
        removed.unshift(...this.tracks.splice(idx, 1));
      }
      positionInfo = uniqueSortedDesc.reverse();
    } else if (typeof input === "function") {
      const indices: number[] = [];
      for (let i = this.tracks.length - 1; i >= 0; i--) {
        if (input(this.tracks[i], i)) {
          removed.unshift(...this.tracks.splice(i, 1));
          indices.unshift(i);
        }
      }
      positionInfo = indices;
    } else if (typeof input === "object" && input !== null && "start" in input && "end" in input) {
      const start = Math.max(0, Math.min(input.start, input.end));
      const end = Math.min(this.tracks.length - 1, Math.max(input.start, input.end));
      if (start <= end) {
        removed.push(...this.tracks.splice(start, end - start + 1));
        positionInfo = Array.from({ length: end - start + 1 }, (_, k) => start + k);
      }
    } else if (typeof input === "object" && input !== null) {
      const idx = this.tracks.findIndex(
        (t) =>
          t === input ||
          (t.encoded && input.encoded && t.encoded === input.encoded) ||
          (t.info.identifier &&
            input.info.identifier &&
            t.info.identifier === input.info.identifier)
      );
      if (idx !== -1) {
        removed.push(...this.tracks.splice(idx, 1));
        positionInfo = idx;
      }
    }

    if (removed.length > 0) {
      await this.utils.save();
      this.queueChangesWatcher?.tracksRemoved(
        this.guildId,
        removed,
        positionInfo,
        oldStored,
        this.cloneSnapshot()
      );
    }

    return { removed };
  }

  /**
   * Shifts and returns the next track in `queue.tracks` and persists.
   */
  public async shift(): Promise<Track | UnresolvedTrack | undefined> {
    if (!this.tracks.length) return undefined;
    const next = this.tracks.shift();
    await this.utils.save();
    return next;
  }

  /**
   * Pops and returns the most recently played track from `queue.previous`.
   */
  public async shiftPrevious(): Promise<Track | undefined> {
    if (!this.previous.length) return undefined;
    const prev = this.previous.shift();
    await this.utils.save();
    return prev;
  }

  /**
   * Shuffles upcoming tracks in `queue.tracks` using Fisher-Yates shuffle.
   */
  public async shuffle(): Promise<number> {
    if (this.tracks.length <= 1) return this.tracks.length;

    const oldStored = this.cloneSnapshot();
    for (let i = this.tracks.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.tracks[i], this.tracks[j]] = [this.tracks[j], this.tracks[i]];
    }

    await this.utils.save();
    this.queueChangesWatcher?.shuffled(this.guildId, oldStored, this.cloneSnapshot());
    return this.tracks.length;
  }

  /**
   * Empties all upcoming tracks in `queue.tracks` (does not stop `queue.current`).
   */
  public async clear(): Promise<{ removed: (Track | UnresolvedTrack)[] }> {
    if (!this.tracks.length) return { removed: [] };
    const oldStored = this.cloneSnapshot();
    const removed = this.tracks.splice(0, this.tracks.length);

    await this.utils.save();
    this.queueChangesWatcher?.tracksRemoved(
      this.guildId,
      removed,
      0,
      oldStored,
      this.cloneSnapshot()
    );
    return { removed };
  }
}

export { Queue as MocylinkQueue };
export type { UnresolvedQuery };
