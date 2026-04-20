import type { InteractionGraph, InteractionNode, InteractionEdge } from "./types";

export function createEmptyGraph(buildSalt: string): InteractionGraph {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    buildSalt,
    nodes: [],
    edges: [],
    // Phase A.1 stats fields are optional on the type but seeded to 0
    // here so numeric increments are always safe.
    stats: {
      routes: 0,
      navigations: 0,
      modals: 0,
      actions: 0,
      fillings: 0,
      slots: 0,
      islands: 0,
      forms: 0,
    },
  };
}

export function addNode(graph: InteractionGraph, node: InteractionNode): void {
  graph.nodes.push(node);
  if (node.kind === "route") graph.stats.routes++;
  else if (node.kind === "modal") graph.stats.modals++;
  else if (node.kind === "action") graph.stats.actions++;
  else if (node.kind === "filling") graph.stats.fillings = (graph.stats.fillings ?? 0) + 1;
  else if (node.kind === "slot") graph.stats.slots = (graph.stats.slots ?? 0) + 1;
  else if (node.kind === "island") graph.stats.islands = (graph.stats.islands ?? 0) + 1;
  else if (node.kind === "form") graph.stats.forms = (graph.stats.forms ?? 0) + 1;
}

export function addEdge(graph: InteractionGraph, edge: InteractionEdge): void {
  graph.edges.push(edge);
  if (edge.kind === "navigate") graph.stats.navigations++;
}
