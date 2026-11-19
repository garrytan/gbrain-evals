### A keyless test of who can read what when a brain's sharing changes

- [test/eval/sharing-contract.test.ts](test/eval/sharing-contract.test.ts) builds synthetic brains, turns each one shared
  in every way gbrain has (declaring `brain.audience shared`, adding or enabling a second member, `gbrain access serves
  several`, three MCP clients in 30 days, setting an owner on a shared brain), turns one back to personal, and archives
  and restores a conversation source. Before and after each change it reads public and private pages, a page kept to the
  owner, a page in an owner-only source, a conversation archived while the brain was personal, and public and private
  facts, as the local CLI, the owner's token, OAuth client and stdio server, another member, a token bound to nobody and a
  caller with no token, through `get_page`, `search`, `query`, `list_pages` and `recall`. It fails when one of the
  owner's callers loses a read or anyone else gains one that gbrain's access guide doesn't allow. It makes no model calls
  and needs no keys. It needs gbrain v0.60.738.0 or later, so on the current pin (v0.60.733.0) it skips with that
  reason and starts running in CI at the next pin move.
