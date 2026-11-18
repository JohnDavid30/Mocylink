import { DestroyReasons } from "../constants";
import type {
  LeastUsedNodeSortType,
  MocylinkNodeOptions,
  NodeManagerEvents,
} from "../types";
import type { MocylinkManager } from "./MocylinkManager";
import { MocylinkNode } from "./MocylinkNode";
import { MiniMap, TypedEventEmitter } from "./Utils";

/**
 * Manages a pool of Lavalink v4 nodes, connection lifecycle, and load-balanced node selection.
 */
export class NodeManager extends TypedEventEmitter<NodeManagerEvents> {
  public readonly LavalinkManager: MocylinkManager;
  public readonly nodes = new MiniMap<string, MocylinkNode>();

  constructor(manager: MocylinkManager) {
    super();
    this.LavalinkManager = manager;

    if (Array.isArray(this.LavalinkManager.options.nodes)) {
      for (const nodeOpts of this.LavalinkManager.options.nodes) {
        this.createNode(nodeOpts);
      }
    }
  }

  public get manager(): MocylinkManager {
    return this.LavalinkManager;
  }

  /**
   * Registers a new Lavalink node and connects it immediately if the manager is already initialized.
   */
  public createNode(options: MocylinkNodeOptions): MocylinkNode {
    const id = options.id ?? options.name ?? `${options.host}:${options.port ?? 2333}`;
    const existing = this.nodes.get(id);
    if (existing) return existing;

    const node = new MocylinkNode(options, this);
    this.nodes.set(node.id, node);
    this.emit("create", node);

    if (this.LavalinkManager.initiated) {
      node.connect();
    }

    return node;
  }

  /**
   * Retrieves a node by its ID or returns the passed `MocylinkNode` instance if registered.
   */
  public get(nodeOrId: string | MocylinkNode): MocylinkNode | undefined {
    if (nodeOrId instanceof MocylinkNode) {
      return this.nodes.get(nodeOrId.id) ?? nodeOrId;
    }
    return this.nodes.get(nodeOrId);
  }

  /**
   * Destroys and removes a node from the pool (optionally migrating its players to another node).
   */
  public async deleteNode(
    nodeOrId: string | MocylinkNode,
    movePlayers = false
  ): Promise<void> {
    const node = this.get(nodeOrId);
    if (!node) {
      throw new Error(
        `Could not find node "${typeof nodeOrId === "string" ? nodeOrId : nodeOrId.id}" to delete.`
      );
    }
    await node.destroy(DestroyReasons.NodeDeleted, true, movePlayers);
  }

  /**
   * Connects all registered nodes that are not yet connected.
   */
  public connectAll(): void {
    if (!this.nodes.size) {
      throw new Error("No Lavalink nodes are configured in NodeManager.");
    }
    for (const node of this.nodes.values()) {
      if (!node.connected) {
        node.connect();
      }
    }
  }

  /**
   * Disconnects all nodes (and optionally deletes them or destroys their players).
   */
  public async disconnectAll(
    deleteAllNodes = false,
    destroyPlayers = true
  ): Promise<void> {
    if (destroyPlayers) {
      for (const player of this.LavalinkManager.players.values()) {
        await player.destroy(DestroyReasons.DisconnectAllNodes);
      }
    }
    for (const node of [...this.nodes.values()]) {
      if (deleteAllNodes) {
        await node.destroy(DestroyReasons.DisconnectAllNodes, true, false);
      } else {
        node.disconnect(DestroyReasons.DisconnectAllNodes);
      }
    }
  }

  /**
   * Forces all nodes to disconnect and immediately reconnect.
   */
  public async reconnectAll(): Promise<void> {
    if (!this.nodes.size) {
      throw new Error("No Lavalink nodes are configured in NodeManager.");
    }
    for (const node of this.nodes.values()) {
      node.disconnect(DestroyReasons.ReconnectAllNodes);
      node.connect(node.sessionId ?? undefined);
    }
  }

  /**
   * Returns all connected nodes sorted from lowest load to highest load.
   */
  public leastUsedNodes(sortType: LeastUsedNodeSortType = "default"): MocylinkNode[] {
    const connected = [...this.nodes.values()].filter((n) => n.connected);

    switch (sortType) {
      case "memory":
        return connected.sort((a, b) => (a.stats.memory?.used ?? 0) - (b.stats.memory?.used ?? 0));
      case "cpuLavalink":
        return connected.sort(
          (a, b) => (a.stats.cpu?.lavalinkLoad ?? 0) - (b.stats.cpu?.lavalinkLoad ?? 0)
        );
      case "cpuSystem":
        return connected.sort(
          (a, b) => (a.stats.cpu?.systemLoad ?? 0) - (b.stats.cpu?.systemLoad ?? 0)
        );
      case "calls":
        return connected.sort((a, b) => a.calls - b.calls);
      case "playingPlayers":
        return connected.sort(
          (a, b) => (a.stats.playingPlayers ?? 0) - (b.stats.playingPlayers ?? 0)
        );
      case "players":
        return connected.sort((a, b) => (a.stats.players ?? 0) - (b.stats.players ?? 0));
      case "default":
      default:
        return connected.sort((a, b) => a.penalties - b.penalties);
    }
  }

  /**
   * Finds the best connected node matching a Discord voice region, falling back to `leastUsedNodes()[0]`.
   */
  public findNodeByRegion(
    region?: string,
    sortType: LeastUsedNodeSortType = "default"
  ): MocylinkNode | undefined {
    const sorted = this.leastUsedNodes(sortType);
    if (!region) return sorted[0];

    const normalized = region.toLowerCase();
    const regional = sorted.find((node) =>
      node.options.regions.some((r) => normalized.includes(r.toLowerCase()))
    );
    return regional ?? sorted[0];
  }
}

export { NodeManager as MocylinkNodeManager };
