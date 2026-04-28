import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { AppError, errorHandler } from '../middleware/errorHandler';

// ── LEARNING NOTES: Why Test Middlewares? ───────────────────
// Middlewares sit between the request and the response. 
// Testing them in isolation ensures they behave correctly 
// (e.g., catching errors, formatting them to JSON) before 
// they are integrated into complex routes.
// We use 'supertest' to simulate HTTP requests without 
// actually starting a server on a real port.

describe('Error Handler Middleware', () => {
    let app: express.Application;

    beforeEach(() => {
        app = express();
        
        // Mock route that throws a known AppError
        app.get('/app-error', (req, res, next) => {
            next(new AppError('TEST_ERROR', 'This is a test error', 400));
        });

        // Mock route that throws an unexpected Javascript Error
        app.get('/unhandled-error', (req, res, next) => {
            next(new Error('Boom! Something unexpected happened'));
        });

        // Use our error handler as the very last middleware
        app.use(errorHandler);
    });

    it('should format AppError correctly and use its status code', async () => {
        const response = await request(app).get('/app-error');
        
        expect(response.status).toBe(400);
        expect(response.body).toEqual({
            error: 'TEST_ERROR',
            message: 'This is a test error'
        });
    });

    it('should hide unexpected error details and return 500 INTERNAL_SERVER_ERROR', async () => {
        const response = await request(app).get('/unhandled-error');
        
        expect(response.status).toBe(500);
        expect(response.body).toEqual({
            error: 'INTERNAL_SERVER_ERROR',
            message: 'An unexpected error occurred'
        });
    });
});
