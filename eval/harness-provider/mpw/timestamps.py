"""Timestamp provenance per dataset.

Every document date given to a memory system is classified as one of:

  observed_session_time  when the conversation or record happened, from the
                         dataset's own session metadata;
  stated_event_date      a date found inside the text (an event the text
                         mentions), which is not when the conversation happened;
  unknown                no date.

Only observed session times are passed to providers as `Document.timestamp`.
A stated event date is recorded in the manifest and dropped, so both systems
see the same dates and neither treats an in-text event date as the time of
the conversation. The PersonaMem loader at the harness pin sets
`Document.timestamp` to the first calendar date found in the session text;
that value is a stated event date and is never promoted.
"""
from __future__ import annotations

OBSERVED = "observed_session_time"
STATED = "stated_event_date"
UNKNOWN = "unknown"

# How each harness loader at the pin fills Document.timestamp (read from its source).
RULES: dict[str, dict] = {
    "longmemeval": {"provenance": OBSERVED, "source": "haystack_dates[i]: the session date in the dataset"},
    "locomo": {"provenance": OBSERVED, "source": "conversation['<session>_date_time']"},
    "lifebench": {"provenance": OBSERVED, "source": "conversation['<session>_date_time']"},
    "beam": {"provenance": OBSERVED, "source": "the session's time_anchor turn field; flat 10M fallback documents carry none"},
    "personamem": {"provenance": STATED, "source": "first 'Month D, YYYY' match in the session text (an event the text mentions)"},
    "precisionmembench": {"provenance": OBSERVED, "source": "belief created_at"},
    "fixture": {"provenance": OBSERVED, "source": "fixture session date"},
}


def classify(dataset: str, timestamp: str | None) -> str:
    if dataset not in RULES:
        raise KeyError(f"no timestamp provenance rule for dataset {dataset!r}; add one to mpw/timestamps.py before running it")
    if not timestamp:
        return UNKNOWN
    return RULES[dataset]["provenance"]


def provider_timestamp(dataset: str, timestamp: str | None) -> tuple[str | None, str]:
    """(timestamp to give providers, provenance). Only observed session times pass."""
    provenance = classify(dataset, timestamp)
    return (timestamp if provenance == OBSERVED else None), provenance
