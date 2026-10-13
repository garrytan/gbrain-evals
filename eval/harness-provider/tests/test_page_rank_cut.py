"""W5's delivery.page_rank_cut is checked against the cell's search.page_rank_cut and search.page_rank_cut_factor."""
import pytest


def _p(**search_config):
    from mpw.gbrain_provider import GbrainMemoryProvider

    return GbrainMemoryProvider({"gbrain_cli": "unused", "child_env": {}, "search_config": search_config})


CUT = {"mode": "whole_pages", "factor": 1.25, "caller_budget": 7500, "target": 9375, "applied_cost": 9102, "candidates": 47, "kept": 12}


def test_cut_must_match_the_arms_mode_and_factor():
    from mpw.gbrain_provider import GbrainRetrieveError

    p = _p(**{"search.page_rank_cut": "whole_pages", "search.page_rank_cut_factor": "1.25"})
    assert p._check_page_rank_cut(CUT, True, 7500, True) == CUT
    assert p._check_page_rank_cut({**CUT, "target": 9000}, True, 7500, True)
    for bad in (None, {**CUT, "factor": 1.5}, {**CUT, "mode": "off"}, {**CUT, "caller_budget": 6300}, {**CUT, "target": 9376},
                {**CUT, "kept": 48}, {k: v for k, v in CUT.items() if k != "applied_cost"}):
        with pytest.raises(GbrainRetrieveError, match="page_rank_cut"):
            p._check_page_rank_cut(bad, True, 7500, True)


def test_recall_and_a_clamped_budget_may_cut_under_the_requested_budget():
    from mpw.gbrain_provider import GbrainRetrieveError

    p = _p(**{"search.page_rank_cut": "whole_pages", "search.page_rank_cut_factor": "1.25"})
    assert p._check_page_rank_cut({**CUT, "caller_budget": 6000, "target": 7500}, True, 7500, False)
    with pytest.raises(GbrainRetrieveError, match="page_rank_cut"):
        p._check_page_rank_cut({**CUT, "caller_budget": 8100, "target": 10125}, True, 7500, False)


def test_factor_resolves_as_gbrain_resolves_it():
    one = {**CUT, "factor": 1, "target": 7500}
    for raw in (None, "", "0", "-2", "inf", "nan", "x"):
        sc = {"search.page_rank_cut": "whole_pages", **({} if raw is None else {"search.page_rank_cut_factor": raw})}
        assert _p(**sc)._check_page_rank_cut(one, True, 7500, True) == one


def test_off_must_report_no_cut():
    from mpw.gbrain_provider import GbrainRetrieveError

    for sc in ({}, {"search.page_rank_cut": "off"}, {"search.page_rank_cut": "off", "search.page_rank_cut_factor": "1.5"}):
        assert _p(**sc)._check_page_rank_cut(None, True, 7500, True) is None
        with pytest.raises(GbrainRetrieveError, match="page_rank_cut off"):
            _p(**sc)._check_page_rank_cut(CUT, True, 7500, True)
    on = _p(**{"search.page_rank_cut": "whole_pages"})
    assert on._check_page_rank_cut(None, False, 7500, True) is None
    assert on._check_page_rank_cut(None, True, None, True) is None


def test_unknown_mode_and_the_fixed_ratio_key_are_refused():
    from mpw.gbrain_provider import GbrainRetrieveError

    with pytest.raises(GbrainRetrieveError, match="neither off nor whole_pages"):
        _p(**{"search.page_rank_cut": "ratio"})._check_page_rank_cut(None, True, 7500, True)
    with pytest.raises(GbrainRetrieveError, match="page_rank_budget_ratio"):
        _p(**{"search.page_rank_budget_ratio": "0"})._check_page_rank_cut(None, True, 7500, True)
