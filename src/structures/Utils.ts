import { EventEmitter } from "events";
import { DebugEvents, DefaultSources, SourceLinksRegexes } from "../constants";
import type { MocylinkManager } from "./MocylinkManager";
import type { MocylinkNode } from "./MocylinkNode";
import type { Player } from "./Player";
import type {
  LavalinkTrack,
  LavaSearchQuery,
  LavaSearchType,
  PluginInfo,
  SearchQuery,
  Track,
  TrackInfo,
  UnresolvedQuery,
  UnresolvedTrack,
} from "../types";

/**
 * Strongly-typed EventEmitter base class.
 */
export class TypedEventEmitter<Events extends { [K in keyof Events]: (...args: any[]) => void }> extends EventEmitter {
  public override on<K extends keyof Events & string>(event: K, listener: Events[K]): this {
    return super.on(event, listener as (...args: any[]) => void);
  }

  public override once<K extends keyof Events & string>(event: K, listener: Events[K]): this {
    return super.once(event, listener as (...args: any[]) => void);
  }

  public override off<K extends keyof Events & string>(event: K, listener: Events[K]): this {
    return super.off(event, listener as (...args: any[]) => void);
  }

  public override removeListener<K extends keyof Events & string>(
    event: K,
    listener: Events[K]
  ): this {
    return super.removeListener(event, listener as (...args: any[]) => void);
  }

  public override emit<K extends keyof Events & string>(
    event: K,
    ...args: Parameters<Events[K]>
  ): boolean {
    return super.emit(event, ...args);
  }
}

/**
 * Lightweight Map extension with collection helpers, compatible with lavalink-client's `MiniMap`.
 */
export class MiniMap<K, V> extends Map<K, V> {
  constructor(entries?: readonly (readonly [K, V])[] | null) {
    super(entries);
  }

  public filter(predicate: (value: V, key: K, map: this) => boolean): MiniMap<K, V> {
    const results = new MiniMap<K, V>();
    for (const [key, value] of this.entries()) {
      if (predicate(value, key, this)) results.set(key, value);
    }
    return results;
  }

  public find(predicate: (value: V, key: K, map: this) => boolean): V | undefined {
    for (const [key, value] of this.entries()) {
      if (predicate(value, key, this)) return value;
    }
    return undefined;
  }

  public map<R>(fn: (value: V, key: K, map: this) => R): R[] {
    const results: R[] = [];
    for (const [key, value] of this.entries()) {
      results.push(fn(value, key, this));
    }
    return results;
  }

  public some(predicate: (value: V, key: K, map: this) => boolean): boolean {
    for (const [key, value] of this.entries()) {
      if (predicate(value, key, this)) return true;
    }
    return false;
  }

  public every(predicate: (value: V, key: K, map: this) => boolean): boolean {
    for (const [key, value] of this.entries()) {
      if (!predicate(value, key, this)) return false;
    }
    return true;
  }

  public first(): V | undefined {
    return this.values().next().value;
  }

  public last(): V | undefined {
    let lastVal: V | undefined;
    for (const val of this.values()) lastVal = val;
    return lastVal;
  }

  public reduce<Acc>(fn: (accumulator: Acc, value: V, key: K, map: this) => Acc, initialValue: Acc): Acc {
    let acc = initialValue;
    for (const [key, value] of this.entries()) {
      acc = fn(acc, value, key, this);
    }
    return acc;
  }

  public toJSON(): Array<[K, V]> {
    return [...this.entries()];
  }
}

const KNOWN_PREFIX_REGEX = /^([a-zA-Z0-9_-]{2,16}):(.+)$/s;

/**
 * Track building, query transformation, URL validation, and unresolved track resolution utilities.
 */
export class ManagerUtils {
  public readonly LavalinkManager: MocylinkManager;

  constructor(manager: MocylinkManager) {
    this.LavalinkManager = manager;
  }

  public get manager(): MocylinkManager {
    return this.LavalinkManager;
  }

  public transformRequester<T = unknown>(requester?: T): T | undefined {
    if (requester === undefined || requester === null) return undefined;
    const transformer = this.LavalinkManager.options.playerOptions?.requesterTransformer;
    if (typeof transformer === "function") {
      return transformer(requester) as T;
    }
    return requester;
  }

  public isUrl(query: string): boolean {
    return SourceLinksRegexes.AllUrlsRegex.test(query.trim());
  }

  public resolveSourcePrefix(source?: string): string {
    const fallback =
      this.LavalinkManager.options.playerOptions?.defaultSearchPlatform || "ytsearch";
    if (!source) {
      return DefaultSources[fallback.toLowerCase()] || fallback;
    }
    const normalized = source.trim().toLowerCase();
    return DefaultSources[normalized] || source.trim();
  }

