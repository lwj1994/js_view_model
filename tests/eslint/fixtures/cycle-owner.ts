import { ViewModel, viewModelSpec } from '../../../src/core/index.js';
import { reportSpec, type ReportViewModel } from './cycle-child.js';

export class DashboardViewModel extends ViewModel {
  public get report(): ReportViewModel {
    return this.viewModelBinding.read(reportSpec);
  }
}

export const dashboardSpec = viewModelSpec(DashboardViewModel, () => new DashboardViewModel());
