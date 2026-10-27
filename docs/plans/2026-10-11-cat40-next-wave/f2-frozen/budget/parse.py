import json
DEC = json.JSONDecoder()
def rows_of(res):
    """The leading JSON array of a recorded result (notices may follow it); a transcript-clipped array keeps its complete rows."""
    res = res.lstrip()
    try:
        j, _ = DEC.raw_decode(res)
        if isinstance(j, dict): j = j.get('results', j.get('rows'))
        return (j, False) if isinstance(j, list) else (None, False)
    except Exception: pass
    if not res.startswith('['): return (None, False)
    rows, i = [], 1
    while True:
        while i < len(res) and res[i] in ' ,\n': i += 1
        try: o, i = DEC.raw_decode(res, i)
        except Exception: break
        rows.append(o)
    return (rows, True) if rows else (None, False)
