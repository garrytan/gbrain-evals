### A slow Cat 6 test no longer fails main's CI at random

- [test/eval/cat6.test.ts](test/eval/cat6.test.ts)'s full-run receipt test takes about 5 s, Bun's default per-test
  limit, and failed main's CI twice when CI started running four test processes per job. It now has a 30 s limit, as
  other tests that run a whole category on a fixture do. Its assertions are unchanged.
