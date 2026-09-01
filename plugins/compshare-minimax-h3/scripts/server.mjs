import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, mkdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const SERVER_NAME = "compshare-minimax-h3";
const SERVER_VERSION = "0.1.0";
const API_BASE_URL = "https://cp.compshare.cn";
const API_KEY_ENV = "COMPSHARE_MINIMAX_API_KEY";
const OUTPUT_DIR_ENV = "COMPSHARE_MINIMAX_OUTPUT_DIR";
const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled"]);
const RESOLUTIONS = new Set(["768P", "1080P", "2K"]);
const RATIOS = new Set(["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]);
const STATUS_FILTERS = new Set(["queued", "running", "succeeded", "failed", "cancelled"]);
const POINTS_PER_SECOND = { "768P": 10, "1080P": 15, "2K": 20 };

class ToolError extends Error {
  constructor(message, details = undefined) {
    super(message);
    this.name = "ToolError";
    this.details = details;
  }
}

const mediaSchema = {
  type: "array",
  items: { type: "string", format: "uri" },
};

const generationProperties = {
  prompt: {
    type: "string",
    minLength: 1,
    maxLength: 5000,
    description: "视频提示词，最多 5000 个字符。",
  },
  resolution: {
    type: "string",
    enum: ["768P", "1080P", "2K"],
    default: "768P",
    description: "输出分辨率；当前计费分别约为每秒 10、15、20 积分。",
  },
  duration: {
    type: "integer",
    minimum: 4,
    maximum: 15,
    default: 5,
    description: "视频时长（秒），范围 4 到 15。",
  },
  ratio: {
    type: "string",
    enum: ["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
    description: "宽高比。纯文生视频不能使用 adaptive；有素材时默认 adaptive。",
  },
  first_frame_url: {
    type: "string",
    format: "uri",
    description: "可公开访问的首帧图片 URL。不能与参考素材混用。",
  },
  last_frame_url: {
    type: "string",
    format: "uri",
    description: "可公开访问的尾帧图片 URL；必须同时提供首帧。",
  },
  reference_image_urls: {
    ...mediaSchema,
    maxItems: 9,
    description: "最多 9 个可公开访问的参考图片 URL。",
  },
  reference_video_urls: {
    ...mediaSchema,
    maxItems: 3,
    description: "最多 3 个可公开访问的参考视频 URL。",
  },
  reference_audio_urls: {
    ...mediaSchema,
    maxItems: 3,
    description: "最多 3 个可公开访问的参考音频 URL。",
  },
  use_context_ir: {
    type: "boolean",
    default: false,
    description: "是否启用 CompShare Context-IR 提示词优化。",
  },
  callback_url: {
    type: "string",
    format: "uri",
    maxLength: 1024,
    description: "可选的公网状态回调 URL。",
  },
  callback_token: {
    type: "string",
    maxLength: 512,
    description: "可选的回调校验 Token；必须与 callback_url 同时使用。不要填写模型 API Key。",
  },
};

const TOOLS = [
  {
    name: "check_configuration",
    description: "检查 CompShare MiniMax H3 插件配置是否完整，不会显示 API Key。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "estimate_points",
    description: "在创建付费任务前估算积分消耗。积分单价可能变化，最终以 CompShare 控制台为准。",
    inputSchema: {
      type: "object",
      properties: {
        resolution: { type: "string", enum: ["768P", "1080P", "2K"] },
        duration: { type: "integer", minimum: 4, maximum: 15 },
        count: { type: "integer", minimum: 1, maximum: 100, default: 1 },
      },
      required: ["resolution", "duration"],
      additionalProperties: false,
    },
  },
  {
    name: "preview_video_request",
    description: "校验 MiniMax H3 视频参数并预览请求与预计积分，不会提交任务或产生费用。",
    inputSchema: {
      type: "object",
      properties: generationProperties,
      required: ["prompt"],
      additionalProperties: false,
    },
  },
  {
    name: "create_video",
    description: "创建会消耗积分的 MiniMax H3 视频任务。仅当用户已明确要求提交这组参数时，才可将 confirm_spend 设为 true。",
    inputSchema: {
      type: "object",
      properties: {
        ...generationProperties,
        confirm_spend: {
          type: "boolean",
          const: true,
          description: "确认提交付费生成任务，必须为 true。",
        },
        idempotency_key: {
          type: "string",
          minLength: 1,
          maxLength: 255,
          description: "可选幂等键；留空时自动生成。重复提交同一键会返回原任务。",
        },
      },
      required: ["prompt", "confirm_spend"],
      additionalProperties: false,
    },
  },
  {
    name: "get_video_task",
    description: "查询单个 MiniMax H3 视频任务；成功后会返回视频下载 URL。",
    inputSchema: {
      type: "object",
      properties: { task_id: { type: "string", minLength: 1 } },
      required: ["task_id"],
      additionalProperties: false,
    },
  },
  {
    name: "wait_for_video",
    description: "轮询任务直到成功、失败、取消或超时；成功时可自动下载到本机。",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", minLength: 1 },
        poll_interval_seconds: { type: "integer", minimum: 3, maximum: 60, default: 10 },
        timeout_seconds: { type: "integer", minimum: 3, maximum: 1800, default: 900 },
        download_on_success: { type: "boolean", default: false },
        output_path: { type: "string", description: "可选下载路径；省略时保存到用户视频目录。" },
        overwrite: { type: "boolean", default: false },
      },
      required: ["task_id"],
      additionalProperties: false,
    },
  },
  {
    name: "list_video_tasks",
    description: "分页查看当前 CompShare 公司账号下的 MiniMax H3 视频任务。",
    inputSchema: {
      type: "object",
      properties: {
        page_num: { type: "integer", minimum: 1, default: 1 },
        page_size: { type: "integer", minimum: 1, maximum: 100, default: 20 },
        status: { type: "string", enum: ["queued", "running", "succeeded", "failed", "cancelled"] },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_points_balance",
    description: "查询 MiniMax H3 总积分、已预占积分和当前可用积分。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_point_packages",
    description: "查询 MiniMax H3 积分套餐包及其有效期、剩余和可用积分。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "cancel_video_task",
    description: "取消尚未结束的视频任务。取消不会删除历史记录；运行中的任务可能需要稍后再次查询才显示 cancelled。",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", minLength: 1 },
        confirm_cancel: { type: "boolean", const: true, description: "确认取消，必须为 true。" },
      },
      required: ["task_id", "confirm_cancel"],
      additionalProperties: false,
    },
  },
  {
    name: "download_video",
    description: "查询成功任务并将结果视频下载到本机；下载请求不会携带 CompShare API Key。",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", minLength: 1 },
        output_path: { type: "string", description: "可选文件或目录路径；省略时保存到用户视频目录。" },
        overwrite: { type: "boolean", default: false },
      },
      required: ["task_id"],
      additionalProperties: false,
    },
  },
];

