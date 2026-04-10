# In-memory repository pattern for demo app

**ID:** ADR-001
**Status:** accepted
**Date:** 2026-04-09
**Tags:** architecture, data, repository

## Context

Demo todo app needs simple data storage without external database dependencies. Must be easy to understand and demonstrate Mandu framework patterns.

## Decision

Use in-memory arrays with repository pattern (findAll, findById, create, update, delete) for both Todo and Category domains. Seed data is included for immediate demo experience.

## Consequences

- Data is lost on server restart - acceptable for demo
- No concurrency issues with single-process server
- Repository interface can be swapped to real DB later
- Fast startup with no DB connection needed

## Related Decisions

None
