import { DebugEvents, DestroyReasons, type DestroyReasonsType } from "../constants";
import type {
  LavalinkEventPayload,
  LavalinkPlayOptions,
  LavaSearchQuery,
  LavaSearchResult,
  LyricsResult,
  PlayerJson,
  PlayerOptions,
  PlayOptions,
  RepeatMode,
  SearchQuery,
  SearchResult,
  SponsorBlockCategory,
  Track,
  UnresolvedTrack,
  VoiceStateChangeOptions,
} from "../types";
import { FilterManager } from "./FilterManager";
import type { MocylinkManager } from "./MocylinkManager";
import { MocylinkNode } from "./MocylinkNode";
import { Queue } from "./Queue";

/**
 * Per-guild audio playback controller for Lavalink v4.
 */
export class Player {
  public readonly LavalinkManager: MocylinkManager;
  public readonly options: PlayerOptions;
  public readonly guildId: string;
  public voiceChannelId: string | null;
  public textChannelId: string | null;
  public selfDeaf: boolean;
  public selfMute: boolean;
  public selfSuppress = false;

  public node: MocylinkNode;
  public readonly queue: Queue;
  public readonly filterManager: FilterManager;

  public volume: number;
  public lavalinkVolume: number;
  public playing = false;
  public paused = false;
  public connected = false;
  public repeatMode: RepeatMode = "off";
  public readonly createdTimeStamp: number;

  public lastPosition = 0;
  public lastPositionChange: number | null = null;

  public ping = {
    ws: -1,
    lavalink: -1,
  };

  public voice: {
    token: string | null;
    endpoint: string | null;
    sessionId: string | null;
    channelId: string | null;
  } = {
    token: null,
    endpoint: null,
    sessionId: null,
    channelId: null,
  };

  /** @internal */
  public _skipAutoAdvanceOnce = false;

  private readonly customDataStore = new Map<string, unknown>();
  private queueEmptyTimeout: ReturnType<typeof setTimeout> | null = null;
  private clientPositionInterval: ReturnType<typeof setInterval> | null = null;
  private errorTimestamps: number[] = [];
  private isDestroying = false;
  private currentTrackStartedAt = 0;

  constructor(options: PlayerOptions, manager: MocylinkManager) {
    this.LavalinkManager = manager;
    this.options = { ...options };
    this.guildId = options.guildId;
    this.voiceChannelId = options.voiceChannelId || null;
    this.textChannelId = options.textChannelId ?? null;
    this.selfDeaf = options.selfDeaf ?? true;
    this.selfMute = options.selfMute ?? false;
    this.createdTimeStamp = Date.now();

    const decrementer = this.LavalinkManager.options.playerOptions?.volumeDecrementer ?? 1;
    this.volume = Math.max(0, Math.min(1000, options.volume ?? 100));
    this.lavalinkVolume = Math.max(0, Math.min(1000, Math.round(this.volume * decrementer)));

    const resolvedNode = options.node
      ? this.LavalinkManager.nodeManager.get(options.node)
      : this.LavalinkManager.nodeManager.findNodeByRegion(options.vcRegion);

    if (!resolvedNode) {
      this.LavalinkManager._debug(DebugEvents.PlayerCreateNodeNotFound, {
        state: "error",
        message: `No connected Lavalink node found while creating player for guild ${this.guildId}`,
        functionLayer: "Player > constructor()",
      });
      // Fall back to first registered node if none connected yet, or throw if pool is empty
      const anyNode = this.LavalinkManager.nodeManager.nodes.first();
      if (!anyNode) {
        throw new RangeError("No Lavalink nodes are available to create a player.");
      }
      this.node = anyNode;
    } else {
      this.node = resolvedNode;
    }

    this.filterManager = new FilterManager(this);

    this.queue = new Queue(
      this.guildId,
      {},
      this.LavalinkManager.options.queueOptions,
      (raw) => {
        if (this.LavalinkManager.utils.isTrack(raw)) {
          return this.LavalinkManager.utils.buildTrack(raw, raw.requester);
        }
        if (this.LavalinkManager.utils.isUnresolvedTrack(raw)) {
          return raw;
        }
        return this.LavalinkManager.utils.buildUnresolvedTrack(
          {
            ...(raw.info || {}),
            title: raw.info?.title || "Unknown Title",
            pluginInfo: raw.pluginInfo,
            userData: raw.userData,
          },
          raw.requester
        );
      }
    );

    if (options.customData) {
      for (const [k, v] of Object.entries(options.customData)) {
        this.customDataStore.set(k, v);
      }
    }

    const posUpdateMs =
      this.LavalinkManager.options.playerOptions?.clientBasedPositionUpdateInterval;
    if (typeof posUpdateMs === "number" && posUpdateMs >= 50) {
      this.clientPositionInterval = setInterval(() => {
        if (this.playing && !this.paused && this.lastPositionChange) {
          this.lastPosition = this.position;
          this.lastPositionChange = Date.now();
        }
      }, posUpdateMs);
      this.clientPositionInterval.unref?.();
    }
  }

