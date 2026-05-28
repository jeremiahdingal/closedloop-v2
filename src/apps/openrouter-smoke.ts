import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

function loadEnv() {
  if (process.env.OPENROUTER_API_KEY) return;
  const envPath = path.resolve(process.cwd(), ".env");
  if (existsSync(envPath)) {
    const content = readFileSync(envPath, "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const separatorIndex = trimmed.indexOf("=");
      if (separatorIndex <= 0) continue;
      const key = trimmed.slice(0, separatorIndex).trim();
      let value = trimmed.slice(separatorIndex + 1).trim();
      if (
        (value.startsWith("\"") && value.endsWith("\""))
        || (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (key === "OPENROUTER_API_KEY") {
        process.env.OPENROUTER_API_KEY = value;
      }
    }
  }
}

async function smokeTest() {
  loadEnv();
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error("OPENROUTER_API_KEY not found");
    process.exit(1);
  }

  const modelsRes = await fetch("https://openrouter.ai/api/v1/models");
  const modelsData = await modelsRes.json() as any;
  const freeModels = modelsData.data.filter((m: any) => 
    m.pricing?.prompt === "0" && m.pricing?.completion === "0"
  ).map((m: any) => m.id);

  if (freeModels.length === 0) {
    console.log(JSON.stringify({ error: "No free models found" }));
    process.exit(0);
  }

  const preferredFree = ["google/gemini-2.0-flash-exp:free", "google/gemini-2.0-pro-exp-02-05:free", "mistralai/mistral-7b-instruct:free", "meta-llama/llama-3-8b-instruct:free"];
  let targetModel = freeModels[0];
  for (const p of preferredFree) {
    if (freeModels.includes(p)) {
      targetModel = p;
      break;
    }
  }

  const chatRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com/google/gemini-cli",
      "X-Title": "Gemini CLI Integration Test"
    },
    body: JSON.stringify({
      model: targetModel,
      messages: [{ role: "user", content: "Say 'OpenRouter streaming is working' and your model id." }],
      stream: true
    })
  });

  if (!chatRes.ok) {
     console.log(JSON.stringify({ status: chatRes.status, body: await chatRes.text() }));
     process.exit(1);
  }

  const reader = chatRes.body?.getReader();
  const decoder = new TextDecoder();
  let result = "";
  while (true) {
    const { done, value } = await reader!.read();
    if (done) break;
    const chunk = decoder.decode(value);
    result += chunk;
  }
  console.log(JSON.stringify({
    freeModelsCount: freeModels.length,
    selectedModel: targetModel,
    status: chatRes.status,
    result: result.slice(0, 500)
  }, null, 2));
}

smokeTest().catch(console.error);
