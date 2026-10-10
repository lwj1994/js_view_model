import { CounterFacade, CounterSnapshot } from '../viewmodel/CounterFacade';

@Entry
@ComponentV2
struct Index {
  @Local private count: number = 0;
  private counter: CounterFacade | undefined = undefined;

  aboutToAppear(): void {
    const counter = new CounterFacade((snapshot: CounterSnapshot): void => {
      this.count = snapshot.count;
    });
    this.counter = counter;
    this.count = counter.getSnapshot().count;
  }

  aboutToDisappear(): void {
    const counter = this.counter;
    this.counter = undefined;
    counter?.dispose();
  }

  build() {
    Column({ space: 16 }) {
      Text('HarmonyOS Counter')
        .fontSize(28)
        .fontWeight(FontWeight.Bold)
      Text(this.count.toString())
        .fontSize(64)
      Button('Increment')
        .onClick((): void => {
          this.counter?.increment();
        })
      Button('Recreate counter')
        .onClick((): void => {
          this.counter?.recycle();
        })
      Text('Tap Increment to add one, or recreate to start again.')
        .fontSize(14)
        .textAlign(TextAlign.Center)
    }
    .padding(24)
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Center)
  }
}