  public get manager(): MocylinkManager {
    return this.LavalinkManager;
  }

  /** Convenience alias for `player.filterManager`. */
  public get filters(): FilterManager {
    return this.filterManager;
  }

  /**
   * Estimated current playback position in milliseconds, accounting for elapsed time and timescale speed.
   */
  public get position(): number {
    if (!this.playing || this.paused || !this.lastPositionChange) {
      return this.lastPosition;
    }
    const speed = this.filterManager.data.timescale?.speed ?? 1;
    const rate = this.filterManager.data.timescale?.rate ?? 1;
    const elapsed = (Date.now() - this.lastPositionChange) * speed * rate;
    const estimated = Math.floor(this.lastPosition + elapsed);

    const currentDuration = this.queue.current?.info.duration;
    if (
      currentDuration &&
      currentDuration > 0 &&
      !this.queue.current?.info.isStream
    ) {
      return Math.min(estimated, currentDuration);
    }
    return estimated;
  }

  // ==================== Custom Per-Player Metadata ====================

  public setData<T = unknown>(key: string, value: T): this {
    this.customDataStore.set(key, value);
    return this;
  }

  public getData<T = unknown>(key: string): T | undefined {
    return this.customDataStore.get(key) as T | undefined;
  }

  /** Alias for `setData()` (lavalink-client compatibility). */
  public set<T = unknown>(key: string, value: T): this {
    return this.setData(key, value);
  }

  /** Alias for `getData()` (lavalink-client compatibility). */
  public get<T = unknown>(key: string): T | undefined {
    return this.getData<T>(key);
  }

  // ==================== Voice Connection Control ====================

  /**
   * Dispatches Gateway Op 4 (`VOICE_STATE_UPDATE`) via `sendToShard` to join the configured voice channel.
   */
  public async connect(): Promise<this> {
    if (!this.voiceChannelId) {
      throw new RangeError(
        `Player for guild "${this.guildId}" has no voiceChannelId configured to connect to.`
      );
    }

    this.LavalinkManager._debug(DebugEvents.PlayerConnect, {
      state: "log",
      message: `Joining voice channel ${this.voiceChannelId} in guild ${this.guildId}`,
      functionLayer: "Player > connect()",
    });

    this.LavalinkManager.options.sendToShard(this.guildId, {
      op: 4,
      d: {
        guild_id: this.guildId,
        channel_id: this.voiceChannelId,
        self_mute: this.selfMute,
        self_deaf: this.selfDeaf,
      },
    });

    return this;
  }

