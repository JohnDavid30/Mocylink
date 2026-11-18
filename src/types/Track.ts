import type { Player } from "../structures/Player";

export type LoadTypes = "track" | "playlist" | "search" | "empty" | "error";

export type LavaSearchType = "track" | "album" | "artist" | "playlist" | "text";

export interface PluginInfo {
  type?: "album" | "playlist" | "artist" | "recommendations" | string;
  albumName?: string;
  albumUrl?: string;
  albumArtUrl?: string;
  artistUrl?: string;
  artistArtworkUrl?: string;
  previewUrl?: string;
  isPreview?: boolean;
  totalTracks?: number;
  identifier?: string;
  artworkUrl?: string;
  author?: string;
  url?: string;
  clientData?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface LavalinkTrackInfo {
  identifier: string;
  isSeekable: boolean;
  author: string;
  length: number;
  isStream: boolean;
  position: number;
  title: string;
  uri: string | null;
  artworkUrl: string | null;
  isrc: string | null;
  sourceName: string;
}

export interface TrackInfo extends Omit<LavalinkTrackInfo, "length"> {
  duration: number;
  length?: number;
}

export interface LavalinkTrack {
  encoded: string | null;
  info: LavalinkTrackInfo;
  pluginInfo: PluginInfo;
  userData?: Record<string, unknown>;
}

export interface Track<Requester = unknown> {
  encoded?: string;
  info: TrackInfo;
  pluginInfo: PluginInfo;
  requester?: Requester;
  userData?: Record<string, unknown>;
}

export interface UnresolvedQuery {
  title: string;
  author?: string;
  duration?: number;
  uri?: string | null;
  artworkUrl?: string | null;
  isrc?: string | null;
  sourceName?: string;
  identifier?: string;
  isStream?: boolean;
  isSeekable?: boolean;
  encoded?: string;
  pluginInfo?: PluginInfo;
  userData?: Record<string, unknown>;
}

export interface UnresolvedTrack<Requester = unknown> {
  encoded?: undefined;
  info: Partial<TrackInfo> & { title: string };
  pluginInfo: PluginInfo;
  userData?: Record<string, unknown>;
  requester?: Requester;
  resolve: (player: Player) => Promise<Track<Requester> | null>;
}

export interface PlaylistInfo {
  name: string;
  title: string;
  author?: string;
  thumbnail?: string;
  uri?: string;
  selectedTrack: Track | null;
  duration: number;
}

export interface Exception {
  message: string;
  severity: "common" | "suspicious" | "fault" | string;
  cause: string;
  causeStackTrace?: string;
}

export interface SearchResult {
  loadType: LoadTypes;
  exception: Exception | null;
  pluginInfo: PluginInfo;
  playlist: PlaylistInfo | null;
  tracks: Track[];
}

export interface LavaSearchPlaylistResult {
  info: {
    name: string;
    selectedTrack: number;
  };
  pluginInfo: PluginInfo;
  tracks: Track[];
}

export interface LavaSearchResult {
  tracks: Track[];
  albums: LavaSearchPlaylistResult[];
  artists: LavaSearchPlaylistResult[];
  playlists: LavaSearchPlaylistResult[];
  texts: Array<{
    text: string;
    pluginInfo: PluginInfo;
  }>;
  pluginInfo: PluginInfo;
}

/**
 * Raw Lavalink v4 `/v4/loadtracks` union response schema.
 */
export type RawLavalinkLoadResult =
  | {
      loadType: "track";
      data: LavalinkTrack;
    }
  | {
      loadType: "playlist";
      data: {
        info: {
          name: string;
          selectedTrack: number;
        };
        pluginInfo: PluginInfo;
        tracks: LavalinkTrack[];
      };
    }
  | {
      loadType: "search";
      data: LavalinkTrack[];
    }
  | {
      loadType: "empty";
      data: Record<string, never>;
    }
  | {
      loadType: "error";
      data: Exception;
    };
