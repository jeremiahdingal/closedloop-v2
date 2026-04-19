import { AppDatabase } from "../db/database.ts";
import { loadConfig } from "../config.ts";

async function main() {
  const config = loadConfig();
  const db = new AppDatabase(config.dbPath);
  const epicId = "epic_f807031a495992f7";
  
  const epic = db.getEpic(epicId);
  if (!epic) {
    console.error(`Epic ${epicId} not found.`);
    process.exit(1);
  }

  console.log(`Marking epic ${epicId} ("${epic.title}") as done...`);
  db.updateEpicStatus(epicId, "done");
  console.log("Success.");
}

void main();
