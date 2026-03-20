-- CreateTable
CREATE TABLE "SketchCollaborator" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sketchId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'collaborator',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SketchCollaborator_sketchId_fkey" FOREIGN KEY ("sketchId") REFERENCES "Sketch" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SketchCollaborator_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "SketchCollaborator_sketchId_userId_key" ON "SketchCollaborator"("sketchId", "userId");
