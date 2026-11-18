import type { MocylinkNode } from "../structures/MocylinkNode";
import type { Player } from "../structures/Player";
import type { LavalinkFilterData } from "./Filters";
import type { LavalinkPlayOptions } from "./Node";
import type { Track, UnresolvedTrack } from "./Track";

export type RepeatMode = "off" | "track" | "queue";

export interface PlayerOptions {
  /** Guild ID of the player. */
  guildId: string;
  /** Voice channel ID to connect to. */
  voiceChannelId: string;
  /** Optional text channel ID associated with player notifications. */
  textChannelId?: string | null;
  /** Initial volume (0-1000, default: 100). */
  volume?: number;
  /** Preferred voice region for automatic node selection. */
  vcRegion?: string;
  /** Self-deafen the bot in the voice channel (default: true). */
  selfDeaf?: boolean;
  /** Self-mute the bot in the voice channel (default: false). */
  selfMute?: boolean;
  /** Specific node ID or MocylinkNode instance to pin this player to. */
  node?: MocylinkNode | string;
  /** Apply `instaFilterFix` seek workaround on filter updates. */
  instaUpdateFiltersFix?: boolean;
  /** Apply volume changes through Lavalink's `filters.volume` instead of top-level `volume`. */
  applyVolumeAsFilter?: boolean;
  /** Custom initial key-value metadata stored on the player. */
  customData?: Record<string, unknown>;
}

export interface PlayOptions extends LavalinkPlayOptions {
  /** High-level Track or UnresolvedTrack to play immediately (or push & play). */
  clientTrack?: Track | UnresolvedTrack;
  /** Whether NOT to replace a currently playing track (default: false). */
  noReplace?: boolean;
}

export interface VoiceStateChangeOptions {
  voiceChannelId?: string;
  selfDeaf?: boolean;
  selfMute?: boolean;
}

export type AutoplayFunction = (player: Player, lastPlayedTrack: Track) => Promise<void>;

export interface ManagerPlayerOptions {
  /** Time window & threshold before destroying a player that repeatedly errors. */
  maxErrorsPerTime?: {
    threshold: number;
    maxAmount: number;
  };
  /** Minimum playback duration in ms before autoplay is allowed to trigger (default: 10000). */
  minAutoPlayMs?: number;
  /** Apply volume updates via Lavalink filter volume instead of player volume. */
  applyVolumeAsFilter?: boolean;
  /** Interval in ms to increment client-side position estimates (optional). */
  clientBasedPositionUpdateInterval?: number;
  /** Default search source prefix (e.g. `"ytsearch"`, `"ytmsearch"`, `"spsearch"`). */
  defaultSearchPlatform?: string;
  /** Scale factor applied to volume sent to Lavalink (e.g. `0.75` sends `75` when player.volume is `100`). */
  volumeDecrementer?: number;
  /** Transform user/requester objects stored on tracks to save memory. */
  requesterTransformer?: (requester: unknown) => unknown;
  /** Automatic handling when the bot is disconnected from voice. */
  onDisconnect?: {
    autoReconnect?: boolean;
    autoReconnectOnlyWithTracks?: boolean;
    destroyPlayer?: boolean;
  };
  /** Automatic handling when the queue finishes all tracks. */
  onEmptyQueue?: {
    autoPlayFunction?: AutoplayFunction;
    destroyAfterMs?: number;
  };
  /** Merge unresolved track metadata over resolved Lavalink track info. */
  useUnresolvedData?: boolean;
}

export interface PlayerJson {
  guildId: string;
  options: PlayerOptions;
  voiceChannelId: string | null;
  textChannelId: string | null;
  position: number;
  lastPosition: number;
  lastPositionChange: number | null;
  volume: number;
  lavalinkVolume: number;
  repeatMode: RepeatMode;
  paused: boolean;
  playing: boolean;
  connected: boolean;
  createdTimeStamp: number;
  filters: LavalinkFilterData;
  ping: {
    ws: number;
    lavalink: number;
  };
  nodeId: string;
  nodeSessionId: string | null;
  currentTrack: Track | null;
}
