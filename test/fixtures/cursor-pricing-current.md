# Models & Pricing (excerpt)

Rows copied verbatim from Cursor's published markdown, including the
`US data residency` column that shifted Notes to the last cell.

## Cursor models

| Model | Provider | Input | Cache write | Cache read | Output | US data residency | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| [Grok 4.7](https://x.ai/news/grok-4-7) | Cursor | $2 | - | $0.5 | $6 | Yes | Jointly trained by Cursor and SpaceXAI; Long context (>256k input tokens) is billed at 2x standard rates, up to 500k; Fast mode is available at 2x pricing; Fast mode for long context (>256k) is billed at 3x standard rates |
| [Grok 4.7 500k](https://x.ai/news/grok-4-7) | Cursor | $4 | - | $1 | $12 | Yes | Jointly trained by Cursor and SpaceXAI; Long context (>256k input tokens) is billed at 2x standard rates, up to 500k; Fast mode is available at 2x pricing; Fast mode for long context (>256k) is billed at 3x standard rates |
| [Composer 2.5](https://cursor.com/blog/composer-2-5) | Cursor | $0.5 | - | $0.2 | $2.5 | Yes | - |

## Third-party models

| Model | Provider | Input | Cache write | Cache read | Output | US data residency | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| [GPT-5.4](https://developers.openai.com/api/docs/models/gpt-5.4) | OpenAI | $2.5 | - | $0.25 | $15 | Yes | Hidden by default; Requires Max Mode on legacy request-based plans; Agentic and reasoning capabilities; 90% discount on cached input tokens; Fast mode is 15% faster with 2x pricing; Long context supports up to 1M tokens with 2x input pricing |
| [GPT-5.6 Luna](https://openai.com/index/previewing-gpt-5-6-sol/) | OpenAI | $0.2 | $0.25 | $0.02 | $1.2 | Yes | Requires Max Mode on legacy request-based plans; Smallest GPT-5.6 variant, optimized for cost and speed; Agentic and reasoning capabilities; Fast mode is available at 2x pricing; Long context supports up to 1M tokens with 2x input pricing; Fast mode is available for long context (>272k) at 2x Fast input pricing; Cache writes are billed at 1.25x the uncached input rate |
| [Claude Sonnet 5](https://www.anthropic.com/claude/sonnet) | Anthropic | $2 | $2.5 | $0.2 | $10 | Yes | Hidden by default; Requires Max Mode on legacy request-based plans; Up to 1M tokens with extended context at the same per-token rates (no long-context surcharge); Uses an updated tokenizer, so the same input can map to more tokens |
| [Gemini 4 Carbon](https://blog.google/innovation-and-ai/models-and-research/gemini-models/introducing-gemini-4-carbon/) | Google | $2 | - | $0.1 | $10 | No | Introductory pricing through November 30, 2026. From December 1, 2026: $4 input, $0.20 cache read, $20 output per 1M tokens |
| [GLM 5.3](https://z.ai) | Z.ai | $1.4 | - | $0.26 | $4.4 | Yes | Hidden by default; Same per-token rates as GLM 5.2 |
