import WebSocket from "ws";
import { DebugEvents, DestroyReasons } from "../constants";
import type {
  LavalinkEventPayload,
  LavalinkInfo,
  LavalinkPlayerObject,
  LavalinkTrack,
  LavalinkWSMessage,
  LavaSearchQuery,
  LavaSearchResult,
  LyricsResult,
  MocylinkNodeOptions,
  NodeStats,
  RawLavalinkLoadResult,
  RoutePlannerStatus,
  SearchQuery,
  SearchResult,
  SponsorBlockCategory,
  Track,
  UnresolvedTrack,
  UpdatePlayerInfo,
} from "../types";
import type { NodeManager } from "./NodeManager";
import type { Player } from "./Player";

const CLIENT_VERSION = "2.0.0";

/**
 * Represents a single Lavalink v4 server connection handling `/v4/websocket` events and `/v4/...` REST calls.
 */
export class MocylinkNode {
  public readonly NodeManager: NodeManager;
  public readonly options: Required<
    Pick<
      MocylinkNodeOptions,
      | "id"
      | "host"
      | "port"
      | "authorization"
      | "secure"
      | "regions"
      | "retryAmount"
      | "retryDelay"
      | "requestSignalTimeoutMS"
      | "closeOnError"
      | "heartBeatInterval"
    >
  > &
    MocylinkNodeOptions;

  public sessionId: string | null = null;
  public resuming: { enabled: boolean; timeoutSeconds: number };
  public info: LavalinkInfo | null = null;
  public version = "v4";
  public calls = 0;
  public stats: NodeStats = {
    players: 0,
    playingPlayers: 0,
    uptime: 0,
    memory: {
      free: 0,
      used: 0,
      allocated: 0,
      reservable: 0,
    },
    cpu: {
      cores: 0,
      systemLoad: 0,
      lavalinkLoad: 0,
    },
    frameStats: null,
  };

  public heartBeatPing = -1;
  public ws: WebSocket | null = null;

  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private heartBeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastPingTimestamp = 0;
  private isDestroying = false;

  /**
   * Track decoding helpers (`/v4/decodetrack` and `/v4/decodetracks`).
   */
  public readonly decode = {
    singleTrack: async <Requester = unknown>(
      encoded: string,
      requester?: Requester
    ): Promise<Track<Requester>> => {
      if (!encoded) throw new RangeError("Encoded track string is required.");
      const raw = await this.request<LavalinkTrack>(
        `/decodetrack?encodedTrack=${encodeURIComponent(encoded)}`
      );
      return this.NodeManager.LavalinkManager.utils.buildTrack(raw, requester);
    },
    multipleTracks: async <Requester = unknown>(
      encodeds: string[],
      requester?: Requester
    ): Promise<Track<Requester>[]> => {
      if (!Array.isArray(encodeds) || !encodeds.length) return [];
      const rawTracks = await this.request<LavalinkTrack[]>(`/decodetracks`, (req) => {
        req.method = "POST";
        req.body = JSON.stringify(encodeds);
      });
      return (rawTracks || []).map((t) =>
        this.NodeManager.LavalinkManager.utils.buildTrack(t, requester)
      );
    },
  };

  /**
   * LavaLyrics v4 plugin helpers (`/v4/lyrics` and session-scoped player lyrics endpoints).
   */
  public readonly lyrics = {
    get: async (
      track: Track | UnresolvedTrack | string,
      skipTrackSource = false
    ): Promise<LyricsResult | null> => {
      const encoded = typeof track === "string" ? track : track.encoded;
      if (!encoded) {
        throw new RangeError("Lyrics lookup requires a resolved track with an `encoded` string.");
      }
      return await this.request<LyricsResult | null>(
        `/lyrics?encodedTrack=${encodeURIComponent(encoded)}&skipTrackSource=${Boolean(skipTrackSource)}`
      );
    },
    getCurrent: async (guildId: string, skipTrackSource = false): Promise<LyricsResult | null> => {
      const sessionId = this.requireSessionId();
      return await this.request<LyricsResult | null>(
        `/sessions/${encodeURIComponent(sessionId)}/players/${encodeURIComponent(guildId)}/track/lyrics?skipTrackSource=${Boolean(skipTrackSource)}`
      );
    },
    subscribe: async (guildId: string, skipTrackSource = false): Promise<void> => {
      const sessionId = this.requireSessionId();
      await this.request<void>(
        `/sessions/${encodeURIComponent(sessionId)}/players/${encodeURIComponent(guildId)}/lyrics/subscribe?skipTrackSource=${Boolean(skipTrackSource)}`,
        (req) => {
          req.method = "POST";
        }
      );
    },
    unsubscribe: async (guildId: string): Promise<void> => {
      const sessionId = this.requireSessionId();
      await this.request<void>(
        `/sessions/${encodeURIComponent(sessionId)}/players/${encodeURIComponent(guildId)}/lyrics/subscribe`,
        (req) => {
          req.method = "DELETE";
        }
      );
    },
  };

