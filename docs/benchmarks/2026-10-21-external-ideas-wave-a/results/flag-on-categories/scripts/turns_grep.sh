cd ~/gbrain-evals
grep -rnE "(user|User|USER|human|Human|Me)(\*\*)?: " eval/generators eval/runner --include=*.ts | grep -v '\.test\.' | grep -v '^.*// ' | cut -c1-200 | head -40
echo ---
grep -rnE "## (User|Human)|role: 'user'.*content" eval/generators --include=*.ts | cut -c1-200 | head -10
