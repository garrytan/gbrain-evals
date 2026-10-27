// GBRA-94 arms. `expand` is the shim's query knob (undefined = the tokenmax default, which expands); `env` is passed to
// gbrain through the shim's per-arm env file. Only the expansion step differs between arms.
export type Arm = { id: string; expand: boolean | undefined; model: string | null; screen?: boolean; env: (proxyWorkerBase: string) => Record<string, string> };
// `screen`: runs only on the nested 90-question subset (subset-k90.json), to fit the cap.

export const ARMS: Arm[] = [
  { id: 'A1', expand: undefined, model: 'anthropic:claude-haiku-4-5-20251001', env: () => ({}) },
  { id: 'A2', expand: undefined, model: 'anthropic:claude-haiku-4-5-20251001', env: () => ({}) },
  { id: 'B', expand: false, model: null, env: () => ({}) },
  { id: 'C-haiku-5-5', expand: undefined, model: 'anthropic:claude-haiku-5-5', env: () => ({ GBRAIN_EXPANSION_MODEL: 'anthropic:claude-haiku-5-5' }) },
  { id: 'C-gpt-6-luna', expand: undefined, model: 'openai:gpt-6-luna', env: () => ({ GBRAIN_EXPANSION_MODEL: 'openai:gpt-6-luna' }) },
  { id: 'C-gemini-3.8-flash', expand: undefined, model: 'google:gemini-3.8-flash', screen: true, env: (base) => ({ GBRAIN_EXPANSION_MODEL: 'google:gemini-3.8-flash', GOOGLE_GENERATIVE_AI_BASE_URL: `${base}/google/v1beta` }) },
];
