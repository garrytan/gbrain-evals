/** The G3 recovering-fake check for source_changed and missing_provenance; see test/support/predictive-g3.ts. */
import { describeG3Recovering, stripProviderKeysForFile } from '../support/predictive-g3.ts';

stripProviderKeysForFile();
describeG3Recovering(['source_changed', 'missing_provenance']);
