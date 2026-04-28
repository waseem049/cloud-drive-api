/**
 * index.ts — Express Server Entry Point
 *
 * ─── MIDDLEWARE ORDER MATTERS! ─────────────────────────────
 *
 * Express processes middleware in the order they are registered.
 * The correct order is:
 *
 *   1. Security headers (helmet)   — first, to protect all responses
 *   2. Request logging             — before routes, to log everything
 *   3. CORS                        — before body parsing
 *   4. Body parsing (express.json) — before routes need req.body
 *   5. Cookie parsing              — before auth middleware reads cookies
 *   6. Rate limiting               — before routes, to block abusers early
 *   7. Route handlers              — the actual business logic
 *   8. Error handler               — LAST, catches anything thrown above
 */

import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { testDbConnection } from './db/client';
import { applyIdempotentSchemaPatches } from './db/schemaPatches';
import { errorHandler } from './middleware/errorHandler';
import { authLimiter, apiLimiter, uploadLimiter } from './middleware/rateLimit';
import { logger, requestLogger } from './utils/logger';
import { authRouter } from './routes/auth';
import { filesRouter } from './routes/files';
import { foldersRouter } from './routes/folders';
import { trashRouter } from './routes/trash';
import { searchRouter } from './routes/search';
import { storageRouter } from './routes/storage';
import { shareRouter } from './routes/share';
import { starsRouter } from './routes/stars';
import { profileRouter } from './routes/profile';
import { bulkRouter } from './routes/bulk';

const app = express();
const PORT = process.env.PORT || 5000;

// ── 1. Security Headers ──────────────────────────────────────
// Helmet sets HTTP headers like X-Content-Type-Options, X-Frame-Options,
// and Content-Security-Policy to prevent common web attacks.
app.use(helmet());

// ── 2. Request Logging ───────────────────────────────────────
// Our custom structured JSON logger replaces morgan.
// Every request is logged with method, path, status, and duration.
app.use(requestLogger);

// ── 3. CORS ──────────────────────────────────────────────────
// Cross-Origin Resource Sharing: allows the frontend (port 3000)
// to call the backend (port 5000) across different origins.
// `credentials: true` is required for cookies to be sent cross-origin.
app.use(cors({
    origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// ── 4. Body Parsing ──────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));
app.options('/{*path}', cors());

// ── 5. Cookie Parsing ────────────────────────────────────────
app.use(cookieParser());

// ── 6. Global API Rate Limiter ───────────────────────────────
// Applied to ALL /api routes. Individual route groups can have
// stricter limits applied on top of this.
app.use('/api', apiLimiter);

// ── 7. Route Handlers ────────────────────────────────────────
// Auth routes get an EXTRA stricter rate limiter on top of the global one.
// This means auth routes are limited by BOTH apiLimiter AND authLimiter.
app.use('/api/auth', authLimiter, authRouter);

// File routes: upload endpoints get an extra upload-specific limiter
app.use('/api/files', filesRouter);
app.use('/api/folders', foldersRouter);
app.use('/api/trash', trashRouter);
app.use('/api/search', searchRouter);
app.use('/api/storage', storageRouter);
app.use('/api/stars', starsRouter);
app.use('/api/profile', profileRouter);
app.use('/api/bulk', bulkRouter);
app.use('/api', shareRouter);

// ── Health Check ─────────────────────────────────────────────
// Used by load balancers and monitoring tools to verify the server is alive.
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timeStamp: new Date().toISOString(),
        environment: process.env.NODE_ENV,
    });
});

// ── 8. Error Handler ─────────────────────────────────────────
// MUST be the last app.use() — it catches errors thrown by all routes above.
app.use(errorHandler);

// ── Server Start ─────────────────────────────────────────────
app.listen(PORT, async () => {
    logger.info('server_started', { port: PORT, env: process.env.NODE_ENV });
    await testDbConnection();
    try {
        await applyIdempotentSchemaPatches();
    } catch (e) {
        logger.error('schema_patches_failed', { error: (e as Error).message });
        process.exit(1);
    }
});

