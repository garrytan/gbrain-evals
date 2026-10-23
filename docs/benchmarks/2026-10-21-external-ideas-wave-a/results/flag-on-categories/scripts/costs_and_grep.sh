cd "$(dirname "$0")/../../../../../.."
W="${FLAGCHECK_DIR:-$PWD/.flagcheck}"
mkdir -p "$W/costs"
env -u OPENAI_API_KEY -u ANTHROPIC_API_KEY bun eval/runner/evidence-delivery.ts costs > "$W/costs/evidence-delivery-costs.json" 2>&1
head -c 1500 "$W/costs/evidence-delivery-costs.json"; echo
env -u OPENAI_API_KEY -u ANTHROPIC_API_KEY bun eval/runner/evidence-auto-v2.ts costs > "$W/costs/evidence-auto-v2-costs.json" 2>&1
head -c 1500 "$W/costs/evidence-auto-v2-costs.json"; echo
echo "==== files with conversation-signal pages"
grep -rlE "type: '(conversation|meeting|transcript|chat|slack|imessage)'|'chat/|conversations/" eval/runner eval/generators | head -80
