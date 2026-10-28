import { version } from "../package.json";

const string = { type: "string" };
const boolean = { type: "boolean" };
const integer = { type: "integer", format: "int64" };
const timestamp = { type: "string", format: "date-time" };
const hash = { type: "string", pattern: "^[0-9a-fA-F]{64}$" };
const type = { type: "string", enum: ["Text", "File", "Image", "Group"] };
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const content = (schema: unknown) => ({ "application/json": { schema } });
const pathParameter = (name: string) => ({ name, in: "path", required: true, schema: string });
const response = {
  "200": { description: "Success" },
  "400": { description: "Invalid request" },
  "401": { description: "Basic authentication required" },
  "404": { description: "Not found" },
  "422": { description: "Transfer data failed validation", content: content(ref("TransferProblem")) },
};
const operation = (summary: string, schema?: unknown) => ({
  summary,
  responses: { ...response, "200": { description: "Success", ...(schema ? { content: content(schema) } : {}) } },
});
const jsonBody = (schema: unknown) => ({ required: true, content: content(schema) });

const profile = {
  type: "object",
  properties: {
    type,
    hash,
    text: string,
    hasData: boolean,
    dataName: { ...string, nullable: true },
    transferDataHash: hash,
    size: integer,
    syncedAt: timestamp,
  },
};
const history = {
  type: "object",
  required: ["type", "hash"],
  properties: {
    type,
    hash,
    text: string,
    size: integer,
    createTime: timestamp,
    lastModified: timestamp,
    lastAccessed: timestamp,
    starred: boolean,
    pinned: boolean,
    isDeleted: boolean,
    hasData: boolean,
    version: integer,
  },
};
const query = {
  type: "object",
  properties: {
    page: { type: "integer", default: 1 },
    before: timestamp,
    after: timestamp,
    modifiedAfter: timestamp,
    types: {
      ...string,
      default: "All",
      description: "Flags: None, Text, File, Image, Group, FileAndGroup, All, or numeric mask 0–15.",
    },
    searchText: string,
    starred: boolean,
    sortByLastAccessed: { ...boolean, default: false },
  },
};
const update = {
  type: "object",
  properties: {
    starred: boolean,
    pinned: boolean,
    isDelete: boolean,
    version: integer,
    lastModified: timestamp,
    lastAccessed: timestamp,
  },
};

export const openApi = {
  openapi: "3.0.3",
  info: { title: "SyncClipboard Server", version },
  security: [{ basicAuth: [] }],
  components: {
    securitySchemes: { basicAuth: { type: "http", scheme: "basic" } },
    schemas: {
      Profile: profile,
      History: history,
      HistoryUpdate: update,
      HistoryQuery: query,
      TransferProblem: {
        type: "object",
        properties: {
          status: { type: "integer", enum: [422] },
          title: string,
          detail: string,
          code: { type: "string", enum: ["history_data_invalid"] },
        },
      },
      Statistics: {
        type: "object",
        properties: {
          activeCount: integer,
          starredCount: integer,
          deletedCount: integer,
          totalCount: integer,
          totalFileSizeMB: { type: "number" },
        },
      },
    },
  },
  paths: {
    "/api/time": { get: operation("Current server time (UTC)", timestamp) },
    "/api/version": {
      get: {
        ...operation("Server protocol version"),
        responses: {
          "200": { description: "Version string", content: { "text/plain": { schema: string } } },
        },
      },
    },
    "/SyncClipboard.json": {
      get: operation("Read current profile", ref("Profile")),
      put: {
        ...operation("Publish current profile and broadcast RemoteProfileChanged"),
        requestBody: jsonBody(ref("Profile")),
      },
    },
    "/file/{fileName}": {
      parameters: [pathParameter("fileName")],
      get: operation("Download recent transfer file"),
      head: operation("Inspect recent transfer file"),
      put: {
        ...operation("Stage transfer file before publishing a profile"),
        requestBody: {
          required: true,
          content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } },
        },
      },
    },
    "/file": { delete: operation("Clear staged files (history attachments remain)") },
    "/api/history": {
      post: {
        ...operation("Upload history and return the accepted record", ref("History")),
        parameters: [
          {
            name: "X-SyncClipboard-Transfer-Data-Hash",
            in: "header",
            schema: hash,
            description: "Optional SHA-256 of data bytes. Requires the data part.",
          },
        ],
        requestBody: {
          required: true,
          content: {
            "multipart/form-data": {
              schema: { ...history, properties: { ...history.properties, data: { type: "string", format: "binary" } } },
            },
          },
        },
      },
    },
    "/api/history/query": {
      post: {
        ...operation("Query history including tombstones (50 records per page)", {
          type: "array",
          items: ref("History"),
        }),
        requestBody: {
          content: {
            "application/x-www-form-urlencoded": { schema: ref("HistoryQuery") },
            "multipart/form-data": { schema: ref("HistoryQuery") },
          },
        },
      },
    },
    "/api/history/{profileId}": {
      parameters: [pathParameter("profileId")],
      get: operation("Get history metadata by Type-Hash", ref("History")),
    },
    "/api/history/{profileId}/data": {
      parameters: [pathParameter("profileId")],
      get: {
        ...operation("Download verified history data"),
        responses: {
          ...response,
          "200": {
            description: "Transfer file",
            headers: { "X-SyncClipboard-Transfer-Data-Hash": { schema: hash } },
            content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } },
          },
        },
      },
    },
    "/api/history/{type}/{hash}": {
      parameters: [pathParameter("type"), pathParameter("hash")],
      patch: {
        ...operation("Update history using version and five minute clock tolerance"),
        requestBody: jsonBody(ref("HistoryUpdate")),
        responses: {
          ...response,
          "409": { description: "Conflict: current server metadata", content: content(ref("HistoryUpdate")) },
        },
      },
    },
    "/api/history/statistics": { get: operation("History counts and attachment disk usage", ref("Statistics")) },
    "/api/history/clear": {
      delete: operation("Delete all history and attachments", {
        type: "object",
        properties: { deleted: integer },
      }),
    },
  },
};
