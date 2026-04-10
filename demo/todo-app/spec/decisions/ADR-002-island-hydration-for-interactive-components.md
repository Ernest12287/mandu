# Island hydration for interactive components

**ID:** ADR-002
**Status:** accepted
**Date:** 2026-04-09
**Tags:** architecture, hydration, island, frontend

## Context

Todo app needs interactive UI (add, toggle, delete, filter) while maintaining SSR for initial page load performance. Mandu supports island architecture for selective hydration.

## Decision

Use Mandu.island() pattern with data-island attributes for TodoList and CategoryManager. SSR provides initial HTML with data-props; islands hydrate on visibility for interactivity.

## Consequences

- Fast initial page load via SSR
- Only interactive parts hydrate - minimal JS shipped
- Server data passed via data-props JSON serialization
- Two islands: todo-list (visible priority) and category-manager (visible priority)

## Related Decisions

None
