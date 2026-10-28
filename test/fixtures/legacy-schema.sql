-- Original EF Core Init migration, before AddHistoryTransferDataHash.
CREATE TABLE "HistoryRecords" (
  "ID" INTEGER NOT NULL CONSTRAINT "PK_HistoryRecords" PRIMARY KEY AUTOINCREMENT,
  "UserId" TEXT NOT NULL, "Type" INTEGER NOT NULL, "Text" TEXT NOT NULL, "Size" INTEGER NOT NULL,
  "TransferDataFile" TEXT NOT NULL, "TransferDataSha256" TEXT NOT NULL, "TransferDataMd5" TEXT NOT NULL,
  "FilePaths" TEXT NOT NULL, "Hash" TEXT NOT NULL, "CreateTime" TEXT NOT NULL,
  "LastAccessed" TEXT NOT NULL, "LastModified" TEXT NOT NULL, "Stared" INTEGER NOT NULL,
  "Pinned" INTEGER NOT NULL, "From" TEXT NOT NULL, "Tags" TEXT NOT NULL, "ExtraData" TEXT NULL,
  "Version" INTEGER NOT NULL, "IsDeleted" INTEGER NOT NULL
);
CREATE TABLE "__EFMigrationsHistory" ("MigrationId" TEXT NOT NULL PRIMARY KEY, "ProductVersion" TEXT NOT NULL);
INSERT INTO "__EFMigrationsHistory" VALUES ('20251105014242_Init', '10.0.0');
CREATE INDEX "IX_History_User_CreateTime_ID" ON "HistoryRecords" ("UserId", "CreateTime", "ID");
CREATE INDEX "IX_History_User_Stared_CreateTime_ID" ON "HistoryRecords" ("UserId", "Stared", "CreateTime", "ID");
CREATE INDEX "IX_History_User_Stared_Type_CreateTime_ID" ON "HistoryRecords" ("UserId", "Stared", "Type", "CreateTime", "ID");