  /**
   * Leaves the Discord voice channel (`channel_id: null`).
   */
  public async disconnect(force = false): Promise<this> {
    if (!force && !this.voiceChannelId && !this.connected) {
      return this;
    }

    this.LavalinkManager._debug(DebugEvents.PlayerDisconnect, {
      state: "log",
      message: `Disconnecting player from voice in guild ${this.guildId}`,
      functionLayer: "Player > disconnect()",
    });

    this.LavalinkManager.options.sendToShard(this.guildId, {
      op: 4,
      d: {
        guild_id: this.guildId,
        channel_id: null,
        self_mute: false,
        self_deaf: false,
      },
    });

    this.connected = false;
    this.voiceChannelId = null;
    return this;
  }

  /**
   * Changes the voice channel, mute, or deaf state on the active Discord voice connection.
   */
  public async changeVoiceState(data: VoiceStateChangeOptions): Promise<this> {
    if (data.voiceChannelId !== undefined) this.voiceChannelId = data.voiceChannelId;
    if (typeof data.selfDeaf === "boolean") this.selfDeaf = data.selfDeaf;
    if (typeof data.selfMute === "boolean") this.selfMute = data.selfMute;

    this.LavalinkManager.options.sendToShard(this.guildId, {
      op: 4,
      d: {
        guild_id: this.guildId,
        channel_id: this.voiceChannelId,
        self_mute: this.selfMute,
        self_deaf: this.selfDeaf,
      },
    });

    return this;
  }

  // ==================== Playback Control ====================

  private clearQueueEmptyTimer(emitCancel = true): void {
    if (this.queueEmptyTimeout) {
      clearTimeout(this.queueEmptyTimeout);
      this.queueEmptyTimeout = null;
      this.LavalinkManager._debug(DebugEvents.PlayerPlayQueueEmptyTimeoutClear, {
        state: "log",
        message: `Cleared pending empty-queue destroy timeout for guild ${this.guildId}`,
        functionLayer: "Player > clearQueueEmptyTimer()",
      });
      if (emitCancel) {
        this.LavalinkManager.emit("playerQueueEmptyCancel", this);
      }
    }
  }

