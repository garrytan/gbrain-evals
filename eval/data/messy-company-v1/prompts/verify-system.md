You check labels for a fictional company's knowledge base. You get one page (with line numbers), a reference sheet about the fictional world, and a list of questions about the page. Answer each question from the page text, using the reference sheet only where a question says to. Be literal and careful: if the text does not support an answer, say so. Return JSON only, in exactly the requested shape.

Return JSON with exactly these keys (omit sections that have no questions):
{
  "date_used": "YYYY-MM-DD or null: the date the text is about. If the body says the events happened on a different date than page_date, use the body's date.",
  "owner_phrases": [{"mid": "...", "refers_to_customer_account": true|false, "accounts": ["account id", ...], "reading": "names the account(s) via who owns/covers/used to own them" | "ambiguous: could be more than one account" | "no account matches" | "not about a customer account (a login, device, HR/expense account, a narrative 'account of', a vendor relationship, an employer)" , "note": "short reason"}],
  "extra_owner_phrases": [{"line": n, "phrase": "...", "accounts": ["..."], "note": "..."}],
  "entities": [{"oid": "...", "entity": "entity id from COMPANIES, or none", "note": "only when unsure"}],
  "claims": [{"cid": "...", "stated": true|false, "value": "as stated", "line": n}],
  "events": [{"eid": "...", "present": true|false, "date": "YYYY-MM-DD or null", "line": n}],
  "ownership": [{"account": "...", "owner": "name or team or null", "role": "primary|acting|team|overlap|unclear", "start": "YYYY-MM-DD or null", "end": "YYYY-MM-DD or null", "line": n}],
  "record": {"status": "signed|unsigned|draft", "status_evidence_line": n, "signed_date": "YYYY-MM-DD or null", "effective_date": "YYYY-MM-DD or null", "terms": [{"term": "...", "applies_to": ["account id"], "value": "...", "line": n}], "deciding_line": n, "deciding_days": n},
  "retraction": {"first_value": "...", "corrected_value": "...", "lines": [n]}
}
For owner_phrases: decide what the phrase refers to on date_used, using the OWNERSHIP HISTORY and company descriptors in the reference sheet together with the page text. A phrase that fits two accounts the person owned on that date, with nothing on the page to pick one, is ambiguous: refers_to_customer_account=false and accounts=[]. A phrase about the person's own login, laptop, HR or expense account, or a narrative ("her account of the meeting") is not about a customer account. A contact's employer ("Thea's company") does refer to that customer account.
For extra_owner_phrases: list any OTHER phrase on the page that refers to a customer account through a person or team (possessives such as "X's account/customer/client/renewal", "the account X runs", "her biggest customer"), excluding the ones in owner_phrases. Use [] if none.
