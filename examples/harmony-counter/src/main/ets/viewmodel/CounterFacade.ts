import { createViewModelHarmonyScope, StateViewModel, viewModelSpec } from '@lwjlol/view_model';
import type { ViewModelHarmonyScope } from '@lwjlol/view_model';

interface CounterState {
  readonly count: number;
}

class CounterViewModel extends StateViewModel<CounterState> {
  public constructor() {
    super({ count: 0 });
  }

  public increment(): void {
    this.updateState((current) => ({ count: current.count + 1 }), 'counter.increment');
  }
}

const counterSpec = viewModelSpec(CounterViewModel, () => new CounterViewModel(), {
  debugLabel: 'HarmonyCounter',
});

/** Only named, concrete data crosses the TS-to-ArkTS boundary. */
export class CounterSnapshot {
  public readonly count: number;

  public constructor(count: number) {
    this.count = count;
  }
}

/** Create this facade in aboutToAppear and dispose it in aboutToDisappear. */
export class CounterFacade {
  private readonly scope: ViewModelHarmonyScope;

  public constructor(onUpdate: (snapshot: CounterSnapshot) => void) {
    this.scope = createViewModelHarmonyScope({
      onUpdate: () => {
        // Resolve again: recycle may have replaced the previous ViewModel.
        onUpdate(this.getSnapshot());
      },
    });
  }

  public get isDisposed(): boolean {
    return this.scope.isDisposed;
  }

  public getSnapshot(): CounterSnapshot {
    const counter = this.scope.watch(counterSpec);
    return new CounterSnapshot(counter.state.count);
  }

  public increment(): void {
    this.scope.read(counterSpec).increment();
  }

  public recycle(): void {
    this.scope.runtime.recycle(counterSpec);
  }

  public dispose(): void {
    this.scope.dispose();
  }
}
