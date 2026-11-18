// Mocylink-branded & lavalink-client drop-in compatible exports
export {
  MocylinkManager,
  LavalinkManager,
  Mocylink,
} from "./structures/MocylinkManager";

export {
  NodeManager,
  MocylinkNodeManager,
} from "./structures/NodeManager";

export {
  MocylinkNode,
  LavalinkNode,
} from "./structures/MocylinkNode";

export {
  Player,
  MocylinkPlayer,
} from "./structures/Player";

export {
  Queue,
  MocylinkQueue,
  QueueSaver,
  DefaultQueueStore,
  MemoryQueueStore,
  type RemoveTrackInput,
} from "./structures/Queue";

export {
  FilterManager,
  MocylinkFilterManager,
} from "./structures/FilterManager";

export {
  ManagerUtils,
  MiniMap,
  TypedEventEmitter,
} from "./structures/Utils";

export {
  DestroyReasons,
  type DestroyReasonsType,
  DebugEvents,
  AudioOutputsData,
  EQList,
  DefaultSources,
  SourceLinksRegexes,
} from "./constants";

export * from "./types";
