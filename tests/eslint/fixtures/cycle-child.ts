import { ViewModel, viewModelSpec } from '../../../src/core/index.js';
import { dashboardSpec } from './cycle-owner.js';

export class ReportViewModel extends ViewModel {
  protected override onCreate(): void {
    this.viewModelBinding.listen(dashboardSpec, () => this.notifyListeners());
  }
}

export const reportSpec = viewModelSpec(ReportViewModel, () => new ReportViewModel());
