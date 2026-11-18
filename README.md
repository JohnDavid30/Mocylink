# Mocylink

[![npm](https://img.shields.io/npm/v/mocylink?style=flat-square)](https://www.npmjs.com/package/mocylink)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](./LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen?style=flat-square)](https://nodejs.org)
[![Lavalink v4](https://img.shields.io/badge/Lavalink-v4-orange?style=flat-square)](https://lavalink.dev)

Easy, flexible, and feature-rich **Lavalink v4** client for Node.js & TypeScript — built in the style of **`lavalink-client`** with both Mocylink-branded exports (`MocylinkManager`, `MocylinkNode`, `MocylinkPlayer`) and drop-in `lavalink-client` aliases (`LavalinkManager`, `NodeManager`, `LavalinkNode`, `Player`, `Queue`, `FilterManager`).

---

## Features

- **Native Lavalink v4** — Built from the ground up for `/v4/websocket` events, `/v4/sessions/...` REST player updates, and automatic session resuming.
- **Library Agnostic** — Works with `discord.js`, `eris`, `oceanic.js`, `seyfert`, or `discordeno` via `sendToShard` and `sendRawData`.
- **Dual CJS + ESM + Full TypeScript Types** — Ships compiled `.cjs`, `.mjs`, `.d.ts`, and `.d.mts` bundles out of the box.
- **Pluggable Queue Stores** — Ships with `DefaultQueueStore` in RAM and lets you plug in Redis, MongoDB, PostgreSQL, or Prisma via `QueueStoreManager`.
- **Lazy `UnresolvedTrack` Support** — Queue lightweight track metadata and resolve encoded Lavalink streams right before playback.
- **Rich `FilterManager` & `EQList` Presets** — 15-band EQ presets, Nightcore, Vaporwave, Slowmode, 8D Rotation, Karaoke, ChannelMix (`mono`/`stereo`/`left`/`right`), plus `lavadspx-plugin` filters (`echo`, `reverb`, `normalization`, `high-pass`, `low-pass`).
- **Lavalink v4 Ecosystem Plugins** — Built-in methods & strongly typed events for **SponsorBlock**, **LavaLyrics**, **LavaSearch**, **LavaSrc**, and **RoutePlanner**.
- **Explicit `DestroyReasons`** — Know exactly why a player ended (`QueueEmpty`, `ChannelDeleted`, `Disconnected`, `NodeDestroy`, `TrackErrorMaxReached`, etc.).

---

## Installation

```bash
npm install mocylink
```

---

## Quick Start (`discord.js` v14)

```ts
import { Client, GatewayIntentBits } from "discord.js";
import { MocylinkManager, DestroyReasons, EQList } from "mocylink";
// Or drop-in alias: import { LavalinkManager } from "mocylink";

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

const mocylink = new MocylinkManager({
  nodes: [
    {
      id: "main-node",
      host: "localhost",
      port: 2333,
      authorization: "youshallnotpass",
      secure: false,
      resuming: { enabled: true, timeoutSeconds: 60 },
    },
  ],
  sendToShard: (guildId, payload) => {
    client.guilds.cache.get(guildId)?.shard?.send(payload);
  },
  client: {
    id: process.env.CLIENT_ID!,
    username: "MocyBot",
  },
  autoSkip: true,
  playerOptions: {
    defaultSearchPlatform: "ytmsearch",
    onDisconnect: {
      autoReconnect: true,
      destroyPlayer: false,
    },
    onEmptyQueue: {
      destroyAfterMs: 30_000,
    },
  },
});

// Forward raw Discord voice packets to Mocylink
client.on("raw", (packet) => {
  void mocylink.sendRawData(packet);
});

// Node events
mocylink.nodeManager.on("connect", (node) => {
  console.log(`Node "${node.id}" connected (session: ${node.sessionId})`);
});

mocylink.nodeManager.on("error", (node, error) => {
  console.error(`Node "${node.id}" error:`, error.message);
});

// Player & Track events
mocylink.on("trackStart", (player, track) => {
  console.log(`[${player.guildId}] Now playing: ${track?.info.title}`);
});

mocylink.on("playerDestroy", (player, reason = DestroyReasons.Manual) => {
  console.log(`[${player.guildId}] Player destroyed (${reason})`);
});

client.once("ready", async () => {
  await mocylink.init({
    id: client.user!.id,
    username: client.user!.username,
  });
  console.log(`Logged in as ${client.user!.tag}`);
});

await client.login(process.env.DISCORD_TOKEN);
```

---

## Searching, Queueing & Playing

```ts
// 1. Create or retrieve a guild player
const player = mocylink.createPlayer({
  guildId: interaction.guildId!,
  voiceChannelId: member.voice.channelId!,
  textChannelId: interaction.channelId,
  selfDeaf: true,
  volume: 100,
});

// 2. Connect to Discord voice
if (!player.connected) await player.connect();

// 3. Search via Lavalink v4 / LavaSrc (ytsearch, ytmsearch, scsearch, spsearch, dzsearch, amsearch, ...)
const res = await player.search(
  { query: "Daft Punk One More Time", source: "ytmsearch" },
  interaction.user
);

if (!res.tracks.length) {
  return interaction.reply("No tracks found!");
}

// 4. Add track(s) to the queue
await player.queue.add(
  res.loadType === "playlist" ? res.tracks : res.tracks[0]
);

// 5. Start playback if idle
if (!player.playing && !player.paused) {
  await player.play();
}
```

---

## Audio Filters & Equalizers

```ts
import { EQList } from "mocylink";

await player.filterManager.setEQ(EQList.BassboostHigh);
await player.filterManager.toggleNightcore();
await player.filterManager.toggle8D(0.2);
await player.filterManager.setAudioOutput("mono");

// Reset all active filters
await player.filterManager.resetFilters();
```

---

## Lavalink v4 Plugins

### SponsorBlock
```ts
await player.setSponsorBlock(["sponsor", "selfpromo", "intro", "outro"]);

mocylink.on("SegmentSkipped", (player, track, payload) => {
  console.log(`Skipped ${payload.segment.category} (${payload.segment.start}ms -> ${payload.segment.end}ms)`);
});
```

### LavaLyrics
```ts
const lyrics = await player.getCurrentLyrics();
await player.subscribeLyrics();

mocylink.on("LyricsLine", (player, track, payload) => {
  console.log(`[${payload.line.timestamp}ms] ${payload.line.line}`);
});
```

### LavaSearch
```ts
const multi = await player.lavaSearch({
  query: "Discovery Daft Punk",
  source: "spsearch",
  types: ["track", "album", "artist", "playlist"],
});
```

---

## Custom QueueStore (Redis / Database)

```ts
import type { QueueStoreManager, StoredQueue } from "mocylink";

export class RedisQueueStore implements QueueStoreManager {
  constructor(private redis: YourRedisClient) {}

  async get(guildId: string) {
    return await this.redis.get(`mocylink:queue:${guildId}`);
  }
  async set(guildId: string, value: StoredQueue | string) {
    await this.redis.set(
      `mocylink:queue:${guildId}`,
      typeof value === "string" ? value : JSON.stringify(value)
    );
  }
  async delete(guildId: string) {
    await this.redis.del(`mocylink:queue:${guildId}`);
  }
  stringify(value: StoredQueue | string) {
    return typeof value === "string" ? value : JSON.stringify(value);
  }
  parse(value: StoredQueue | string | null | undefined) {
    return value ? (typeof value === "string" ? JSON.parse(value) : value) : {};
  }
}
```

---

## License

MIT © [JOHNDAVID](https://github.com/MrrVit665)
