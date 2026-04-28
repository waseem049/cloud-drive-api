/**
 * logger.ts — Structured Logging Utility
 *
 * ─── WHY STRUCTURED LOGGING? ───────────────────────────────
 *
 * Plain `console.log("user logged in")` messages are hard to search,
 * filter, and aggregate in production. Structured logging outputs
 * JSON objects like:
 *
 *   {"level":"info","msg":"user_login","userId":"abc","ts":"2025-..."}
 *
 * This lets you:
 *   - Filter logs by level (show only errors in production)
 *   - Search logs by userId or requestId
 *   - Aggregate metrics (how many logins per hour?)
 *   - Pipe to services like Datadog, CloudWatch, or ELK Stack
 *
 * ─── LOG LEVELS ────────────────────────────────────────────
 *
 *   error — Something broke. Needs immediate attention.
 *   warn  — Something concerning but not broken (e.g., rate limit hit).
 *   info  — Normal operational events (e.g., server started, user login).
 *   debug — Detailed debugging info (e.g., SQL queries, timing data).
 *           Only shown in development.
 *
 * ─── WHY NOT JUST USE console.log? ─────────────────────────
 *
 * 1. console.log has no log levels (can't filter error vs info)
 * 2. console.log outputs plain text (hard to parse programmatically)
 * 3. console.log has no timestamps in many environments
 * 4. console.log can't be redirected to files or services easily
 *
 * We're building a LIGHTWEIGHT logger here instead of using a library
 * like pino or winston to keep dependencies minimal. In a larger
 * production app, you'd use pino for its performance advantages.
 */

type LogLevel = "debug" | "info" | "warn" | "error";

// Numeric ranking for log levels.
// Only messages at or above the configured level are printed.
const LEVEL_RANK: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
};

// In production, suppress debug logs to reduce noise and improve performance.
// In development, show everything for easier debugging.
const MIN_LEVEL: LogLevel = process.env.NODE_ENV === "production" ? "info" : "debug";

/**
 * Core log function. Outputs a JSON line to stdout/stderr.
 *
 * @param level  - Severity level
 * @param msg    - Short machine-readable message (snake_case by convention)
 * @param meta   - Additional structured data to attach
 */
function log(level: LogLevel, msg: string, meta?: Record<string, unknown>): void {
    // Skip messages below the minimum level
    if (LEVEL_RANK[level] < LEVEL_RANK[MIN_LEVEL]) return;

    const entry = {
        level,
        msg,
        ts: new Date().toISOString(),
        ...meta,
    };

    // JSON.stringify produces a single line — important for log aggregators
    // that parse one JSON object per line (NDJSON format).
    const line = JSON.stringify(entry);

    // Use stderr for errors (convention: stderr = errors, stdout = normal output)
    if (level === "error") {
        process.stderr.write(line + "\n");
    } else {
        process.stdout.write(line + "\n");
    }
}

/**
 * Exported logger object with methods for each level.
 *
 * Usage:
 *   logger.info("user_login", { userId: "abc", ip: "1.2.3.4" });
 *   logger.error("db_query_failed", { query: "SELECT ...", error: err.message });
 *   logger.debug("cache_hit", { key: "folder:123" });
 */
export const logger = {
    debug: (msg: string, meta?: Record<string, unknown>) => log("debug", msg, meta),
    info: (msg: string, meta?: Record<string, unknown>) => log("info", msg, meta),
    warn: (msg: string, meta?: Record<string, unknown>) => log("warn", msg, meta),
    error: (msg: string, meta?: Record<string, unknown>) => log("error", msg, meta),
};

/**
 * Express middleware that logs every incoming request and its response time.
 *
 * HOW IT WORKS:
 * We record the start time, then listen for the response "finish" event.
 * When the response is sent, we calculate the duration and log it.
 *
 * This replaces `morgan` with structured JSON logging.
 */
export function requestLogger(
    req: import("express").Request,
    res: import("express").Response,
    next: import("express").NextFunction
): void {
    const start = Date.now();

    // The "finish" event fires when the response has been sent to the client.
    // We use `once` instead of `on` to avoid memory leaks (only listen once).
    res.once("finish", () => {
        const durationMs = Date.now() - start;
        const meta: Record<string, unknown> = {
            method: req.method,
            path: req.path,
            status: res.statusCode,
            durationMs,
        };

        // Attach userId if the request was authenticated
        if (req.user?.userId) {
            meta.userId = req.user.userId;
        }

        // Choose log level based on status code
        if (res.statusCode >= 500) {
            logger.error("http_request", meta);
        } else if (res.statusCode >= 400) {
            logger.warn("http_request", meta);
        } else {
            logger.info("http_request", meta);
        }
    });

    next();
}
