/**
 * rateLimit.ts — Rate Limiting Middleware
 *
 * ─── WHAT IS RATE LIMITING? ────────────────────────────────
 *
 * Rate limiting restricts how many requests a client can make in a
 * time window. It protects against:
 *
 *   1. Brute-force attacks (e.g., guessing passwords)
 *   2. DDoS (flooding the server with requests)
 *   3. API abuse (scraping, bulk operations by bots)
 *
 * ─── HOW express-rate-limit WORKS ──────────────────────────
 *
 * It uses a "sliding window" or "fixed window" algorithm:
 *   - Track request count per key (usually IP address)
 *   - If count exceeds `max` within `windowMs`, respond with 429
 *   - After the window expires, the counter resets
 *
 * ─── KEY DECISION: IP vs USER-based limiting ───────────────
 *
 * Auth routes → limit by IP (because the user isn't authenticated yet)
 * API routes  → limit by userId (fairer — multiple users can share an IP,
 *               e.g., behind a corporate NAT or VPN)
 *
 * ─── WHY DIFFERENT LIMITS PER ROUTE? ───────────────────────
 *
 * Auth routes get strict limits (10/min) because they're prime targets
 * for brute-force. Regular API routes get generous limits (200/min)
 * because normal usage can be bursty (loading a folder fetches many files).
 */

import rateLimit from "express-rate-limit";
import type { Request } from "express";

/**
 * Auth rate limiter — applied to /api/auth routes.
 * 10 requests per minute per IP address.
 *
 * This prevents password brute-forcing. Even at 10/min,
 * it would take ~13.7 hours to try 8,192 passwords.
 */
export const authLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute window
    max: 10,              // max 10 requests per window
    standardHeaders: true, // Return rate limit info in `RateLimit-*` headers
    legacyHeaders: false,  // Disable deprecated `X-RateLimit-*` headers
    // The message returned when limit is exceeded:
    message: {
        error: "TOO_MANY_REQUESTS",
        message: "Too many requests from this IP. Please try again in a minute.",
    },
    // Skip successful requests for /me endpoint (session checks are frequent and harmless)
    skip: (req: Request) => req.path === "/me" && req.method === "GET",
});

/**
 * General API rate limiter — applied to all /api routes.
 * 200 requests per minute, keyed by userId when available,
 * falling back to IP address for unauthenticated requests.
 *
 * WHY 200? A typical page load might trigger 5-8 API calls
 * (folder contents, storage usage, stars, etc.), and the user
 * might navigate through 10-15 pages per minute during active use.
 */
export const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    // keyGenerator determines WHAT we count requests by.
    // Using userId means each authenticated user gets their own bucket.
    keyGenerator: (req: Request) => {
        // If the user is authenticated (middleware has run), use userId
        // Otherwise fall back to IP address
        return req.user?.userId ?? req.ip ?? "unknown";
    },
    message: {
        error: "TOO_MANY_REQUESTS",
        message: "Rate limit exceeded. Please slow down.",
    },
});

/**
 * Upload rate limiter — stricter limit for file uploads.
 * 30 uploads per minute per user.
 *
 * File uploads are expensive operations (DB write + storage PUT),
 * so we limit them more aggressively than reads.
 */
export const uploadLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req: Request) => req.user?.userId ?? req.ip ?? "unknown",
    message: {
        error: "TOO_MANY_REQUESTS",
        message: "Too many uploads. Please wait before uploading more files.",
    },
});
