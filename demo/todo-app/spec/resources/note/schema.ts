import { defineResource } from "@mandujs/core";

export const noteResource = defineResource({
  name: "note",
  fields: {
    title: { type: "string", required: true, description: "Note title" },
    content: { type: "string", required: true, description: "Note body text" },
    todoId: { type: "string", description: "Optional linked todo ID" },
    pinned: { type: "boolean", default: false, description: "Pin to top" },
  },
  options: {
    description: "Quick notes attached to todos for additional context",
    tags: ["notes"],
    endpoints: {
          "list": true,
          "get": true,
          "create": true,
          "update": true,
          "delete": true
    },
  },
});

export default noteResource;