  /**
   * Starts playing the next track in the queue, an explicit `clientTrack`, or raw Lavalink track options.
   */
  public async play(options: PlayOptions = {}): Promise<this> {
    if (!this.node.connected || !this.node.sessionId) {
      // Attempt to pick another connected node if the current one went offline
      const backupNode = this.LavalinkManager.nodeManager.findNodeByRegion(this.options.vcRegion);
      if (backupNode) {
        this.node = backupNode;
      } else {
        throw new Error(
          `Cannot play on guild "${this.guildId}": node "${this.node.id}" is not connected.`
        );
      }
    }

    this.clearQueueEmptyTimer(true);

    // Case 1: Explicit low-level `options.track` (`{ encoded, identifier, userData }`)
    if (
      options.track &&
      (options.track.encoded !== undefined || options.track.identifier !== undefined)
    ) {
      const playPayload: LavalinkPlayOptions = {
        track: { ...options.track },
        position: options.position ?? 0,
        paused: options.paused ?? false,
        volume: options.volume ?? this.lavalinkVolume,
      };
      if (options.endTime !== undefined) playPayload.endTime = options.endTime;
      if (options.filters) playPayload.filters = options.filters;
      if (options.voice) playPayload.voice = options.voice;

      const updated = await this.node.updatePlayer({
        guildId: this.guildId,
        noReplace: options.noReplace ?? false,
        playerOptions: playPayload,
      });

      if (updated?.track) {
        this.queue.current = this.LavalinkManager.utils.buildTrack(updated.track);
        await this.queue.utils.save();
      }
      this.playing = Boolean(options.track.encoded || options.track.identifier);
      this.paused = Boolean(options.paused);
      this.lastPosition = options.position ?? 0;
      this.lastPositionChange = Date.now();
      this.currentTrackStartedAt = Date.now();
      return this;
    }

    // Case 2: `options.clientTrack` or shift next item from `this.queue`
    let candidate: Track | UnresolvedTrack | undefined = options.clientTrack;
    if (!candidate) {
      candidate = await this.queue.shift();
    }

    if (!candidate) {
      throw new RangeError(`No track available in the queue to play for guild "${this.guildId}".`);
    }

    // Resolve lazy UnresolvedTrack on demand
    let resolvedTrack: Track | null = null;
    if (this.LavalinkManager.utils.isUnresolvedTrack(candidate)) {
      this.LavalinkManager._debug(DebugEvents.PlayerPlayUnresolvedTrack, {
        state: "log",
        message: `Resolving UnresolvedTrack "${candidate.info.title}" on guild ${this.guildId}`,
        functionLayer: "Player > play()",
      });
      try {
        resolvedTrack = await candidate.resolve(this);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        this.LavalinkManager._debug(DebugEvents.PlayerPlayUnresolvedTrackFailed, {
          state: "error",
          message: `Failed resolving "${candidate.info.title}": ${error.message}`,
          functionLayer: "Player > play()",
        });
        this.LavalinkManager.emit("trackError", this, candidate, { error });

        if (
          this.LavalinkManager.options.autoSkipOnResolveError !== false &&
          this.queue.tracks.length > 0
        ) {
          return await this.play({ ...options, clientTrack: undefined });
        }
        return this;
      }

      if (!resolvedTrack || !resolvedTrack.encoded) {
        const error = new Error(`Could not resolve playable track for "${candidate.info.title}".`);
        this.LavalinkManager.emit("trackError", this, candidate, { error });
        if (
          this.LavalinkManager.options.autoSkipOnResolveError !== false &&
          this.queue.tracks.length > 0
        ) {
          return await this.play({ ...options, clientTrack: undefined });
        }
        return this;
      }
    } else {
      resolvedTrack = candidate;
    }

    if (!resolvedTrack.encoded) {
      throw new Error(`Track "${resolvedTrack.info.title}" is missing an encoded base64 string.`);
    }

    // If replacing an active track via explicit `clientTrack`, archive the previous one
    if (options.clientTrack && this.queue.current && options.noReplace !== true) {
      this.LavalinkManager._debug(DebugEvents.PlayerPlayWithTrackReplace, {
        state: "log",
        message: `Replacing current track "${this.queue.current.info.title}" on guild ${this.guildId}`,
        functionLayer: "Player > play()",
      });
      this.queue.previous.unshift(this.queue.current);
    }

    this.queue.current = resolvedTrack;
    await this.queue.utils.save();

    const applyVolFilter =
      this.options.applyVolumeAsFilter ??
      this.LavalinkManager.options.playerOptions?.applyVolumeAsFilter ??
      false;

    const targetVolume = options.volume ?? this.lavalinkVolume;
    const playPayload: LavalinkPlayOptions = {
      track: {
        encoded: resolvedTrack.encoded,
        userData: resolvedTrack.userData,
      },
      position: options.position ?? 0,
      paused: options.paused ?? false,
    };

    if (options.endTime !== undefined) playPayload.endTime = options.endTime;

    if (applyVolFilter) {
      this.filterManager.data.volume = targetVolume / 100;
      playPayload.filters = {
        ...this.filterManager.toLavalinkFilters(),
        ...(options.filters || {}),
      };
    } else {
      playPayload.volume = targetVolume;
      if (options.filters) {
        playPayload.filters = options.filters;
      }
    }

    if (options.voice) {
      playPayload.voice = options.voice;
    } else if (this.voice.token && this.voice.endpoint && this.voice.sessionId) {
      playPayload.voice = {
        token: this.voice.token,
        endpoint: this.voice.endpoint,
        sessionId: this.voice.sessionId,
        ...(this.voice.channelId ? { channelId: this.voice.channelId } : {}),
      };
    }

    await this.node.updatePlayer({
      guildId: this.guildId,
      noReplace: options.noReplace ?? false,
      playerOptions: playPayload,
    });

    this.playing = true;
    this.paused = Boolean(options.paused);
    this.lastPosition = options.position ?? 0;
    this.lastPositionChange = Date.now();
    this.currentTrackStartedAt = Date.now();

    return this;
  }

