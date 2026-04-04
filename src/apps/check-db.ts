import { AppDatabase } from "../db/database.ts";

const db = new AppDatabase("data/state.db");

console.log("=== EPICS ===");
const epics = db.listEpics();
epics.forEach(e => console.log(JSON.stringify(e, null, 2)));

console.log("\n=== JOBS ===");
const jobs = db.listJobs();
jobs.forEach(j => console.log(JSON.stringify(j, null, 2)));

console.log("\n=== TICKETS ===");
const tickets = db.listTickets ? db.listTickets() : [];
tickets.forEach(t => console.log(JSON.stringify(t, null, 2)));

console.log("\n=== NEXT QUEUED JOB ===");
const nextJob = db.nextQueuedJob();
console.log(nextJob ? JSON.stringify(nextJob, null, 2) : "No queued jobs found");

db.close();