  /**
   * Lavalink v4 RoutePlanner IP rotation management helpers.
   */
  public readonly routePlanner = {
    getStatus: async (): Promise<RoutePlannerStatus> => {
      return await this.request<RoutePlannerStatus>(`/routeplanner/status`);
    },
    unmarkFailedAddress: async (address: string): Promise<void> => {
      await this.request<void>(`/routeplanner/free/address`, (req) => {
        req.method = "POST";
        req.body = JSON.stringify({ address });
      });
    },
    unmarkAllFailedAddresses: async (): Promise<void> => {
      await this.request<void>(`/routeplanner/free/all`, (req) => {
        req.method = "POST";
      });
    },
  };

  constructor(options: MocylinkNodeOptions, manager: NodeManager) {
    this.NodeManager = manager;
    const port = options.port ?? 2333;
    const authorization = options.authorization ?? options.password ?? "youshallnotpass";
    const id = options.id ?? options.name ?? `${options.host}:${port}`;

    this.options = {
      ...options,
      id,
      host: options.host,
      port,
      authorization,
      secure: Boolean(options.secure),
      regions: options.regions ?? [],
      retryAmount: options.retryAmount ?? 5,
      retryDelay: options.retryDelay ?? 10_000,
      requestSignalTimeoutMS: options.requestSignalTimeoutMS ?? 10_000,
      closeOnError: options.closeOnError ?? false,
      heartBeatInterval: options.heartBeatInterval ?? 30_000,
    };

    this.sessionId = options.sessionId ?? null;
    this.resuming = {
      enabled: options.resuming?.enabled ?? true,
      timeoutSeconds: options.resuming?.timeoutSeconds ?? 60,
    };
  }

  public get id(): string {
    return this.options.id;
  }

  public get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  public get isAlive(): boolean {
    return this.connected;
  }

  public get restAddress(): string {
    return `http${this.options.secure ? "s" : ""}://${this.options.host}:${this.options.port}`;
  }

  public get wsAddress(): string {
    return `ws${this.options.secure ? "s" : ""}://${this.options.host}:${this.options.port}/v4/websocket`;
  }

  /**
   * Computes a load-balancing penalty score based on players, CPU load, and audio frame deficits.
   */
  public get penalties(): number {
    if (!this.connected) return Number.MAX_SAFE_INTEGER;
    let score = 0;
    score += this.stats.players;
    if (this.stats.cpu?.systemLoad) {
      score += Math.round(Math.pow(1.05, 100 * this.stats.cpu.systemLoad) * 10 - 10);
    }
    if (this.stats.frameStats) {
      score += this.stats.frameStats.deficit;
      score += this.stats.frameStats.nulled * 2;
    }
    return score;
  }

  private requireSessionId(): string {
    if (!this.sessionId) {
      throw new Error(`Node "${this.id}" does not have an active Lavalink v4 sessionId yet.`);
    }
    return this.sessionId;
  }

