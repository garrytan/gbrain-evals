/** The G3 recovering-fake check for sources_without_brain and two_range_read; see test/support/predictive-g3.ts. */
import { describeG3Recovering, stripProviderKeysForFile } from '../support/predictive-g3.ts';

stripProviderKeysForFile();
describeG3Recovering(['sources_without_brain', 'two_range_read']);
