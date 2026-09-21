---
name: doc-to-skill
description: Convert reference documents (API docs, product guides, specs, PDFs, wiki pages, web docs) and tool documents (OpenAPI specs, MCP tool schemas, CLI --help output, SDK docs) directly into a single, ready-to-install SKILL.md that an AI client can load to act on that documentation. Use this skill whenever the user hands over documentation and wants a skill built from it, says things like "turn these docs into a skill", "make this API usable by Claude", "convert this reference into a skill", "generate a skill from this doc", or uploads docs and mentions skills, agents, MCP tools, or AI clients — even if they don't say "skill" explicitly. Also use it when an existing skill needs to be regenerated from updated documentation.
---

# Doc-to-Skill

Raw documentation is written for humans reading linearly. A skill is read by a model that needs to act: know *when* to trigger, *which* call to make, *what* to pass, *what to do on failure*, and *what is dangerous*. This skill reads the docs once and writes that model-facing version as **one SKILL.md**.

Default output is a single file. Claude loads a skill in layers — `description` always, the SKILL.md body only when triggered, and `references/` files only when the body explicitly points to one — so splitting only pays off when the body would otherwise exceed ~500 lines. Below that, extra files are pure overhead. Do not produce intermediate packages, manifests, or one-file-per-tool folders.

```
reference docs + tool docs ─► read & extract ─► write SKILL.md ─► quality gate ─► (references/ only if >500 lines)
```

## Inputs

**Reference documents** (knowledge): PDFs, .docx, HTML, Markdown, text, wiki exports, READMEs, URLs. Concepts, business rules, workflows, vocabulary.

**Tool documents** (capabilities): OpenAPI/Swagger, MCP tool listings, GraphQL schemas, CLI `--help`, SDK docs, Postman collections, webhook docs. Callable operations.

Many real docs are **mixed** — one file containing both. Run both extraction checklists on it.

If a file is uploaded but not in context, read it with the appropriate reader before proceeding. Never infer content from a filename. Sources may also be a **local folder or file path** (read the files directly; the same path can be re-read on a later run, so nothing needs re-uploading) or **Google Drive documents** collected by `drive-collect`.

## Step 1 — Read and inventory

List every input with its type, format, version/date if stated, and a one-line summary. If two inputs cover the same thing at different versions, note which is newer — you will need it when they disagree.

Ask one round of clarifying questions **only if** the answer changes the output: which AI client is the target, whether any tools should be excluded, whether internal-only sections should be dropped. If inferable from the docs or conversation, don't ask.

Note any **other documents the source references by name** but that were not supplied (e.g. "see the Domain reference"). These become gaps to report.

## Step 2 — Extract

Read with a goal per type. Extraction pulls what a *model acting for a user* needs — not a summary of everything.

**From reference material, pull:**
- Core concepts and domain vocabulary (the words users say that map to parameters)
- Business rules and constraints
- Multi-step workflows, especially multi-tool sequences
- Prerequisites, auth, permissions, setup
- Pitfalls, rate limits, deprecations, "do not" warnings
- Concrete examples with realistic inputs/outputs
- Any **document-wide policy** (e.g. "always confirm before mutations") — these must propagate to every affected tool, not sit in one paragraph

**From tool material, pull per tool/endpoint/command:**
- Canonical name, aliases
- Purpose phrased as *when a user would want this*
- Required vs optional inputs with types, enums, defaults
- Output shape and which fields feed the next step
- Error cases and the correct next action (retry / ask user / stop)
- Auth/scope
- One minimal working example
- Side effects: read-only, creates, modifies, deletes, sends, charges — flag irreversible ones

Drop marketing copy, old changelogs, UI screenshots without parameters, and implementation internals the client cannot act on.

## Step 3 — Write the SKILL.md

Use this structure. Sections may be omitted when the docs have nothing for them; never pad.

