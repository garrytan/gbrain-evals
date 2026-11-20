/** The G3 recovering-fake check for ambiguous_entity and fact_and_items; see test/support/predictive-g3.ts. */
import { describeG3Recovering, stripProviderKeysForFile } from '../support/predictive-g3.ts';

stripProviderKeysForFile();
describeG3Recovering(['ambiguous_entity', 'fact_and_items']);