  /**
   * Executes a Lavalink REST request (automatically prefixed with `/v4` unless `rawPath` is set).
   */
  public async request<T = unknown>(
    endpoint: string,
    modify?: (init: RequestInit & { headers: Record<string, string> }) => void,
    rawPath = false
  ): Promise<T> {
    this.calls++;
    const normalizedEndpoint = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
    const url = `${this.restAddress}${rawPath ? "" : "/v4"}${normalizedEndpoint}`;

    const init: RequestInit & { headers: Record<string, string> } = {
      method: "GET",
      headers: {
        Authorization: this.options.authorization,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(this.options.requestSignalTimeoutMS),
    };

    if (modify) modify(init);
    if (init.method === "GET" || init.method === "DELETE") {
      if (!init.body) {
        delete init.headers["Content-Type"];
      }
    }

    const res = await fetch(url, init);

    if (res.status === 204) {
      return undefined as T;
    }

    const contentType = res.headers.get("content-type") || "";
    if (!res.ok) {
      let errDetail = `${res.status} ${res.statusText}`;
      try {
        if (contentType.includes("application/json")) {
          const errJson = (await res.json()) as { message?: string; error?: string };
          errDetail = errJson.message || errJson.error || JSON.stringify(errJson);
        } else {
          errDetail = (await res.text()) || errDetail;
        }
      } catch {
        // Ignore body parse errors on error responses
      }
      throw new Error(`[Mocylink REST Error] ${init.method} ${url} failed (${res.status}): ${errDetail}`);
    }

    if (contentType.includes("application/json")) {
      return (await res.json()) as T;
    }
    return (await res.text()) as unknown as T;
  }

  /**
   * Connects to the Lavalink v4 `/v4/websocket` endpoint.
   */
  public connect(sessionId?: string): void {
    if (this.connected || (this.ws && this.ws.readyState === WebSocket.CONNECTING)) return;

    const clientId = this.NodeManager.LavalinkManager.options.client?.id;
    if (!clientId) {
      throw new Error(
        `Cannot connect node "${this.id}" before client.id is configured (call manager.init({ id }) first).`
      );
    }

    this.isDestroying = false;
    if (sessionId) this.sessionId = sessionId;

    const clientUsername = this.NodeManager.LavalinkManager.options.client?.username;
    const clientNameHeader = clientUsername
      ? `Mocylink/${CLIENT_VERSION} (${clientUsername})`
      : `Mocylink/${CLIENT_VERSION}`;

    const headers: Record<string, string> = {
      Authorization: this.options.authorization,
      "User-Id": clientId,
      "Client-Name": clientNameHeader,
    };

    if (this.sessionId) {
      headers["Session-Id"] = this.sessionId;
    }

    if (this.ws) {
      this.ws.removeAllListeners();
      try {
        this.ws.close();
      } catch {
        // Ignore close error on stale socket
      }
      this.ws = null;
    }

    this.ws = new WebSocket(this.wsAddress, { headers });
    this.ws.on("open", () => this.onOpen());
    this.ws.on("message", (data) => void this.onMessage(data));
    this.ws.on("error", (err) => this.onError(err));
    this.ws.on("close", (code, reason) => this.onClose(code, reason));
    this.ws.on("pong", () => {
      if (this.lastPingTimestamp > 0) {
        this.heartBeatPing = Date.now() - this.lastPingTimestamp;
      }
    });
  }

  /**
   * Closes the WebSocket connection without deleting the node from `NodeManager`.
   */
  public disconnect(destroyReason?: string): void {
    this.clearTimers();
    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close(1000, destroyReason || "Node disconnected");
      }
      this.ws = null;
    }
    this.NodeManager.emit("disconnect", this, { code: 1000, reason: destroyReason || "Manual disconnect" });
  }

  /**
   * Destroys all players bound to this node (or migrates them if requested), closes WS, and removes the node.
   */
  public async destroy(
    destroyReason: string = DestroyReasons.NodeDestroy,
    deleteNode = true,
    movePlayers = false
  ): Promise<void> {
    this.isDestroying = true;
    this.clearTimers();

    const attachedPlayers = this.NodeManager.LavalinkManager.players.filter(
      (p) => p.node.id === this.id
    );

    for (const player of attachedPlayers.values()) {
      if (movePlayers) {
        const fallback = this.NodeManager.leastUsedNodes().find((n) => n.id !== this.id);
        if (fallback) {
          try {
            await player.changeNode(fallback);
            continue;
          } catch {
            // Fall back to destroying player if migration fails
          }
        }
      }
      await player.destroy(destroyReason);
    }

    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close(1000, destroyReason);
      }
      this.ws = null;
    }

    if (deleteNode) {
      this.NodeManager.nodes.delete(this.id);
    }
    this.NodeManager.emit("destroy", this, destroyReason);
  }

  private clearTimers(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    if (this.heartBeatTimer) {
      clearInterval(this.heartBeatTimer);
      this.heartBeatTimer = null;
    }
  }

  private startHeartBeat(): void {
    if (this.heartBeatTimer) clearInterval(this.heartBeatTimer);
    if (this.options.heartBeatInterval <= 0) return;

    const triggerPing = () => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.lastPingTimestamp = Date.now();
        this.ws.ping();
        this.NodeManager.LavalinkManager._debug(DebugEvents.HeartBeatTriggered, {
          state: "log",
          message: `Sent WS ping to node "${this.id}"`,
          functionLayer: "MocylinkNode > startHeartBeat()",
        });
      }
    };

    triggerPing();
    this.heartBeatTimer = setInterval(triggerPing, this.options.heartBeatInterval);
    this.heartBeatTimer.unref?.();
  }

  private onOpen(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    this.reconnectAttempts = 0;
    this.startHeartBeat();
    this.NodeManager.LavalinkManager._debug(DebugEvents.NodeConnect, {
      state: "log",
      message: `WebSocket opened to "${this.wsAddress}"`,
      functionLayer: "MocylinkNode > onOpen()",
    });
  }

  private onError(error: Error): void {
    this.NodeManager.LavalinkManager._debug(DebugEvents.NodeError, {
      state: "error",
      message: `WebSocket error on node "${this.id}": ${error.message}`,
      functionLayer: "MocylinkNode > onError()",
    });
    this.NodeManager.emit("error", this, error);
    if (this.options.closeOnError && this.ws) {
      this.ws.close(1006, error.message);
    }
  }

  private onClose(code: number, reasonBuf: Buffer): void {
    const reason = reasonBuf?.toString() || "Unknown reason";
    if (this.heartBeatTimer) {
      clearInterval(this.heartBeatTimer);
      this.heartBeatTimer = null;
    }

    this.NodeManager.LavalinkManager._debug(DebugEvents.NodeDisconnect, {
      state: "warn",
      message: `WebSocket closed on node "${this.id}" (code=${code}, reason=${reason})`,
      functionLayer: "MocylinkNode > onClose()",
    });

    this.NodeManager.emit("disconnect", this, { code, reason });

    if (this.isDestroying || code === 1000) return;
    this.scheduleReconnect();
  }

  public reconnect(): void {
    if (this.reconnectTimeout) {
      this.NodeManager.emit("reconnectinprogress", this);
      return;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.options.retryAmount) {
      const err = new Error(
        `Node "${this.id}" exhausted all ${this.options.retryAmount} reconnection attempts.`
      );
      this.NodeManager.emit("error", this, err);
      void this.destroy(DestroyReasons.NodeReconnectFail, false, true);
      return;
    }

    this.reconnectAttempts++;
    this.NodeManager.emit("reconnecting", this);
    this.NodeManager.LavalinkManager._debug(DebugEvents.NodeReconnect, {
      state: "log",
      message: `Scheduling reconnect #${this.reconnectAttempts}/${this.options.retryAmount} for "${this.id}" in ${this.options.retryDelay}ms`,
      functionLayer: "MocylinkNode > scheduleReconnect()",
    });

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      try {
        this.connect();
      } catch (e) {
        this.NodeManager.emit("error", this, e instanceof Error ? e : new Error(String(e)));
        this.scheduleReconnect();
      }
    }, this.options.retryDelay);
    this.reconnectTimeout.unref?.();
  }

  private async onMessage(rawData: WebSocket.RawData): Promise<void> {
    let text: string;
    if (typeof rawData === "string") text = rawData;
    else if (Buffer.isBuffer(rawData)) text = rawData.toString("utf8");
    else if (Array.isArray(rawData)) text = Buffer.concat(rawData).toString("utf8");
    else text = Buffer.from(rawData).toString("utf8");

    let packet: LavalinkWSMessage;
    try {
      packet = JSON.parse(text) as LavalinkWSMessage;
    } catch (err) {
      this.NodeManager.emit(
        "error",
        this,
        err instanceof Error ? err : new Error(String(err)),
        text
      );
      return;
    }

    this.NodeManager.emit("raw", this, packet);

    switch (packet.op) {
      case "ready": {
        this.sessionId = packet.sessionId;

        if (this.resuming.enabled) {
          try {
            await this.updateSession(true, this.resuming.timeoutSeconds);
          } catch (err) {
            this.NodeManager.emit(
              "error",
              this,
              err instanceof Error ? err : new Error(String(err)),
              packet
            );
          }
        }

        try {
          this.info = await this.fetchInfo();
          if (this.info?.version?.semver) {
            this.version = this.info.version.semver;
          }
        } catch {
          // Non-fatal if /v4/info is unavailable on minimal mock servers
        }

        if (packet.resumed) {
          let players: LavalinkPlayerObject[] = [];
          try {
            players = await this.fetchAllPlayers();
          } catch {
            // Ignore
          }
          this.NodeManager.emit(
            "resumed",
            this,
            packet as { op: "ready"; resumed: true; sessionId: string },
            players
          );
        } else {
          this.NodeManager.emit("connect", this);
        }
        break;
      }

      case "stats": {
        this.stats = {
          players: packet.players,
          playingPlayers: packet.playingPlayers,
          uptime: packet.uptime,
          memory: packet.memory,
          cpu: packet.cpu,
          frameStats: packet.frameStats ?? null,
        };
        break;
      }

      case "playerUpdate": {
        const player = this.NodeManager.LavalinkManager.getPlayer(packet.guildId);
        if (!player) break;
        const oldJson = player.toJSON() as unknown as Record<string, unknown>;
        player.lastPosition = packet.state.position ?? 0;
        player.lastPositionChange = Date.now();
        player.connected = Boolean(packet.state.connected);
        player.ping.lavalink = packet.state.ping ?? -1;
        this.NodeManager.LavalinkManager.emit("playerUpdate", oldJson, player);
        break;
      }

      case "event": {
        await this.handleLavalinkEvent(packet);
        break;
      }
    }
  }

  private async handleLavalinkEvent(payload: LavalinkEventPayload): Promise<void> {
    const manager = this.NodeManager.LavalinkManager;
    const player = manager.getPlayer(payload.guildId);
    if (!player) return;

    switch (payload.type) {
      case "TrackStartEvent": {
        player.playing = true;
        player.paused = false;
        player.lastPosition = payload.track?.info?.position ?? 0;
        player.lastPositionChange = Date.now();

        const built = payload.track
          ? manager.utils.buildTrack(payload.track, player.queue.current?.requester)
          : player.queue.current;

        if (built && player.queue.current) {
          built.userData = { ...player.queue.current.userData, ...built.userData };
          built.requester = player.queue.current.requester ?? built.requester;
          player.queue.current = built;
        } else if (built) {
          player.queue.current = built;
        }

        await player.queue.utils.save();

        if (manager.options.emitNewSongsOnly) {
          const prev = player.queue.previous[0];
          if (
            prev &&
            built &&
            ((prev.encoded && prev.encoded === built.encoded) ||
              (prev.info.identifier && prev.info.identifier === built.info.identifier))
          ) {
            return;
          }
        }

        manager.emit("trackStart", player, player.queue.current, payload);
        break;
      }

      case "TrackEndEvent": {
        await this.handleTrackEnd(player, payload);
        break;
      }

      case "TrackStuckEvent": {
        manager.emit("trackStuck", player, player.queue.current, payload);
        if (manager.options.autoSkip !== false) {
          await this.advanceOnFailure(player, payload);
        }
        break;
      }

      case "TrackExceptionEvent": {
        manager.emit("trackError", player, player.queue.current, payload);
        if (await player._recordTrackErrorAndCheckDestroy()) {
          return;
        }
        if (manager.options.autoSkip !== false) {
          await this.advanceOnFailure(player, payload);
        }
        break;
      }

      case "WebSocketClosedEvent": {
        manager.emit("playerSocketClosed", player, payload);
        // Re-negotiate voice connection on Discord voice gateway codes 4015 (voice server crashed) or 4009 (session timeout)
        if ([4015, 4009].includes(payload.code) && player.voiceChannelId) {
          await player.connect();
        }
        break;
      }

      // SponsorBlock Plugin Events
      case "SegmentsLoaded": {
        manager.emit("SegmentsLoaded", player, player.queue.current, payload);
        break;
      }
      case "SegmentSkipped": {
        manager.emit("SegmentSkipped", player, player.queue.current, payload);
        break;
      }
      case "ChaptersLoaded": {
        manager.emit("ChaptersLoaded", player, player.queue.current, payload);
        break;
      }
      case "ChapterStarted": {
        manager.emit("ChapterStarted", player, player.queue.current, payload);
        break;
      }

      // LavaLyrics Plugin Events
      case "LyricsFoundEvent": {
        manager.emit("LyricsFound", player, player.queue.current, payload);
        break;
      }
      case "LyricsNotFoundEvent": {
        manager.emit("LyricsNotFound", player, player.queue.current, payload);
        break;
      }
      case "LyricsLineEvent": {
        manager.emit("LyricsLine", player, player.queue.current, payload);
        break;
      }
    }
  }

  private async handleTrackEnd(
    player: Player,
    payload: Extract<LavalinkEventPayload, { type: "TrackEndEvent" }>
  ): Promise<void> {
    const manager = this.NodeManager.LavalinkManager;
    const endedTrack = player.queue.current;

    // If replaced by a new play() call, do not advance the queue again
    if (payload.reason === "replaced") {
      manager._debug(DebugEvents.TrackEndReplaced, {
        state: "log",
        message: `Track replaced on guild ${player.guildId}`,
        functionLayer: "MocylinkNode > handleTrackEnd()",
      });
      manager.emit("trackEnd", player, endedTrack, payload);
      return;
    }

    if (payload.reason === "cleanup") {
      player.playing = false;
      manager.emit("trackEnd", player, endedTrack, payload);
      return;
    }

    // Push finished track to `queue.previous`
    if (endedTrack) {
      player.queue.previous.unshift(endedTrack);
      const maxPrev = player.queue.utils.maxPreviousTracks;
      if (player.queue.previous.length > maxPrev) {
        player.queue.previous.splice(maxPrev, player.queue.previous.length - maxPrev);
      }
    }

    if (payload.reason === "loadFailed") {
      if (manager.options.autoSkip !== false) {
        await this.advanceOnFailure(player, payload);
      }
      return;
    }

    if (payload.reason === "stopped" && player._skipAutoAdvanceOnce) {
      player._skipAutoAdvanceOnce = false;
      player.playing = false;
      player.queue.current = null;
      await player.queue.utils.save();
      manager.emit("trackEnd", player, endedTrack, payload);
      if (player.queue.tracks.length === 0) {
        await player._handleQueueEmpty(endedTrack, payload);
      }
      return;
    }

    if (manager.options.autoSkip === false) {
      player.playing = false;
      player.queue.current = null;
      await player.queue.utils.save();
      manager.emit("trackEnd", player, endedTrack, payload);
      return;
    }

    // Repeat mode handling
    if (endedTrack && player.repeatMode === "track" && payload.reason !== "stopped") {
      manager.emit("trackEnd", player, endedTrack, payload);
      await player.play({ clientTrack: endedTrack, noReplace: false });
      return;
    }

    if (endedTrack && player.repeatMode === "queue") {
      await player.queue.add(endedTrack);
    }

    if (player.queue.tracks.length > 0) {
      manager.emit("trackEnd", player, endedTrack, payload);
      await player.play({ noReplace: false });
      return;
    }

    // Queue is now empty
    player.playing = false;
    player.paused = false;
    player.queue.current = null;
    await player.queue.utils.save();
    manager.emit("trackEnd", player, endedTrack, payload);
    await player._handleQueueEmpty(endedTrack, payload);
  }

  private async advanceOnFailure(
    player: Player,
    payload: Extract<
      LavalinkEventPayload,
      { type: "TrackEndEvent" | "TrackStuckEvent" | "TrackExceptionEvent" }
    >
  ): Promise<void> {
    const failedTrack = player.queue.current;
    this.NodeManager.LavalinkManager._debug(DebugEvents.AutoSkipFailedTrack, {
      state: "warn",
      message: `Auto-skipping failed/stuck track on guild ${player.guildId}`,
      functionLayer: "MocylinkNode > advanceOnFailure()",
    });

    if (player.queue.tracks.length > 0) {
      await player.play({ noReplace: false });
      return;
    }

    player.playing = false;
    player.paused = false;
    player.queue.current = null;
    await player.queue.utils.save();
    await player._handleQueueEmpty(failedTrack, payload);
  }

  // ==================== Lavalink v4 REST API Methods ====================

  /**
   * Resolves a search identifier or URL via `GET /v4/loadtracks` and normalizes into `SearchResult`.
   */
  public async search<Requester = unknown>(
    query: SearchQuery,
    requestUser?: Requester,
    throwOnEmpty = false
  ): Promise<SearchResult> {
    const utils = this.NodeManager.LavalinkManager.utils;
    const transformed = utils.transformQuery(query);
    utils.validateQueryString(this, transformed.query);

    let endpoint = `/loadtracks?identifier=${encodeURIComponent(transformed.identifier)}`;
    if (transformed.extraQueryUrlParams) {
      const extra = transformed.extraQueryUrlParams.toString();
      if (extra) endpoint += `&${extra}`;
    }

    const raw = await this.request<RawLavalinkLoadResult>(endpoint);
    const result = this.normalizeLoadResult(raw, requestUser);

    if (throwOnEmpty && (result.loadType === "empty" || result.tracks.length === 0)) {
      throw new Error(`No tracks found for query "${transformed.identifier}".`);
    }

    return result;
  }

  /**
   * Low-level `GET /v4/loadtracks` call returning raw Lavalink v4 payload.
   */
  public async loadTracks(identifier: string): Promise<RawLavalinkLoadResult> {
    return await this.request<RawLavalinkLoadResult>(
      `/loadtracks?identifier=${encodeURIComponent(identifier)}`
    );
  }

  private normalizeLoadResult<Requester = unknown>(
    raw: RawLavalinkLoadResult,
    requestUser?: Requester
  ): SearchResult {
    const utils = this.NodeManager.LavalinkManager.utils;

    if (!raw || raw.loadType === "empty") {
      return {
        loadType: "empty",
        exception: null,
        pluginInfo: {},
        playlist: null,
        tracks: [],
      };
    }

    if (raw.loadType === "error") {
      return {
        loadType: "error",
        exception: raw.data,
        pluginInfo: {},
        playlist: null,
        tracks: [],
      };
    }

    if (raw.loadType === "track") {
      const built = utils.buildTrack(raw.data, requestUser);
      return {
        loadType: "track",
        exception: null,
        pluginInfo: raw.data.pluginInfo || {},
        playlist: null,
        tracks: [built],
      };
    }

    if (raw.loadType === "search") {
      const tracks = (raw.data || []).map((t) => utils.buildTrack(t, requestUser));
      return {
        loadType: "search",
        exception: null,
        pluginInfo: {},
        playlist: null,
        tracks,
      };
    }

    if (raw.loadType === "playlist") {
      const tracks = (raw.data.tracks || []).map((t) => utils.buildTrack(t, requestUser));
      const selectedIdx = raw.data.info?.selectedTrack ?? -1;
      const selectedTrack =
        selectedIdx >= 0 && selectedIdx < tracks.length ? tracks[selectedIdx] : null;
      const totalDuration = tracks.reduce((sum, t) => sum + (t.info.duration || 0), 0);
      const pluginInfo = raw.data.pluginInfo || {};

      return {
        loadType: "playlist",
        exception: null,
        pluginInfo,
        playlist: {
          name: raw.data.info?.name || "Unknown Playlist",
          title: raw.data.info?.name || "Unknown Playlist",
          author: typeof pluginInfo.author === "string" ? pluginInfo.author : undefined,
          thumbnail:
            (typeof pluginInfo.artworkUrl === "string" ? pluginInfo.artworkUrl : undefined) ||
            tracks[0]?.info.artworkUrl ||
            undefined,
          uri: typeof pluginInfo.url === "string" ? pluginInfo.url : undefined,
          selectedTrack,
          duration: totalDuration,
        },
        tracks,
      };
    }

    return {
      loadType: "empty",
      exception: null,
      pluginInfo: {},
      playlist: null,
      tracks: [],
    };
  }

  /**
   * Executes a multi-type LavaSearch query (`GET /v4/loadsearch`).
   */
  public async lavaSearch<Requester = unknown>(
    query: LavaSearchQuery | string,
    requestUser?: Requester,
    throwOnEmpty = false
  ): Promise<LavaSearchResult> {
    const utils = this.NodeManager.LavalinkManager.utils;
    const transformed = utils.transformLavaSearchQuery(query);
    utils.validateQueryString(this, transformed.query);

    const params = new URLSearchParams();
    params.set("query", transformed.identifier);
    for (const type of transformed.types) {
      params.append("types", type);
    }

    const raw = await this.request<{
      tracks?: LavalinkTrack[];
      albums?: Array<{
        info: { name: string; selectedTrack: number };
        pluginInfo: Record<string, unknown>;
        tracks: LavalinkTrack[];
      }>;
      artists?: Array<{
        info: { name: string; selectedTrack: number };
        pluginInfo: Record<string, unknown>;
        tracks: LavalinkTrack[];
      }>;
      playlists?: Array<{
        info: { name: string; selectedTrack: number };
        pluginInfo: Record<string, unknown>;
        tracks: LavalinkTrack[];
      }>;
      texts?: Array<{ text: string; pluginInfo: Record<string, unknown> }>;
      plugin?: Record<string, unknown>;
    } | null>(`/loadsearch?${params.toString()}`);

    const mapGroup = (
      items?: Array<{
        info: { name: string; selectedTrack: number };
        pluginInfo: Record<string, unknown>;
        tracks: LavalinkTrack[];
      }>
    ) =>
      (items || []).map((group) => ({
        info: group.info,
        pluginInfo: group.pluginInfo || {},
        tracks: (group.tracks || []).map((t) => utils.buildTrack(t, requestUser)),
      }));

    const result: LavaSearchResult = {
      tracks: (raw?.tracks || []).map((t) => utils.buildTrack(t, requestUser)),
      albums: mapGroup(raw?.albums),
      artists: mapGroup(raw?.artists),
      playlists: mapGroup(raw?.playlists),
      texts: raw?.texts || [],
      pluginInfo: raw?.plugin || {},
    };

    const isEmpty =
      !result.tracks.length &&
      !result.albums.length &&
      !result.artists.length &&
      !result.playlists.length &&
      !result.texts.length;

    if (throwOnEmpty && isEmpty) {
      throw new Error(`LavaSearch returned no results for "${transformed.identifier}".`);
    }

    return result;
  }

  /**
   * Updates or creates a player on Lavalink (`PATCH /v4/sessions/{sessionId}/players/{guildId}`).
   */
  public async updatePlayer(data: UpdatePlayerInfo): Promise<LavalinkPlayerObject> {
    const sessionId = this.requireSessionId();
    const noReplace = Boolean(data.noReplace);
    const body = { ...data.playerOptions };

    // Convert top-level legacy `encodedTrack` / `identifier` into Lavalink v4's `track` object if needed
    if (body.encodedTrack !== undefined && body.track === undefined) {
      body.track = { encoded: body.encodedTrack };
      delete body.encodedTrack;
    }
    if (body.identifier !== undefined && body.track === undefined) {
      body.track = { identifier: body.identifier };
      delete body.identifier;
    }

    return await this.request<LavalinkPlayerObject>(
      `/sessions/${encodeURIComponent(sessionId)}/players/${encodeURIComponent(data.guildId)}?noReplace=${noReplace}`,
      (req) => {
        req.method = "PATCH";
        req.body = JSON.stringify(body);
      }
    );
  }

  /**
   * Destroys a guild player on Lavalink (`DELETE /v4/sessions/{sessionId}/players/{guildId}`).
   */
  public async destroyPlayer(guildId: string): Promise<void> {
    if (!this.sessionId) return;
    await this.request<void>(
      `/sessions/${encodeURIComponent(this.sessionId)}/players/${encodeURIComponent(guildId)}`,
      (req) => {
        req.method = "DELETE";
      }
    );
  }

  public async fetchAllPlayers(): Promise<LavalinkPlayerObject[]> {
    const sessionId = this.requireSessionId();
    return await this.request<LavalinkPlayerObject[]>(
      `/sessions/${encodeURIComponent(sessionId)}/players`
    );
  }

  public async fetchPlayer(guildId: string): Promise<LavalinkPlayerObject> {
    const sessionId = this.requireSessionId();
    return await this.request<LavalinkPlayerObject>(
      `/sessions/${encodeURIComponent(sessionId)}/players/${encodeURIComponent(guildId)}`
    );
  }

  /**
   * Configures session resuming on Lavalink (`PATCH /v4/sessions/{sessionId}`).
   */
  public async updateSession(
    resuming = true,
    timeoutSeconds = 60
  ): Promise<{ resuming: boolean; timeout: number }> {
    const sessionId = this.requireSessionId();
    this.resuming = { enabled: resuming, timeoutSeconds };
    return await this.request<{ resuming: boolean; timeout: number }>(
      `/sessions/${encodeURIComponent(sessionId)}`,
      (req) => {
        req.method = "PATCH";
        req.body = JSON.stringify({ resuming, timeout: timeoutSeconds });
      }
    );
  }

  public async fetchStats(): Promise<NodeStats> {
    const stats = await this.request<NodeStats>(`/stats`);
    this.stats = {
      ...stats,
      frameStats: stats.frameStats ?? null,
    };
    return this.stats;
  }

  public async fetchInfo(): Promise<LavalinkInfo> {
    const info = await this.request<LavalinkInfo>(`/info`);
    this.info = info;
    return info;
  }

  public async fetchVersion(): Promise<string> {
    const ver = await this.request<string>(`/version`, undefined, true);
    this.version = ver.trim();
    return this.version;
  }

  // ==================== SponsorBlock Plugin REST Methods ====================

  public async getSponsorBlock(guildId: string): Promise<SponsorBlockCategory[]> {
    const sessionId = this.requireSessionId();
    this.NodeManager.LavalinkManager._debug(DebugEvents.GetSponsorBlock, {
      state: "log",
      message: `Fetching SponsorBlock categories for guild ${guildId}`,
      functionLayer: "MocylinkNode > getSponsorBlock()",
    });
    return await this.request<SponsorBlockCategory[]>(
      `/sessions/${encodeURIComponent(sessionId)}/players/${encodeURIComponent(guildId)}/sponsorblock/categories`
    );
  }

  public async setSponsorBlock(
    guildId: string,
    segments: SponsorBlockCategory[] = ["sponsor", "selfpromo"]
  ): Promise<void> {
    const sessionId = this.requireSessionId();
    if (!segments.length) {
      throw new RangeError("SponsorBlock segments array must contain at least one category.");
    }
    this.NodeManager.LavalinkManager._debug(DebugEvents.SetSponsorBlock, {
      state: "log",
      message: `Setting SponsorBlock categories [${segments.join(", ")}] for guild ${guildId}`,
      functionLayer: "MocylinkNode > setSponsorBlock()",
    });
    await this.request<void>(
      `/sessions/${encodeURIComponent(sessionId)}/players/${encodeURIComponent(guildId)}/sponsorblock/categories`,
      (req) => {
        req.method = "PUT";
        req.body = JSON.stringify(segments);
      }
    );
  }

  public async deleteSponsorBlock(guildId: string): Promise<void> {
    const sessionId = this.requireSessionId();
    this.NodeManager.LavalinkManager._debug(DebugEvents.DeleteSponsorBlock, {
      state: "log",
      message: `Deleting SponsorBlock categories for guild ${guildId}`,
      functionLayer: "MocylinkNode > deleteSponsorBlock()",
    });
    await this.request<void>(
      `/sessions/${encodeURIComponent(sessionId)}/players/${encodeURIComponent(guildId)}/sponsorblock/categories`,
      (req) => {
        req.method = "DELETE";
      }
    );
  }
}

export { MocylinkNode as LavalinkNode };
