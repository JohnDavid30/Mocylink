import type { DebugEvents, DestroyReasonsType } from "../constants";
import type { MocylinkNode } from "../structures/MocylinkNode";
import type { Player } from "../structures/Player";
import type {
  ChapterStartedEventPayload,
  ChaptersLoadedEventPayload,
  LyricsFoundEventPayload,
  LyricsLineEventPayload,
  LyricsNotFoundEventPayload,
  MocylinkNodeOptions,
  SegmentSkippedEventPayload,
  SegmentsLoadedEventPayload,
  TrackEndEventPayload,
  TrackExceptionEventPayload,
  TrackStartEventPayload,
  TrackStuckEventPayload,
  WebSocketClosedEventPayload,
} from "./Node";
import type { ManagerPlayerOptions } from "./Player";
import type { ManagerQueueOptions } from "./Queue";
import type { Track, UnresolvedTrack } from "./Track";
import type { DiscordGatewayVoicePayload } from "./Utils";

export interface BotClientOptions {
  /** Discord Bot Application / User ID. */
  id: string;
  /** Optional bot username used in Lavalink's `Client-Name` header. */
  username?: string;
}

export interface AdvancedManagerOptions {
  /** Emit structured `debug` events on the manager (default: false). */
  enableDebugEvents?: boolean;
  /** Max track duration in ms eligible for `instaFilterFix` seek (default: 600000). */
  maxFilterFixDuration?: number;
  debugOptions?: {
    logCustomSearches?: boolean;
    noAudio?: boolean;
    playerDestroy?: {
      dontThrowError?: boolean;
      debugLog?: boolean;
    };
  };
}

export interface MocylinkManagerOptions<CustomPlayer extends Player = Player> {
  /** Array of Lavalink v4 node configurations. */
  nodes: MocylinkNodeOptions[];
  /** Bridge callback to dispatch Gateway Op 4 voice payloads to the Discord shard for a guild. */
  sendToShard: (guildId: string, payload: DiscordGatewayVoicePayload) => void;
  /** Bot client user details (can also be supplied later in `manager.init(clientData)`). */
  client?: Partial<BotClientOptions>;
  /** Automatically advance to the next track on `TrackEndEvent`, `TrackStuckEvent`, or `TrackExceptionEvent` (default: true). */
  autoSkip?: boolean;
  /** Automatically skip to the next queued track if an `UnresolvedTrack` fails to resolve (default: true). */
  autoSkipOnResolveError?: boolean;
  /** Only emit `trackStart` when the new track differs from the previous track (default: false). */
  emitNewSongsOnly?: boolean;
  /** Custom Player constructor subclass if extending `Player`. */
  customPlayer?: new (...args: any[]) => CustomPlayer;
  /** Per-player default options and lifecycle hooks. */
  playerOptions?: ManagerPlayerOptions;
  /** Queue persistence and history options. */
  queueOptions?: ManagerQueueOptions;
  /** Whether HTTP/HTTPS URL queries are allowed in `search` (default: true). */
  linksAllowed?: boolean;
  /** Regexes or substrings that URLs must NOT match. */
  linksBlacklist?: Array<RegExp | string>;
  /** Regexes or substrings that URLs MUST match (when non-empty). */
  linksWhitelist?: Array<RegExp | string>;
  /** Debugging and filter-fix tuning options. */
  advancedOptions?: AdvancedManagerOptions;
}

export type LavalinkManagerOptions<CustomPlayer extends Player = Player> =
  MocylinkManagerOptions<CustomPlayer>;

export interface DebugEventPayload {
  name: string;
  state: "log" | "warn" | "error";
  message: string;
  functionLayer: string;
  details?: Record<string, unknown>;
}

export interface ManagerEvents<CustomPlayer extends Player = Player> {
  trackStart: (
    player: CustomPlayer,
    track: Track | null,
    payload: TrackStartEventPayload
  ) => void;
  trackEnd: (
    player: CustomPlayer,
    track: Track | null,
    payload: TrackEndEventPayload
  ) => void;
  trackStuck: (
    player: CustomPlayer,
    track: Track | null,
    payload: TrackStuckEventPayload
  ) => void;
  trackError: (
    player: CustomPlayer,
    track: Track | UnresolvedTrack | null,
    payload: TrackExceptionEventPayload | { error: Error }
  ) => void;
  queueEnd: (
    player: CustomPlayer,
    track: Track | null,
    payload: TrackEndEventPayload | TrackStuckEventPayload | TrackExceptionEventPayload
  ) => void;
  playerCreate: (player: CustomPlayer) => void;
  playerMove: (
    player: CustomPlayer,
    oldVoiceChannelId: string,
    newVoiceChannelId: string
  ) => void;
  playerDisconnect: (player: CustomPlayer, voiceChannelId: string) => void;
  playerReconnect: (player: CustomPlayer, voiceChannelId: string) => void;
  playerSocketClosed: (
    player: CustomPlayer,
    payload: WebSocketClosedEventPayload
  ) => void;
  playerDestroy: (player: CustomPlayer, destroyReason?: DestroyReasonsType) => void;
  playerUpdate: (
    oldPlayerJson: Record<string, unknown>,
    newPlayer: CustomPlayer
  ) => void;
  playerMuteChange: (
    player: CustomPlayer,
    selfMuted: boolean,
    serverMuted: boolean
  ) => void;
  playerDeafChange: (
    player: CustomPlayer,
    selfDeafed: boolean,
    serverDeafed: boolean
  ) => void;
  playerSuppressChange: (player: CustomPlayer, suppress: boolean) => void;
  playerQueueEmptyStart: (player: CustomPlayer, timeoutMs: number) => void;
  playerQueueEmptyEnd: (player: CustomPlayer) => void;
  playerQueueEmptyCancel: (player: CustomPlayer) => void;
  playerVoiceJoin: (player: CustomPlayer, userId: string) => void;
  playerVoiceLeave: (player: CustomPlayer, userId: string) => void;
  playerNodeChange: (
    player: CustomPlayer,
    oldNode: MocylinkNode,
    newNode: MocylinkNode
  ) => void;

  // SponsorBlock Plugin Events
  SegmentsLoaded: (
    player: CustomPlayer,
    track: Track | UnresolvedTrack | null,
    payload: SegmentsLoadedEventPayload
  ) => void;
  SegmentSkipped: (
    player: CustomPlayer,
    track: Track | UnresolvedTrack | null,
    payload: SegmentSkippedEventPayload
  ) => void;
  ChaptersLoaded: (
    player: CustomPlayer,
    track: Track | UnresolvedTrack | null,
    payload: ChaptersLoadedEventPayload
  ) => void;
  ChapterStarted: (
    player: CustomPlayer,
    track: Track | UnresolvedTrack | null,
    payload: ChapterStartedEventPayload
  ) => void;

  // LavaLyrics Plugin Events
  LyricsFound: (
    player: CustomPlayer,
    track: Track | UnresolvedTrack | null,
    payload: LyricsFoundEventPayload
  ) => void;
  LyricsNotFound: (
    player: CustomPlayer,
    track: Track | UnresolvedTrack | null,
    payload: LyricsNotFoundEventPayload
  ) => void;
  LyricsLine: (
    player: CustomPlayer,
    track: Track | UnresolvedTrack | null,
    payload: LyricsLineEventPayload
  ) => void;

  // Structured Debug Event
  debug: (eventKey: DebugEvents | string, eventData: DebugEventPayload) => void;
}
