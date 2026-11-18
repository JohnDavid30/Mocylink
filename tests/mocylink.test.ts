import http from "node:http";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import {
  AudioOutputsData,
  DefaultQueueStore,
  DestroyReasons,
  EQList,
  FilterManager,
  LavalinkManager,
  LavalinkNode,
  Mocylink,
  MocylinkFilterManager,
  MocylinkManager,
  MocylinkNode,
  MocylinkNodeManager,
  MocylinkPlayer,
  MocylinkQueue,
  NodeManager,
  Player,
  Queue,
  type LavalinkTrack,
  type QueueStoreManager,
  type StoredQueue,
} from "../src";

interface RecordedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}

const SAMPLE_TRACK_1: LavalinkTrack = {
  encoded: "QAAAjQIAJVJpY2sgQXN0bGV5IC0gTmV2ZXIgR29ubmEgR2l2ZSBZb3UgVXAAAAAOdGVzdC1hdXRob3ItMQAAAAMnEA==",
  info: {
    identifier: "dQw4w9WgXcQ",
    isSeekable: true,
    author: "Rick Astley",
    length: 212000,
    isStream: false,
    position: 0,
    title: "Never Gonna Give You Up",
    uri: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    artworkUrl: null,
    isrc: "GBARL9300135",
    sourceName: "youtube",
  },
  pluginInfo: {},
  userData: {},
};

const SAMPLE_TRACK_2: LavalinkTrack = {
  encoded: "QAAAjQIAFURhZnQgUHVua25hIC0gT25lIE1vcmUgVGltZQAAAABkYWZ0LXB1bmsAAAAD6D==",
  info: {
    identifier: "FGBhQbmPwH8",
    isSeekable: true,
    author: "Daft Punk",
    length: 320000,
    isStream: false,
    position: 0,
    title: "One More Time",
    uri: "https://www.youtube.com/watch?v=FGBhQbmPwH8",
    artworkUrl: "https://example.com/daft.jpg",
    isrc: "GBDUW0000053",
    sourceName: "youtube",
  },
  pluginInfo: {
    albumName: "Discovery",
  },
  userData: {},
};

class MockLavalinkV4Server {
  public httpServer!: http.Server;
  public wss!: WebSocketServer;
  public port = 0;
  public sessionId = "mock-session-v4-123";
  public requests: RecordedRequest[] = [];
  public wsHeaders: http.IncomingHttpHeaders | null = null;
  public clients = new Set<WsSocket>();
  public sponsorBlockCategories = new Map<string, string[]>();

  public async start(): Promise<number> {
    this.httpServer = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const rawBody = Buffer.concat(chunks).toString("utf8");
      let parsedBody: unknown = undefined;
      if (rawBody) {
        try {
          parsedBody = JSON.parse(rawBody);
        } catch {
          parsedBody = rawBody;
        }
      }

      const urlObj = new URL(req.url || "/", `http://127.0.0.1`);
      this.requests.push({
        method: req.method || "GET",
        url: req.url || "/",
        headers: req.headers,
        body: parsedBody,
      });

      const sendJson = (status: number, data: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      };

      // Route handling
      if (urlObj.pathname === "/version") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("4.0.8");
        return;
      }

      if (urlObj.pathname === "/v4/info") {
        sendJson(200, {
          version: { semver: "4.0.8", major: 4, minor: 0, patch: 8 },
          buildTime: Date.now(),
          git: { branch: "main", commit: "abcdef", commitTime: Date.now() },
          jvm: "21.0.2",
          lavaplayer: "2.2.1",
          sourceManagers: ["youtube", "soundcloud", "spotify", "http"],
          filters: ["equalizer", "karaoke", "timescale", "tremolo", "vibrato", "rotation", "distortion", "channelMix", "lowPass"],
          plugins: [
            { name: "sponsorblock-plugin", version: "3.0.1" },
            { name: "lavalyrics-plugin", version: "1.0.0" },
            { name: "lavasearch-plugin", version: "1.0.0" },
            { name: "lavasrc-plugin", version: "4.2.0" },
          ],
        });
        return;
      }