  /**
   * Pauses playback on the Lavalink node.
   */
  public async pause(): Promise<this> {
    if (this.paused) {
      throw new Error(`Player for guild "${this.guildId}" is already paused.`);
    }
    this.lastPosition = this.position;
    this.paused = true;
    this.playing = false;
    this.lastPositionChange = null;

    this.LavalinkManager._debug(DebugEvents.PlayerPause, {
      state: "log",
      message: `Paused player in guild ${this.guildId}`,
      functionLayer: "Player > pause()",
    });

    await this.node.updatePlayer({
      guildId: this.guildId,
      playerOptions: { paused: true },
    });

    return this;
  }

  /**
   * Resumes a paused player.
   */
  public async resume(): Promise<this> {
    if (!this.paused) {
      throw new Error(`Player for guild "${this.guildId}" is not paused.`);
    }
    this.paused = false;
    this.playing = Boolean(this.queue.current);
    this.lastPositionChange = Date.now();

    this.LavalinkManager._debug(DebugEvents.PlayerResume, {
      state: "log",
      message: `Resumed player in guild ${this.guildId}`,
      functionLayer: "Player > resume()",
    });

    await this.node.updatePlayer({
      guildId: this.guildId,
      playerOptions: { paused: false },
    });

    return this;
  }

  /**
   * Stops current playback (`track: { encoded: null }`), optionally clearing upcoming tracks.
   */
  public async stopPlaying(clearQueue = true, executeAutoplay = false): Promise<this> {
    this.LavalinkManager._debug(DebugEvents.PlayerStopPlaying, {
      state: "log",
      message: `Stopping playback in guild ${this.guildId} (clearQueue=${clearQueue}, executeAutoplay=${executeAutoplay})`,
      functionLayer: "Player > stopPlaying()",
    });

    if (clearQueue) {
      await this.queue.clear();
    }

    if (!executeAutoplay) {
      this._skipAutoAdvanceOnce = true;
    }

    await this.node.updatePlayer({
      guildId: this.guildId,
      playerOptions: {
        track: { encoded: null },
      },
    });

    this.playing = false;
    this.paused = false;
    this.lastPosition = 0;
    this.lastPositionChange = null;
    return this;
  }

  /**
   * Skips to the next track in the queue (or jumps to index `skipTo` if `skipTo > 0`).
   */
  public async skip(skipTo = 0, throwError = true): Promise<this> {
    if (!this.queue.tracks.length) {
      if (throwError) {
        throw new RangeError(
          `Cannot skip in guild "${this.guildId}": there are no upcoming tracks in the queue.`
        );
      }
      return await this.stopPlaying(false, false);
    }

    if (typeof skipTo === "number" && skipTo > 0) {
      if (skipTo >= this.queue.tracks.length) {
        if (throwError) {
          throw new RangeError(
            `Cannot skip to index ${skipTo}: queue only has ${this.queue.tracks.length} tracks.`
          );
        }
      } else {
        await this.queue.splice(0, skipTo);
      }
    }

    return await this.play({ noReplace: false });
  }

  /**
   * Seeks to a millisecond position within the currently playing track.
   */
  public async seek(position: number): Promise<this> {
    if (!this.queue.current) {
      throw new Error(`Cannot seek in guild "${this.guildId}": no track is currently loaded.`);
    }
    if (typeof position !== "number" || Number.isNaN(position)) {
      throw new RangeError("Seek position must be a valid number in milliseconds.");
    }
    if (!this.queue.current.info.isSeekable || this.queue.current.info.isStream) {
      throw new RangeError("The current track is not seekable or is a live stream.");
    }

    const clamped = Math.max(
      0,
      Math.min(position, this.queue.current.info.duration || position)
    );

    this.LavalinkManager._debug(DebugEvents.PlayerSeek, {
      state: "log",
      message: `Seeking player in guild ${this.guildId} to ${clamped}ms`,
      functionLayer: "Player > seek()",
    });

    await this.node.updatePlayer({
      guildId: this.guildId,
      playerOptions: { position: clamped },
    });

    this.lastPosition = clamped;
    this.lastPositionChange = Date.now();
    return this;
  }

