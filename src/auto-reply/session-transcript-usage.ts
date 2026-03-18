import fs from "node:fs";
import { derivePromptTokens, normalizeUsage, type UsageLike } from "../agents/usage.js";
import {
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
  type SessionEntry,
} from "../config/sessions.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";

export type SessionTranscriptUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  promptTokens: number;
  total: number;
  model?: string;
};

export function readSessionTranscriptUsage(params: {
  sessionId?: string;
  sessionEntry?: SessionEntry;
  agentId?: string;
  sessionKey?: string;
  storePath?: string;
  tailBytes?: number;
}): SessionTranscriptUsage | undefined {
  const sessionId = params.sessionId?.trim();
  if (!sessionId) {
    return undefined;
  }

  let logPath: string;
  try {
    const resolvedAgentId =
      params.agentId ??
      (params.sessionKey ? resolveAgentIdFromSessionKey(params.sessionKey) : undefined);
    logPath = resolveSessionFilePath(
      sessionId,
      params.sessionEntry,
      resolveSessionFilePathOptions({
        agentId: resolvedAgentId,
        storePath: params.storePath,
      }),
    );
  } catch {
    return undefined;
  }

  if (!fs.existsSync(logPath)) {
    return undefined;
  }

  try {
    const tailBytesRaw = params.tailBytes;
    const tailBytes =
      typeof tailBytesRaw === "number" && Number.isFinite(tailBytesRaw) && tailBytesRaw > 0
        ? Math.floor(tailBytesRaw)
        : 8192;
    const stat = fs.statSync(logPath);
    const offset = Math.max(0, stat.size - tailBytes);
    const buf = Buffer.alloc(Math.min(tailBytes, stat.size));
    const fd = fs.openSync(logPath, "r");
    try {
      fs.readSync(fd, buf, 0, buf.length, offset);
    } finally {
      fs.closeSync(fd);
    }

    const tail = buf.toString("utf-8");
    const lines = (offset > 0 ? tail.slice(tail.indexOf("\n") + 1) : tail).split(/\n+/);

    let model: string | undefined;
    let lastUsage: ReturnType<typeof normalizeUsage> | undefined;

    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      try {
        const parsed = JSON.parse(line) as {
          message?: {
            usage?: UsageLike;
            model?: string;
          };
          usage?: UsageLike;
          model?: string;
        };
        const usageRaw = parsed.message?.usage ?? parsed.usage;
        const usage = normalizeUsage(usageRaw);
        if (usage) {
          lastUsage = usage;
        }
        model = parsed.message?.model ?? parsed.model ?? model;
      } catch {
        // ignore malformed lines (including a potentially truncated first tail line)
      }
    }

    if (!lastUsage) {
      return undefined;
    }

    const input = lastUsage.input ?? 0;
    const output = lastUsage.output ?? 0;
    const cacheRead = lastUsage.cacheRead ?? 0;
    const cacheWrite = lastUsage.cacheWrite ?? 0;
    const promptTokens =
      derivePromptTokens(lastUsage) ?? lastUsage.total ?? input + cacheRead + cacheWrite;
    const total = lastUsage.total ?? promptTokens + output;

    if (promptTokens === 0 && total === 0) {
      return undefined;
    }

    return {
      input,
      output,
      cacheRead,
      cacheWrite,
      promptTokens,
      total,
      model,
    };
  } catch {
    return undefined;
  }
}