  /**
   * Normalizes a string or SearchQuery object into an identifier ready for `/v4/loadtracks`.
   */
  public transformQuery(query: SearchQuery): {
    query: string;
    source: string;
    identifier: string;
    extraQueryUrlParams?: URLSearchParams;
  } {
    const rawQuery = typeof query === "string" ? query.trim() : query.query.trim();
    const explicitSource = typeof query === "object" ? query.source : undefined;
    const extraParams = typeof query === "object" ? query.extraQueryUrlParams : undefined;
    const resolvedSource = this.resolveSourcePrefix(explicitSource);

    if (this.isUrl(rawQuery)) {
      return {
        query: rawQuery,
        source: "url",
        identifier: rawQuery,
        extraQueryUrlParams: extraParams,
      };
    }

    // Check if query already starts with a search/URI prefix like ytsearch:, spotify:track:, local:, etc.
    const prefixMatch = KNOWN_PREFIX_REGEX.exec(rawQuery);
    if (prefixMatch) {
      const prefix = prefixMatch[1].toLowerCase();
      if (
        prefix === "spotify" ||
        Object.values(DefaultSources).includes(prefix) ||
        DefaultSources[prefix]
      ) {
        const mappedPrefix = prefix === "spotify" ? "spotify" : DefaultSources[prefix] || prefix;
        const remainder = prefixMatch[2];
        return {
          query: remainder,
          source: mappedPrefix,
          identifier: `${mappedPrefix}:${remainder}`,
          extraQueryUrlParams: extraParams,
        };
      }
    }

    return {
      query: rawQuery,
      source: resolvedSource,
      identifier: `${resolvedSource}:${rawQuery}`,
      extraQueryUrlParams: extraParams,
    };
  }

  /**
   * Normalizes a LavaSearch query for `/v4/loadsearch`.
   */
  public transformLavaSearchQuery(query: LavaSearchQuery | string): {
    query: string;
    source: string;
    identifier: string;
    types: LavaSearchType[];
  } {
    const validTypes: LavaSearchType[] = ["track", "album", "artist", "playlist", "text"];
    const rawQuery = typeof query === "string" ? query.trim() : query.query.trim();
    const explicitSource = typeof query === "object" ? query.source : undefined;
    const requestedTypes =
      typeof query === "object" && Array.isArray(query.types) && query.types.length > 0
        ? query.types.filter((t): t is LavaSearchType => validTypes.includes(t))
        : (["track", "album", "artist", "playlist", "text"] as LavaSearchType[]);

    const transformed = this.transformQuery({
      query: rawQuery,
      source: explicitSource,
    });

    return {
      query: transformed.query,
      source: transformed.source,
      identifier: transformed.identifier,
      types: requestedTypes,
    };
  }

  /**
   * Validates URL queries against `linksAllowed`, `linksBlacklist`, `linksWhitelist`, and node sourceManagers.
   */
  public validateQueryString(node: MocylinkNode, queryString: string): void {
    const trimmed = queryString.trim();
    if (!trimmed) {
      throw new RangeError("Query string cannot be empty.");
    }

    if (this.isUrl(trimmed)) {
      if (this.LavalinkManager.options.linksAllowed === false) {
        this.LavalinkManager._debug(DebugEvents.ValidateQueryError, {
          state: "warn",
          message: `Links are disabled in manager options: "${trimmed}"`,
          functionLayer: "ManagerUtils > validateQueryString()",
        });
        throw new Error("Direct URL links are disabled by manager configuration.");
      }

      const blacklist = this.LavalinkManager.options.linksBlacklist;
      if (Array.isArray(blacklist) && blacklist.length > 0) {
        const blocked = blacklist.some((rule) =>
          rule instanceof RegExp ? rule.test(trimmed) : trimmed.toLowerCase().includes(rule.toLowerCase())
        );
        if (blocked) {
          this.LavalinkManager._debug(DebugEvents.ValidateQueryError, {
            state: "warn",
            message: `URL matched linksBlacklist: "${trimmed}"`,
            functionLayer: "ManagerUtils > validateQueryString()",
          });
          throw new Error("This URL domain or pattern is blacklisted.");
        }
      }

      const whitelist = this.LavalinkManager.options.linksWhitelist;
      if (Array.isArray(whitelist) && whitelist.length > 0) {
        const allowed = whitelist.some((rule) =>
          rule instanceof RegExp ? rule.test(trimmed) : trimmed.toLowerCase().includes(rule.toLowerCase())
        );
        if (!allowed) {
          this.LavalinkManager._debug(DebugEvents.ValidateQueryError, {
            state: "warn",
            message: `URL did not match linksWhitelist: "${trimmed}"`,
            functionLayer: "ManagerUtils > validateQueryString()",
          });
          throw new Error("This URL domain or pattern is not whitelisted.");
        }
      }
    }

    // Optional source capability validation when node.info is already populated
    if (node.info?.sourceManagers?.length) {
      if (
        SourceLinksRegexes.SpotifyRegex.test(trimmed) &&
        !node.info.sourceManagers.includes("spotify")
      ) {
        // Still allow if user might have another plugin, only log debug warning
        this.LavalinkManager._debug(DebugEvents.ValidateQueryError, {
          state: "warn",
          message: `Node "${node.id}" does not advertise "spotify" in sourceManagers.`,
          functionLayer: "ManagerUtils > validateQueryString()",
        });
      }
    }
  }