  /**
   * Adjusts player volume (`0` to `1000`), respecting `volumeDecrementer` and `applyVolumeAsFilter`.
   */
  public async setVolume(volume: number, ignoreVolumeDecrementer = false): Promise<this> {
    if (typeof volume !== "number" || Number.isNaN(volume) || volume < 0 || volume > 1000) {
      throw new RangeError("Volume must be a number between 0 and 1000.");
    }

    this.volume = Math.round(volume);
    const decrementer = ignoreVolumeDecrementer
      ? 1
      : (this.LavalinkManager.options.playerOptions?.volumeDecrementer ?? 1);
    this.lavalinkVolume = Math.max(0, Math.min(1000, Math.round(this.volume * decrementer)));

    const applyVolFilter =
      this.options.applyVolumeAsFilter ??
      this.LavalinkManager.options.playerOptions?.applyVolumeAsFilter ??
      false;

    if (applyVolFilter) {
      await this.filterManager.setVolume(this.lavalinkVolume / 100);
    } else {
      await this.node.updatePlayer({
        guildId: this.guildId,
        playerOptions: { volume: this.lavalinkVolume },
      });
    }

    return this;
  }

  /**
   * Sets repeat mode (`"off" | "track" | "queue"`).
   */
  public setRepeatMode(mode: RepeatMode): this {
    if (!["off", "track", "queue"].includes(mode)) {
      throw new RangeError(`Invalid repeat mode "${mode}". Expected "off", "track", or "queue".`);
    }
    this.repeatMode = mode;
    return this;
  }

  /**
   * Seamlessly moves this player (including current track, position, volume, filters, and voice state) to another node.
   */
  public async changeNode(
    newNode: MocylinkNode | string,
    checkSources = true
  ): Promise<MocylinkNode> {
    const target = this.LavalinkManager.nodeManager.get(newNode);
    if (!target) {
      throw new Error(
        `Target node "${typeof newNode === "string" ? newNode : newNode.id}" does not exist.`
      );
    }
    if (!target.connected || !target.sessionId) {
      throw new Error(`Target node "${target.id}" is not connected.`);
    }
    if (target.id === this.node.id) {
      return this.node;
    }

    if (
      checkSources &&
      this.queue.current?.info.sourceName &&
      target.info?.sourceManagers?.length &&
      !target.info.sourceManagers.includes(this.queue.current.info.sourceName)
    ) {
      throw new Error(
        `Target node "${target.id}" does not support source "${this.queue.current.info.sourceName}".`
      );
    }

    const oldNode = this.node;
    const resumePos = this.position;

    this.LavalinkManager._debug(DebugEvents.PlayerChangeNode, {
      state: "log",
      message: `Moving player for guild ${this.guildId} from "${oldNode.id}" to "${target.id}"`,
      functionLayer: "Player > changeNode()",
    });

    if (oldNode.connected && oldNode.sessionId) {
      try {
        await oldNode.destroyPlayer(this.guildId);
      } catch {
        // Ignore cleanup errors on the old node
      }
    }

    this.node = target;

    const payload: LavalinkPlayOptions = {
      volume: this.lavalinkVolume,
      paused: this.paused,
      filters: this.filterManager.toLavalinkFilters(),
    };

    if (this.queue.current?.encoded) {
      payload.track = {
        encoded: this.queue.current.encoded,
        userData: this.queue.current.userData,
      };
      payload.position = resumePos;
    }

    if (this.voice.token && this.voice.endpoint && this.voice.sessionId) {
      payload.voice = {
        token: this.voice.token,
        endpoint: this.voice.endpoint,
        sessionId: this.voice.sessionId,
        ...(this.voice.channelId ? { channelId: this.voice.channelId } : {}),
      };
    }

    await this.node.updatePlayer({
      guildId: this.guildId,
      noReplace: false,
      playerOptions: payload,
    });

    this.LavalinkManager.emit("playerNodeChange", this, oldNode, target);
    return target;
  }

