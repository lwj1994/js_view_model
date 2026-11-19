import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ViewModel,
  ViewModelRuntime,
  viewModelSpec,
  type ViewModelSpec,
} from '../../src/core/index.js';

/**
 * A shared ViewModel read by every cell of a long list, whose dependencies
 * mirror every cell as an owner. Owner propagation must stay linear per owner
 * change, otherwise building or unmounting such a list hangs.
 */
let disposed: string[];
const runtimes: ViewModelRuntime[] = [];
beforeEach(() => {
  ViewModel.reset();
  disposed = [];
});
afterEach(() => {
  for (const app of runtimes.splice(0)) app.dispose();
  ViewModel.reset();
});

class Chain extends ViewModel {
  constructor(
    readonly name: string,
    readonly next: ViewModelSpec<Chain> | undefined,
  ) {
    super();
  }
  /** Resolves the whole chain below this level. */
  get leaf(): Chain {
    return this.next === undefined ? this : this.viewModelBinding.read(this.next).leaf;
  }
  protected override onDispose() {
    disposed.push(this.name);
  }
}

const chain = (depth: number): ViewModelSpec<Chain> => {
  let next: ViewModelSpec<Chain> | undefined;
  for (let level = depth - 1; level >= 0; level--) {
    const below = next;
    next = viewModelSpec(Chain, () => new Chain(`level${level}`, below), { key: `level${level}` });
  }
  return next!;
};

const levels = (root: Chain): Chain[] => {
  const result = [root];
  while (result.at(-1)!.next !== undefined) {
    const last = result.at(-1)!;
    result.push(last.viewModelBinding.read(last.next!));
  }
  return result;
};

const flush = async () => {
  for (let i = 0; i < 3; i++) await Promise.resolve();
};

describe('many owners of one shared ViewModel', () => {
  it('thousands of owners propagate to dependencies in linear time', async () => {
    const app = new ViewModelRuntime();
    runtimes.push(app);
    const owners = 1500;
    const depth = 4;
    const spec = chain(depth);
    const cells = Array.from({ length: owners }, () => app.createBinding());

    const bindStart = performance.now();
    for (const cell of cells) void cell.read(spec).leaf;
    const bound = performance.now() - bindStart;

    const chainLevels = levels(cells[0]!.read(spec));
    expect(chainLevels).toHaveLength(depth);
    const cellIds = new Set(cells.map((cell) => cell.id));
    for (const node of chainLevels) {
      expect(
        node.bindingIds.filter((id) => cellIds.has(id)),
        node.name,
      ).toHaveLength(owners);
    }

    // Unmount in the order a list unmounts its cells.
    const releaseStart = performance.now();
    for (const cell of cells) cell.dispose();
    const released = performance.now() - releaseStart;
    await flush();

    expect(disposed).toEqual(['level0', 'level1', 'level2', 'level3']);
    // Quadratic owner sync took seconds here; linear sync takes milliseconds.
    expect(bound + released, `bind ${bound}ms, release ${released}ms`).toBeLessThan(5000);
  });

  it('releasing owners from the middle keeps the remaining propagation', async () => {
    const app = new ViewModelRuntime();
    runtimes.push(app);
    const owners = 200;
    const spec = chain(3);
    const cells = Array.from({ length: owners }, () => app.createBinding());
    for (const cell of cells) void cell.read(spec).leaf;
    const chainLevels = levels(cells[1]!.read(spec));

    for (let i = 0; i < owners; i += 2) cells[i]!.dispose();
    await flush();
    const kept = cells.filter((_, i) => i % 2 === 1).map((cell) => cell.id);
    const cellIds = new Set(cells.map((cell) => cell.id));
    for (const node of chainLevels) {
      expect(
        node.bindingIds.filter((id) => cellIds.has(id)),
        node.name,
      ).toEqual(kept);
    }
    expect(disposed).toEqual([]);

    for (let i = 1; i < owners; i += 2) cells[i]!.dispose();
    await flush();
    expect(disposed).toEqual(['level0', 'level1', 'level2']);
  });
});
