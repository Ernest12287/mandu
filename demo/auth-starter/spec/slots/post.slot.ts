// 🥟 Mandu Filling - post Resource
// Pattern: /api/posts
// 이 파일에서 비즈니스 로직을 구현하세요.

import { Mandu } from "@mandujs/core";
import contract from "../contracts/post.contract";

export default Mandu.filling()
  // 📋 List Posts
  .get(async (ctx) => {
    const input = await ctx.input(contract, "GET", ctx.params);
    const { page, limit } = input;

    // TODO: Implement database query
    // const offset = (page - 1) * limit;
    // const items = await db.select().from(posts).limit(limit).offset(offset);
    // const total = await db.select({ count: count() }).from(posts);

    const mockData = {
      data: [], // Replace with actual data
      pagination: {
        page,
        limit,
        total: 0,
      },
    };

    return ctx.output(contract, 200, mockData);
  })

  // 📄 Get Single Post
  .get(async (ctx) => {
    const { id } = ctx.params;

    // TODO: Implement database query
    // const item = await db.select().from(posts).where(eq(posts.id, id)).limit(1);
    // if (!item) return ctx.notFound("Post not found");

    const mockData = {
      data: { id, message: "Post details" }, // Replace with actual data
    };

    return ctx.output(contract, 200, mockData);
  })

  // ➕ Create Post
  .post(async (ctx) => {
    const input = await ctx.input(contract, "POST", ctx.params);

    // TODO: Implement database insertion
    // const [created] = await db.insert(posts).values(input).returning();

    const mockData = {
      data: { id: "new-id", ...input }, // Replace with actual created data
    };

    return ctx.output(contract, 201, mockData);
  })

  // ✏️ Update Post
  .put(async (ctx) => {
    const { id } = ctx.params;
    const input = await ctx.input(contract, "PUT", ctx.params);

    // TODO: Implement database update
    // const [updated] = await db.update(posts)
    //   .set(input)
    //   .where(eq(posts.id, id))
    //   .returning();
    // if (!updated) return ctx.notFound("Post not found");

    const mockData = {
      data: { id, ...input }, // Replace with actual updated data
    };

    return ctx.output(contract, 200, mockData);
  })

  // 🗑️ Delete Post
  .delete(async (ctx) => {
    const { id } = ctx.params;

    // TODO: Implement database deletion
    // const deleted = await db.delete(posts).where(eq(posts.id, id));
    // if (!deleted) return ctx.notFound("Post not found");

    return ctx.output(contract, 200, { data: { message: "Post deleted" } });
  })

// 💡 Contract 기반 사용법:
// ctx.input(contract, "GET")  - Contract로 요청 검증 + 정규화
// ctx.output(contract, 200, data) - Contract로 응답 검증
// ctx.okContract(contract, data)  - 200 OK (Contract 검증)
// ctx.createdContract(contract, data) - 201 Created (Contract 검증)
//
// 💡 데이터베이스 연동 예시:
// const { data } = await db.select().from(posts).where(eq(posts.id, id));
// return ctx.output(contract, 200, { data });
