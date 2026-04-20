---
"@mandujs/core": patch
---

fix(core/openapi): Zod optional no longer marked nullable

`z.string().optional()` was emitting `nullable: true` in the OpenAPI
spec, which conflated "may be absent" with "may literally be null" and
broke Postman / codegen / Swagger UI imports of Mandu-generated specs.

Optionality is now correctly expressed via the parent object's
`required[]` array (or `parameter.required: false`), and `nullable` is
reserved for `.nullable()` chains. `.nullable().optional()` still emits
`nullable: true` on the inner schema as expected.
