import { StateViewModel, ViewModel, viewModelSpec } from '../../../src/core/index.js';

export class CounterViewModel extends StateViewModel<{ count: number }> {
  public constructor() {
    super({ count: 0 });
  }

  public increment(): void {
    this.setState({ count: this.state.count + 1 });
  }
}

export class UserViewModel extends ViewModel {
  public constructor(public readonly userId: string) {
    super();
  }
}

export const counterSpec = viewModelSpec(CounterViewModel, () => new CounterViewModel());