  /** Alias for `changeNode()` (selects ideal fallback node automatically if omitted). */
  public async moveNode(node?: MocylinkNode | string): Promise<MocylinkNode> {
    const target =
      node ??
      this.LavalinkManager.nodeManager.leastUsedNodes().find((n) => n.id !== this.node.id);
    if (!target) {
      throw new Error("No alternative connected Lavalink node is available to move to.");
    }
    return await this.changeNode(target);
  }

  // ==================== Search & Plugin Shortcuts ====================

  public async search<Requester = unknown>(
    query: SearchQuery,
    requestUser?: Requester,
    throwOnEmpty = false
  ): Promise<SearchResult> {
    return await this.node.search(query, requestUser, throwOnEmpty);
  }

  public async lavaSearch<Requester = unknown>(
    query: LavaSearchQuery | string,
    requestUser?: Requester,
    throwOnEmpty = false
  ): Promise<LavaSearchResult> {
    return await this.node.lavaSearch(query, requestUser, throwOnEmpty);
  }

  public async getSponsorBlock(): Promise<SponsorBlockCategory[]> {
    return await this.node.getSponsorBlock(this.guildId);
  }

  public async setSponsorBlock(
    segments: SponsorBlockCategory[] = ["sponsor", "selfpromo"]
  ): Promise<void> {
    await this.node.setSponsorBlock(this.guildId, segments);
  }

  public async deleteSponsorBlock(): Promise<void> {
    await this.node.deleteSponsorBlock(this.guildId);
  }

  public async getCurrentLyrics(skipTrackSource = false): Promise<LyricsResult | null> {
    return await this.node.lyrics.getCurrent(this.guildId, skipTrackSource);
  }

  public async getLyrics(
    track?: Track | UnresolvedTrack | string,
    skipTrackSource = false
  ): Promise<LyricsResult | null> {
    const target = track ?? this.queue.current;
    if (!target) return null;
    return await this.node.lyrics.get(target, skipTrackSource);
  }

  public async subscribeLyrics(skipTrackSource = false): Promise<void> {
    await this.node.lyrics.subscribe(this.guildId, skipTrackSource);
  }

  public async unsubscribeLyrics(): Promise<void> {
    await this.node.lyrics.unsubscribe(this.guildId);
  }

  // ==================== Lifecycle & Teardown ====================

  /**
   * Destroys the player on Lavalink, disconnects from Discord voice, wipes queue store, and emits `playerDestroy`.
   */
  public async destroy(
    reason: DestroyReasonsType = DestroyReasons.Manual,
    disconnect = true
  ): Promise<void> {
    if (this.isDestroying) return;
    this.isDestroying = true;

    this.LavalinkManager._debug(DebugEvents.PlayerDestroying, {
      state: "log",
      message: `Destroying player in guild ${this.guildId} (reason=${reason})`,
      functionLayer: "Player > destroy()",
    });

    this.clearQueueEmptyTimer(false);
    if (this.clientPositionInterval) {
      clearInterval(this.clientPositionInterval);
      this.clientPositionInterval = null;
    }

    if (disconnect) {
      await this.disconnect(true);
    }

    if (this.node.connected && this.node.sessionId) {
      try {
        await this.node.destroyPlayer(this.guildId);
      } catch {
        // Ignore remote destroy failures when tearing down
      }
    }

    await this.queue.utils.destroy();
    this.LavalinkManager.players.delete(this.guildId);

    this.playing = false;
    this.paused = false;
    this.connected = false;

    this.LavalinkManager._debug(DebugEvents.PlayerDestroyed, {
      state: "log",
      message: `Destroyed player in guild ${this.guildId}`,
      functionLayer: "Player > destroy()",
    });

    this.LavalinkManager.emit("playerDestroy", this, reason);
  }

