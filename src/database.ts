import { Database, type SQLQueryBindings } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { profileTypes, type HistoryQuery, type HistoryRecord, type ProfileType } from "./models";

const userId = "default_user";
type Row = Record<string, any>;

function utc(value: string): string {
  const normalized = value.replace(" ", "T");
  return new Date(/[zZ]|[+-]\d\d:\d\d$/.test(normalized) ? normalized : `${normalized}Z`).toISOString();
}

function fromRow(row: Row): HistoryRecord {
  const paths = JSON.parse(row.FilePaths) as string[];
  return {
    id: row.ID,
    userId: row.UserId,
    type: profileTypes[row.Type]!,
    hash: row.Hash,
    text: row.Text,
    size: row.Size,
    transferDataFile: row.TransferDataFile,
    transferDataHash: row.TransferDataHash,
    filePaths: paths,
    createTime: utc(row.CreateTime),
    lastAccessed: utc(row.LastAccessed),
    lastModified: utc(row.LastModified),
    starred: !!row.Stared,
    pinned: !!row.Pinned,
    version: row.Version,
    isDeleted: !!row.IsDeleted,
    hasData: !!row.TransferDataFile || paths.length > 0,
  };
}

export class HistoryDatabase {
  readonly db: Database;

  constructor(dataDir: string) {
    mkdirSync(join(dataDir, "data"), { recursive: true });
    this.db = new Database(join(dataDir, "data", "history.db"));
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
    this.db.transaction(() => {
      this.db.exec(`CREATE TABLE IF NOT EXISTS HistoryRecords (
        ID INTEGER PRIMARY KEY AUTOINCREMENT, UserId TEXT NOT NULL, Type INTEGER NOT NULL,
        Text TEXT NOT NULL, Size INTEGER NOT NULL, TransferDataFile TEXT NOT NULL,
        TransferDataHash TEXT NULL, TransferDataSha256 TEXT NOT NULL DEFAULT '',
        TransferDataMd5 TEXT NOT NULL DEFAULT '', FilePaths TEXT NOT NULL,
        Hash TEXT NOT NULL, CreateTime TEXT NOT NULL, LastAccessed TEXT NOT NULL,
        LastModified TEXT NOT NULL, Stared INTEGER NOT NULL, Pinned INTEGER NOT NULL,
        "From" TEXT NOT NULL DEFAULT '', Tags TEXT NOT NULL DEFAULT '[]', ExtraData TEXT NULL,
        Version INTEGER NOT NULL, IsDeleted INTEGER NOT NULL
      );`);
      const columns = this.db.query<{ name: string }, []>("PRAGMA table_info(HistoryRecords)").all();
      if (!columns.some((column) => column.name === "TransferDataHash")) {
        this.db.exec("ALTER TABLE HistoryRecords ADD COLUMN TransferDataHash TEXT NULL");
      }
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS IX_History_User_CreateTime_ID ON HistoryRecords(UserId, CreateTime, ID);
        CREATE INDEX IF NOT EXISTS IX_History_User_Stared_CreateTime_ID ON HistoryRecords(UserId, Stared, CreateTime, ID);
        CREATE INDEX IF NOT EXISTS IX_History_User_Stared_Type_CreateTime_ID ON HistoryRecords(UserId, Stared, Type, CreateTime, ID);
        CREATE INDEX IF NOT EXISTS IX_History_User_Type_Hash ON HistoryRecords(UserId, Type, Hash COLLATE NOCASE);
      `);
    })();
  }

  get(type: ProfileType, hash: string): HistoryRecord | undefined {
    const row = this.db
      .query<Row, [string, number, string]>(
        "SELECT * FROM HistoryRecords WHERE UserId = ? AND Type = ? AND Hash = ? COLLATE NOCASE ORDER BY ID LIMIT 1",
      )
      .get(userId, profileTypes.indexOf(type), hash);
    return row ? fromRow(row) : undefined;
  }

  all(): HistoryRecord[] {
    return this.db.query<Row, [string]>("SELECT * FROM HistoryRecords WHERE UserId = ?").all(userId).map(fromRow);
  }

  query(query: HistoryQuery): HistoryRecord[] {
    const clauses = ["UserId = ?"];
    const values: SQLQueryBindings[] = [userId];
    const time = query.sortByLastAccessed ? "LastAccessed" : "CreateTime";
    for (const [field, operator, value] of [
      [time, "<", query.before],
      [time, ">=", query.after],
      ["LastModified", ">=", query.modifiedAfter],
    ] as const) {
      if (value) {
        clauses.push(`julianday(${field}) ${operator} julianday(?)`);
        values.push(value);
      }
    }
    if (query.types != null && query.types !== 15) {
      clauses.push("((1 << Type) & ?) != 0");
      values.push(query.types);
    }
    if (query.searchText) {
      clauses.push("Text LIKE ?");
      values.push(`%${query.searchText}%`);
    }
    if (query.starred != null) {
      clauses.push("Stared = ?");
      values.push(Number(query.starred));
    }
    values.push((Math.max(1, query.page ?? 1) - 1) * 50);
    return this.db
      .query<Row, SQLQueryBindings[]>(
        `SELECT * FROM HistoryRecords WHERE ${clauses.join(" AND ")} ORDER BY julianday(${time}) DESC, ID DESC LIMIT 50 OFFSET ?`,
      )
      .all(...values)
      .map(fromRow);
  }

  save(record: HistoryRecord): void {
    const columns = [
      "UserId",
      "Type",
      "Hash",
      "Text",
      "Size",
      "TransferDataFile",
      "TransferDataHash",
      "FilePaths",
      "CreateTime",
      "LastAccessed",
      "LastModified",
      "Stared",
      "Pinned",
      "Version",
      "IsDeleted",
    ];
    const values: SQLQueryBindings[] = [
      record.userId,
      profileTypes.indexOf(record.type),
      record.hash,
      record.text,
      record.size,
      record.transferDataFile,
      record.transferDataHash,
      JSON.stringify(record.filePaths),
      record.createTime,
      record.lastAccessed,
      record.lastModified,
      Number(record.starred),
      Number(record.pinned),
      record.version,
      Number(record.isDeleted),
    ];
    if (record.id) {
      this.db
        .query(`UPDATE HistoryRecords SET ${columns.map((name) => `${name} = ?`).join(",")} WHERE ID = ?`)
        .run(...values, record.id);
    } else {
      // EF Core's original schema has required legacy fields without SQL defaults.
      columns.push("TransferDataSha256", "TransferDataMd5", '"From"', "Tags");
      values.push("", "", "", "[]");
      const result = this.db
        .query(`INSERT INTO HistoryRecords (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`)
        .run(...values);
      record.id = Number(result.lastInsertRowid);
    }
  }

  remove(id: number): void {
    this.db.query("DELETE FROM HistoryRecords WHERE ID = ? AND UserId = ?").run(id, userId);
  }

  close(): void {
    this.db.close();
  }
}
