---
"@mandujs/core": patch
---

fix(brain/openai): default model gpt-4o-mini → gpt-5.4

The original OpenAI adapter shipped with `gpt-4o-mini` as a
cost/quality compromise, but the whole point of moving brain off the
local `ministral-3:3b` adapter was to get quality-tier suggestions.
Current-generation flagship (`gpt-5.4`) is the correct default;
`ManduConfig.brain.openai.model` still lets users drop to a cheaper
tier for low-stakes automated runs.
