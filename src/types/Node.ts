import type { MocylinkNode } from "../structures/MocylinkNode";
import type { LavalinkFilterData } from "./Filters";
import type { Exception, LavalinkTrack, PluginInfo } from "./Track";

export interface MocylinkNodeOptions {
  /** Unique identifier for this node (defaults to `${host}:${port}`). */
  id?: string;
  /** Optional alias for `id` for legacy compatibility. */
  name?: string;
  /** Hostname or IP address without protocol. */
  host: string;
  /** Lavalink server port (default: 2333). */
  port?: number;
  /** Lavalink server password (`Authorization` header). */
  authorization?: string;
  /** Legacy alias for `authorization`. */
  password?: string;
  /** Use `wss://` and `https://` when true. */
  secure?: boolean;
  /** Existing Lavalink v4 sessionId to resume immediately on connect. */
  sessionId?: string;
  /** Discord voice regions preferred for this node. */
  regions?: string[];
  /** Maximum reconnection attempts before giving up (default: 5). */
  retryAmount?: number;
  /** Milliseconds between reconnection attempts (default: 10000). */
  retryDelay?: number;
  /** Timeout in ms for REST HTTP requests (default: 10000). */
  requestSignalTimeoutMS?: number;
  /** Force close the WebSocket when a socket error occurs. */
  closeOnError?: boolean;
  /** Interval in ms for WebSocket ping heartbeats (default: 30000). */
  heartBeatInterval?: number;
  /** Configure Lavalink v4 session resuming automatically on ready. */
  resuming?: {
    enabled: boolean;
    timeoutSeconds?: number;
  };
}

export type LavalinkNodeOptions = MocylinkNodeOptions;

export interface MemoryStats {
  free: number;
  used: number;
  allocated: number;
  reservable: number;
}

export interface CPUStats {
  cores: number;
  systemLoad: number;
  lavalinkLoad: number;
}

export interface FrameStats {
  sent: number;
  nulled: number;
  deficit: number;
}

export interface BaseNodeStats {
  players: number;
  playingPlayers: number;
  uptime: number;
  memory: MemoryStats;
  cpu: CPUStats;
  frameStats?: FrameStats | null;
}

export interface NodeStats extends BaseNodeStats {
  frameStats: FrameStats | null;
}

export interface LavalinkInfo {
  version: {
    semver: string;
    major: number;
    minor: number;
    patch: number;
    preRelease?: string | null;
    build?: string | null;
  };
  buildTime: number;
  git: {
    branch: string;
    commit: string;
    commitTime: number;
  };
  jvm: string;
  lavaplayer: string;
  sourceManagers: string[];
  filters: string[];
  plugins: Array<{
    name: string;
    version: string;
  }>;
}

export interface LavalinkPlayerVoice {
  token: string;
  endpoint: string;
  sessionId: string;
  channelId?: string;
}

export interface LavalinkPlayerObject {
  guildId: string;
  track?: LavalinkTrack | null;
  volume: number;
  paused: boolean;
  state: {
    time: number;
    position: number;
    connected: boolean;
    ping: number;
  };
  voice: LavalinkPlayerVoice;
  filters: LavalinkFilterData;
}

export interface UpdatePlayerTrackOptions {
  encoded?: string | null;
  identifier?: string;
  userData?: Record<string, unknown>;
}

export interface LavalinkPlayOptions {
  track?: UpdatePlayerTrackOptions;
  /** Deprecated Lavalink v4.0 field, still supported for older v4 servers if explicitly passed. */
  encodedTrack?: string | null;
  identifier?: string;
  position?: number;
  endTime?: number | null;
  volume?: number;
  paused?: boolean;
  filters?: Partial<LavalinkFilterData>;
  voice?: LavalinkPlayerVoice;
}

export interface UpdatePlayerInfo {
  guildId: string;
  playerOptions: LavalinkPlayOptions;
  noReplace?: boolean;
}

export type SponsorBlockCategory =
  | "sponsor"
  | "selfpromo"
  | "interaction"
  | "intro"
  | "outro"
  | "preview"
  | "music_offtopic"
  | "filler";

export interface SponsorBlockSegment {
  category: SponsorBlockCategory | string;
  start: number;
  end: number;
}

export interface SponsorBlockChapter {
  name: string;
  start: number;
  end: number;
  duration: number;
}

export interface LyricsLine {
  timestamp: number;
  duration: number | null;
  line: string;
  plugin: PluginInfo;
}

