import { Request, Response, NextFunction } from 'express';

// Every error in the app gets thrown as AppError, which has a status code and message
export class AppError extends Error {
    constructor(
        public code: string,
        public message: string,
        public statusCode: number = 400
    ) {
        super(message);
        this.name = 'AppError';
    } 
}

// Common errors - use these instead of raw strings
export const Errors = {
    UNAUTHORIZED: new AppError('UNAUTHORIZED', 'You must be logged in to access this resource', 401),
    FORBIDDEN: new AppError('FORBIDDEN', 'You do not have permission to access this resource', 403),
    NOT_FOUND: new AppError('NOT_FOUND', 'The requested resource was not found', 404),
    BAD_REQUEST: new AppError('BAD_REQUEST', 'The request was invalid or cannot be processed', 400),
    CONFLICT: new AppError('CONFLICT', 'The request could not be completed due to a conflict with the current state of the resource', 409),
    INTERNAL_SERVER_ERROR: new AppError('INTERNAL_SERVER_ERROR', 'An unexpected error occurred', 500),
};

// Global error handler - must be the LAST app.use() in index.ts
export function errorHandler(
    err: Error,
    req: Request,
    res: Response,
    next: NextFunction
): void {
    if (err instanceof AppError) {
        res.status(err.statusCode).json({ error: err.code, message: err.message });
        return;
    }

    // Unexpecte error - log it, don't expose internals to client
    import('../utils/logger').then(({ logger }) => {
        logger.error('unexpected_error', { error: err.stack || err.message });
    });
    
    res.status(500).json({ 
        error: Errors.INTERNAL_SERVER_ERROR.code, message: Errors.INTERNAL_SERVER_ERROR.message 
    });
}