      if (urlObj.pathname === "/v4/stats") {
        sendJson(200, {
          players: 1,
          playingPlayers: 1,
          uptime: 60000,
          memory: { free: 100, used: 200, allocated: 300, reservable: 400 },
          cpu: { cores: 4, systemLoad: 0.12, lavalinkLoad: 0.05 },
          frameStats: { sent: 3000, nulled: 0, deficit: 0 },
        });
        return;
      }

      if (urlObj.pathname === `/v4/sessions/${this.sessionId}` && req.method === "PATCH") {
        const body = (parsedBody || {}) as { resuming?: boolean; timeout?: number };
        sendJson(200, {
          resuming: Boolean(body.resuming),
          timeout: body.timeout ?? 60,
        });
        return;
      }

      if (urlObj.pathname === "/v4/loadtracks") {
        const identifier = urlObj.searchParams.get("identifier") || "";
        if (identifier.includes("empty-query")) {
          sendJson(200, { loadType: "empty", data: {} });
          return;
        }
        if (identifier.includes("playlist")) {
          sendJson(200, {
            loadType: "playlist",
            data: {
              info: { name: "Synth Classics", selectedTrack: 0 },
              pluginInfo: { author: "Curator", url: "https://open.spotify.com/playlist/123" },
              tracks: [SAMPLE_TRACK_1, SAMPLE_TRACK_2],
            },
          });
          return;
        }
        sendJson(200, {
          loadType: "search",
          data: [SAMPLE_TRACK_1, SAMPLE_TRACK_2],
        });
        return;
      }

      if (urlObj.pathname === "/v4/loadsearch") {
        sendJson(200, {
          tracks: [SAMPLE_TRACK_2],
          albums: [
            {
              info: { name: "Discovery", selectedTrack: -1 },
              pluginInfo: { author: "Daft Punk" },
              tracks: [SAMPLE_TRACK_2],
            },
          ],
          artists: [],
          playlists: [],
          texts: [{ text: "Top result", pluginInfo: {} }],
          plugin: {},
        });
        return;
      }

      if (urlObj.pathname === "/v4/decodetrack") {
        sendJson(200, SAMPLE_TRACK_1);
        return;
      }

      if (urlObj.pathname === "/v4/decodetracks" && req.method === "POST") {
        sendJson(200, [SAMPLE_TRACK_1, SAMPLE_TRACK_2]);
        return;
      }

      if (urlObj.pathname === "/v4/lyrics") {
        sendJson(200, {
          sourceName: "youtube",
          provider: "lrclib",
          text: "We're no strangers to love",
          lines: [{ timestamp: 18000, duration: 4000, line: "We're no strangers to love", plugin: {} }],
          plugin: {},
        });
        return;
      }

      const sbMatch = /^\/v4\/sessions\/([^/]+)\/players\/([^/]+)\/sponsorblock\/categories$/.exec(
        urlObj.pathname
      );
      if (sbMatch) {
        const guildId = sbMatch[2];
        if (req.method === "PUT") {
          this.sponsorBlockCategories.set(guildId, parsedBody as string[]);
          res.writeHead(204);
          res.end();
          return;
        }
        if (req.method === "GET") {
          sendJson(200, this.sponsorBlockCategories.get(guildId) || []);
          return;
        }
        if (req.method === "DELETE") {
          this.sponsorBlockCategories.delete(guildId);
          res.writeHead(204);
          res.end();
          return;
        }
      }