export interface LyricsResult {
  sourceName: string;
  provider: string;
  text: string | null;
  lines: LyricsLine[];
  plugin: PluginInfo;
}

export interface RoutePlannerStatus {
  class: string | null;
  details: {
    ipBlock?: {
      type: string;
      size: string;
    };
    failingAddresses?: Array<{
      failingAddress: string;
      failingTimestamp: number;
      failingTime: string;
    }>;
    rotateIndex?: string;
    ipIndex?: string;
    currentAddress?: string;
    currentAddressIndex?: string;
    blockIndex?: string;
  } | null;
}

export type TrackEndReason = "finished" | "loadFailed" | "stopped" | "replaced" | "cleanup";

export interface TrackStartEventPayload {
  op: "event";
  type: "TrackStartEvent";
  guildId: string;
  track: LavalinkTrack;
}

export interface TrackEndEventPayload {
  op: "event";
  type: "TrackEndEvent";
  guildId: string;
  track: LavalinkTrack;
  reason: TrackEndReason;
}

export interface TrackExceptionEventPayload {
  op: "event";
  type: "TrackExceptionEvent";
  guildId: string;
  track: LavalinkTrack;
  exception: Exception;
}

export interface TrackStuckEventPayload {
  op: "event";
  type: "TrackStuckEvent";
  guildId: string;
  track: LavalinkTrack;
  thresholdMs: number;
}

export interface WebSocketClosedEventPayload {
  op: "event";
  type: "WebSocketClosedEvent";
  guildId: string;
  code: number;
  reason: string;
  byRemote: boolean;
}

export interface SegmentsLoadedEventPayload {
  op: "event";
  type: "SegmentsLoaded";
  guildId: string;
  segments: SponsorBlockSegment[];
}

export interface SegmentSkippedEventPayload {
  op: "event";
  type: "SegmentSkipped";
  guildId: string;
  segment: SponsorBlockSegment;
}

export interface ChaptersLoadedEventPayload {
  op: "event";
  type: "ChaptersLoaded";
  guildId: string;
  chapters: SponsorBlockChapter[];
}

export interface ChapterStartedEventPayload {
  op: "event";
  type: "ChapterStarted";
  guildId: string;
  chapter: SponsorBlockChapter;
}

export interface LyricsFoundEventPayload {
  op: "event";
  type: "LyricsFoundEvent";
  guildId: string;
  lyrics: LyricsResult;
}

export interface LyricsNotFoundEventPayload {
  op: "event";
  type: "LyricsNotFoundEvent";
  guildId: string;
}

export interface LyricsLineEventPayload {
  op: "event";
  type: "LyricsLineEvent";
  guildId: string;
  lineIndex: number;
  line: LyricsLine;
  skipped: boolean;
}

export type LavalinkEventPayload =
  | TrackStartEventPayload
  | TrackEndEventPayload
  | TrackExceptionEventPayload
  | TrackStuckEventPayload
  | WebSocketClosedEventPayload
  | SegmentsLoadedEventPayload
  | SegmentSkippedEventPayload
  | ChaptersLoadedEventPayload
  | ChapterStartedEventPayload
  | LyricsFoundEventPayload
  | LyricsNotFoundEventPayload
  | LyricsLineEventPayload;

export type LavalinkWSMessage =
  | {
      op: "ready";
      resumed: boolean;
      sessionId: string;
    }
  | ({
      op: "stats";
    } & BaseNodeStats)
  | {
      op: "playerUpdate";
      guildId: string;
      state: {
        time: number;
        position: number;
        connected: boolean;
        ping: number;
      };
    }
  | LavalinkEventPayload;

export type LeastUsedNodeSortType =
  | "default"
  | "memory"
  | "cpuLavalink"
  | "cpuSystem"
  | "calls"
  | "playingPlayers"
  | "players";

export interface NodeManagerEvents {
  create: (node: MocylinkNode) => void;
  destroy: (node: MocylinkNode, destroyReason?: string) => void;
  connect: (node: MocylinkNode) => void;
  reconnecting: (node: MocylinkNode) => void;
  reconnectinprogress: (node: MocylinkNode) => void;
  disconnect: (node: MocylinkNode, reason: { code?: number; reason?: string }) => void;
  error: (node: MocylinkNode, error: Error, payload?: unknown) => void;
  raw: (node: MocylinkNode, payload: unknown) => void;
  resumed: (
    node: MocylinkNode,
    payload: { op: "ready"; resumed: true; sessionId: string },
    players: LavalinkPlayerObject[]
  ) => void;
}