  public isTrack(data: unknown): data is Track {
    if (!data || typeof data !== "object") return false;
    const candidate = data as Record<string, unknown>;
    return (
      typeof candidate.encoded === "string" &&
      candidate.encoded.length > 0 &&
      typeof candidate.info === "object" &&
      candidate.info !== null &&
      !("resolve" in candidate && typeof candidate.resolve === "function")
    );
  }

  public isUnresolvedTrack(data: unknown): data is UnresolvedTrack {
    if (!data || typeof data !== "object") return false;
    const candidate = data as Record<string, unknown>;
    return (
      typeof candidate.resolve === "function" &&
      typeof candidate.info === "object" &&
      candidate.info !== null
    );
  }

  /**
   * Builds a normalized `Track` instance from a Lavalink v4 track object or existing Track.
   */
  public buildTrack<Requester = unknown>(
    data: LavalinkTrack | Track<Requester>,
    requester?: Requester
  ): Track<Requester> {
    if (!data?.info) {
      this.LavalinkManager._debug(DebugEvents.BuildTrackError, {
        state: "error",
        message: "Cannot build track without `data.info`.",
        functionLayer: "ManagerUtils > buildTrack()",
      });
      throw new RangeError("Track data must include a valid `info` object.");
    }

    const rawInfo = data.info as LavalinkTrack["info"] & Partial<TrackInfo>;
    const duration =
      typeof rawInfo.duration === "number"
        ? rawInfo.duration
        : typeof rawInfo.length === "number"
          ? rawInfo.length
          : 0;

    const sourceName = rawInfo.sourceName || "unknown";
    const artworkUrl =
      rawInfo.artworkUrl ||
      (typeof data.pluginInfo?.artworkUrl === "string" ? data.pluginInfo.artworkUrl : null) ||
      (typeof data.pluginInfo?.albumArtUrl === "string" ? data.pluginInfo.albumArtUrl : null) ||
      (sourceName.toLowerCase().includes("youtube") && rawInfo.identifier
        ? `https://img.youtube.com/vi/${rawInfo.identifier}/maxresdefault.jpg`
        : null);

    const pluginInfo: PluginInfo = {
      ...(data.pluginInfo || {}),
    };

    const resolvedRequester =
      requester !== undefined
        ? this.transformRequester(requester)
        : "requester" in data
          ? this.transformRequester(data.requester)
          : undefined;

    const builtTrack: Track<Requester> = {
      encoded: data.encoded ?? undefined,
      info: {
        identifier: rawInfo.identifier ?? "",
        isSeekable: Boolean(rawInfo.isSeekable),
        author: rawInfo.author ?? "Unknown",
        duration,
        length: duration,
        isStream: Boolean(rawInfo.isStream),
        position: rawInfo.position ?? 0,
        title: rawInfo.title ?? "Unknown Title",
        uri: rawInfo.uri ?? null,
        artworkUrl,
        isrc: rawInfo.isrc ?? null,
        sourceName,
      },
      pluginInfo,
      requester: resolvedRequester,
      userData: data.userData ? { ...data.userData } : {},
    };

    return builtTrack;
  }

