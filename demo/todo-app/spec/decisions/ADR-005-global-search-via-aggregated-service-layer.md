# Global search via aggregated service layer

**ID:** ADR-005
**Status:** accepted
**Date:** 2026-04-09
**Tags:** search, api, architecture

## Context

Need cross-domain search across todos, notes, and categories. Creating a dedicated search domain would be over-engineering for in-memory data.

## Decision

Create thin search.service.ts that delegates to existing todoService, noteService, categoryService. Single /api/search?q= endpoint returns grouped results. Client-side debounced input (300ms) for real-time search.

## Consequences

- No new repository needed - reuses existing services
- Simple string.includes() matching - acceptable for in-memory demo
- Search page is island-only (no SSR search results)
- Debounce prevents excessive API calls

## Related Decisions

None
