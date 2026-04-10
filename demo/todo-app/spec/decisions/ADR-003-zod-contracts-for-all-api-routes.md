# Zod contracts for all API routes

**ID:** ADR-003
**Status:** accepted
**Date:** 2026-04-09
**Tags:** api, contract, validation, zod

## Context

API routes need request validation and response type safety. Contracts enable OpenAPI generation and ATE L2/L3 testing.

## Decision

Define Zod contracts for all 4 API routes (api-todos, api-todos-$id, api-categories, api-categories-$id). Shared schemas (TodoSchema, CategorySchema, PrioritySchema) defined per contract file.

## Consequences

- Automatic request validation via Mandu contract system
- OpenAPI 3.0 spec auto-generated
- ATE L2 contract-level testing enabled
- Type inference flows from contracts to handlers

## Related Decisions

None