function requireApiKey() {
  const key = process.env[API_KEY_ENV]?.trim();
  if (!key) {
    throw new ToolError(
      `尚未配置 ${API_KEY_ENV}。请运行插件 scripts/configure-key.ps1，然后完全重启 Codex。`,
    );
  }
  if (!key.startsWith("sk-ml-")) {
    throw new ToolError(`${API_KEY_ENV} 格式不正确：CompShare 模型 API Key 应以 sk-ml- 开头。`);
  }
  return key;
}

function assertInteger(value, label, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ToolError(`${label} 必须是 ${min} 到 ${max} 之间的整数。`);
  }
}

function assertRemoteUrl(value, label) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new ToolError(`${label} 必须是有效的公网 http/https URL。`);
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol)) {
    throw new ToolError(`${label} 只支持 http/https URL。`);
  }
  return parsed.toString();
}

function mediaArray(value, label, max) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) {
    throw new ToolError(`${label} 最多允许 ${max} 项。`);
  }
  return value.map((item, index) => assertRemoteUrl(item, `${label}[${index}]`));
}

function buildGenerationRequest(args) {
  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
  if (!prompt) throw new ToolError("prompt 不能为空。");
  if (prompt.length > 5000) throw new ToolError("prompt 不能超过 5000 个字符。");

  const resolution = args.resolution ?? "768P";
  if (!RESOLUTIONS.has(resolution)) throw new ToolError("resolution 只支持 768P、1080P 或 2K。");
  const duration = args.duration ?? 5;
  assertInteger(duration, "duration", 4, 15);

  const firstFrame = args.first_frame_url
    ? assertRemoteUrl(args.first_frame_url, "first_frame_url")
    : undefined;
  const lastFrame = args.last_frame_url
    ? assertRemoteUrl(args.last_frame_url, "last_frame_url")
    : undefined;
  const referenceImages = mediaArray(args.reference_image_urls, "reference_image_urls", 9);
  const referenceVideos = mediaArray(args.reference_video_urls, "reference_video_urls", 3);
  const referenceAudios = mediaArray(args.reference_audio_urls, "reference_audio_urls", 3);
  const hasFrameMode = Boolean(firstFrame || lastFrame);
  const hasReferenceMode = referenceImages.length + referenceVideos.length + referenceAudios.length > 0;

  if (lastFrame && !firstFrame) throw new ToolError("提供尾帧时必须同时提供首帧。");
  if (hasFrameMode && hasReferenceMode) throw new ToolError("首尾帧模式不能与参考图片、视频或音频混用。");

  const hasMedia = hasFrameMode || hasReferenceMode;
  const ratio = args.ratio ?? (hasMedia ? "adaptive" : "16:9");
  if (!RATIOS.has(ratio)) throw new ToolError("ratio 参数不受支持。");
  if (!hasMedia && ratio === "adaptive") throw new ToolError("纯文生视频不能使用 adaptive，请选择明确的宽高比。");

  if (args.callback_token && !args.callback_url) {
    throw new ToolError("callback_token 必须与 callback_url 同时使用。");
  }

  const content = [{ type: "text", text: prompt }];
  if (firstFrame) content.push({ type: "image_url", image_url: { url: firstFrame }, role: "first_frame" });
  if (lastFrame) content.push({ type: "image_url", image_url: { url: lastFrame }, role: "last_frame" });
  for (const url of referenceImages) {
    content.push({ type: "image_url", image_url: { url }, role: "reference_image" });
  }
  for (const url of referenceVideos) {
    content.push({ type: "video_url", video_url: { url }, role: "reference_video" });
  }
  for (const url of referenceAudios) {
    content.push({ type: "audio_url", audio_url: { url }, role: "reference_audio" });
  }

  const request = {
    model: "MiniMax-H3",
    content,
    resolution,
    duration,
    ratio,
    use_context_ir: args.use_context_ir ?? false,
    aigc_watermark: false,
  };
  if (args.callback_url) request.callback_url = assertRemoteUrl(args.callback_url, "callback_url");
  if (args.callback_token) request.callback_token = args.callback_token;

  return {
    request,
    estimate: estimatePoints(resolution, duration, 1),
    mode: hasFrameMode ? (lastFrame ? "first_last_frame" : "first_frame") : hasReferenceMode ? "reference" : "text",
  };
}