      const curLyricsMatch = /^\/v4\/sessions\/([^/]+)\/players\/([^/]+)\/track\/lyrics$/.exec(
        urlObj.pathname
      );
      if (curLyricsMatch) {
        sendJson(200, {
          sourceName: "youtube",
          provider: "lrclib",
          text: "Never gonna give you up",
          lines: [{ timestamp: 43000, duration: 3500, line: "Never gonna give you up", plugin: {} }],
          plugin: {},
        });
        return;
      }

      const subLyricsMatch = /^\/v4\/sessions\/([^/]+)\/players\/([^/]+)\/lyrics\/subscribe$/.exec(
        urlObj.pathname
      );
      if (subLyricsMatch) {
        res.writeHead(204);
        res.end();
        return;
      }

      if (urlObj.pathname === "/v4/routeplanner/status") {
        sendJson(200, { class: "RotatingNanoIpRoutePlanner", details: { ipIndex: "1" } });
        return;
      }

      if (urlObj.pathname.startsWith("/v4/routeplanner/free/")) {
        res.writeHead(204);
        res.end();
        return;
      }

      const playerMatch = /^\/v4\/sessions\/([^/]+)\/players\/([^/]+)$/.exec(urlObj.pathname);
      if (playerMatch) {
        const guildId = playerMatch[2];
        if (req.method === "DELETE") {
          res.writeHead(204);
          res.end();
          return;
        }
        if (req.method === "PATCH" || req.method === "GET") {
          const body = (parsedBody || {}) as Record<string, unknown>;
          sendJson(200, {
            guildId,
            track: SAMPLE_TRACK_1,
            volume: typeof body.volume === "number" ? body.volume : 100,
            paused: Boolean(body.paused),
            state: { time: Date.now(), position: typeof body.position === "number" ? body.position : 0, connected: true, ping: 18 },
            voice: body.voice || { token: "tok", endpoint: "us-east.discord.media", sessionId: "sess" },
            filters: body.filters || {},
          });
          return;
        }
      }

      if (urlObj.pathname === `/v4/sessions/${this.sessionId}/players`) {
        sendJson(200, []);
        return;
      }

      sendJson(404, { message: `Unhandled mock path ${urlObj.pathname}` });
    });

    this.wss = new WebSocketServer({ server: this.httpServer, path: "/v4/websocket" });
    this.wss.on("connection", (socket, req) => {
      this.wsHeaders = req.headers;
      this.clients.add(socket);
      const resumed = req.headers["session-id"] === this.sessionId;
      socket.send(
        JSON.stringify({
          op: "ready",
          resumed,
          sessionId: this.sessionId,
        })
      );
      socket.on("close", () => {
        this.clients.delete(socket);
      });
    });

    await new Promise<void>((resolve) => {
      this.httpServer.listen(0, "127.0.0.1", () => resolve());
    });

    const addr = this.httpServer.address();
    this.port = typeof addr === "object" && addr ? addr.port : 0;
    return this.port;
  }

  public broadcast(payload: unknown): void {
    const json = JSON.stringify(payload);
    for (const client of this.clients) {
      client.send(json);
    }
  }

  public async stop(): Promise<void> {
    for (const client of this.clients) {
      client.terminate();
    }
    this.clients.clear();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.httpServer.close(() => resolve()));
  }
}

