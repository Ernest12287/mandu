# Note domain with Todo linkage

**ID:** ADR-004
**Status:** accepted
**Date:** 2026-04-09
**Tags:** architecture, note, domain

## Context

Todo app needs supplementary notes for additional context. Notes are a separate domain entity but can optionally link to a specific todo via todoId.

## Decision

Create standalone Note domain (types, repository, service) with optional todoId foreign key. Pin feature for prioritizing important notes. Separate API routes and island component (NoteEditor).

## Consequences

- Third domain entity adds complexity but demonstrates multi-domain patterns
- todoId link is optional - notes can exist independently
- Pin sorting in repository layer keeps logic centralized
- NoteEditor island includes todo linking dropdown

## Related Decisions

None
