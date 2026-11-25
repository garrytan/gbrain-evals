- **The Ubicloud runner no longer puts its API key in curl's arguments.** `scripts/ubicloud/ubi-runner.sh` passed
  `Authorization: Bearer <key>` to curl on its command line, so any process listing that prints arguments showed the key
  while a request ran. The header now reaches curl as a file on a pipe, as gstack's copy of the runner already does,
  and `test/eval/ubi-runner-key-argv.test.ts` fails if the key or an Authorization header shows up in curl's arguments.
