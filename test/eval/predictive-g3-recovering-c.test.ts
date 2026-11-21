/** The G3 recovering-fake check for scope_denied and commit_paths_invalid; see test/support/predictive-g3.ts. */
import { describeG3Recovering, stripProviderKeysForFile } from '../support/predictive-g3.ts';

stripProviderKeysForFile();
describeG3Recovering(['scope_denied', 'commit_paths_invalid']);
