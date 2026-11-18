import { DebugEvents, DestroyReasons, type DestroyReasonsType } from "../constants";
import type {
  BotClientOptions,
  DebugEventPayload,
  LavaSearchQuery,
  LavaSearchResult,
  ManagerEvents,
  MocylinkManagerOptions,
  PlayerOptions,
  SearchQuery,
  SearchResult,
  VoicePacket,
  VoiceServer,
  VoiceStatePacket,
} from "../types";
import { MocylinkNode } from "./MocylinkNode";
import { NodeManager } from "./NodeManager";
import { Player } from "./Player";
import { DefaultQueueStore } from "./Queue";
import { ManagerUtils, MiniMap, TypedEventEmitter } from "./Utils";

/**
 * Main Lavalink v4 Manager hub (`MocylinkManager` / `LavalinkManager` / `Mocylink`).
 * Coordinates Lavalink nodes, per-guild players, Discord gateway voice updates, queues, and plugins.
 */
export class MocylinkManager<CustomPlayer extends Player = Player> extends TypedEventEmitter<
  ManagerEvents<CustomPlayer>
> {
  public readonly options: MocylinkManagerOptions<CustomPlayer>;
  public readonly nodeManager: NodeManager;
  public readonly utils: ManagerUtils;
  public readonly players = new MiniMap<string, CustomPlayer>();
  public initiated = false;

  private readonly voiceUsersByGuild = new Map<string, Map<string, string>>();

  constructor(options: MocylinkManagerOptions<CustomPlayer>) {
    super();

    if (!options || typeof options !== "object") {
      throw new TypeError("MocylinkManager options object must be provided.");
    }
    if (!Array.isArray(options.nodes) || options.nodes.length === 0) {
      throw new RangeError("MocylinkManager options.nodes must be a non-empty array of node configs.");
    }
    if (typeof options.sendToShard !== "function") {
      throw new TypeError("MocylinkManager options.sendToShard must be a function.");
    }

    this.options = {
      autoSkip: true,
      autoSkipOnResolveError: true,
      emitNewSongsOnly: false,
      linksAllowed: true,
      ...options,
      client: {
        ...(options.client || {}),
      },
      playerOptions: {
        defaultSearchPlatform: "ytsearch",
        minAutoPlayMs: 10_000,
        volumeDecrementer: 1,
        applyVolumeAsFilter: false,
        useUnresolvedData: false,
        ...(options.playerOptions || {}),
      },
      queueOptions: {
        maxPreviousTracks: options.queueOptions?.maxPreviousTracks ?? 25,
        queueStore: options.queueOptions?.queueStore ?? new DefaultQueueStore(),
        queueChangesWatcher: options.queueOptions?.queueChangesWatcher,
      },
      advancedOptions: {
        enableDebugEvents: false,
        maxFilterFixDuration: 600_000,
        ...(options.advancedOptions || {}),
      },
    };

    this.utils = new ManagerUtils(this as unknown as MocylinkManager);
    this.nodeManager = new NodeManager(this as unknown as MocylinkManager);
  }

  /** @internal */
  public _debug(eventKey: DebugEvents | string, data: Omit<DebugEventPayload, "name">): void {
    if (!this.options.advancedOptions?.enableDebugEvents) return;
    this.emit("debug", eventKey, {
      name: String(eventKey),
      ...data,
    });
  }

  /**
   * Initializes the manager with the Discord bot's client ID (and optional username) and connects all nodes.
   */
  public async init(clientData: BotClientOptions): Promise<this> {
    if (clientData) {
      this.options.client = {
        ...this.options.client,
        ...clientData,
      };
    }

    if (!this.options.client?.id) {
      throw new Error("`client.id` (Discord Bot User ID) is required to initialize MocylinkManager.");
    }

    if (this.initiated) return this;
    this.initiated = true;
    this.nodeManager.connectAll();
    return this;
  }

  /**
   * Creates a new guild Player (or returns the existing one if already active).
   */
  public createPlayer(options: PlayerOptions): CustomPlayer {
    if (!options?.guildId) {
      throw new RangeError("`options.guildId` is required to create a Player.");
    }

    const existing = this.players.get(options.guildId);
    if (existing) {
      if (options.voiceChannelId && !existing.voiceChannelId) {
        existing.voiceChannelId = options.voiceChannelId;
      }
      if (options.textChannelId) {
        existing.textChannelId = options.textChannelId;
      }
      return existing;
    }

    const PlayerClass = (this.options.customPlayer ?? Player) as new (
      opts: PlayerOptions,
      mgr: MocylinkManager
    ) => CustomPlayer;

    const player = new PlayerClass(options, this as unknown as MocylinkManager);
    this.players.set(options.guildId, player);
    this.emit("playerCreate", player);
    return player;
  }

  /**
   * Retrieves an active guild Player if one exists.
   */
  public getPlayer(guildId: string): CustomPlayer | undefined {
    return this.players.get(guildId);
  }

  /**
   * Destroys an active guild Player and disconnects from voice.
   */
  public async destroyPlayer(
    guildId: string,
    destroyReason: DestroyReasonsType = DestroyReasons.Manual
  ): Promise<void> {
    const player = this.players.get(guildId);
    if (!player) return;
    await player.destroy(destroyReason);
  }

  /**
   * Removes a Player from the internal registry without issuing REST/Gateway calls.
   */
  public deletePlayer(guildId: string): boolean {
    this.voiceUsersByGuild.delete(guildId);
    return this.players.delete(guildId);
  }

  /**
   * Searches for tracks/playlists on the specified or least-used connected Lavalink node.
   */
  public async search<Requester = unknown>(
    query: SearchQuery,
    requestUser?: Requester,
    node?: MocylinkNode | string,
    throwOnEmpty = false
  ): Promise<SearchResult> {
    const targetNode = node
      ? this.nodeManager.get(node)
      : this.nodeManager.leastUsedNodes()[0];

    if (!targetNode || !targetNode.connected) {
      throw new Error("No connected Lavalink nodes are available to execute search.");
    }

    return await targetNode.search(query, requestUser, throwOnEmpty);
  }

  /**
   * Executes a multi-type LavaSearch query on the specified or least-used connected Lavalink node.
   */
  public async lavaSearch<Requester = unknown>(
    query: LavaSearchQuery | string,
    requestUser?: Requester,
    node?: MocylinkNode | string,
    throwOnEmpty = false
  ): Promise<LavaSearchResult> {
    const targetNode = node
      ? this.nodeManager.get(node)
      : this.nodeManager.leastUsedNodes()[0];

    if (!targetNode || !targetNode.connected) {
      throw new Error("No connected Lavalink nodes are available to execute lavaSearch.");
    }

    return await targetNode.lavaSearch(query, requestUser, throwOnEmpty);
  }

  /**
   * Feeds raw Discord Gateway packets (`VOICE_STATE_UPDATE`, `VOICE_SERVER_UPDATE`, `CHANNEL_DELETE`) into Mocylink.
   */
  public async sendRawData(
    packet: VoicePacket | VoiceServer | VoiceStatePacket
  ): Promise<void> {
    if (!packet || typeof packet !== "object") return;

    // Support passing raw `d` payloads directly as well as `{ t, d }` gateway envelopes
    if ("t" in packet && packet.t) {
      if (packet.t === "VOICE_SERVER_UPDATE" && packet.d) {
        await this.handleVoiceServerUpdate(packet.d as VoiceServer);
      } else if (packet.t === "VOICE_STATE_UPDATE" && packet.d) {
        await this.handleVoiceStateUpdate(packet.d as VoiceStatePacket);
      } else if (packet.t === "CHANNEL_DELETE" && packet.d) {
        const channelData = packet.d as { id: string; guild_id?: string };
        if (channelData.guild_id) {
          const player = this.players.get(channelData.guild_id);
          if (player && player.voiceChannelId === channelData.id) {
            await player.destroy(DestroyReasons.ChannelDeleted, false);
          }
        }
      }
      return;
    }

    if ("token" in packet && "endpoint" in packet) {
      await this.handleVoiceServerUpdate(packet);
    } else if ("session_id" in packet && "user_id" in packet) {
      await this.handleVoiceStateUpdate(packet);
    }
  }

  private async handleVoiceServerUpdate(data: VoiceServer): Promise<void> {
    if (!data?.guild_id) return;
    const player = this.players.get(data.guild_id);
    if (!player) return;

    this._debug(DebugEvents.VoiceServerUpdate, {
      state: "log",
      message: `Received VOICE_SERVER_UPDATE for guild ${data.guild_id} (endpoint=${data.endpoint})`,
      functionLayer: "MocylinkManager > handleVoiceServerUpdate()",
    });

    player.voice.token = data.token;
    player.voice.endpoint = data.endpoint;

    if (!data.endpoint) {
      this._debug(DebugEvents.PlayerUpdateError, {
        state: "warn",
        message: `Discord sent null voice endpoint for guild ${data.guild_id}; awaiting new server allocation.`,
        functionLayer: "MocylinkManager > handleVoiceServerUpdate()",
      });
      return;
    }

    if (player.voice.sessionId) {
      await this.dispatchVoiceToLavalink(player);
    }
  }

  private async handleVoiceStateUpdate(data: VoiceStatePacket): Promise<void> {
    if (!data?.guild_id) return;
    const player = this.players.get(data.guild_id);

    // Track non-bot users joining/leaving the player's voice channel
    if (data.user_id !== this.options.client?.id) {
      let guildMap = this.voiceUsersByGuild.get(data.guild_id);
      if (!guildMap) {
        guildMap = new Map<string, string>();
        this.voiceUsersByGuild.set(data.guild_id, guildMap);
      }

      const previousChannel = guildMap.get(data.user_id) ?? null;
      const newChannel = data.channel_id ?? null;

      if (newChannel) {
        guildMap.set(data.user_id, newChannel);
      } else {
        guildMap.delete(data.user_id);
      }

      if (player && player.voiceChannelId) {
        if (previousChannel !== player.voiceChannelId && newChannel === player.voiceChannelId) {
          this.emit("playerVoiceJoin", player, data.user_id);
        } else if (
          previousChannel === player.voiceChannelId &&
          newChannel !== player.voiceChannelId
        ) {
          this.emit("playerVoiceLeave", player, data.user_id);
        }
      }
      return;
    }

    if (!player) return;

    this._debug(DebugEvents.VoiceStateUpdate, {
      state: "log",
      message: `Received bot VOICE_STATE_UPDATE for guild ${data.guild_id} (channel=${data.channel_id})`,
      functionLayer: "MocylinkManager > handleVoiceStateUpdate()",
    });

    // Detect mute/deaf/suppress transitions
    const nextSelfMute = Boolean(data.self_mute);
    const nextServerMute = Boolean(data.mute);
    if (nextSelfMute !== player.selfMute || nextServerMute) {
      player.selfMute = nextSelfMute;
      this.emit("playerMuteChange", player, nextSelfMute, nextServerMute);
    }

    const nextSelfDeaf = Boolean(data.self_deaf);
    const nextServerDeaf = Boolean(data.deaf);
    if (nextSelfDeaf !== player.selfDeaf || nextServerDeaf) {
      player.selfDeaf = nextSelfDeaf;
      this.emit("playerDeafChange", player, nextSelfDeaf, nextServerDeaf);
    }

    if (typeof data.suppress === "boolean" && data.suppress !== player.selfSuppress) {
      player.selfSuppress = data.suppress;
      this.emit("playerSuppressChange", player, data.suppress);
    }

    // Bot was disconnected from voice
    if (!data.channel_id) {
      const oldChannelId = player.voiceChannelId || "";
      player.connected = false;
      this.emit("playerDisconnect", player, oldChannelId);

      const onDisc = this.options.playerOptions?.onDisconnect;
      if (onDisc?.destroyPlayer === true) {
        await player.destroy(DestroyReasons.Disconnected, false);
        return;
      }

      if (onDisc?.autoReconnect === true && oldChannelId) {
        const hasTracks = player.queue.totalSize > 0;
        if (!onDisc.autoReconnectOnlyWithTracks || hasTracks) {
          try {
            player.voiceChannelId = oldChannelId;
            await player.connect();
            this.emit("playerReconnect", player, oldChannelId);
            return;
          } catch {
            await player.destroy(DestroyReasons.PlayerReconnectFail, false);
            return;
          }
        }
      }

      player.voiceChannelId = null;
      player.voice = {
        token: null,
        endpoint: null,
        sessionId: null,
        channelId: null,
      };
      return;
    }

    // Bot moved between two voice channels
    if (player.voiceChannelId && player.voiceChannelId !== data.channel_id) {
      const oldChannelId = player.voiceChannelId;
      player.voiceChannelId = data.channel_id;
      this.emit("playerMove", player, oldChannelId, data.channel_id);
    } else {
      player.voiceChannelId = data.channel_id;
    }

    player.voice.sessionId = data.session_id;
    player.voice.channelId = data.channel_id;
    player.connected = true;

    if (player.voice.token && player.voice.endpoint) {
      await this.dispatchVoiceToLavalink(player);
    }
  }

  private async dispatchVoiceToLavalink(player: CustomPlayer): Promise<void> {
    if (
      !player.node.connected ||
      !player.node.sessionId ||
      !player.voice.token ||
      !player.voice.endpoint ||
      !player.voice.sessionId
    ) {
      return;
    }

    try {
      await player.node.updatePlayer({
        guildId: player.guildId,
        playerOptions: {
          voice: {
            token: player.voice.token,
            endpoint: player.voice.endpoint,
            sessionId: player.voice.sessionId,
            ...(player.voice.channelId ? { channelId: player.voice.channelId } : {}),
          },
        },
      });
      this._debug(DebugEvents.PlayerUpdateSuccess, {
        state: "log",
        message: `Forwarded Discord voice credentials to Lavalink for guild ${player.guildId}`,
        functionLayer: "MocylinkManager > dispatchVoiceToLavalink()",
      });
    } catch (err) {
      this._debug(DebugEvents.PlayerUpdateError, {
        state: "error",
        message: `Failed forwarding voice credentials for guild ${player.guildId}: ${err instanceof Error ? err.message : String(err)}`,
        functionLayer: "MocylinkManager > dispatchVoiceToLavalink()",
      });
    }
  }
}

export {
  MocylinkManager as LavalinkManager,
  MocylinkManager as Mocylink,
};
