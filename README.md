# pi-maxout

A small, conservative [Pi coding agent](https://github.com/earendil-works/pi) extension that adds a live `/maxout` command for controlling the **maximum completion/output-token cap sent to the active provider**.

`pi-maxout` changes the final provider request only. It does **not** change reasoning effort, context-window size, model metadata, compaction policy, or llama.cpp launch settings.

## Why

Pi and provider adapters sometimes expose a conservative `maxTokens` value even when the backing server can accept a larger completion cap. This is especially useful with local OpenAI-compatible/llama.cpp endpoints where you may want to raise or lower the generation ceiling without restarting Pi or editing environment variables.

## Install

```bash
git clone https://github.com/meowsigma/pi-maxout.git
cd pi-maxout
bash install.sh
```

The installer:

- runs the bundled core tests first;
- stages the extension before replacing anything;
- backs up an existing `pi-maxout` installation;
- rolls back if installation does not complete.

Then restart Pi or run:

```text
/reload
```

## Usage

```text
/maxout                 show current state
/maxout status          same as above
/maxout 32k             session-only cap for the active model
/maxout 65536           exact integer form
/maxout max             use Pi's declared maxTokens for the active model
/maxout auto            clear the session override; saved default still applies

/maxout save 32k        save and apply a per-model default
/maxout save max        save Pi's declared maxTokens
/maxout save auto       remove the saved default
```

Examples:

```text
/maxout 16k
/maxout 32k
/maxout 64k
/maxout 128k
```

Session overrides are scoped to the active `provider:model`. Saved defaults are stored in the active Pi agent directory as `pi-maxout.json`, written atomically with mode `0600` where supported.

## Provider support

The extension preserves the output field already chosen by the provider adapter. If the field is absent, it recognizes Pi's standard request shapes:

| Provider/API shape | Field patched |
| --- | --- |
| OpenAI/OpenRouter/llama.cpp chat completions | `max_tokens` or `max_completion_tokens` |
| OpenAI/Codex/Azure Responses | `max_output_tokens` |
| Anthropic | `max_tokens` |
| Mistral | `max_tokens` |
| Google/Vertex | `generationConfig.maxOutputTokens` |
| Bedrock Converse | `inferenceConfig.maxTokens` |

Unknown custom API shapes **fail open**. The request is left untouched rather than receiving a guessed field.

After a request, `/maxout` reports the exact field it changed. A `!` in the Pi footer means the last request shape was unsupported and was intentionally left unchanged.

## Important semantics

`/maxout` is a request cap, not a capability unlock.

- The provider or local server remains the hard authority and may clamp or reject excessive values.
- Reasoning tokens may count inside a provider's output budget.
- `/maxout max` means **Pi's declared `model.maxTokens`**. It never assumes the entire context window is output room.
- Explicit values may be larger than Pi's declared `maxTokens` when the context window permits it. This is intentional for conservative local-provider metadata.
- Raising the wire cap does not rewrite Pi's catalog metadata or compaction math. Leave healthy context headroom when overriding local models substantially above their declared max-out.

## Verify

```bash
bash verify.sh
```

The core tests cover token parsing, provider/model scoping, state normalization, non-mutating request rewrites, provider-specific fields, compatibility overrides, nested Google/Bedrock payloads, and fail-open handling for unknown APIs.

## Uninstall

```bash
bash uninstall.sh
```

Saved per-model defaults are left in place by default. To remove them too:

```bash
bash uninstall.sh --purge
```

## Files

```text
index.ts             Pi extension entry point and /maxout command
core.mjs             dependency-free parsing and request-patching core
core.d.mts           core type declarations
tests/core.test.mjs  focused Node tests
install.sh           tested, rollback-safe local installer
uninstall.sh         extension removal / optional state purge
verify.sh            test + shell syntax verification
```

## License

MIT. See [LICENSE](LICENSE).