function estimatePoints(resolution, duration, count) {
  if (!RESOLUTIONS.has(resolution)) throw new ToolError("resolution 只支持 768P、1080P 或 2K。");
  assertInteger(duration, "duration", 4, 15);
  assertInteger(count, "count", 1, 100);
  const pointsPerSecond = POINTS_PER_SECOND[resolution];
  return {
    resolution,
    duration_seconds: duration,
    count,
    points_per_second: pointsPerSecond,
    estimated_points_each: pointsPerSecond * duration,
    estimated_points_total: pointsPerSecond * duration * count,
    note: "按 2026-08-13 CompShare 文档估算，最终以控制台实时计费为准。",
  };
}

function safeRequestPreview(built) {
  const request = { ...built.request };
  if (request.callback_token) request.callback_token = "[已隐藏]";
  return { mode: built.mode, estimate: built.estimate, request };
}

async function apiRequest(method, pathname, { query, body, idempotencyKey } = {}) {
  const apiKey = requireApiKey();
  const url = new URL(pathname, API_BASE_URL);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }

  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") throw new ToolError("连接 CompShare API 超时（60 秒）。");
    throw new ToolError(`无法连接 CompShare API：${error?.message ?? String(error)}`);
  } finally {
    clearTimeout(timer);
  }

  const responseText = await response.text();
  let payload = {};
  if (responseText) {
    try {
      payload = JSON.parse(responseText);
    } catch {
      payload = { message: responseText.slice(0, 1000) };
    }
  }
  if (!response.ok) {
    const message = payload?.error?.message ?? payload?.Message ?? payload?.message ?? response.statusText;
    throw new ToolError(`CompShare API 返回 ${response.status}：${message}`, {
      http_status: response.status,
      request_id: payload?.request_id ?? payload?.request_uuid,
      error: payload?.error ?? (payload?.RetCode ? { code: payload.RetCode, message: payload.Message } : undefined),
    });
  }
  return payload;
}

