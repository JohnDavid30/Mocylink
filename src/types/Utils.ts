export interface VoiceServer {
  token: string;
  guild_id: string;
  endpoint: string;
}

export interface VoiceStatePacket {
  guild_id?: string;
  channel_id: string | null;
  user_id: string;
  session_id: string;
  deaf?: boolean;
  mute?: boolean;
  self_deaf?: boolean;
  self_mute?: boolean;
  self_video?: boolean;
  suppress?: boolean;
}

export type VoicePacket =
  | {
      t: "VOICE_SERVER_UPDATE";
      d: VoiceServer;
    }
  | {
      t: "VOICE_STATE_UPDATE";
      d: VoiceStatePacket;
    }
  | {
      t: "CHANNEL_DELETE";
      d: {
        id: string;
        guild_id?: string;
      };
    }
  | {
      t?: string;
      d?: unknown;
    };

export interface DiscordGatewayVoicePayload {
  op: 4;
  d: {
    guild_id: string;
    channel_id: string | null;
    self_mute: boolean;
    self_deaf: boolean;
  };
}

export type SearchPlatform =
  | "ytsearch"
  | "ytmsearch"
  | "scsearch"
  | "bcsearch"
  | "spsearch"
  | "sprec"
  | "amsearch"
  | "dzsearch"
  | "dzisrc"
  | "dzrec"
  | "ymsearch"
  | "ymrec"
  | "vksearch"
  | "tdsearch"
  | "tdrec"
  | "qbsearch"
  | "qbisrc"
  | "qbrec"
  | "jssearch"
  | "jsrec"
  | "ftts"
  | "speak"
  | "tts"
  | "local"
  | "youtube"
  | "yt"
  | "youtube music"
  | "youtubemusic"
  | "ytm"
  | "soundcloud"
  | "sc"
  | "bandcamp"
  | "bc"
  | "spotify"
  | "sp"
  | "applemusic"
  | "apple music"
  | "am"
  | "deezer"
  | "dz"
  | "yandexmusic"
  | "yandex music"
  | "ym"
  | "tidal"
  | "td"
  | "qobuz"
  | "qb"
  | "jiosaavn"
  | "js"
  | "flowery"
  | (string & {});

export type SearchQuery =
  | string
  | {
      query: string;
      extraQueryUrlParams?: URLSearchParams;
      source?: SearchPlatform;
    };

export interface LavaSearchQuery {
  query: string;
  source?: SearchPlatform;
  types?: Array<"track" | "album" | "artist" | "playlist" | "text">;
}
