import { describe, it, expect } from "vitest";
import {
  deriveContract,
  propsFromOutputSchema,
  actionsFromTools,
  humanizeToolName,
  stripPrefix,
  camelKey,
  type McpToolSpec,
} from "./derive-contract.js";

describe("humanizeToolName", () => {
  it("without prefix, keeps the full name title-cased (bare tool names must not lose their verb)", () => {
    expect(humanizeToolName("get_task")).toBe("Get Task");
    expect(humanizeToolName("complete_task")).toBe("Complete Task");
    expect(humanizeToolName("get_current_weather")).toBe("Get Current Weather");
  });
  it("with matching prefix, strips it and title-cases the rest", () => {
    expect(humanizeToolName("gmail_search_messages", "gmail_")).toBe("Search Messages");
    expect(humanizeToolName("gcal_find_my_free_time", "gcal_")).toBe("Find My Free Time");
  });
  it("prefix that does not match is ignored", () => {
    expect(humanizeToolName("get_task", "gmail_")).toBe("Get Task");
  });
  it("single-word tool name", () => {
    expect(humanizeToolName("discover")).toBe("Discover");
  });
});

describe("stripPrefix", () => {
  it("strips only when the name starts with the prefix", () => {
    expect(stripPrefix("gmail_archive", "gmail_")).toBe("archive");
    expect(stripPrefix("get_task", "gmail_")).toBe("get_task");
  });
  it("no prefix → identity", () => {
    expect(stripPrefix("get_task")).toBe("get_task");
  });
});

describe("camelKey", () => {
  it("camel-cases snake_case", () => {
    expect(camelKey("search_messages")).toBe("searchMessages");
  });
  it("handles single word", () => {
    expect(camelKey("archive")).toBe("archive");
  });
});

describe("propsFromOutputSchema — object shapes", () => {
  it("produces one PropEntry per top-level property", () => {
    const spec = propsFromOutputSchema({
      type: "object",
      properties: {
        messages: { type: "array", items: { type: "object" } },
        nextPageToken: { type: "string" },
      },
      required: ["messages"],
    });
    expect(spec?.properties.messages.required).toBe(true);
    expect(spec?.properties.nextPageToken.required).toBe(false);
    expect(spec?.properties.messages.schema.type).toBe("array");
  });

  it("carries description through", () => {
    const spec = propsFromOutputSchema({
      type: "object",
      properties: {
        id: { type: "string", description: "Message ID" },
      },
    });
    expect(spec?.properties.id.description).toBe("Message ID");
  });
});

describe("propsFromOutputSchema — non-object shapes", () => {
  it("wraps array schema as single `data` prop", () => {
    const spec = propsFromOutputSchema({ type: "array", items: { type: "string" } });
    expect(Object.keys(spec!.properties)).toEqual(["data"]);
    expect(spec?.properties.data.schema.type).toBe("array");
    expect(spec?.properties.data.required).toBe(true);
  });

  it("returns undefined when outputSchema missing", () => {
    expect(propsFromOutputSchema(undefined)).toBeUndefined();
  });
});

describe("actionsFromTools", () => {
  it("bare-named tools retain their verb (regression: no silent prefix stripping)", () => {
    // Real todoist + weather tool names — these previously collapsed to keys like "task".
    const spec = actionsFromTools([
      { name: "get_task" },
      { name: "update_task" },
      { name: "complete_task" },
      { name: "reopen_task" },
      { name: "get_current_weather" },
    ]);
    expect(Object.keys(spec).sort()).toEqual([
      "completeTask",
      "getCurrentWeather",
      "getTask",
      "reopenTask",
      "updateTask",
    ]);
    // Raw tool names preserved on entry.nextStep.
    expect(spec.getTask.nextStep).toBe("get_task");
    expect(spec.getCurrentWeather.nextStep).toBe("get_current_weather");
    // Labels humanize the full name.
    expect(spec.getTask.label).toBe("Get Task");
    expect(spec.getCurrentWeather.label).toBe("Get Current Weather");
  });

  it("wires `tool` for every action, stripping prefix only when asked", () => {
    const spec = actionsFromTools(
      [
        { name: "gmail_archive", inputSchema: { type: "object", properties: { id: { type: "string" } } } },
        { name: "gmail_create_draft" },
      ],
      "gmail_",
    );
    expect(spec.archive.nextStep).toBe("gmail_archive");
    expect(spec.createDraft.nextStep).toBe("gmail_create_draft");
    expect(spec.archive.label).toBe("Archive");
  });

  it("uses inputSchema as action schema", () => {
    const inputSchema = { type: "object" as const, properties: { taskId: { type: "string" as const } } };
    const spec = actionsFromTools([{ name: "complete_task", inputSchema }]);
    expect(spec.completeTask.schema).toEqual(inputSchema);
  });

  it("disambiguates key collisions with numeric suffixes", () => {
    // Contrived: two tools that camelKey to the same string.
    const spec = actionsFromTools([
      { name: "get_task" },
      { name: "getTask" }, // already camel — same key
    ]);
    const keys = Object.keys(spec);
    expect(keys.length).toBe(2);
    expect(keys).toContain("getTask");
    expect(spec[keys[0]].nextStep).toBeDefined();
    expect(spec[keys[1]].nextStep).toBeDefined();
  });
});

describe("deriveContract — end-to-end", () => {
  const searchMessages: McpToolSpec = {
    name: "gmail_search_messages",
    description: "Search messages in Gmail",
    outputSchema: {
      type: "object",
      properties: {
        messages: { type: "array", items: { type: "object" } },
        nextPageToken: { type: "string" },
      },
      required: ["messages"],
    },
  };

  const archive: McpToolSpec = {
    name: "gmail_archive",
    description: "Archive a message",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  };

  it("derives props and actions together (with prefix stripping)", () => {
    const contract = deriveContract({
      serverName: "Gmail",
      dataTool: searchMessages,
      actionTools: [archive],
      toolPrefix: "gmail_",
    });

    // `intent` is retired from `DataContract`. The deriver no longer
    // emits an intent; callers thread their own intent at the outer
    // pipeline level.
    expect(contract.propsSpec?.properties.messages.required).toBe(true);
    expect(contract.actionSpec!.archive.nextStep).toBe("gmail_archive");
  });

  it("bare tool names produce sane action keys with NO prefix", () => {
    const getTask: McpToolSpec = {
      name: "get_task",
      outputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    };
    const completeTask: McpToolSpec = { name: "complete_task" };
    const contract = deriveContract({
      serverName: "Todoist",
      dataTool: getTask,
      actionTools: [completeTask],
    });
    expect(contract.actionSpec!.completeTask.nextStep).toBe("complete_task");
  });

  it("omits actions when no actionTools provided", () => {
    const contract = deriveContract({ serverName: "Gmail", dataTool: searchMessages });
    expect(contract.actionSpec).toBeUndefined();
  });

  it("omits props when dataTool has no outputSchema", () => {
    const contract = deriveContract({
      serverName: "Weather",
      dataTool: { name: "weather_probe" },
      toolPrefix: "weather_",
    });
    expect(contract.propsSpec).toBeUndefined();
  });
});