async function getTask(taskId) {
  if (!taskId || typeof taskId !== "string") throw new ToolError("task_id 不能为空。");
  return apiRequest("GET", `/minimax/v2/query/video_generation/${encodeURIComponent(taskId)}`);
}

function outputDirectory() {
  const configured = process.env[OUTPUT_DIR_ENV]?.trim();
  return configured ? path.resolve(configured) : path.join(homedir(), "Videos", "MiniMax-H3");
}

function sanitizeFilename(value) {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120) || "video";
}

function downloadTarget(taskId, videoUrl, requestedPath) {
  let extension = path.extname(new URL(videoUrl).pathname).toLowerCase();
  if (![".mp4", ".mov", ".webm", ".mkv"].includes(extension)) extension = ".mp4";
  const defaultName = `${sanitizeFilename(taskId)}${extension}`;
  if (!requestedPath) return path.join(outputDirectory(), defaultName);

  const resolved = path.resolve(requestedPath);
  if (path.extname(resolved)) return resolved;
  return path.join(resolved, defaultName);
}

async function pathExists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function downloadTaskVideo(task, requestedPath, overwrite) {
  if (task?.status !== "succeeded") {
    throw new ToolError(`任务尚不能下载，当前状态为 ${task?.status ?? "unknown"}。`);
  }
  const videoUrl = task?.content?.url;
  if (!videoUrl) throw new ToolError("成功任务没有返回 content.url。");
  assertRemoteUrl(videoUrl, "content.url");
  const target = downloadTarget(task.id, videoUrl, requestedPath);
  await mkdir(path.dirname(target), { recursive: true });
  if (!overwrite && (await pathExists(target))) {
    throw new ToolError(`文件已存在：${target}。如需替换，请明确设置 overwrite=true。`);
  }

  const response = await fetch(videoUrl, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new ToolError(`下载视频失败：HTTP ${response.status} ${response.statusText}`);
  }
  const tempTarget = `${target}.part-${randomUUID()}`;
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(tempTarget, { flags: "wx" }));
    if (overwrite && (await pathExists(target))) await rm(target, { force: true });
    await rename(tempTarget, target);
  } catch (error) {
    await rm(tempTarget, { force: true }).catch(() => {});
    if (error instanceof ToolError) throw error;
    throw new ToolError(`保存视频失败：${error?.message ?? String(error)}`);
  }

  return {
    task_id: task.id,
    local_path: target,
    source_url: videoUrl,
    content_type: response.headers.get("content-type"),
    content_length: response.headers.get("content-length")
      ? Number(response.headers.get("content-length"))
      : undefined,
  };
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function dispatchTool(name, args = {}) {
  switch (name) {
    case "check_configuration": {
      const key = process.env[API_KEY_ENV]?.trim();
      return {
        configured: Boolean(key?.startsWith("sk-ml-")),
        api_key_present: Boolean(key),
        api_key_format_ok: Boolean(key?.startsWith("sk-ml-")),
        api_key_env: API_KEY_ENV,
        api_base_url: API_BASE_URL,
        output_directory: outputDirectory(),
        restart_required_after_change: true,
      };
    }
    case "estimate_points":
      return estimatePoints(args.resolution, args.duration, args.count ?? 1);
    case "preview_video_request":
      return safeRequestPreview(buildGenerationRequest(args));
    case "create_video": {
      if (args.confirm_spend !== true) {
        throw new ToolError("未确认积分消耗。只有用户明确要求提交该任务时，才能设置 confirm_spend=true。");
      }
      const built = buildGenerationRequest(args);
      const idempotencyKey = args.idempotency_key?.trim() || `codex-${randomUUID()}`;
      const response = await apiRequest("POST", "/minimax/v2/video_generation", {
        body: built.request,
        idempotencyKey,
      });
      return {
        ...response,
        mode: built.mode,
        estimate: built.estimate,
        idempotency_key: idempotencyKey,
      };
    }
    case "get_video_task":
      return getTask(args.task_id);
    case "wait_for_video": {
      const interval = args.poll_interval_seconds ?? 10;
      const timeout = args.timeout_seconds ?? 900;
      assertInteger(interval, "poll_interval_seconds", 3, 60);
      assertInteger(timeout, "timeout_seconds", 3, 1800);
      const startedAt = Date.now();
      let payload;
      while (true) {
        payload = await getTask(args.task_id);
        const task = payload?.task;
        if (TERMINAL_STATUSES.has(task?.status)) {
          const result = { ...payload, waited_seconds: Math.round((Date.now() - startedAt) / 1000) };
          if (task.status === "succeeded" && args.download_on_success) {
            result.download = await downloadTaskVideo(task, args.output_path, args.overwrite ?? false);
          }
          return result;
        }
        const elapsed = (Date.now() - startedAt) / 1000;
        if (elapsed >= timeout) {
          return {
            ...payload,
            timed_out: true,
            waited_seconds: Math.round(elapsed),
            message: "等待超时；任务仍可继续运行，请稍后再次查询。",
          };
        }
        await sleep(Math.min(interval, Math.max(0, timeout - elapsed)) * 1000);
      }
    }
    case "list_video_tasks": {
      const pageNum = args.page_num ?? 1;
      const pageSize = args.page_size ?? 20;
      assertInteger(pageNum, "page_num", 1, Number.MAX_SAFE_INTEGER);
      assertInteger(pageSize, "page_size", 1, 100);
      if (args.status && !STATUS_FILTERS.has(args.status)) throw new ToolError("status 筛选值不受支持。");
      return apiRequest("GET", "/minimax/v2/query/video_generation", {
        query: {
          page_num: pageNum,
          page_size: pageSize,
          "filter.status": args.status,
          "filter.model": "MiniMax-H3",
          "filter.task_type": "generation",
        },
      });
    }
    case "get_points_balance":
      return apiRequest("GET", "/minimax/v2/query/point_usage_summary");
    case "list_point_packages":
      return apiRequest("GET", "/minimax/v2/query/point_packages");
    case "cancel_video_task":
      if (args.confirm_cancel !== true) throw new ToolError("取消操作未确认。请将 confirm_cancel 设为 true。");
      return apiRequest("DELETE", `/minimax/v2/video_generation/${encodeURIComponent(args.task_id)}`);
    case "download_video": {
      const payload = await getTask(args.task_id);
      return downloadTaskVideo(payload?.task, args.output_path, args.overwrite ?? false);
    }
    default:
      throw new ToolError(`未知工具：${name}`);
  }
}