describe("Mocylink v2 (lavalink-client compatible Lavalink v4 suite)", () => {
  let server: MockLavalinkV4Server;
  let shardPayloads: Array<{ guildId: string; payload: unknown }>;
  let manager: MocylinkManager;

  beforeEach(async () => {
    server = new MockLavalinkV4Server();
    await server.start();
    shardPayloads = [];
  });

  afterEach(async () => {
    if (manager) {
      await manager.nodeManager.disconnectAll(true, true);
    }
    await server.stop();
  });

  it("exports both Mocylink-branded classes and lavalink-client drop-in aliases (ESM & CJS)", async () => {
    expect(MocylinkManager).toBe(LavalinkManager);
    expect(Mocylink).toBe(LavalinkManager);
    expect(MocylinkNodeManager).toBe(NodeManager);
    expect(MocylinkNode).toBe(LavalinkNode);
    expect(MocylinkPlayer).toBe(Player);
    expect(MocylinkQueue).toBe(Queue);
    expect(MocylinkFilterManager).toBe(FilterManager);
    expect(EQList.BassboostHigh.length).toBeGreaterThan(10);
    expect(AudioOutputsData.mono.leftToRight).toBe(0.5);

    // Verify compiled CJS bundle loads cleanly
    const require = createRequire(import.meta.url);
    const cjsBundle = require("../dist/index.cjs");
    expect(cjsBundle.MocylinkManager).toBeDefined();
    expect(cjsBundle.LavalinkManager).toBe(cjsBundle.MocylinkManager);
  });

  it("connects to Lavalink v4 /v4/websocket, configures session resuming, and fetches node info", async () => {
    manager = new MocylinkManager({
      nodes: [
        {
          id: "primary-node",
          host: "127.0.0.1",
          port: server.port,
          authorization: "youshallnotpass",
          resuming: { enabled: true, timeoutSeconds: 90 },
        },
      ],
      sendToShard: (guildId, payload) => {
        shardPayloads.push({ guildId, payload });
      },
      client: { id: "123456789012345678", username: "MocyBot" },
    });

    const connectedNode = await new Promise<MocylinkNode>((resolve) => {
      manager.nodeManager.once("connect", (node) => resolve(node));
      void manager.init({ id: "123456789012345678", username: "MocyBot" });
    });

    expect(connectedNode.id).toBe("primary-node");
    expect(connectedNode.sessionId).toBe(server.sessionId);
    expect(connectedNode.info?.version.semver).toBe("4.0.8");
    expect(server.wsHeaders?.["user-id"]).toBe("123456789012345678");
    expect(server.wsHeaders?.["authorization"]).toBe("youshallnotpass");
    expect(String(server.wsHeaders?.["client-name"])).toContain("Mocylink/2.0.0");

    const sessionPatch = server.requests.find(
      (r) => r.method === "PATCH" && r.url === `/v4/sessions/${server.sessionId}`
    );
    expect(sessionPatch).toBeDefined();
    expect(sessionPatch?.body).toEqual({ resuming: true, timeout: 90 });

    const ver = await connectedNode.fetchVersion();
    expect(ver).toBe("4.0.8");
    const stats = await connectedNode.fetchStats();
    expect(stats.players).toBe(1);
    expect(manager.nodeManager.leastUsedNodes()[0].id).toBe("primary-node");
  });

  it("handles voice connection, raw gateway voice updates, search, queue, playback, and filters", async () => {
    manager = new LavalinkManager({
      nodes: [
        {
          id: "main",
          host: "127.0.0.1",
          port: server.port,
          authorization: "youshallnotpass",
        },
      ],
      sendToShard: (guildId, payload) => {
        shardPayloads.push({ guildId, payload });
      },
      playerOptions: {
        defaultSearchPlatform: "ytmsearch",
        requesterTransformer: (req: any) => ({ id: req.id, tag: req.tag }),
      },
    });

    await new Promise<void>((resolve) => {
      manager.nodeManager.once("connect", () => resolve());
      void manager.init({ id: "999888777666555444" });
    });

    const player = manager.createPlayer({
      guildId: "guild-1",
      voiceChannelId: "vc-1",
      textChannelId: "tc-1",
      selfDeaf: true,
      volume: 85,
    });

    player.set("requestedByCommand", "/play");
    expect(player.get("requestedByCommand")).toBe("/play");

    await player.connect();
    expect(shardPayloads[0]).toEqual({
      guildId: "guild-1",
      payload: {
        op: 4,
        d: {
          guild_id: "guild-1",
          channel_id: "vc-1",
          self_mute: false,
          self_deaf: true,
        },
      },
    });

    // Simulate Discord Gateway VOICE_STATE_UPDATE & VOICE_SERVER_UPDATE
    await manager.sendRawData({
      t: "VOICE_STATE_UPDATE",
      d: {
        guild_id: "guild-1",
        channel_id: "vc-1",
        user_id: "999888777666555444",
        session_id: "discord-voice-session-abc",
        self_deaf: true,
        self_mute: false,
      },
    });
    await manager.sendRawData({
      t: "VOICE_SERVER_UPDATE",
      d: {
        guild_id: "guild-1",
        token: "discord-voice-token-xyz",
        endpoint: "rotterdam1234.discord.media:443",
      },
    });

    const voiceRestCall = server.requests.find(
      (r) =>
        r.method === "PATCH" &&
        r.url.startsWith(`/v4/sessions/${server.sessionId}/players/guild-1`) &&
        Boolean((r.body as any)?.voice)
    );
    expect((voiceRestCall?.body as any)?.voice).toEqual({
      token: "discord-voice-token-xyz",
      endpoint: "rotterdam1234.discord.media:443",
      sessionId: "discord-voice-session-abc",
      channelId: "vc-1",
    });

    // Search & Queue
    const searchRes = await player.search(
      { query: "Never Gonna Give You Up" },
      { id: "u1", tag: "Alice#0001", extraHeavyField: "ignored" }
    );
    expect(searchRes.loadType).toBe("search");
    expect(searchRes.tracks.length).toBe(2);
    expect(searchRes.tracks[0].requester).toEqual({ id: "u1", tag: "Alice#0001" });
    expect(searchRes.tracks[0].info.artworkUrl).toContain("dQw4w9WgXcQ");

    await player.queue.add(searchRes.tracks);
    expect(player.queue.size).toBe(2);

    // Play first track
    await player.play();
    expect(player.playing).toBe(true);
    expect(player.queue.current?.info.title).toBe("Never Gonna Give You Up");
    expect(player.queue.size).toBe(1);

    // Emit TrackStartEvent from Lavalink WS
    const startedPromise = new Promise<string>((resolve) => {
      manager.once("trackStart", (_p, track) => resolve(track?.info.title || ""));
    });
    server.broadcast({
      op: "event",
      type: "TrackStartEvent",
      guildId: "guild-1",
      track: SAMPLE_TRACK_1,
    });
    expect(await startedPromise).toBe("Never Gonna Give You Up");

    // Pause, Resume, Seek, Volume, Filters
    await player.pause();
    expect(player.paused).toBe(true);
    await player.resume();
    expect(player.paused).toBe(false);

    await player.seek(45_000);
    expect(player.lastPosition).toBe(45_000);

    await player.setVolume(120);
    expect(player.volume).toBe(120);

    await player.filterManager.setEQ(EQList.BassboostLow);
    expect(player.filterManager.equalizerBands.length).toBe(EQList.BassboostLow.length);

    await player.filterManager.toggleNightcore();
    expect(player.filterManager.filters.nightcore).toBe(true);

    await player.filterManager.toggle8D();
    expect(player.filterManager.filters.rotation).toBe(true);

    await player.filterManager.setAudioOutput("mono");
    expect(player.filterManager.filters.audioOutput).toBe("mono");

    await player.filterManager.lavalinkLavaDspxPlugin.toggleEcho({ delay: 0.4, decay: 0.6 });
    expect(player.filterManager.filters.lavadspx.echo).toBe(true);

    await player.filterManager.resetFilters();
    expect(player.filterManager.filters.nightcore).toBe(false);
    expect(player.filterManager.equalizerBands.length).toBe(0);
  });

  it("supports UnresolvedTrack lazy resolution, custom QueueStore rehydration, repeat modes, and autoplay", async () => {
    const externalBacking = new Map<string, string>();
    const customStore: QueueStoreManager = {
      get: async (guildId) => externalBacking.get(guildId),
      set: async (guildId, val) => {
        externalBacking.set(guildId, typeof val === "string" ? val : JSON.stringify(val));
        return true;
      },
      delete: async (guildId) => externalBacking.delete(guildId),
      stringify: (val) => (typeof val === "string" ? val : JSON.stringify(val)),
      parse: (val) => (val ? (typeof val === "string" ? (JSON.parse(val) as StoredQueue) : val) : {}),
    };

    let autoplayCalled = false;

    manager = new MocylinkManager({
      nodes: [{ id: "n1", host: "127.0.0.1", port: server.port, authorization: "youshallnotpass" }],
      sendToShard: () => {},
      queueOptions: { queueStore: customStore },
      playerOptions: {
        minAutoPlayMs: 0,
        useUnresolvedData: true,
        onEmptyQueue: {
          autoPlayFunction: async (p) => {
            autoplayCalled = true;
            const res = await p.search("Daft Punk");
            if (res.tracks[1]) await p.queue.add(res.tracks[1]);
          },
        },
      },
    });

    await new Promise<void>((resolve) => {
      manager.nodeManager.once("connect", () => resolve());
      void manager.init({ id: "111222333" });
    });

    const player = manager.createPlayer({ guildId: "guild-lazy", voiceChannelId: "vc-lazy" });

    const unresolved = manager.utils.buildUnresolvedTrack(
      {
        title: "Custom Spotify Track Title",
        author: "Rick Astley",
        duration: 212000,
        artworkUrl: "https://spotify.cdn/cover.png",
      },
      { id: "user-42" }
    );

    await player.queue.add(unresolved);
    // Simulate re-syncing from external Redis/JSON store (where `.resolve` function was stripped during JSON.stringify)
    await player.queue.utils.sync(true, true);
    expect(player.queue.size).toBe(1);

    await player.play();
    expect(player.queue.current?.encoded).toBe(SAMPLE_TRACK_1.encoded);
    expect(player.queue.current?.info.title).toBe("Custom Spotify Track Title");
    expect(player.queue.current?.requester).toEqual({ id: "user-42" });

    // Trigger TrackEndEvent ("finished") -> should invoke autoPlayFunction and start playing next track
    const endedAndAutoplayed = new Promise<void>((resolve) => {
      manager.on("trackEnd", () => {
        setTimeout(() => resolve(), 30);
      });
    });

    server.broadcast({
      op: "event",
      type: "TrackEndEvent",
      guildId: "guild-lazy",
      track: SAMPLE_TRACK_1,
      reason: "finished",
    });

    await endedAndAutoplayed;
    expect(autoplayCalled).toBe(true);
    expect(player.queue.current?.info.title).toBe("One More Time");
  });

  it("supports Lavalink v4 Plugins: SponsorBlock, LavaLyrics, LavaSearch, and RoutePlanner", async () => {
    manager = new MocylinkManager({
      nodes: [{ id: "plug-node", host: "127.0.0.1", port: server.port, authorization: "youshallnotpass" }],
      sendToShard: () => {},
    });

    await new Promise<void>((resolve) => {
      manager.nodeManager.once("connect", () => resolve());
      void manager.init({ id: "555666777" });
    });

    const player = manager.createPlayer({ guildId: "guild-plug", voiceChannelId: "vc-plug" });

    // 1. SponsorBlock REST + WS Events
    await player.setSponsorBlock(["sponsor", "intro", "outro"]);
    const categories = await player.getSponsorBlock();
    expect(categories).toEqual(["sponsor", "intro", "outro"]);

    const segmentSkippedPromise = new Promise<string>((resolve) => {
      manager.once("SegmentSkipped", (_p, _t, payload) => resolve(payload.segment.category));
    });
    server.broadcast({
      op: "event",
      type: "SegmentSkipped",
      guildId: "guild-plug",
      segment: { category: "sponsor", start: 10000, end: 25000 },
    });
    expect(await segmentSkippedPromise).toBe("sponsor");

    await player.deleteSponsorBlock();
    expect(await player.getSponsorBlock()).toEqual([]);

    // 2. LavaLyrics REST + WS Events
    const curLyrics = await player.getCurrentLyrics();
    expect(curLyrics?.lines[0].line).toBe("Never gonna give you up");

    const trackLyrics = await player.getLyrics(SAMPLE_TRACK_1.encoded!);
    expect(trackLyrics?.text).toBe("We're no strangers to love");

    await player.subscribeLyrics();
    const linePromise = new Promise<string>((resolve) => {
      manager.once("LyricsLine", (_p, _t, payload) => resolve(payload.line.line));
    });
    server.broadcast({
      op: "event",
      type: "LyricsLineEvent",
      guildId: "guild-plug",
      lineIndex: 0,
      line: { timestamp: 18000, duration: 4000, line: "We're no strangers to love", plugin: {} },
      skipped: false,
    });
    expect(await linePromise).toBe("We're no strangers to love");
    await player.unsubscribeLyrics();

    // 3. LavaSearch
    const lavaSearchRes = await player.lavaSearch({
      query: "Discovery",
      source: "spsearch",
      types: ["track", "album"],
    });
    expect(lavaSearchRes.albums[0].info.name).toBe("Discovery");
    expect(lavaSearchRes.tracks[0].info.author).toBe("Daft Punk");

    // 4. RoutePlanner & Decode
    const rp = await player.node.routePlanner.getStatus();
    expect(rp.class).toBe("RotatingNanoIpRoutePlanner");
    await player.node.routePlanner.unmarkFailedAddress("1.2.3.4");
    await player.node.routePlanner.unmarkAllFailedAddresses();

    const decoded = await player.node.decode.multipleTracks([
      SAMPLE_TRACK_1.encoded!,
      SAMPLE_TRACK_2.encoded!,
    ]);
    expect(decoded.length).toBe(2);

    // 5. Destroy with explicit DestroyReasons
    const destroyReasonPromise = new Promise<string | undefined>((resolve) => {
      manager.once("playerDestroy", (_p, reason) => resolve(reason));
    });
    await player.destroy(DestroyReasons.Cleanup);
    expect(await destroyReasonPromise).toBe(DestroyReasons.Cleanup);
  });

  it("enforces URL whitelist/blacklist rules and migrates players across nodes via changeNode()", async () => {
    const server2 = new MockLavalinkV4Server();
    await server2.start();

    try {
      manager = new MocylinkManager({
        nodes: [
          { id: "node-a", host: "127.0.0.1", port: server.port, authorization: "youshallnotpass" },
          { id: "node-b", host: "127.0.0.1", port: server2.port, authorization: "youshallnotpass" },
        ],
        sendToShard: () => {},
        linksBlacklist: [/evil\.example\.com/i],
      });

      await new Promise<void>((resolve) => {
        let count = 0;
        manager.nodeManager.on("connect", () => {
          count++;
          if (count === 2) resolve();
        });
        void manager.init({ id: "777888999" });
      });

      const player = manager.createPlayer({
        guildId: "guild-move",
        voiceChannelId: "vc-move",
        node: "node-a",
      });

      await expect(player.search("https://evil.example.com/track.mp3")).rejects.toThrow(
        /blacklisted/i
      );

      const res = await player.search("One More Time");
      await player.queue.add(res.tracks[1]);
      await player.play();
      expect(player.node.id).toBe("node-a");

      await player.changeNode("node-b");
      expect(player.node.id).toBe("node-b");

      const nodeBPatch = server2.requests.find(
        (r) =>
          r.method === "PATCH" &&
          r.url.startsWith(`/v4/sessions/${server2.sessionId}/players/guild-move`)
      );
      expect(nodeBPatch).toBeDefined();
    } finally {
      await server2.stop();
    }
  });
});