```markdown
---
name: <kebab-case>
description: <what it does> + <8–15 realistic trigger phrasings, casual and indirect, written the way users talk — not doc section titles>. Make it pushy: skills under-trigger.
---

# <Title>

## Safety / confirmation policy      ← first if the docs declare one; otherwise a short "confirm before mutating" rule
## Mental model                      ← 5–10 lines: what the system is, the 2–4 things you can do with it, identity model
## Prerequisites                     ← auth, publishing state, connectors, what the caller must never send
## <Tool 1>                          ← one section per tool, fixed sub-structure:
   endpoint/command · purpose · side effects (⚠️ if mutating, ⚠️⚠️ if irreversible)
   inputs table (name | type | required | default | notes)
   output shape + which fields matter
   errors → next action
   one example
## <Tool 2> …
## Shared mechanics                  ← envelope format, pagination models, filter grammar, value shapes — anything used by ≥2 tools
## Workflows                         ← ordered multi-tool procedures; mark ⚠️ steps needing confirmation
## User phrasing → call              ← table mapping how users talk to the exact tool + parameters
## Pitfalls                          ← limits, drift between layers, silent failures, deprecated/alternate surfaces
## Not covered by source docs        ← every gap, marked; dependent docs not supplied
```

Writing rules that keep the file useful to a model:
- **Imperative and dense.** Tables over prose for parameters and mappings.
- **Every tool gets the same sub-structure**, even when thin. An empty "errors" row saying `UNKNOWN — not in docs` is more useful than a plausible guess.
- **Inline the policy.** If the docs say "confirm before mutations," each mutating tool's side-effects line says so and each mutating workflow step carries ⚠️. A rule stated once at the top gets skipped in the middle of a task.
- **Put defaults you *chose* (authoring conventions) in the text explicitly**, distinguished from defaults the system applies.

## Step 4 — Quality gate

Check before delivering. Each check exists because the model using the skill will otherwise inherit the flaw silently.

- **No invention.** Anything not in the sources is `UNKNOWN — not in docs`, collected in "Not covered by source docs." A confident fabricated default is worse than a blank.
- **No secrets.** Strip keys, tokens, real customer data, internal hostnames; use `<API_KEY>`-style placeholders.
- **Conflicts explicit.** When sources disagree, prefer the newer, note the older in one line with its source, list in gaps.
- **Side effects flagged on every mutating tool and workflow step**, not just in the policy section.
- **Trigger phrases in the description**, not in the body — the body only loads after triggering.
- **Size.** If the body exceeds ~500 lines, move the bulkiest shared-mechanics or per-tool detail into `references/<topic>.md` and leave a one-line pointer saying *when* to read it. Otherwise keep it one file.
- **Consistency.** Tool names, parameter names, and glossary terms spelled identically throughout.
- **Dependencies reported.** Docs referenced but not supplied are named in the gaps section and told to the user as the next thing to provide.

## Step 5 — Deliver

Write `<output-dir>/<skill-name>/SKILL.md`. Output dir: inside a repo that already has a `skills/` directory → `skills/`; otherwise the current project root; on hosts with a dedicated outputs folder (Cowork: `/mnt/user-data/outputs/`) → that folder. Ask once if none of these is obvious.

Alongside it, write `SOURCES.md`: every source document with title, version/date, and origin (upload, local path with sha256, or Drive link and modified date). Do **not** copy the raw source files into the skill folder — `references/` is only for distilled material the SKILL.md explicitly points to. Provenance goes in `SOURCES.md`, not in the skill body.

Present the result. In the reply, give the user: what the skill covers, the gaps found, and which additional documents would close them. Offer to regenerate when they supply more (the `close-gaps` skill fills gaps from the backend repo, the running API, and Drive).

## Edge cases

- **Reference only, no tool docs:** knowledge-only skill; omit tool sections, keep rules and workflows, say so in gaps.
- **Tool docs only:** derive trigger phrases from tool purposes; flag that business rules are unknown.
- **UI docs, not API:** keep the workflows and rules; mark tools `UNKNOWN — UI only`; the skill guides rather than executes.
- **Huge doc sets:** extract in passes by topic; this is the one case where `references/` is expected. Keep SKILL.md as the router.
- **Non-English docs:** keep original terms beside English in the phrasing table so either language triggers correctly.
- **Regenerating from updated docs:** preserve the existing skill's `name`; diff behavior changes for the user.