function toolResult(data) {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

function toolErrorResult(error) {
  const data = {
    error: {
      message: error?.message ?? String(error),
      ...(error?.details ? { details: error.details } : {}),
    },
  };
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
    isError: true,
  };
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handleMessage(message) {
  if (!message || message.jsonrpc !== "2.0") return;
  if (message.id === undefined || message.id === null) return;

  try {
    let result;
    switch (message.method) {
      case "initialize":
        result = {
          protocolVersion: message.params?.protocolVersion ?? "2024-11-05",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        };
        break;
      case "ping":
        result = {};
        break;
      case "tools/list":
        result = { tools: TOOLS };
        break;
      case "tools/call":
        try {
          result = toolResult(
            await dispatchTool(message.params?.name, message.params?.arguments ?? {}),
          );
        } catch (error) {
          result = toolErrorResult(error);
        }
        break;
      case "logging/setLevel":
        result = {};
        break;
      default:
        send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: `Method not found: ${message.method}` },
        });
        return;
    }
    send({ jsonrpc: "2.0", id: message.id, result });
  } catch (error) {
    send({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32603, message: error?.message ?? String(error) },
    });
  }
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const parsed = JSON.parse(trimmed);
    void handleMessage(parsed);
  } catch (error) {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: `Parse error: ${error.message}` } });
  }
});