  /**
   * Builds a lazy-loading `UnresolvedTrack` whose `.resolve(player)` fetches the playable encoded track on demand.
   */
  public buildUnresolvedTrack<Requester = unknown>(
    query: UnresolvedQuery | UnresolvedTrack<Requester>,
    requester?: Requester
  ): UnresolvedTrack<Requester> {
    const rawInfo: Partial<TrackInfo> & { title?: string } =
      "info" in query && query.info ? query.info : (query as UnresolvedQuery);

    if (!rawInfo?.title) {
      throw new RangeError("UnresolvedTrack requires at least a `title`.");
    }

    const resolvedRequester =
      requester !== undefined
        ? this.transformRequester(requester)
        : "requester" in query
          ? this.transformRequester(query.requester)
          : undefined;

    const pluginInfo: PluginInfo = { ...(query.pluginInfo || {}) };
    const userData: Record<string, unknown> = { ...(query.userData || {}) };
    const utils = this;

    const unresolved: UnresolvedTrack<Requester> = {
      encoded: undefined,
      info: {
        title: rawInfo.title,
        author: rawInfo.author,
        duration: rawInfo.duration,
        uri: rawInfo.uri ?? undefined,
        artworkUrl: rawInfo.artworkUrl ?? null,
        isrc: rawInfo.isrc ?? null,
        sourceName: rawInfo.sourceName ?? "unresolved",
        identifier: rawInfo.identifier,
        isSeekable: rawInfo.isSeekable ?? true,
        isStream: rawInfo.isStream ?? false,
      },
      pluginInfo,
      userData,
      requester: resolvedRequester,
      async resolve(player: Player): Promise<Track<Requester> | null> {
        const closest = await utils.getClosestTrack(unresolved, player);
        if (!closest) return null;

        if (utils.LavalinkManager.options.playerOptions?.useUnresolvedData) {
          if (unresolved.info.title) closest.info.title = unresolved.info.title;
          if (unresolved.info.author) closest.info.author = unresolved.info.author;
          if (unresolved.info.uri) closest.info.uri = unresolved.info.uri;
          if (unresolved.info.artworkUrl) closest.info.artworkUrl = unresolved.info.artworkUrl;
          if (unresolved.info.isrc) closest.info.isrc = unresolved.info.isrc;
        }

        closest.requester = unresolved.requester;
        closest.userData = {
          ...closest.userData,
          ...unresolved.userData,
        };
        closest.pluginInfo = {
          ...closest.pluginInfo,
          ...unresolved.pluginInfo,
        };
        return closest as Track<Requester>;
      },
    };

    return unresolved;
  }

  /**
   * Finds the closest playable Lavalink track matching an `UnresolvedTrack`.
   */
  public async getClosestTrack<Requester = unknown>(
    unresolvedTrack: UnresolvedTrack<Requester>,
    player: Player
  ): Promise<Track<Requester> | null> {
    if (!player?.node?.connected) {
      throw new Error("Cannot resolve track because player node is not connected.");
    }

    // 1. Direct URI lookup if available and supported by node sourceManagers
    if (unresolvedTrack.info.uri && this.isUrl(unresolvedTrack.info.uri)) {
      try {
        const directRes = await player.search(
          { query: unresolvedTrack.info.uri },
          unresolvedTrack.requester,
          false
        );
        if (directRes.tracks.length > 0 && directRes.tracks[0].encoded) {
          return directRes.tracks[0] as Track<Requester>;
        }
      } catch {
        // Fall through to text/ISRC search
      }
    }

    // 2. ISRC search if present
    if (unresolvedTrack.info.isrc) {
      try {
        const isrcRes = await player.search(
          {
            query: `"${unresolvedTrack.info.isrc}"`,
            source: this.LavalinkManager.options.playerOptions?.defaultSearchPlatform,
          },
          unresolvedTrack.requester,
          false
        );
        if (isrcRes.tracks.length > 0 && isrcRes.tracks[0].encoded) {
          return isrcRes.tracks[0] as Track<Requester>;
        }
      } catch {
        // Fall through to author + title search
      }
    }

    // 3. Title + Author search with duration/author scoring
    const searchTerms = [unresolvedTrack.info.title, unresolvedTrack.info.author]
      .filter(Boolean)
      .join(" - ");

    const res = await player.search(
      {
        query: searchTerms,
        source: this.LavalinkManager.options.playerOptions?.defaultSearchPlatform,
      },
      unresolvedTrack.requester,
      false
    );

    if (!res.tracks.length) return null;

    const targetDuration = unresolvedTrack.info.duration;
    const targetAuthor = unresolvedTrack.info.author?.toLowerCase();

    if (!targetDuration && !targetAuthor) {
      return (res.tracks[0] as Track<Requester>) ?? null;
    }

    const scored = res.tracks
      .filter((t) => Boolean(t.encoded))
      .slice(0, 10)
      .map((candidate, index) => {
        let score = index * 2; // Slight preference for higher search rank
        if (targetDuration && candidate.info.duration) {
          score += Math.abs(candidate.info.duration - targetDuration) / 1000;
        }
        if (targetAuthor && candidate.info.author.toLowerCase().includes(targetAuthor)) {
          score -= 5;
        }
        return { candidate, score };
      })
      .sort((a, b) => a.score - b.score);

    return (scored[0]?.candidate as Track<Requester>) ?? (res.tracks[0] as Track<Requester>) ?? null;
  }
}
