/** A scripted accessibility backend: the same contract as a real one, over a tree held in memory. For tests. */
import { A11yError, type A11yActArgs, type A11yBackend, type A11yCheck, type A11yRawNode, type A11yRawTree, type A11yTreeArgs } from './computer-use-a11y.js';

export interface FakeA11yBackend extends A11yBackend {
  /** Every action received, in order. */
  readonly acts: A11yActArgs[];
  /** Every tree request received, in order. */
  readonly reads: A11yTreeArgs[];
  /** Replaces the tree of a window, as when the interface changes. */
  setTree(windowId: string, nodes: A11yRawNode[]): void;
}

export function createFakeA11yBackend(initial: Record<string, A11yRawNode[]>, probe: A11yCheck = 'ok'): FakeA11yBackend {
  const trees = new Map(Object.entries(initial));
  const acts: A11yActArgs[] = [];
  const reads: A11yTreeArgs[] = [];
  return {
    acts, reads,
    setTree: (windowId, nodes) => { trees.set(windowId, nodes); },
    probe: async () => probe,
    tree: async (args): Promise<A11yRawTree> => {
      reads.push(args);
      const nodes = trees.get(args.windowId);
      if (!nodes) throw new A11yError('stale', 'No such window.');
      const kept = nodes.filter((node) => node.path.split('.').length - 1 < args.maxDepth);
      return { truncated: kept.length > args.maxNodes || kept.length < nodes.length, nodes: kept.slice(0, args.maxNodes) };
    },
    act: async (args) => {
      const node = trees.get(args.windowId)?.find((candidate) => candidate.path === args.path);
      if (!node) throw new A11yError('stale', 'No such element.');
      if (!node.actions.includes(args.action)) throw new A11yError('unsupported', 'That element cannot do this.', node.actions as A11yActArgs['action'][]);
      acts.push(args);
    },
  };
}
