import type { LoadedFile, SourceEntry, AdapterId } from '../manifest.ts';
import { fromCat40 } from './cat40.ts';
import { fromLiveRecall } from './live-recall.ts';
import { fromNightly } from './nightly.ts';
import { fromRefreshBarrier } from './refresh-barrier.ts';
import { fromRs1 } from './rs1.ts';
import type { AdapterOutput } from './shared.ts';
import { fromSkillOpt } from './skillopt.ts';

export type { AdapterOutput } from './shared.ts';
export { fromCat40, fromLiveRecall, fromNightly, fromRefreshBarrier, fromRs1, fromSkillOpt };

export const ADAPTERS: Record<AdapterId, (files: LoadedFile[], entry: SourceEntry) => AdapterOutput> = {
  'refresh-barrier': fromRefreshBarrier,
  rs1: fromRs1,
  cat40: fromCat40,
  skillopt: fromSkillOpt,
  'live-recall': fromLiveRecall,
  nightly: fromNightly,
};