  /** @internal */
  public async _recordTrackErrorAndCheckDestroy(): Promise<boolean> {
    const cfg = this.LavalinkManager.options.playerOptions?.maxErrorsPerTime;
    if (!cfg || cfg.maxAmount <= 0 || cfg.threshold <= 0) return false;

    const now = Date.now();
    this.errorTimestamps = this.errorTimestamps.filter((ts) => now - ts <= cfg.threshold);
    this.errorTimestamps.push(now);

    if (this.errorTimestamps.length >= cfg.maxAmount) {
      await this.destroy(DestroyReasons.TrackErrorMaxReached);
      return true;
    }
    return false;
  }

  /** @internal */
  public async _handleQueueEmpty(
    lastTrack: Track | null,
    payload: Extract<
      LavalinkEventPayload,
      { type: "TrackEndEvent" | "TrackStuckEvent" | "TrackExceptionEvent" }
    >
  ): Promise<void> {
    const emptyOpts = this.LavalinkManager.options.playerOptions?.onEmptyQueue;
    const minAutoPlayMs = this.LavalinkManager.options.playerOptions?.minAutoPlayMs ?? 10_000;
    const playedMs = this.currentTrackStartedAt > 0 ? Date.now() - this.currentTrackStartedAt : minAutoPlayMs;

    if (
      typeof emptyOpts?.autoPlayFunction === "function" &&
      lastTrack &&
      playedMs >= minAutoPlayMs
    ) {
      this.LavalinkManager._debug(DebugEvents.PlayerAutoplay, {
        state: "log",
        message: `Executing autoPlayFunction for guild ${this.guildId}`,
        functionLayer: "Player > _handleQueueEmpty()",
      });
      try {
        await emptyOpts.autoPlayFunction(this, lastTrack);
      } catch (err) {
        this.LavalinkManager.emit("trackError", this, lastTrack, {
          error: err instanceof Error ? err : new Error(String(err)),
        });
      }

      if (this.queue.tracks.length > 0 && !this.playing) {
        await this.play({ noReplace: false });
        return;
      }
      if (this.playing) {
        return;
      }
    }

    this.LavalinkManager.emit("queueEnd", this, lastTrack, payload);

    const destroyAfterMs = emptyOpts?.destroyAfterMs;
    if (typeof destroyAfterMs === "number" && destroyAfterMs >= 0) {
      if (destroyAfterMs === 0) {
        this.LavalinkManager.emit("playerQueueEmptyEnd", this);
        await this.destroy(DestroyReasons.QueueEmpty);
        return;
      }

      this.clearQueueEmptyTimer(false);
      this.LavalinkManager.emit("playerQueueEmptyStart", this, destroyAfterMs);

      this.queueEmptyTimeout = setTimeout(() => {
        this.queueEmptyTimeout = null;
        if (!this.playing && this.queue.tracks.length === 0) {
          this.LavalinkManager.emit("playerQueueEmptyEnd", this);
          void this.destroy(DestroyReasons.QueueEmpty);
        }
      }, destroyAfterMs);
      this.queueEmptyTimeout.unref?.();
    }
  }

  public toJSON(): PlayerJson {
    return {
      guildId: this.guildId,
      options: { ...this.options },
      voiceChannelId: this.voiceChannelId,
      textChannelId: this.textChannelId,
      position: this.position,
      lastPosition: this.lastPosition,
      lastPositionChange: this.lastPositionChange,
      volume: this.volume,
      lavalinkVolume: this.lavalinkVolume,
      repeatMode: this.repeatMode,
      paused: this.paused,
      playing: this.playing,
      connected: this.connected,
      createdTimeStamp: this.createdTimeStamp,
      filters: this.filterManager.toLavalinkFilters(),
      ping: { ...this.ping },
      nodeId: this.node.id,
      nodeSessionId: this.node.sessionId,
      currentTrack: this.queue.current,
    };
  }
}

export { Player as MocylinkPlayer };
