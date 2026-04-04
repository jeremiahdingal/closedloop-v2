/**
 * Ollama Embedding Client
 * Calls /api/embed endpoint to get vector embeddings for text
 */

const DEFAULT_MODEL = "nomic-embed-text";
const DEFAULT_BASE_URL = "http://127.0.0.1:11434";
const BATCH_SIZE = 32;

export interface EmbeddingOptions {
  model?: string;
  baseUrl?: string;
}

/**
 * Embed multiple texts using Ollama /api/embed endpoint
 * Batches requests (32 per call) to avoid overwhelming the server
 */
export async function embedTexts(
  texts: string[],
  options?: EmbeddingOptions
): Promise<Float32Array[]> {
  const model = options?.model || DEFAULT_MODEL;
  const baseUrl = options?.baseUrl || DEFAULT_BASE_URL;

  if (texts.length === 0) return [];

  const results: Float32Array[] = [];

  // Process in batches
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const response = await fetch(`${baseUrl}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        input: batch.length === 1 ? batch[0] : batch,
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Ollama embedding failed: ${response.status} ${response.statusText}`
      );
    }

    const data = (await response.json()) as { embeddings: number[][] };
    if (!data.embeddings || !Array.isArray(data.embeddings)) {
      throw new Error("Invalid embedding response format");
    }

    for (const embedding of data.embeddings) {
      results.push(new Float32Array(embedding));
    }
  }

  return results;
}

/**
 * Check if the embedding model is available on the Ollama server
 */
export async function isEmbeddingModelAvailable(
  options?: EmbeddingOptions
): Promise<boolean> {
  const model = options?.model || DEFAULT_MODEL;
  const baseUrl = options?.baseUrl || DEFAULT_BASE_URL;

  try {
    const response = await fetch(`${baseUrl}/api/tags`, {
      method: "GET",
      headers: { "content-type": "application/json" },
    });

    if (!response.ok) return false;

    const data = (await response.json()) as {
      models?: Array<{ name: string }>;
    };
    if (!data.models) return false;

    // Check if model name matches (strip tags like :latest)
    const modelBase = model.split(":")[0];
    return data.models.some((m) => m.name.startsWith(modelBase));
  } catch {
    return false;
  }
}

/**
 * Serialize a Float32Array to a Buffer for SQLite BLOB storage
 */
export function serializeEmbedding(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

/**
 * Deserialize a Buffer back to a Float32Array
 */
export function deserializeEmbedding(buf: Buffer): Float32Array {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
}

/**
 * Compute cosine similarity between two vectors
 * Returns value between -1 and 1 (typically closer to 1 for similar vectors)
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error("Vectors must have same length");
  }

  let dotProduct = 0;
  let magnitudeA = 0;
  let magnitudeB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    magnitudeA += a[i] * a[i];
    magnitudeB += b[i] * b[i];
  }

  magnitudeA = Math.sqrt(magnitudeA);
  magnitudeB = Math.sqrt(magnitudeB);

  if (magnitudeA === 0 || magnitudeB === 0) {
    return 0;
  }

  return dotProduct / (magnitudeA * magnitudeB);
}
