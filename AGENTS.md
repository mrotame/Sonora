# Sonora - Agent Instructions

## Project context

Sonora is a personal portfolio project: a web experience that analyzes music and generates a procedural 3D world synchronized with it. The project documentation is the source of truth for requirements and approved technical decisions.

## Required reading

Before planning or implementing a task, read:

1. `PRODUCT_SPEC.md` for product goals, user experience, behavior, and requirements.
2. `TECHNICAL_ARCHITECTURE.md` for the current technical direction, module responsibilities, constraints, and implementation conventions.
3. `TECH_STACK.md` for approved technology decisions and their rationale (ADRs 0001–0005).

If the repository later places these documents under a `docs/` directory, preserve the same filenames and update paths consistently.

## Authority and status of information

The documentation distinguishes three statuses:

- **DECIDED**: explicitly approved requirement or decision. Preserve it unless the user authorizes a change.
- **PROPOSED**: a candidate solution that has not yet been approved. Evaluate it; do not silently treat it as mandatory.
- **OPEN**: an unresolved question that requires investigation, a recommendation, or user input.

When documents conflict, do not guess. Identify the conflict, explain its impact, and ask for clarification when it affects implementation.

Do not turn an implementation preference or an example into a product requirement.

## Working rules

- Understand the relevant product requirements and architectural boundaries before changing code.
- Prefer simple, modular solutions that satisfy the documented requirements.
- Keep responsibilities separated. Avoid coupling scenario-specific behavior to generic audio analysis, timeline, or rendering infrastructure.
- Preserve determinism wherever required by the product specification.
- Do not introduce dependencies, frameworks, services, or architectural patterns without explaining why they are needed.
- Do not expand MVP scope without discussing the trade-offs.
- Do not make unrelated refactors as part of a focused task.
- Do not claim that tests, builds, or manual verification succeeded unless they were actually run.
- When requirements are incomplete, identify assumptions explicitly. Ask before making consequential product or architecture decisions.
- Do not modify this `AGENTS.md` file unless the user explicitly requests it. If a change appears necessary, explain the proposed change and wait for approval.

## Documentation maintenance

When an approved change affects product behavior, update `PRODUCT_SPEC.md`.

When an approved change affects technologies, module responsibilities, interfaces, data flow, project structure, or engineering conventions, update `TECHNICAL_ARCHITECTURE.md`.

For a significant approved technology or architecture decision, add or update a concise ADR section in `TECH_STACK.md`, keeping all approved stack ADRs consolidated in that file as requested for this project. Do not create separate decision files unless the user explicitly changes this documentation convention. Do not create ADRs for routine implementation details.

Keep documentation concise and consistent with the implementation. Preserve the distinction between DECIDED, PROPOSED, and OPEN. Do not silently promote a proposal to a decision.

## Before finishing a task

Report:

1. What changed.
2. Which requirements or architectural decisions the change addresses.
3. What verification was performed and its actual result.
4. Any remaining assumptions, limitations, or open questions.
5. Which documentation files were updated, if any.
