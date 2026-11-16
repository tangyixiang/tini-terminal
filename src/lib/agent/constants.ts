/** 单次任务最大工具调用轮次 */
export const MAX_AGENT_LOOPS = 20;

/** 流式渲染节流间隔，兼顾流畅度与渲染开销 */
export const STREAM_FLUSH_INTERVAL_MS = 50;

/** 结论请求失败后的额外重试次数 */
export const CONCLUSION_RETRY_TIMES = 1;

/** 上下文保留的最近历史消息条数 */
export const HISTORY_MESSAGE_LIMIT = 20;
